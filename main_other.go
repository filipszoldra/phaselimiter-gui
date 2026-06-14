//go:build !windows

package main

import (
	"fmt"
	"os"
)

// The app targets Windows (WebView2 runtime + the Windows phase_limiter build).
// This stub exists only so the module compiles and `go mod tidy` resolves on a
// non-Windows CI host.
func main() {
	fmt.Fprintln(os.Stderr, "phaselimiter-gui is Windows-only (requires the Microsoft Edge WebView2 Runtime).")
	os.Exit(1)
}
