//go:build linux

package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

//go:embed web
var webFS embed.FS

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	execDir := getExecDir()
	ffmpeg := findFfmpeg()
	log.Printf("execDir=%s ffmpeg=%s port=%s", execDir, ffmpeg, port)

	an := NewAnalyzer(execDir, ffmpeg)
	runner := CreateMasteringRunner()
	go runner.Run()

	// Fan-out MasteringUpdate channel to per-job SSE watchers.
	go func() {
		for m := range runner.MasteringUpdate {
			watcher.dispatch(m)
		}
	}()

	startTokenGC()

	var nextID int
	var nextIDMu sync.Mutex

	webSub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()

	mux.HandleFunc("/api/reference", handleReference(execDir))
	mux.HandleFunc("/api/upload-chunk", handleUploadChunk())
	mux.HandleFunc("/api/analyze", handleAnalyze(an))
	mux.HandleFunc("/api/analyze-by-token/", handleAnalyzeByToken(an))
	mux.HandleFunc("/api/master", handleMaster(&runner, execDir, ffmpeg, &nextID, &nextIDMu))
	mux.HandleFunc("/api/download/", handleDownload())
	mux.HandleFunc("/api/files/", handleFiles())
	mux.HandleFunc("/api/debug", handleDebug(execDir))

	// Static assets — index.html gets window.__webServerMode injected.
	fileServer := http.FileServer(http.FS(webSub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || path == "/index.html" {
			serveIndexWithServerMode(w, r, webSub)
			return
		}
		fileServer.ServeHTTP(w, r)
	})

	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func handleDebug(execDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		var sb strings.Builder

		fmt.Fprintf(&sb, "=== env ===\nLD_LIBRARY_PATH=%s\nPATH=%s\n\n",
			os.Getenv("LD_LIBRARY_PATH"), os.Getenv("PATH"))

		binDir := filepath.Join(execDir, "phaselimiter/bin")
		fmt.Fprintf(&sb, "=== %s ===\n", binDir)
		entries, err := os.ReadDir(binDir)
		if err != nil {
			fmt.Fprintf(&sb, "ReadDir error: %v\n\n", err)
		} else {
			for _, e := range entries {
				info, _ := e.Info()
				size := int64(0)
				if info != nil {
					size = info.Size()
				}
				fmt.Fprintf(&sb, "  %s  %d\n", e.Name(), size)
			}
			fmt.Fprintln(&sb)
		}

		for _, name := range []string{"phase_limiter", "audio_analyzer"} {
			path := filepath.Join(binDir, name)
			cmd := exec.Command("ldd", path)
			out, err := cmd.CombinedOutput()
			fmt.Fprintf(&sb, "=== ldd %s (exit=%v) ===\n%s\n", name, err, string(out))
		}

		// Quick smoke-test: run phase_limiter with no args and capture stderr.
		phPath := filepath.Join(binDir, "phase_limiter")
		cmd := exec.Command(phPath)
		cmd.Env = os.Environ()
		out, err := cmd.CombinedOutput()
		fmt.Fprintf(&sb, "=== phase_limiter (no args, exit=%v) ===\n%s\n", err, string(out))

		w.Write([]byte(sb.String()))
	}
}

func serveIndexWithServerMode(w http.ResponseWriter, r *http.Request, webSub fs.FS) {
	data, err := fs.ReadFile(webSub, "index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	injected := strings.Replace(string(data),
		"</head>",
		"<script>window.__webServerMode=true;</script></head>",
		1,
	)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(injected))
}
