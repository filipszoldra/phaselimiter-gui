package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log"
	"math"
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
	MSMatchingLevel         float64    // mastering_ms_matching_level: stereo-field match strength (0=ignore, 1=full)
	EQBandLevels            [9]float64 // mastering5_eq_band_levels: per-band optimizer upper-bound (ceiling) multipliers (1=neutral)
	EQTransformLevels       [9]float64 // mastering5_eq_transform_levels: per-band post-opt wet_gain strength multipliers (1=neutral)
	EQTransformSymmetric    bool       // mastering5_eq_transform_symmetric: scale cuts too (else boost-only)
	EQAnalysisTarget        [9]float64 // eq_analysis_target: user's per-band dBFS targets for post-AM static correction
	EQAnalysisEnabled       bool       // send --eq_analysis_target to the engine
	// Section-aware mastering: re-render quiet sections with gentler settings.
	Sections               []Section
	SectionIntensity       float64
	SectionMasteringEnable bool

	// Ctx, if non-nil, is used to kill the engine process (e.g. on client disconnect).
	// Nil falls back to context.Background().
	Ctx context.Context

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
// paths and mastering level. Returns the args and a cleanup func for any temp files
// created (currently none; kept for callers' defer).
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
		"--input", toShortPath(inputPath),
		"--output", toShortPath(outputPath),
		"--ffmpeg", toShortPath(m.Ffmpeg),
		"--sound_quality2_cache", toShortPath(m.SoundQuality2Cache),
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
		if m.MSMatchingLevel > 0 {
			args = append(args, "--mastering_ms_matching_level", formatFloat(m.MSMatchingLevel))
		}
		anyNonDefault := false
		for _, v := range m.EQBandLevels {
			if math.Abs(v-1.0) > 1e-9 {
				anyNonDefault = true
				break
			}
		}
		if anyNonDefault {
			parts := make([]string, 9)
			for i, v := range m.EQBandLevels {
				parts[i] = strconv.FormatFloat(v, 'f', 3, 64)
			}
			args = append(args, "--mastering5_eq_band_levels", strings.Join(parts, ","))
		}
		anyTransform := false
		for _, v := range m.EQTransformLevels {
			if math.Abs(v-1.0) > 1e-9 {
				anyTransform = true
				break
			}
		}
		if anyTransform {
			parts := make([]string, 9)
			for i, v := range m.EQTransformLevels {
				parts[i] = strconv.FormatFloat(v, 'f', 3, 64)
			}
			args = append(args, "--mastering5_eq_transform_levels", strings.Join(parts, ","))
			if m.EQTransformSymmetric {
				args = append(args, "--mastering5_eq_transform_symmetric", "true")
			}
		}
		if m.EQAnalysisEnabled {
			parts := make([]string, 9)
			for i, v := range m.EQAnalysisTarget {
				parts[i] = strconv.FormatFloat(v, 'f', 3, 64)
			}
			args = append(args, "--eq_analysis_target", strings.Join(parts, ","))
		}
		if m.SectionMasteringEnable && len(m.Sections) > 0 {
			parts := make([]string, len(m.Sections))
			for i, s := range m.Sections {
				parts[i] = strconv.FormatFloat(s.StartSec, 'f', 3, 64) + ":" +
					strconv.FormatFloat(s.EndSec, 'f', 3, 64)
			}
			args = append(args,
				"--mastering5_section_ranges", strings.Join(parts, ","),
				"--mastering5_section_intensity", formatFloat(m.SectionIntensity),
			)
		}
	}

	return args, cleanup
}

func (m Mastering) execute(update chan Mastering) {
	// Phase 1: global master (normal pipeline, drives the loudness arc).
	args, cleanup := m.buildEngineArgs(m.Input, m.Output, m.Level)
	defer cleanup()

	ctx := m.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	cmd := exec.CommandContext(ctx, m.PhaselimiterPath, args...)
	CmdHideWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.Status = MasteringStatusFailed
		m.Message = "failed to create stdout pipe: " + err.Error()
		update <- m
		return
	}
	// Capture stderr separately so it appears in failure messages and Cloud Run logs.
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	m.Status = MasteringStatusProcessing
	update <- m

	log.Printf("engine cmd [job %d]: %s %v", m.Id, m.PhaselimiterPath, args)
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
		se := strings.TrimSpace(stderrBuf.String())
		if se != "" {
			// Log full stderr to Cloud Run logs (no truncation).
			log.Printf("engine stderr FULL [job %d]:\n%s", m.Id, se)
		}
		msg := "command failed: " + err.Error()
		if se != "" {
			// Show last 2000 chars in SSE message (tail: error is at the end).
			msg += "; stderr: " + tail(se, 2000)
		}
		m.Status = MasteringStatusFailed
		m.Message = msg
		update <- m
		return
	}

	m.Progression = 1
	m.Status = MasteringStatusSucceeded
	m.Message = ""
	update <- m
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
