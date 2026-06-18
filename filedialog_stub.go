//go:build !windows

package main

import "errors"

func selectAudioFiles() ([]string, error) { return nil, errors.New("not supported") }
func selectDirectory() (string, error)    { return "", errors.New("not supported") }
