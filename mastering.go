package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type MasteringStatus string

const (
	MasteringStatusWaiting    = MasteringStatus("waiting")
	MasteringStatusProcessing = MasteringStatus("processing")
	MasteringStatusFailed     = MasteringStatus("failed")
	MasteringStatusSucceeded  = MasteringStatus("succeeded")
)

type Mastering struct {
	Id                 int
	Input              string
	Output             string
	Ffmpeg             string
	PhaselimiterPath   string
	SoundQuality2Cache string
	Loudness           float64
	Level              float64 // AutoMastering5 reference-matching strength (mastering5_mastering_level)
	BassPreservation   bool
	LimiterOnly        bool // diagnostic: bypass AutoMastering5, run the limiter only
	// Advanced (glitch-reduction) controls.
	Ceiling                 float64
	LimiterOversample       int
	LimiterMaxIter          int
	PreCompression          bool
	PreCompressionThreshold float64
	PreCompressionMeanSec   float64
	// Reference-EQ: tilt the AI's target tonal curve.
	ReferenceBasePath string
	ReferenceEQ       ReferenceEQ
	// Section-aware mastering: re-render quiet sections with gentler settings.
	Sections               []Section
	SectionIntensity       float64
	SectionMasteringEnable bool

	Progression float64
	Status      MasteringStatus
	Message     string
}

type MasteringRunner struct {
	MasteringUpdate chan Mastering
	mastering       chan Mastering
	terminated      chan bool
}

// buildEngineArgs constructs the phase_limiter argument list for the given input/output
// paths and mastering level. Returns the args and a cleanup func that removes any temp
// files created (e.g. the reference-EQ JSON).
func (m Mastering) buildEngineArgs(inputPath, outputPath string, level float64) ([]string, func()) {
	formatFloat := func(x float64) string {
		return strconv.FormatFloat(x, 'f', 7, 64)
	}
	formatBool := func(x bool) string {
		if x {
			return "true"
		}
		return "false"
	}

	args := []string{
		"--input", inputPath,
		"--output", outputPath,
		"--ffmpeg", m.Ffmpeg,
		"--sound_quality2_cache", m.SoundQuality2Cache,
		"--erb_eval_func_weighting", formatBool(m.BassPreservation),
		"--reference", formatFloat(m.Loudness),
		"--ceiling", formatFloat(m.Ceiling),
		"--limiter_internal_oversample", strconv.Itoa(m.LimiterOversample),
		"--max_iter1", strconv.Itoa(m.LimiterMaxIter),
		"--pre_compression", formatBool(m.PreCompression),
		"--pre_compression_threshold", formatFloat(m.PreCompressionThreshold),
		"--pre_compression_mean_sec", formatFloat(m.PreCompressionMeanSec),
	}

	cleanup := func() {}
	if m.LimiterOnly {
		args = append(args, "--mastering", "false")
	} else {
		args = append(args,
			"--mastering", "true",
			"--mastering_mode", "mastering5",
			"--mastering5_mastering_level", formatFloat(level),
		)
		if !m.ReferenceEQ.IsZero() && m.ReferenceBasePath != "" {
			if tmp, err := writeReferenceWithEQ(m.ReferenceBasePath, m.ReferenceEQ); err == nil {
				cleanup = func() { os.Remove(tmp) }
				args = append(args, "--mastering5_mastering_reference_file", tmp)
			}
		}
	}

	return args, cleanup
}

