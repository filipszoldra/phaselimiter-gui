package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// ReferenceEQ holds per-band-group tonal offsets (dB) to apply to the engine's
// mastering reference. Positive = boost that band in the AI target, negative = cut.
// v1 adjusts mid_mean (tonal/mono target) only; side_mean and covariance are untouched.
type ReferenceEQ struct {
	LowDB     float64 // <250 Hz
	LowMidDB  float64 // 250–2000 Hz
	HighMidDB float64 // 2000–6000 Hz
	HighDB    float64 // ≥6000 Hz
}

// IsZero reports whether all offsets are zero (no modification needed).
func (eq ReferenceEQ) IsZero() bool {
	return eq.LowDB == 0 && eq.LowMidDB == 0 && eq.HighMidDB == 0 && eq.HighDB == 0
}

func clampEQ(v float64) float64 {
	if v > 6 {
		return 6
	}
	if v < -6 {
		return -6
	}
	return v
}

// eqOffsetForHz returns the dB offset for the band group that contains centreHz.
func (eq ReferenceEQ) eqOffsetForHz(centreHz float64) float64 {
	switch {
	case centreHz < 250:
		return clampEQ(eq.LowDB)
	case centreHz < 2000:
		return clampEQ(eq.LowMidDB)
	case centreHz < 6000:
		return clampEQ(eq.HighMidDB)
	default:
		return clampEQ(eq.HighDB)
	}
}

// writeReferenceWithEQ loads the base mastering reference JSON, adds per-band dB
// offsets to mid_mean (the tonal target curve), and writes the result to a temp file
// whose path is returned. The caller must remove the file when done.
// All other fields (covariance, side_mean, loudness, …) are preserved verbatim via
// a map[string]interface{} round-trip so unknown fields survive without a typed schema.
func writeReferenceWithEQ(basePath string, eq ReferenceEQ) (string, error) {
	data, err := os.ReadFile(basePath)
	if err != nil {
		return "", fmt.Errorf("read reference: %w", err)
	}

	var root map[string]interface{}
	if err := json.Unmarshal(data, &root); err != nil {
		return "", fmt.Errorf("parse reference: %w", err)
	}

	bandsRaw, ok := root["bands"]
	if !ok {
		return "", fmt.Errorf("reference JSON has no 'bands' field")
	}
	bands, ok := bandsRaw.([]interface{})
	if !ok {
		return "", fmt.Errorf("reference JSON 'bands' is not an array")
	}

	for i, bRaw := range bands {
		band, ok := bRaw.(map[string]interface{})
		if !ok {
			continue
		}
		lo, _ := band["low_freq"].(float64) // missing for first band → 0
		hi, _ := band["high_freq"].(float64)
		centre := (lo + hi) / 2
		if hi <= 0 {
			centre = lo
		}

		mid, ok := band["mid_mean"].(float64)
		if !ok {
			continue
		}
		band["mid_mean"] = mid + eq.eqOffsetForHz(centre)
		bands[i] = band
	}
	root["bands"] = bands

	out, err := json.Marshal(root)
	if err != nil {
		return "", fmt.Errorf("marshal reference: %w", err)
	}

	tmp, err := os.CreateTemp("", "pl_ref_*.json")
	if err != nil {
		return "", fmt.Errorf("create temp reference: %w", err)
	}
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	tmp.Close()
	return tmp.Name(), nil
}
