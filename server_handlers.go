//go:build linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
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

// chunkSession tracks in-progress chunked file uploads.
type chunkSession struct {
	ext   string
	total int
	files map[int]string
	mu    sync.Mutex
	at    time.Time
}

var chunkSessions sync.Map

// handleUploadChunk receives raw binary chunks one at a time.
// Headers: X-Session-ID (empty on first chunk), X-Chunk-Index, X-Total-Chunks, X-File-Ext.
// Body: application/octet-stream — one chunk (<= 25 MB).
// Returns {"sessionId":"..."} until all chunks arrive, then adds "fileToken" to the response.
func handleUploadChunk() http.HandlerFunc {
	go func() {
		for range time.Tick(10 * time.Minute) {
			chunkSessions.Range(func(k, v any) bool {
				s := v.(*chunkSession)
				s.mu.Lock()
				old := time.Since(s.at) > 30*time.Minute
				var stale []string
				if old {
					for _, p := range s.files {
						stale = append(stale, p)
					}
				}
				s.mu.Unlock()
				if old {
					for _, p := range stale {
						os.Remove(p)
					}
					chunkSessions.Delete(k)
				}
				return true
			})
		}
	}()

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Bug 13: limit chunk size to 30 MB to prevent OOM.
		r.Body = http.MaxBytesReader(w, r.Body, 30<<20)

		sessID := r.Header.Get("X-Session-ID")
		idx, _ := strconv.Atoi(r.Header.Get("X-Chunk-Index"))
		total, _ := strconv.Atoi(r.Header.Get("X-Total-Chunks"))
		ext := r.Header.Get("X-File-Ext")
		if ext == "" {
			ext = ".wav"
		}
		if total < 1 {
			total = 1
		}

		var sess *chunkSession
		if sessID == "" {
			sessID = newToken()
			sess = &chunkSession{ext: ext, total: total, files: make(map[int]string), at: time.Now()}
			chunkSessions.Store(sessID, sess)
		} else {
			v, ok := chunkSessions.Load(sessID)
			if !ok {
				http.Error(w, "session not found", http.StatusNotFound)
				return
			}
			sess = v.(*chunkSession)
		}

		tmp, err := os.CreateTemp("", "pl_chunk_*")
		if err != nil {
			http.Error(w, "temp: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if _, err := io.Copy(tmp, r.Body); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			http.Error(w, "read chunk: "+err.Error(), http.StatusInternalServerError)
			return
		}
		tmp.Close()

		sess.mu.Lock()
		sess.files[idx] = tmp.Name()
		sess.at = time.Now()
		received := len(sess.files)
		total = sess.total // use authoritative total from session
		sess.mu.Unlock()

		if received < total {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"sessionId": sessID})
			return
		}

		// All chunks received — atomically take ownership so only one goroutine assembles.
		// Bug 3: use LoadAndDelete to prevent double-assembly race.
		actual, loaded := chunkSessions.LoadAndDelete(sessID)
		if !loaded {
			http.Error(w, "session already assembled or expired", http.StatusConflict)
			return
		}
		sess = actual.(*chunkSession)

		// Bug 4: collect all chunk paths up front; defer cleanup regardless of success/failure.
		sess.mu.Lock()
		chunkPaths := make([]string, sess.total)
		for i := 0; i < sess.total; i++ {
			chunkPaths[i] = sess.files[i]
		}
		sess.mu.Unlock()
		defer func() {
			for _, p := range chunkPaths {
				os.Remove(p)
			}
		}()

		tok := newToken()
		outPath := filepath.Join(os.TempDir(), "pl_upload_"+tok+sess.ext)
		out, err := os.Create(outPath)
		if err != nil {
			http.Error(w, "assemble create: "+err.Error(), http.StatusInternalServerError)
			return
		}
		var assembleErr error
		for i, p := range chunkPaths {
			f, openErr := os.Open(p)
			if openErr != nil {
				assembleErr = fmt.Errorf("open chunk %d: %w", i, openErr)
				break
			}
			_, copyErr := io.Copy(out, f)
			f.Close()
			if copyErr != nil {
				assembleErr = fmt.Errorf("copy chunk %d: %w", i, copyErr)
				break
			}
		}
		out.Close()
		if assembleErr != nil {
			os.Remove(outPath)
			http.Error(w, "assemble: "+assembleErr.Error(), http.StatusInternalServerError)
			return
		}

		storeToken(tok, outPath, []string{outPath})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"sessionId": sessID, "fileToken": tok})
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

