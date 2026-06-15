package main

import (
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

// JobView is the row the frontend renders for one mastering job; it is also the
// shape pushed on every progress update.
type JobView struct {
	ID       int     `json:"id"`
	Input    string  `json:"input"`
	Output   string  `json:"output"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Message  string  `json:"message"`
}

func toJobView(m Mastering) JobView {
	return JobView{
		ID:       m.Id,
		Input:    m.Input,
		Output:   m.Output,
		Status:   string(m.Status),
		Progress: m.Progression,
		Message:  m.Message,
	}
}

// JobSettings mirrors the engine-facing controls the UI exposes (the 4-band
// Reference-Tone EQ is intentionally gone — it switched the engine to distance
// mode). Field names match the JS settings object.
type JobSettings struct {
	OutputName              string     `json:"outputName"`
	Loudness                float64    `json:"loudness"`
	Level                   float64    `json:"level"`
	BassPreservation        bool       `json:"bassPreservation"`
	LimiterOnly             bool       `json:"limiterOnly"`
	Ceiling                 float64    `json:"ceiling"`
	LimiterOversample       int        `json:"limiterOversample"`
	LimiterMaxIter          int        `json:"limiterMaxIter"`
	PreCompression          bool       `json:"preCompression"`
	PreCompressionThreshold float64    `json:"preCompressionThreshold"`
	PreCompressionMeanSec   float64    `json:"preCompressionMeanSec"`
	MSMatchingLevel         float64    `json:"msMatchingLevel"`
	EQBandLevels            [9]float64 `json:"eqBandLevels"`
	EQTransformLevels       [9]float64 `json:"eqTransformLevels"`
	EQTransformSymmetric    bool       `json:"eqTransformSymmetric"`
	Sections                []Section  `json:"sections"`
	SectionIntensity        float64    `json:"sectionIntensity"`
	SectionMasteringEnable  bool       `json:"sectionMasteringEnable"`
}

// StartReq is the payload for plStartMastering.
type StartReq struct {
	Inputs    []string    `json:"inputs"`
	OutputDir string      `json:"outputDir"`
	Settings  JobSettings `json:"settings"`
}

func (app *App) pickInputFiles() ([]string, error) { return selectAudioFiles() }
func (app *App) pickOutputDir() (string, error)    { return selectDirectory() }

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
		m.LimiterOnly = s.LimiterOnly
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
		m.Sections = append([]Section(nil), s.Sections...)
		m.SectionIntensity = s.SectionIntensity
		m.SectionMasteringEnable = s.SectionMasteringEnable

		app.runner.Add(m)
		views = append(views, toJobView(m))
	}
	return views, nil
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

// ---------------------------------------------------------------------------
// platform-neutral path helpers
// ---------------------------------------------------------------------------

func getExecDir() string {
	ex, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	return filepath.Dir(ex)
}

// findFfmpeg returns an absolute path to ffmpeg. It checks beside the exe first
// (the expected install layout), then falls back to the system PATH. Using an
// absolute path avoids Go 1.19+'s refusal to run executables found in "."
// (exec: "ffmpeg": cannot run executable found relative to current directory).
func findFfmpeg() string {
	beside := filepath.Join(getExecDir(), "ffmpeg")
	if runtime.GOOS == "windows" {
		beside += ".exe"
	}
	if _, err := os.Stat(beside); err == nil {
		return beside
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return "ffmpeg"
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

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
