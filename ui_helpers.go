package main

import (
	"fmt"
	"strings"
)

// oversampleIndex maps a limiter-oversample factor to the combo box index
// (the combo lists "1", "2", "4").
func oversampleIndex(v int) int {
	switch v {
	case 4:
		return 2
	case 2:
		return 1
	default:
		return 0
	}
}

// formatSuggestionMessage renders the applied settings, the reasoning, and any
// auto-detected quiet sections for the F3 "Analyze & suggest" dialog.
func formatSuggestionMessage(a AudioAnalysis, s SuggestedSettings) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Input: %.1f LUFS, LRA %.1f LU, true-peak %.1f dBFS, dynamics %.1f\n\n",
		a.Loudness, a.LoudnessRange, a.TruePeak, a.Dynamics)

	b.WriteString("Applied settings:\n")
	fmt.Fprintf(&b, "• Target loudness: %.0f LUFS\n", s.Loudness)
	fmt.Fprintf(&b, "• Intensity: %.2f\n", s.Level)
	fmt.Fprintf(&b, "• Preserve bass: %v\n", s.BassPreservation)
	fmt.Fprintf(&b, "• Ceiling: %.1f dB · Oversample: %d× · Iterations: %d\n",
		s.Ceiling, s.LimiterOversample, s.LimiterMaxIter)
	fmt.Fprintf(&b, "• Pre-comp: %v · threshold %.1f dB · window %.2f s\n\n",
		s.PreCompression, s.PreCompressionThreshold, s.PreCompressionMeanSec)

	b.WriteString("Why:\n")
	for _, n := range s.Notes {
		b.WriteString("• " + n + "\n")
	}

	secs := detectQuietSections(a.LoudnessTimeSeries, DefaultSectionDetectOptions())
	if len(secs) > 0 {
		fmt.Fprintf(&b, "\n%d quiet section(s) detected and shown in the \"Detected quiet sections\" list.\n", len(secs))
		b.WriteString("Enable \"Section-aware mastering\" to re-render them with gentler settings.")
	} else if len(a.LoudnessTimeSeries) > 0 {
		b.WriteString("\nNo strongly quiet sections detected — global settings should be fine.")
	}
	return b.String()
}
