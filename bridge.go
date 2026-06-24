//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// App holds the shared state the JS frontend drives via bound functions. It is
// platform-neutral: the Windows entrypoint wires `emit` to webview Eval.
type App struct {
	runner   MasteringRunner
	analyzer *Analyzer
	ffmpeg   string
	execDir  string
	emit     func(js string) // push JS to the page (set by the platform main)
	nextID   int
}

// StartReq is the payload for plStartMastering.
type StartReq struct {
	Inputs    []string    `json:"inputs"`
	OutputDir string      `json:"outputDir"`
	Settings  JobSettings `json:"settings"`
}

func (app *App) pickInputFiles() ([]string, error) { return selectAudioFiles() }
func (app *App) pickOutputDir() (string, error)    { return selectDirectory() }

// analyze / analyzeFull are fire-and-forget: they run the heavy analysis in a
// goroutine so the WebView2 UI thread (which invokes bound functions synchronously)
// is never blocked. The result is pushed back to the page via emitAnalyzeResult,
// correlated to the JS caller by id. See web/app.js (__plAnalyzeResolve).
func (app *App) analyze(id float64, input string) {
	go func() {
		log.Printf("analyze: input=%q ffmpeg=%q", input, app.analyzer.Ffmpeg)
		result, err := app.analyzer.AnalyzeAudio(input)
		if err != nil {
			log.Printf("analyze error: %v", err)
		} else {
			log.Printf("analyze ok: %.0fs, %d samples, %d sections", result.TotalSec, len(result.LoudnessSeries), len(result.Sections))
		}
		app.emitAnalyzeResult(int(id), result, err)
	}()
}

func (app *App) analyzeFull(id float64, input string) {
	go func() {
		log.Printf("analyzeFull: input=%q", input)
		result, err := app.analyzer.AnalyzeAudioFull(input)
		if err != nil {
			log.Printf("analyzeFull error: %v", err)
		} else {
			log.Printf("analyzeFull ok: %.0fs, LUFS=%.1f, spectro=%q", result.TotalSec, result.GlobalLoudness, result.SpectrogramURL)
		}
		app.emitAnalyzeResult(int(id), result, err)
	}()
}

// emitAnalyzeResult pushes an analysis result (or error) to the page, resolving the
// JS-side promise keyed by id. Mirrors the plOnJobUpdate emit pattern.
func (app *App) emitAnalyzeResult(id int, result *AnalysisResult, err error) {
	res, errJSON := []byte("null"), []byte("null")
	if err != nil {
		errJSON, _ = json.Marshal(err.Error())
	} else {
		res, _ = json.Marshal(result)
	}
	app.emit(fmt.Sprintf("window.__plAnalyzeResolve(%d,%s,%s)", id, res, errJSON))
}

// startMastering builds one Mastering job per input, enqueues them, and returns
// the initial rows so the frontend can render the queue immediately.
func (app *App) startMastering(req StartReq) ([]JobView, error) {
	var views []JobView
	for _, in := range req.Inputs {
		m := Mastering{}
		m.Status = MasteringStatusWaiting
		m.Id = app.nextID
		app.nextID++
		m.Ffmpeg = app.ffmpeg
		m.PhaselimiterPath = filepath.Join(app.execDir, "phaselimiter/bin/phase_limiter")
		m.SoundQuality2Cache = filepath.Join(app.execDir, "phaselimiter/resource/sound_quality2_cache")
		m.Input = in

		name := strings.TrimSuffix(filepath.Base(in), filepath.Ext(in)) + "_output.wav"
		if len(req.Inputs) == 1 && strings.TrimSpace(req.Settings.OutputName) != "" {
			name = strings.TrimSpace(req.Settings.OutputName)
			if filepath.Ext(name) == "" {
				name += ".wav"
			}
		}
		m.Output = filepath.Join(req.OutputDir, name)

		s := req.Settings
		m.Loudness = s.Loudness
		m.Level = s.Level
		m.BassPreservation = s.BassPreservation
		m.Ceiling = s.Ceiling
		m.LimiterOversample = s.LimiterOversample
		if m.LimiterOversample < 1 {
			m.LimiterOversample = 1
		}
		m.LimiterMaxIter = s.LimiterMaxIter
		m.PreCompression = s.PreCompression
		m.PreCompressionThreshold = s.PreCompressionThreshold
		m.PreCompressionMeanSec = s.PreCompressionMeanSec
		m.MSMatchingLevel = s.MSMatchingLevel
		m.EQBandLevels = s.EQBandLevels
		m.EQTransformLevels = s.EQTransformLevels
		m.EQTransformSymmetric = s.EQTransformSymmetric
		m.EQAnalysisTarget = s.EQAnalysisTarget
		m.EQAnalysisEnabled = s.EQAnalysisEnabled
		m.Sections = append([]Section(nil), s.Sections...)
		m.SectionIntensity = s.SectionIntensity
		m.SectionMasteringEnable = s.SectionMasteringEnable

		app.runner.Add(m)
		views = append(views, toJobView(m))
	}
	return views, nil
}

// ---------------------------------------------------------------------------
// Reference profile (mastering_reference.json → frontend)
// ---------------------------------------------------------------------------

// getReference reads phaselimiter/resource/mastering_reference.json and returns
// the 9-band loudness profile used by AutoMastering5.
func (app *App) getReference() (*RefProfile, error) {
	path := filepath.Join(app.execDir, "phaselimiter/resource/mastering_reference.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read mastering_reference.json: %w", err)
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
		return nil, fmt.Errorf("parse mastering_reference.json: %w", err)
	}
	prof := &RefProfile{Loudness: raw.Loudness}
	for _, b := range raw.Bands {
		prof.Bands = append(prof.Bands, RefBand{
			LowFreq:  b.LowFreq,
			HighFreq: b.HighFreq,
			Loudness: b.Loudness,
			MidMean:  b.MidMean,
			SideMean: b.SideMean,
		})
	}
	return prof, nil
}

// serveLocalFile streams a local file (used later for analysis PNGs in temp
// dirs). Loopback-only; the frontend passes ?path=<absolute path>.
func (app *App) serveLocalFile(wr http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(wr, "missing path", http.StatusBadRequest)
		return
	}
	http.ServeFile(wr, r, p)
}

func getDefaultOutputDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/tmp"
	}
	if downloads := filepath.Join(home, "Downloads"); dirExists(downloads) {
		return downloads
	}
	if desktop := filepath.Join(home, "Desktop"); dirExists(desktop) {
		return desktop
	}
	return home
}