// handleAnalyze accepts either:
//   - multipart form with "file" field (small files, original path), or
//   - multipart form with "fileToken" field (chunked-upload path — file already on disk).
//
// Returns JSON result with spectrogramURL rewritten to /api/files/{token}.
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

		var tmpPath string
		var ownFile bool // true = we created the temp file and must delete it

		if tok := r.FormValue("fileToken"); tok != "" {
			p, ok := lookupToken(tok)
			if !ok {
				http.Error(w, "file token not found or expired", http.StatusNotFound)
				return
			}
			unstoreToken(tok) // transfer ownership; we delete after analysis
			tmpPath = p
			ownFile = true
		} else {
			f, hdr, err := r.FormFile("file")
			if err != nil {
				http.Error(w, "missing file or fileToken: "+err.Error(), http.StatusBadRequest)
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
			tmpPath = tmp.Name()
			ownFile = true
			if _, err := io.Copy(tmp, f); err != nil {
				tmp.Close()
				os.Remove(tmpPath)
				http.Error(w, "write temp: "+err.Error(), http.StatusInternalServerError)
				return
			}
			tmp.Close()
		}
		if ownFile {
			defer os.Remove(tmpPath)
		}

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
			exists := imgPath != "" && fileExists(imgPath)
			log.Printf("spectrogram rewrite: path=%q exists=%v", imgPath, exists)
			if exists {
				tok := newToken()
				storeToken(tok, imgPath, []string{imgPath})
				result.SpectrogramURL = "/api/files/" + tok
			}
		} else if result.SpectrogramURL != "" {
			log.Printf("spectrogram URL unexpected format: %q", result.SpectrogramURL)
		} else {
			log.Printf("spectrogram URL empty after analysis")
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
		settingsJSON := r.FormValue("settings")
		var settings JobSettings
		if settingsJSON != "" {
			if err := json.Unmarshal([]byte(settingsJSON), &settings); err != nil {
				http.Error(w, "parse settings: "+err.Error(), http.StatusBadRequest)
				return
			}
		}

		outTok := newToken()
		outPath := filepath.Join(os.TempDir(), "pl_out_"+outTok+".wav")

		var inPath, inputName string

		if tok := r.FormValue("fileToken"); tok != "" {
			p, ok := lookupToken(tok)
			if !ok {
				http.Error(w, "file token not found or expired", http.StatusNotFound)
				return
			}
			unstoreToken(tok) // transfer ownership to outTok cleanup below
			inPath = p
			inputName = r.FormValue("fileName")
			if inputName == "" {
				inputName = filepath.Base(p)
			}
		} else {
			f, hdr, err := r.FormFile("file")
			if err != nil {
				http.Error(w, "missing file or fileToken: "+err.Error(), http.StatusBadRequest)
				return
			}
			defer f.Close()
			ext := filepath.Ext(hdr.Filename)
			if ext == "" {
				ext = ".wav"
			}
			inTok := newToken()
			inPath = filepath.Join(os.TempDir(), "pl_in_"+inTok+ext)
			inputName = hdr.Filename
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
		}

		nextIDMu.Lock()
		jobID := *nextID
		*nextID++
		nextIDMu.Unlock()

		// Register download token before job completes so it's ready when SSE fires.
		storeToken(outTok, outPath, []string{inPath, outPath})

		// Use a background context so the engine keeps running if the SSE client
		// disconnects mid-job. r.Context() cancellation (client disconnect) would
		// SIGKILL the engine after only a few seconds, causing "signal: killed".
		jobCtx := context.Background()

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
			Ctx:                     jobCtx,
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
			// Filesystem fallback: token may have been evicted from memory (GC or restart)
			// but the file may still exist on this instance (same /tmp, same revision).
			fallbackPath := filepath.Join(os.TempDir(), "pl_out_"+token+".wav")
			if fi, statErr := os.Stat(fallbackPath); statErr == nil && fi.Size() > 0 {
				log.Printf("download: token=%q not in store — filesystem fallback OK, size=%d", token, fi.Size())
				w.Header().Set("Content-Disposition", `attachment; filename="output.wav"`)
				http.ServeFile(w, r, fallbackPath)
				return
			}
			log.Printf("download: token=%q not in store, no filesystem fallback — 404", token)
			http.Error(w, "not found or expired", http.StatusNotFound)
			return
		}
		log.Printf("download: token=%q found in store, path=%q", token, filePath)
		if fi, statErr := os.Stat(filePath); statErr != nil || fi.Size() == 0 {
			log.Printf("download: token=%q file missing or empty: statErr=%v", token, statErr)
			http.Error(w, "file missing on server", http.StatusInternalServerError)
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
			exists := imgPath != "" && fileExists(imgPath)
			log.Printf("spectrogram rewrite (by-token): path=%q exists=%v", imgPath, exists)
			if exists {
				tok := newToken()
				storeToken(tok, imgPath, []string{imgPath})
				result.SpectrogramURL = "/api/files/" + tok
			}
		} else if result.SpectrogramURL != "" {
			log.Printf("spectrogram URL unexpected format (by-token): %q", result.SpectrogramURL)
		} else {
			log.Printf("spectrogram URL empty after by-token analysis")
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
