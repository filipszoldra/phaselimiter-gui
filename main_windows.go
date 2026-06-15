//go:build windows

package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"

	webview2 "github.com/jchv/go-webview2"
)

//go:embed web
var webFS embed.FS

func main() {
	runner := CreateMasteringRunner()
	go runner.Run()

	ffmpegPath := findFfmpeg()
	app := &App{
		runner:   runner,
		analyzer: NewAnalyzer(getExecDir(), ffmpegPath),
		ffmpeg:   ffmpegPath,
		execDir:  getExecDir(),
	}

	// Serve the embedded frontend (and local analysis images) over loopback. A
	// real HTTP origin keeps relative asset paths, fetch and the WebView2 cache
	// behaving normally — far less fragile than a single about:blank document.
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/local", app.serveLocalFile)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	go func() { _ = http.Serve(ln, mux) }()
	url := "http://" + ln.Addr().String() + "/"

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     true,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "phaselimiter",
			Width:  1040,
			Height: 840,
			Center: true,
		},
	})
	if w == nil {
		log.Fatalln("Failed to create webview — is the Microsoft Edge WebView2 Runtime installed?")
	}
	defer w.Destroy()
	w.SetSize(1040, 840, webview2.HintNone)

	app.emit = func(js string) { w.Dispatch(func() { w.Eval(js) }) }
	w.Bind("plPickInputFiles", app.pickInputFiles)
	w.Bind("plPickOutputDir", app.pickOutputDir)
	w.Bind("plDefaultOutputDir", func() string { return getDefaultOutputDir() })
	w.Bind("plStartMastering", app.startMastering)
	w.Bind("plAnalyze", app.analyze)
	w.Bind("plGetReference", app.getReference)

	// Push every mastering status/progress update to the page.
	go func() {
		for m := range runner.MasteringUpdate {
			b, _ := json.Marshal(toJobView(m))
			app.emit("window.plOnJobUpdate && window.plOnJobUpdate(" + string(b) + ")")
		}
	}()

	w.Navigate(url)
	w.Run()
	runner.Terminate()
}
