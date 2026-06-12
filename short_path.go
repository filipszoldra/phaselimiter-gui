//go:build !windows

package main

func toShortPath(p string) string { return p }
