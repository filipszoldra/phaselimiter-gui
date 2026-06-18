//go:build linux

package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"sync"
	"time"
)

type tokenEntry struct {
	filePath string   // primary file to serve
	cleanup  []string // all paths to remove on GC
	created  time.Time
}

var tokenStore sync.Map // string token → *tokenEntry

func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func storeToken(token, filePath string, cleanup []string) {
	tokenStore.Store(token, &tokenEntry{
		filePath: filePath,
		cleanup:  cleanup,
		created:  time.Now(),
	})
}

func lookupToken(token string) (string, bool) {
	v, ok := tokenStore.Load(token)
	if !ok {
		return "", false
	}
	return v.(*tokenEntry).filePath, true
}

func deleteTokenEntry(token string) {
	if v, ok := tokenStore.LoadAndDelete(token); ok {
		for _, p := range v.(*tokenEntry).cleanup {
			os.Remove(p)
		}
	}
}

// unstoreToken removes the token from the store without deleting any files.
// Use when transferring ownership of the file to another token's cleanup list.
func unstoreToken(token string) {
	tokenStore.Delete(token)
}

func startTokenGC() {
	go func() {
		for {
			time.Sleep(5 * time.Minute)
			cutoff := time.Now().Add(-15 * time.Minute)
			tokenStore.Range(func(k, v any) bool {
				e := v.(*tokenEntry)
				if e.created.Before(cutoff) {
					for _, p := range e.cleanup {
						os.Remove(p)
					}
					tokenStore.Delete(k)
				}
				return true
			})
		}
	}()
}
