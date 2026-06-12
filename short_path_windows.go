//go:build windows

package main

import "syscall"

// toShortPath converts a Windows path to its 8.3 short form.
// The phase_limiter engine calls ffmpeg via std::system() without quoting paths,
// so spaces in the path cause cmd.exe to split the command. Short paths have no spaces.
// Falls back to the original path if short-path support is disabled on the volume.
func toShortPath(longPath string) string {
	if longPath == "" {
		return longPath
	}
	p, err := syscall.UTF16PtrFromString(longPath)
	if err != nil {
		return longPath
	}
	buf := make([]uint16, 4096)
	n, err := syscall.GetShortPathName(p, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		return longPath
	}
	return syscall.UTF16ToString(buf[:n])
}
