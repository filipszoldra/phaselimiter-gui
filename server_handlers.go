//go:build linux

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// jobWatcher fans out MasteringUpdate broadcasts to per-job channels so each
// SSE handler only receives updates for its own job.
type jobWatcher struct {
	mu   sync.Mutex
	subs map[int]chan Mastering
}

var watcher = &jobWatcher{subs: make(map[int]chan Mastering)}

func (w *jobWatcher) subscribe(id int) chan Mastering {
	ch := make(chan Mastering, 200)
	w.mu.Lock()
	w.subs[id] = ch
	w.mu.Unlock()
	return ch
}

func (w *jobWatcher) unsubscribe(id int) {
	w.mu.Lock()
	delete(w.subs, id)
	w.mu.Unlock()
}

func (w *jobWatcher) dispatch(m Mastering) {
	w.mu.Lock()
	ch, ok := w.subs[m.Id]
	w.mu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- m:
	default: // drop if buffer full; shouldn't happen with capacity 200
	}
}

// handleReference serves mastering_reference.json in frontend-friendly format.
func handleReference(execDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		path := filepath.Join(execDir, "phaselimiter/resource/mastering_reference.json")
		data, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "reference not found: "+err.Error(), http.StatusNotFound)
			return
		}
		var raw struct {
			Bands []struct {
				LowFreq  float64 `json:"low_freq"`
				HighFreq float64 `json:"high_freq"`
				Loudness float64 `json:"loudness"`
				MidMean  float64 `json:"mid_mean"`
				SideMean float64 `json:"side_mean"`
			} `json:"bands"`
			Loudness float64 `json:"loudness"`
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			http.Error(w, "parse error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		prof := RefProfile{Loudness: raw.Loudness}
		for _, b := range raw.Bands {
			prof.Bands = append(prof.Bands, RefBand{
				LowFreq:  b.LowFreq,
				HighFreq: b.HighFreq,
				Loudness: b.Loudness,
				MidMean:  b.MidMean,
				SideMean: b.SideMean,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(prof)
	}
}

// handleAnalyze accepts a multipart audio file upload, runs AnalyzeAudioFull,
// and returns the JSON result with spectrogramURL rewritten to /api/files/{token}.
func handleAnalyze(an *Analyzer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseMultipartForm(500 << 20); err != nil {
			http.Error(w, "parse form: "+err.Error(), http.StatusBadRequest)
			return
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "missing file: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer f.Close()

		ext := filepath.Ext(hdr.Filename)
		if ext == "" {
			ext = ".wav"
		}
		tmp, err := os.CreateTemp("", "pl_analyze_in_*"+ext)
		if err != nil {
			http.Error(w, "temp file: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)
		if _, err := io.Copy(tmp, f); err != nil {
			tmp.Close()
			http.Error(w, "write temp: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tmp.Close()

		result, err := an.AnalyzeAudioFull(tmpPath)
		if err != nil {
			log.Printf("analyze error: %v", err)
			http.Error(w, "analyze error: "+err.Error(), http.StatusInternalServerError)
			return
		}

		// Rewrite /local?path= URL to /api/files/{token} for web clients.
		if strings.HasPrefix(result.SpectrogramURL, "/local?path=") {
			encoded := strings.TrimPrefix(result.SpectrogramURL, "/local?path=")
			imgPath, _ := url.QueryUnescape(encoded)
			if imgPath != "" && fileExists(imgPath) {
				tok := newToken()
				storeToken(tok, imgPath, []string{imgPath})
				result.SpectrogramURL = "/api/files/" + tok
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

// handleMaster accepts a multipart audio file + JSON settings, enqueues a
// mastering job, and streams progress as Server-Sent Events. The final
// "succeeded" event carries output as "/api/download/{token}".
func handleMaster(runner *MasteringRunner, execDir, ffmpeg string, nextID *int, nextIDMu *sync.Mutex) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseMultipartForm(500 << 20); err != nil {
			http.Error(w, "parse form: "+err.Error(), http.StatusBadRequest)
			return
		}
		f, hdr, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "missing file: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer f.Close()

		settingsJSON := r.FormValue("settings")
		var settings JobSettings
		if settingsJSON != "" {
			if err := json.Unmarshal([]byte(settingsJSON), &settings); err != nil {
				http.Error(w, "parse settings: "+err.Error(), http.StatusBadRequest)
				return
			}
		}

		ext := filepath.Ext(hdr.Filename)
		if ext == "" {
			ext = ".wav"
		}
		inTok := newToken()
		inPath := filepath.Join(os.TempDir(), "pl_in_"+inTok+ext)
		outTok := newToken()
		outPath := filepath.Join(os.TempDir(), "pl_out_"+outTok+".wav")

		inFile, err := os.Create(inPath)
		if err != nil {
			http.Error(w, "create temp: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if _, copyErr := io.Copy(inFile, f); copyErr != nil {
			inFile.Close()
			os.Remove(inPath)
			http.Error(w, "write temp: "+copyErr.Error(), http.StatusInternalServerError)
			return
		}
		inFile.Close()

		nextIDMu.Lock()
		jobID := *nextID
		*nextID++
		nextIDMu.Unlock()

		// Register download token before job completes so it's ready when SSE fires.
		storeToken(outTok, outPath, []string{inPath, outPath})

		oversample := settings.LimiterOversample
		if oversample < 1 {
			oversample = 1
		}
		m := Mastering{
			Id:                      jobID,
			Input:                   inPath,
			Output:                  outPath,
			Ffmpeg:                  ffmpeg,
			PhaselimiterPath:        filepath.Join(execDir, "phaselimiter/bin/phase_limiter"),
			SoundQuality2Cache:      filepath.Join(execDir, "phaselimiter/resource/sound_quality2_cache"),
			Status:                  MasteringStatusWaiting,
			Loudness:                settings.Loudness,
			Level:                   settings.Level,
			BassPreservation:        settings.BassPreservation,
			LimiterOnly:             settings.LimiterOnly,
			Ceiling:                 settings.Ceiling,
			LimiterOversample:       oversample,
			LimiterMaxIter:          settings.LimiterMaxIter,
			PreCompression:          settings.PreCompression,
			PreCompressionThreshold: settings.PreCompressionThreshold,
			PreCompressionMeanSec:   settings.PreCompressionMeanSec,
			MSMatchingLevel:         settings.MSMatchingLevel,
			EQBandLevels:            settings.EQBandLevels,
			EQTransformLevels:       settings.EQTransformLevels,
			EQTransformSymmetric:    settings.EQTransformSymmetric,
			EQAnalysisTarget:        settings.EQAnalysisTarget,
			EQAnalysisEnabled:       settings.EQAnalysisEnabled,
			Sections:                append([]Section(nil), settings.Sections...),
			SectionIntensity:        settings.SectionIntensity,
			SectionMasteringEnable:  settings.SectionMasteringEnable,
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")

		updates := watcher.subscribe(jobID)
		defer watcher.unsubscribe(jobID)

		// Send initial row so the frontend can render the queue entry immediately.
		inputName := hdr.Filename
		sendSSE(w, flusher, JobView{
			ID: jobID, Input: inputName, Status: string(MasteringStatusWaiting),
		})

		runner.Add(m)

		for {
			select {
			case upd := <-updates:
				jv := toJobView(upd)
				jv.Input = inputName
				if upd.Status == MasteringStatusSucceeded {
					jv.Output = "/api/download/" + outTok
				}
				sendSSE(w, flusher, jv)
				if upd.Status == MasteringStatusSucceeded || upd.Status == MasteringStatusFailed {
					if upd.Status == MasteringStatusFailed {
						// Job failed — clean up input; output may not exist.
						deleteTokenEntry(outTok)
						os.Remove(inPath)
					}
					return
				}
			case <-r.Context().Done():
				return
			}
		}
	}
}

func sendSSE(w http.ResponseWriter, flusher http.Flusher, jv JobView) {
	b, _ := json.Marshal(jv)
	fmt.Fprintf(w, "data: %s\n\n", b)
	flusher.Flush()
}

// handleDownload serves the mastered output WAV.
// Files are cleaned up by the 15-minute GC rather than immediately, so the
// comparison analysis that runs right after job success can still access the file.
func handleDownload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := filepath.Base(r.URL.Path)
		filePath, ok := lookupToken(token)
		if !ok {
			http.Error(w, "not found or expired", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="output.wav"`)
		http.ServeFile(w, r, filePath)
	}
}

// handleAnalyzeByToken runs AnalyzeAudioFull on a temp file identified by token.
// Used by the frontend to analyze the output file after mastering without re-uploading it.
func handleAnalyzeByToken(an *Analyzer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := filepath.Base(r.URL.Path)
		filePath, ok := lookupToken(token)
		if !ok {
			http.Error(w, "not found or expired", http.StatusNotFound)
			return
		}
		result, err := an.AnalyzeAudioFull(filePath)
		if err != nil {
			log.Printf("analyze-by-token error: %v", err)
			http.Error(w, "analyze error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if strings.HasPrefix(result.SpectrogramURL, "/local?path=") {
			encoded := strings.TrimPrefix(result.SpectrogramURL, "/local?path=")
			imgPath, _ := url.QueryUnescape(encoded)
			if imgPath != "" && fileExists(imgPath) {
				tok := newToken()
				storeToken(tok, imgPath, []string{imgPath})
				result.SpectrogramURL = "/api/files/" + tok
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

// handleFiles serves tokenized temp image files (spectrograms, etc.).
func handleFiles() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := filepath.Base(r.URL.Path)
		filePath, ok := lookupToken(token)
		if !ok {
			http.Error(w, "not found or expired", http.StatusNotFound)
			return
		}
		http.ServeFile(w, r, filePath)
	}
}