func (m Mastering) execute(update chan Mastering) {
	// Phase 1: global master (normal pipeline, drives the loudness arc).
	args, cleanup := m.buildEngineArgs(m.Input, m.Output, m.Level)
	defer cleanup()

	cmd := exec.Command(m.PhaselimiterPath, args...)
	CmdHideWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.Status = MasteringStatusFailed
		m.Message = "failed to create stdout pipe: " + err.Error()
		update <- m
		return
	}
	cmd.Stderr = cmd.Stdout

	m.Status = MasteringStatusProcessing
	update <- m

	if err = cmd.Start(); err != nil {
		m.Status = MasteringStatusFailed
		m.Message = "failed to start command: " + err.Error()
		update <- m
		return
	}

	scanner := bufio.NewScanner(stdout)
	r := regexp.MustCompile("progression: ([-+]?[0-9]*\\.?[0-9]+)")
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Println(line)
		if matches := r.FindStringSubmatch(line); len(matches) > 0 {
			m.Progression, _ = strconv.ParseFloat(matches[1], 64)
			update <- m
		}
	}

	if err = cmd.Wait(); err != nil {
		m.Status = MasteringStatusFailed
		m.Message = "command failed: " + err.Error()
		update <- m
		return
	}

	// Phase 2: section rescue (optional — re-render quiet sections gently, splice back).
	if m.SectionMasteringEnable && len(m.Sections) > 0 {
		for i, s := range m.Sections {
			m.Message = fmt.Sprintf("Section rescue %d/%d (%.0f–%.0f s)…",
				i+1, len(m.Sections), s.StartSec, s.EndSec)
			update <- m
			if err := m.rescueSection(s, i); err != nil {
				fmt.Printf("section %d rescue failed (keeping global master): %v\n", i, err)
			}
		}
	}

	m.Progression = 1
	m.Status = MasteringStatusSucceeded
	m.Message = ""
	update <- m
}

// rescueSection re-processes one quiet section with a gentler mastering level, then
// loudness-matches it to the global master and splices it back with crossfades.
func (m Mastering) rescueSection(s Section, idx int) error {
	secInput := fmt.Sprintf("%s.sec%d_in.wav", m.Output, idx)
	secOutput := fmt.Sprintf("%s.sec%d_out.wav", m.Output, idx)
	secGain := fmt.Sprintf("%s.sec%d_gain.wav", m.Output, idx)
	for _, f := range []string{secInput, secOutput, secGain} {
		defer os.Remove(f)
	}

	// Extract the section from the ORIGINAL input (not the global master) so the
	// engine gets audio without the global limiting already applied.
	if err := runFFmpegArgs(m.Ffmpeg, "-y", "-i", m.Input,
		"-ss", fmt.Sprintf("%.3f", s.StartSec),
		"-to", fmt.Sprintf("%.3f", s.EndSec),
		secInput); err != nil {
		return fmt.Errorf("extract section input: %w", err)
	}

	// Master the section with the gentler section intensity.
	sArgs, sCleanup := m.buildEngineArgs(secInput, secOutput, m.SectionIntensity)
	defer sCleanup()
	secCmd := exec.Command(m.PhaselimiterPath, sArgs...)
	CmdHideWindow(secCmd)
	if out, err := secCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("section mastering: %w: %s", err, tail(string(out), 400))
	}

	// Loudness-match the rescued section to the global master's level at that spot.
	globalLUFS, err := measureSegmentLUFS(m.Ffmpeg, m.Output, s.StartSec, s.EndSec)
	if err != nil {
		return fmt.Errorf("measure global LUFS: %w", err)
	}
	sectionLUFS, err := measureFileLUFS(m.Ffmpeg, secOutput)
	if err != nil {
		return fmt.Errorf("measure section LUFS: %w", err)
	}
	gainDB := globalLUFS - sectionLUFS
	// Clamp gain to ±18 dB — a huge difference signals an analysis failure.
	gainDB = math.Max(-18, math.Min(18, gainDB))

	if err := applyGainDB(m.Ffmpeg, secOutput, secGain, gainDB); err != nil {
		return fmt.Errorf("apply gain: %w", err)
	}

	// Splice the rescued section back into the global master.
	return spliceSectionIntoGlobal(m.Ffmpeg, m.Output, secGain, s.StartSec, s.EndSec)
}

// runFFmpegArgs runs ffmpeg with the given arguments, hiding the console window on
// Windows, and returns an error on non-zero exit.
func runFFmpegArgs(ffmpegPath string, args ...string) error {
	cmd := exec.Command(ffmpegPath, args...)
	CmdHideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, tail(string(out), 400))
	}
	return nil
}

