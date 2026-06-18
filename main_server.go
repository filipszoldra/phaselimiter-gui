//go:build linux

package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
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
	mux.HandleFunc("/api/analyze", handleAnalyze(an))
	mux.HandleFunc("/api/analyze-by-token/", handleAnalyzeByToken(an))
	mux.HandleFunc("/api/master", handleMaster(&runner, execDir, ffmpeg, &nextID, &nextIDMu))
	mux.HandleFunc("/api/download/", handleDownload())
	mux.HandleFunc("/api/files/", handleFiles())

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
