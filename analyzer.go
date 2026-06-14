package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// Band is one ERB band from audio_analyzer's "bands" array (only fields we use).
type Band struct {
	Loudness float64 `json:"loudness"`
	MidMean  float64 `json:"mid_mean"`
	SideMean float64 `json:"side_mean"`
	LowFreq  float64 `json:"low_freq"`
	HighFreq float64 `json:"high_freq"`
}

// LoudnessPoint is one sample of the short-term loudness curve (loudness_time_series).
type LoudnessPoint struct {
	Sec float64 `json:"sec"`
	DB  float64 `json:"db"`
}

// AudioAnalysis is the subset of `audio_analyzer --mode default` JSON we consume.
// Units (from the engine source): peak/true_peak/rms are dB(FS); loudness and
// loudness_range are LUFS/LU; dynamics is a dB stddev; space/drr are dB-ish.
type AudioAnalysis struct {
	Channels   float64 `json:"channels"`
	SampleRate float64 `json:"sample_rate"`
	Frames     float64 `json:"frames"`

	Peak               float64 `json:"peak"`
	TruePeak           float64 `json:"true_peak"`
	LowpassTruePeak    float64 `json:"lowpass_true_peak_15khz"`
	Rms                float64 `json:"rms"`
	Loudness           float64 `json:"loudness"`
	LoudnessRange      float64 `json:"loudness_range"`
	LoudnessRangeShort float64 `json:"loudness_range_short"`
	Dynamics           float64 `json:"dynamics"`
	Sharpness          float64 `json:"sharpness"`
	Space              float64 `json:"space"`
	Drr                float64 `json:"drr"`
	SoundQuality2      float64 `json:"sound_quality2"`

	Bands              []Band          `json:"bands"`
	LoudnessTimeSeries []LoudnessPoint `json:"loudness_time_series"`
}

// DurationSec returns the track length in seconds (0 if unknown).
func (a AudioAnalysis) DurationSec() float64 {
	if a.SampleRate <= 0 {
		return 0
	}
	return a.Frames / a.SampleRate
}

// ImagePaths holds rendered PNG analysis images (empty string if a render failed).
type ImagePaths struct {
	Spectrogram          string
	SpectrumDistribution string
	StereoDistribution   string
}

// Analyzer runs audio_analyzer and caches metric results by file path + size + mtime.
type Analyzer struct {
	AudioAnalyzerPath  string // .../phaselimiter/bin/audio_analyzer
	Ffmpeg             string // ffmpeg executable (on PATH or absolute)
	SoundQuality2Cache string // .../phaselimiter/resource/sound_quality2_cache
	AnalysisDataDir    string // .../phaselimiter/resource/analysis_data

	mu    sync.Mutex
	cache map[string]AudioAnalysis
}

// NewAnalyzer resolves the tool/resource paths relative to the GUI exe dir,
// the same way mastering.go locates phase_limiter.
func NewAnalyzer(execDir, ffmpeg string) *Analyzer {
	return &Analyzer{
		AudioAnalyzerPath:  filepath.Join(execDir, "phaselimiter/bin/audio_analyzer"),
		Ffmpeg:             ffmpeg,
		SoundQuality2Cache: filepath.Join(execDir, "phaselimiter/resource/sound_quality2_cache"),
		AnalysisDataDir:    filepath.Join(execDir, "phaselimiter/resource/analysis_data"),
		cache:              make(map[string]AudioAnalysis),
	}
}

func analyzeCacheKey(path string) string {
	if info, err := os.Stat(path); err == nil {
		return fmt.Sprintf("%s|%d|%d", path, info.Size(), info.ModTime().UnixNano())
	}
	return path
}

// Analyze measures the given audio file and returns the parsed metrics, caching
// the result by path+size+mtime so F3/F4a/F4b can share one analysis of a file.
func (an *Analyzer) Analyze(audioPath string) (AudioAnalysis, error) {
	key := analyzeCacheKey(audioPath)

	an.mu.Lock()
	if cached, ok := an.cache[key]; ok {
		an.mu.Unlock()
		return cached, nil
	}
	an.mu.Unlock()

	wav, err := an.decodeToWav(audioPath)
	if err != nil {
		return AudioAnalysis{}, err
	}
	defer os.Remove(wav)

	analysis, err := an.runAnalyzerOnWav(wav, nil)
	if err != nil {
		return AudioAnalysis{}, err
	}

	an.mu.Lock()
	an.cache[key] = analysis
	an.mu.Unlock()
	return analysis, nil
}

