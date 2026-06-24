package main

// JobView is the row the frontend renders for one mastering job.
// Shared between the Windows WebView2 host (bridge.go) and the Linux HTTP server.
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

// JobSettings mirrors the engine-facing controls the UI exposes.
// Field names match the JS settings object.
type JobSettings struct {
	OutputName              string     `json:"outputName"`
	Loudness                float64    `json:"loudness"`
	Level                   float64    `json:"level"`
	BassPreservation        bool       `json:"bassPreservation"`
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
	EQAnalysisTarget        [9]float64 `json:"eqAnalysisTarget"`
	EQAnalysisEnabled       bool       `json:"eqAnalysisEnabled"`
	Sections                []Section  `json:"sections"`
	SectionIntensity        float64    `json:"sectionIntensity"`
	SectionMasteringEnable  bool       `json:"sectionMasteringEnable"`
}

// RefBand is one ERB band from the mastering reference profile.
type RefBand struct {
	LowFreq  float64 `json:"lowFreq"`
	HighFreq float64 `json:"highFreq"`
	Loudness float64 `json:"loudness"`
	MidMean  float64 `json:"midMean"`
	SideMean float64 `json:"sideMean"`
}

// RefProfile is the per-band spectral target returned to the frontend.
type RefProfile struct {
	Bands    []RefBand `json:"bands"`
	Loudness float64   `json:"loudness"`
}
