package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func getExecDir() string {
	ex, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(ex)
}

// findFfmpeg returns an absolute path to ffmpeg. It checks beside the exe first
// (the expected install layout), then falls back to the system PATH.
func findFfmpeg() string {
	beside := filepath.Join(getExecDir(), "ffmpeg")
	if runtime.GOOS == "windows" {
		beside += ".exe"
	}
	if _, err := os.Stat(beside); err == nil {
		return beside
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return "ffmpeg"
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