// AnalyzeWithImages runs the analyzer once and returns both the metrics and PNG
// images written under pngDir (which must already exist). Image fields are set
// only for files the analyzer actually produced. Not cached.
func (an *Analyzer) AnalyzeWithImages(audioPath, pngDir string) (AudioAnalysis, ImagePaths, error) {
	wav, err := an.decodeToWav(audioPath)
	if err != nil {
		return AudioAnalysis{}, ImagePaths{}, err
	}
	defer os.Remove(wav)

	spectro := filepath.Join(pngDir, "spectrogram.png")
	spectrum := filepath.Join(pngDir, "spectrum.png")
	stereo := filepath.Join(pngDir, "stereo.png")

	analysis, err := an.runAnalyzerOnWav(wav, []string{
		"--spectrogram_output", spectro,
		"--spectrum_distribution_output", spectrum,
		"--stereo_distribution_output", stereo,
	})
	if err != nil {
		return AudioAnalysis{}, ImagePaths{}, err
	}

	var imgs ImagePaths
	if fileExists(spectro) {
		imgs.Spectrogram = spectro
	}
	if fileExists(spectrum) {
		imgs.SpectrumDistribution = spectrum
	}
	if fileExists(stereo) {
		imgs.StereoDistribution = stereo
	}
	return analysis, imgs, nil
}

// decodeToWav normalizes any input to a temporary stereo 44.1 kHz float WAV. This
// guarantees a format the analyzer accepts (it reads WAV only) and forces stereo,
// because the engine's dynamics calculation throws on mono input. Caller removes
// the returned file.
func (an *Analyzer) decodeToWav(audioPath string) (string, error) {
	tmp, err := os.CreateTemp("", "pl_analyze_*.wav")
	if err != nil {
		return "", fmt.Errorf("create temp wav: %w", err)
	}
	tempWav := tmp.Name()
	tmp.Close()

	dec := exec.Command(an.Ffmpeg, "-y", "-i", audioPath,
		"-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", tempWav)
	CmdHideWindow(dec)
	if out, err := dec.CombinedOutput(); err != nil {
		os.Remove(tempWav)
		return "", fmt.Errorf("ffmpeg decode failed: %w: %s", err, tail(string(out), 500))
	}
	return tempWav, nil
}

// runAnalyzerOnWav runs audio_analyzer on a WAV and parses its stdout JSON.
//
// --quick_exit=false makes the binary return normally so the buffered JSON on
// stdout is flushed (the default quick_exit=true uses std::_Exit, which can skip
// flushing). A post-flush crash during shutdown is tolerated: we parse whatever
// JSON we captured regardless of the process exit status.
func (an *Analyzer) runAnalyzerOnWav(wavPath string, extraArgs []string) (AudioAnalysis, error) {
	args := append([]string{
		"--mode", "default",
		"--input", wavPath,
		"--sound_quality2_cache", an.SoundQuality2Cache,
		"--analysis_data_dir", an.AnalysisDataDir,
		"--quick_exit", "false",
	}, extraArgs...)

	cmd := exec.Command(an.AudioAnalyzerPath, args...)
	CmdHideWindow(cmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	var analysis AudioAnalysis
	if jsonErr := json.Unmarshal(stdout.Bytes(), &analysis); jsonErr != nil {
		if runErr != nil {
			return AudioAnalysis{}, fmt.Errorf("audio_analyzer failed: %w: %s", runErr, tail(stderr.String(), 500))
		}
		return AudioAnalysis{}, fmt.Errorf("audio_analyzer output not parseable: %w", jsonErr)
	}
	return analysis, nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Size() > 0
}

// tail returns at most the last n characters of s (with an ellipsis if truncated).
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "..." + s[len(s)-n:]
}