// measureFileLUFS measures the integrated loudness (LUFS) of a whole WAV file using
// ffmpeg's loudnorm filter (print_format=json). The process exits non-zero (loudnorm
// only measures, doesn't encode), but the JSON stats appear in stderr regardless.
func measureFileLUFS(ffmpegPath, filePath string) (float64, error) {
	cmd := exec.Command(ffmpegPath, "-i", filePath,
		"-af", "loudnorm=print_format=json",
		"-f", "null", "-")
	CmdHideWindow(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Run() // intentionally ignore exit code

	output := stderr.String()
	start := strings.LastIndex(output, "{")
	end := strings.LastIndex(output, "}")
	if start < 0 || end <= start {
		return 0, fmt.Errorf("no JSON from loudnorm for %s", filePath)
	}

	var result struct {
		InputI string `json:"input_i"`
	}
	if err := json.Unmarshal([]byte(output[start:end+1]), &result); err != nil {
		return 0, fmt.Errorf("parse loudnorm JSON: %w", err)
	}

	lufs, err := strconv.ParseFloat(strings.TrimSpace(result.InputI), 64)
	if err != nil {
		return 0, fmt.Errorf("parse LUFS value %q: %w", result.InputI, err)
	}
	return lufs, nil
}

// measureSegmentLUFS measures the integrated loudness of a time slice [startSec, endSec]
// of filePath by extracting it to a temp WAV and calling measureFileLUFS.
func measureSegmentLUFS(ffmpegPath, filePath string, startSec, endSec float64) (float64, error) {
	tmp, err := os.CreateTemp("", "pl_meas_*.wav")
	if err != nil {
		return 0, err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())

	if err := runFFmpegArgs(ffmpegPath, "-y", "-i", filePath,
		"-ss", fmt.Sprintf("%.3f", startSec),
		"-to", fmt.Sprintf("%.3f", endSec),
		tmp.Name()); err != nil {
		return 0, err
	}
	return measureFileLUFS(ffmpegPath, tmp.Name())
}

// applyGainDB applies a linear gain (converted from dB) to a WAV file via ffmpeg.
func applyGainDB(ffmpegPath, inputPath, outputPath string, gainDB float64) error {
	gainAmp := math.Pow(10, gainDB/20)
	return runFFmpegArgs(ffmpegPath, "-y", "-i", inputPath,
		"-af", fmt.Sprintf("volume=%.6f", gainAmp),
		outputPath)
}

// spliceSectionIntoGlobal replaces [startSec, endSec] of globalPath with sectionPath,
// using short fade-in/out on the section edges to smooth the transitions.
// The result overwrites globalPath in place.
func spliceSectionIntoGlobal(ffmpegPath, globalPath, sectionPath string, startSec, endSec float64) error {
	fade := 0.08 // seconds
	dur := endSec - startSec
	fadeOutStart := dur - fade
	if fadeOutStart < fade {
		// Very short section: reduce fade so both fit.
		fade = dur / 4
		fadeOutStart = dur - fade
	}

	tmp := globalPath + ".splice.tmp.wav"

	filter := fmt.Sprintf(
		"[0:a]atrim=end=%.3f,asetpts=PTS-STARTPTS[pre];"+
			"[1:a]afade=t=in:st=0:d=%.3f,afade=t=out:st=%.3f:d=%.3f,asetpts=PTS-STARTPTS[sec];"+
			"[0:a]atrim=start=%.3f,asetpts=PTS-STARTPTS[post];"+
			"[pre][sec][post]concat=n=3:v=0:a=1[out]",
		startSec, fade, fadeOutStart, fade, endSec,
	)

	cmd := exec.Command(ffmpegPath, "-y",
		"-i", globalPath, "-i", sectionPath,
		"-filter_complex", filter,
		"-map", "[out]",
		tmp)
	CmdHideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("splice: %w: %s", err, tail(string(out), 400))
	}

	os.Remove(globalPath)
	return os.Rename(tmp, globalPath)
}

func CreateMasteringRunner() MasteringRunner {
	m := MasteringRunner{}
	m.mastering = make(chan Mastering, 1000)
	m.terminated = make(chan bool, 1000)
	m.MasteringUpdate = make(chan Mastering, 1000)
	return m
}

func (m MasteringRunner) Run() {
	for {
		select {
		case x := <-m.mastering:
			x.execute(m.MasteringUpdate)
		case _ = <-m.terminated:
			return
		}
	}
}

func (m MasteringRunner) Add(mastering Mastering) {
	m.mastering <- mastering
}

func (m MasteringRunner) Terminate() {
	m.terminated <- true
}
