package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
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
	// Advanced (glitch-reduction) controls. These act on the limiter / ceiling /
	// pre-compression stages, which run regardless of how gentle Loudness/Level are.
	Ceiling                 float64 // true-peak ceiling in dB (e.g. -1.0); reduces clicks
	LimiterOversample       int     // 1/2/4; higher reduces aliasing "crunch"
	LimiterMaxIter          int     // limiter optimizer outer iterations; higher = cleaner
	PreCompression          bool    // pre-compression on/off
	PreCompressionThreshold float64 // dB over loudness; higher = more dynamics
	PreCompressionMeanSec   float64 // smoothing window; longer = less pumping
	Progression             float64
	Status                  MasteringStatus
	Message                 string
}

type MasteringRunner struct {
	MasteringUpdate chan Mastering
	mastering       chan Mastering
	terminated      chan bool
}

func (m Mastering) execute(update chan Mastering) {
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
		"--input", m.Input,
		"--output", m.Output,
		"--ffmpeg", m.Ffmpeg,
		"--sound_quality2_cache", m.SoundQuality2Cache,
		"--erb_eval_func_weighting", formatBool(m.BassPreservation),
		"--reference", formatFloat(m.Loudness),
		// Advanced glitch-reduction stages (see Mastering struct comments).
		"--ceiling", formatFloat(m.Ceiling),
		"--limiter_internal_oversample", strconv.Itoa(m.LimiterOversample),
		"--max_iter1", strconv.Itoa(m.LimiterMaxIter),
		"--pre_compression", formatBool(m.PreCompression),
		"--pre_compression_threshold", formatFloat(m.PreCompressionThreshold),
		"--pre_compression_mean_sec", formatFloat(m.PreCompressionMeanSec),
	}

	// AutoMastering5 (reference matching). In mastering5 mode only
	// --mastering5_mastering_level has any effect; --mastering_matching_level and
	// --mastering_ms_matching_level apply only to "classic" mode, so they are not
	// passed here. "Limiter only" disables matching entirely for A/B diagnosis.
	if m.LimiterOnly {
		args = append(args, "--mastering", "false")
	} else {
		args = append(args,
			"--mastering", "true",
			"--mastering_mode", "mastering5",
			"--mastering5_mastering_level", formatFloat(m.Level),
		)
	}
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

	err = cmd.Start()
	if err != nil {
		m.Status = MasteringStatusFailed
		m.Message = "failed to start command: " + err.Error()
		update <- m
		return
	}

	scanner := bufio.NewScanner(stdout)
	r := regexp.MustCompile("progression: ([-+]?[0-9]*\\.?[0-9]+)")
	//output := ""
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Println(line)
		// output += line
		matches := r.FindStringSubmatch(line)
		if len(matches) > 0 {
			m.Progression, _ = strconv.ParseFloat(matches[1], 64)
			update <- m
		}
	}

	err = cmd.Wait()
	if err != nil {
		m.Status = MasteringStatusFailed
		m.Message = "command failed: " + err.Error() // + " output: " + output
		update <- m
		return
	}

	m.Progression = 1
	m.Status = MasteringStatusSucceeded
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
