package main

import (
	"fmt"
	"sort"
)

// SuggestedSettings holds values for the existing GUI controls, derived from an
// input analysis. Notes explains each choice (shown to the user / logged).
type SuggestedSettings struct {
	Loudness                float64
	Level                   float64
	BassPreservation        bool
	Ceiling                 float64
	LimiterOversample       int
	LimiterMaxIter          int
	PreCompression          bool
	PreCompressionThreshold float64
	PreCompressionMeanSec   float64
	Notes                   []string
}

// suggestSettings maps measured input metrics to gentle, glitch-avoiding control
// values. The primary signal is loudness range (LRA, well-defined in LU); true
// peak (dB) drives the ceiling and band balance drives bass preservation. All
// returned values stay within the GUI control ranges.
func suggestSettings(a AudioAnalysis) SuggestedSettings {
	s := SuggestedSettings{
		Ceiling:           -1.0,
		LimiterOversample: 2,
		LimiterMaxIter:    100,
		PreCompression:    true,
	}

	lra := a.LoudnessRange
	switch {
	case lra >= 10:
		s.Loudness = -14
		s.Level = 0.25
		s.PreCompressionMeanSec = 0.45
		s.PreCompressionThreshold = 6
		s.Notes = append(s.Notes, fmt.Sprintf(
			"High loudness range (LRA %.1f LU): big dynamic swings → more pre-compression to smooth peaks before the limiter (threshold 6), long window, -14 LUFS target.", lra))
	case lra >= 6:
		s.Loudness = -13
		s.Level = 0.4
		s.PreCompressionMeanSec = 0.3
		s.PreCompressionThreshold = 8
		s.Notes = append(s.Notes, fmt.Sprintf(
			"Moderate loudness range (LRA %.1f LU): balanced settings.", lra))
	default:
		s.Loudness = -12
		s.Level = 0.6
		s.PreCompressionMeanSec = 0.2
		s.PreCompressionThreshold = 10
		s.Notes = append(s.Notes, fmt.Sprintf(
			"Low loudness range (LRA %.1f LU): already compressed, peaks uniform → light pre-compression (threshold 10), can push intensity harder.", lra))
	}

	// Louder targets drive the limiter harder, so give it more iterations.
	if s.Loudness >= -11 {
		s.LimiterMaxIter = 200
	}

	// Bass-heavy material: protect the low end so the limiter doesn't pump it.
	if emph, ok := bassEmphasisDb(a.Bands); ok && emph > 2.0 {
		s.BassPreservation = true
		s.Notes = append(s.Notes, fmt.Sprintf(
			"Low end is strong (+%.1f dB vs midrange): enabling Preserve bass.", emph))
	}

	s.Notes = append(s.Notes, fmt.Sprintf(
		"Ceiling -1.0 dB + 2× oversampling for true-peak headroom (input true-peak %.1f dBFS).", a.TruePeak))
	return s
}

// bassEmphasisDb returns how much louder the low bands are than the overall
// median band loudness (in dB), and whether it could be computed. Positive means
// bass-heavy. Bands are the analyzer's ERB bands; the first band has no low_freq.
func bassEmphasisDb(bands []Band) (float64, bool) {
	if len(bands) < 3 {
		return 0, false
	}
	var low, all []float64
	for i, b := range bands {
		all = append(all, b.MidMean)
		// "Low" = the sub band (first, no low edge) or bands ending below ~300 Hz.
		if i == 0 || (b.HighFreq > 0 && b.HighFreq <= 300) {
			low = append(low, b.MidMean)
		}
	}
	if len(low) == 0 {
		low = append(low, bands[0].MidMean)
	}
	return mean(low) - median(all), true
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	c := append([]float64(nil), xs...)
	sort.Float64s(c)
	n := len(c)
	if n%2 == 1 {
		return c[n/2]
	}
	return 0.5 * (c[n/2-1] + c[n/2])
}
