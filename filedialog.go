//go:build windows

package main

import "github.com/ncruces/zenity"

// selectAudioFiles opens a native multi-select open dialog filtered to audio
// files and returns absolute paths. A cancelled dialog yields (nil, nil).
func selectAudioFiles() ([]string, error) {
	files, err := zenity.SelectFileMultiple(
		zenity.Title("Choose audio files"),
		zenity.FileFilters{
			{Name: "Audio files", Patterns: []string{"*.wav", "*.mp3", "*.flac", "*.aac", "*.m4a", "*.ogg", "*.aiff", "*.aif"}, CaseFold: true},
			{Name: "All files", Patterns: []string{"*"}, CaseFold: false},
		},
	)
	if err == zenity.ErrCanceled {
		return nil, nil
	}
	return files, err
}

// selectDirectory opens a native folder picker and returns the chosen path. A
// cancelled dialog yields ("", nil).
func selectDirectory() (string, error) {
	dir, err := zenity.SelectFile(
		zenity.Title("Choose output folder"),
		zenity.Directory(),
	)
	if err == zenity.ErrCanceled {
		return "", nil
	}
	return dir, err
}
