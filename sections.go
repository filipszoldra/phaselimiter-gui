package main

import (
	"fmt"
	"sort"
)

// Section is a contiguous time span detected from the short-term loudness curve.
type Section struct {
	StartSec float64
	EndSec   float64
	MinDB    float64 // quietest short-term loudness inside the span (LUFS)
	GapDB    float64 // how far the span sits below the loud reference (positive LU)
}

func (s Section) DurationSec() float64 { return s.EndSec - s.StartSec }

func (s Section) String() string {
	return fmt.Sprintf("%5.1fs–%5.1fs (%.1fs, %.0f LU below loud)",
		s.StartSec, s.EndSec, s.DurationSec(), s.GapDB)
}

// SectionDetectOptions tunes quiet-section detection. Zero value is unusable;
// use DefaultSectionDetectOptions().
type SectionDetectOptions struct {
	DropDB              float64 // a span is "quiet" if this far below the loud reference
	MinDurationSec      float64 // ignore quiet runs shorter than this
	BridgeSec           float64 // merge quiet spans separated by less than this
	ReferencePercentile float64 // percentile of the curve treated as the loud level
}

func DefaultSectionDetectOptions() SectionDetectOptions {
	return SectionDetectOptions{
		DropDB:              6,
		MinDurationSec:      2.0,
		BridgeSec:           1.0,
		ReferencePercentile: 0.95,
	}
}

// detectQuietSections finds spans of the short-term loudness curve that sit well
// below the track's loud level — the parts a single global master tends to
// over-process. The loud reference is a high percentile of the curve, so a brief
// loud transient does not skew it. Returned spans are merged across short gaps
// and filtered by minimum duration.
func detectQuietSections(series []LoudnessPoint, opts SectionDetectOptions) []Section {
	if len(series) < 3 {
		return nil
	}

	dbs := make([]float64, len(series))
	for i, p := range series {
		dbs[i] = p.DB
	}
	reference := percentile(dbs, opts.ReferencePercentile)
	threshold := reference - opts.DropDB
	step := medianStep(series)

	// Collect raw quiet runs as [startIdx, endIdx] inclusive.
	type run struct{ start, end int }
	var runs []run
	inRun := false
	var cur run
	for i, p := range series {
		if p.DB < threshold {
			if !inRun {
				cur = run{start: i, end: i}
				inRun = true
			} else {
				cur.end = i
			}
		} else if inRun {
			runs = append(runs, cur)
			inRun = false
		}
	}
	if inRun {
		runs = append(runs, cur)
	}

	// Bridge runs separated by a gap shorter than BridgeSec.
	var merged []run
	for _, r := range runs {
		if n := len(merged); n > 0 {
			gap := series[r.start].Sec - series[merged[n-1].end].Sec
			if gap < opts.BridgeSec {
				merged[n-1].end = r.end
				continue
			}
		}
		merged = append(merged, r)
	}

	var sections []Section
	for _, r := range merged {
		start := series[r.start].Sec
		end := series[r.end].Sec + step // include the last block's coverage
		if end-start < opts.MinDurationSec {
			continue
		}
		minDB := series[r.start].DB
		for i := r.start; i <= r.end; i++ {
			if series[i].DB < minDB {
				minDB = series[i].DB
			}
		}
		sections = append(sections, Section{
			StartSec: start,
			EndSec:   end,
			MinDB:    minDB,
			GapDB:    reference - minDB,
		})
	}
	return sections
}

// percentile returns the p-quantile (0..1) of xs using nearest-rank.
func percentile(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	c := append([]float64(nil), xs...)
	sort.Float64s(c)
	idx := int(p * float64(len(c)-1))
	if idx < 0 {
		idx = 0
	}
	if idx >= len(c) {
		idx = len(c) - 1
	}
	return c[idx]
}

// medianStep estimates the time between consecutive curve samples.
func medianStep(series []LoudnessPoint) float64 {
	if len(series) < 2 {
		return 0.1
	}
	diffs := make([]float64, 0, len(series)-1)
	for i := 1; i < len(series); i++ {
		d := series[i].Sec - series[i-1].Sec
		if d > 0 {
			diffs = append(diffs, d)
		}
	}
	if len(diffs) == 0 {
		return 0.1
	}
	return median(diffs)
}
