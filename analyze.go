package main

import (
	"bufio"
	"math"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// AnalysisResult is returned to the frontend by plAnalyze.
type AnalysisResult struct {
	TotalSec       float64          `json:"totalSec"`
	LoudnessSeries []LoudnessSample `json:"loudnessSeries"`
	Sections       []SectionBound   `json:"sections"`
}

// LoudnessSample is one data point in the loudness timeline.
type LoudnessSample struct {
	Sec float64 `json:"sec"`
	Db  float64 `json:"db"`
}

// SectionBound is a time range the frontend can mark as a "quiet section".
type SectionBound struct {
	StartSec float64 `json:"startSec"`
	EndSec   float64 `json:"endSec"`
}

// Analyzer wraps ffmpeg-based audio analysis.
type Analyzer struct {
	ffmpeg string
}

var reEbur128 = regexp.MustCompile(`t:\s*([\d.]+)\s+M:\s*(-?\d[\d.]*|-inf)\s+S:\s*(-?\d[\d.]*|-inf)`)
var reDuration = regexp.MustCompile(`Duration:\s*(\d+):(\d+):([\d.]+)`)

type eburFrame struct{ t, m, s float64 }

// Analyze runs ffmpeg ebur128 on the input file and returns the result.
func (a *Analyzer) Analyze(input string) (*AnalysisResult, error) {
	cmd := exec.Command(a.ffmpeg,
		"-i", input,
		"-af", "ebur128=framelog=verbose",
		"-f", "null", "-",
	)
	// CombinedOutput captures both stdout and stderr (ebur128 writes to stderr).
	// ffmpeg exits non-zero when using null muxer on some builds — ignore exit code.
	out, _ := cmd.CombinedOutput()
	text := string(out)

	// Parse total duration from ffmpeg's input info line.
	totalSec := 0.0
	if m := reDuration.FindStringSubmatch(text); m != nil {
		h, _ := strconv.ParseFloat(m[1], 64)
		mn, _ := strconv.ParseFloat(m[2], 64)
		s, _ := strconv.ParseFloat(m[3], 64)
		totalSec = h*3600 + mn*60 + s
	}

	// Parse per-frame LUFS (momentary M and short-term S).
	var frames []eburFrame
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		m := reEbur128.FindStringSubmatch(scanner.Text())
		if m == nil {
			continue
		}
		t, _ := strconv.ParseFloat(m[1], 64)
		mv := clampDB(m[2])
		sv := clampDB(m[3])
		frames = append(frames, eburFrame{t, mv, sv})
		if t > totalSec {
			totalSec = t
		}
	}

	series := resampleTo05s(frames, totalSec)
	sections := detectQuietSections(series, totalSec)

	return &AnalysisResult{
		TotalSec:       totalSec,
		LoudnessSeries: series,
		Sections:       sections,
	}, nil
}

func clampDB(s string) float64 {
	if s == "-inf" || s == "" {
		return -70.0
	}
	v, _ := strconv.ParseFloat(s, 64)
	if v < -70 {
		return -70
	}
	return v
}

// resampleTo05s averages per-frame ebur128 output into 0.5 s buckets.
// Prefers short-term (S) LUFS; falls back to momentary (M) for leading silence.
func resampleTo05s(frames []eburFrame, totalSec float64) []LoudnessSample {
	if len(frames) == 0 || totalSec <= 0 {
		return nil
	}
	const step = 0.5
	n := int(math.Ceil(totalSec/step)) + 2
	sums := make([]float64, n)
	counts := make([]int, n)
	for _, f := range frames {
		idx := int(f.t / step)
		if idx >= n {
			idx = n - 1
		}
		v := f.s
		if v <= -69 {
			v = f.m // short-term not yet valid, use momentary
		}
		sums[idx] += v
		counts[idx]++
	}
	var out []LoudnessSample
	for i := 0; i < n; i++ {
		t := float64(i) * step
		if t > totalSec+step {
			break
		}
		db := -70.0
		if counts[i] > 0 {
			db = sums[i] / float64(counts[i])
		}
		out = append(out, LoudnessSample{Sec: t, Db: db})
	}
	return out
}

// detectQuietSections finds contiguous regions >6 dB below the track's body
// median — these are candidates for section-aware mastering.
func detectQuietSections(series []LoudnessSample, totalSec float64) []SectionBound {
	if len(series) < 4 {
		return nil
	}

	// Median of non-silent samples as body reference.
	var active []float64
	for _, s := range series {
		if s.Db > -55 {
			active = append(active, s.Db)
		}
	}
	if len(active) == 0 {
		return nil
	}
	sort.Float64s(active)
	bodyMedian := active[len(active)/2]
	threshold := bodyMedian - 6.0

	const minDurSec = 2.0
	const minGapSec = 3.0

	var sections []SectionBound
	inQuiet := false
	var qStart float64

	merge := func(qEnd float64) {
		if qEnd-qStart < minDurSec {
			return
		}
		if len(sections) > 0 && qStart-sections[len(sections)-1].EndSec < minGapSec {
			sections[len(sections)-1].EndSec = qEnd
		} else {
			sections = append(sections, SectionBound{StartSec: qStart, EndSec: qEnd})
		}
	}

	for _, s := range series {
		if s.Db < threshold {
			if !inQuiet {
				inQuiet = true
				qStart = s.Sec
			}
		} else {
			if inQuiet {
				inQuiet = false
				merge(s.Sec)
			}
		}
	}
	if inQuiet {
		merge(totalSec)
	}
	return sections
}
