package main

import (
	"fmt"
	"github.com/gotk3/gotk3/gdk"
	"github.com/gotk3/gotk3/glib"
	"github.com/gotk3/gotk3/gtk"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

const (
	COLUMN_ID = iota
	COLUMN_INPUT
	COLUMN_OUTPUT
	COLUMN_STATUS
)

func getExecDir() string {
	ex, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	return filepath.Dir(ex)
}

func getDefaultOutputDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "/tmp"
	}
	downloads := filepath.Join(home, "Downloads")
	_, err = os.Stat(downloads)
	if err == nil {
		return downloads
	}
	desktop := filepath.Join(home, "Desktop")
	_, err = os.Stat(desktop)
	if err == nil {
		return desktop
	}
	return home
}

func createTreeViewColumn(title string, order int) *gtk.TreeViewColumn {
	renderer, _ := gtk.CellRendererTextNew()
	tvc, _ := gtk.TreeViewColumnNewWithAttribute(
		title, renderer, "text", order)
	return tvc
}

func updateListItem(model *gtk.ListStore, iter *gtk.TreeIter, m Mastering) {
	status := string(m.Status)
	if m.Status == MasteringStatusProcessing {
		status = strconv.FormatFloat(m.Progression*100, 'f', 0, 64) + "%"
	}
	model.Set(iter, []int{COLUMN_ID, COLUMN_INPUT, COLUMN_OUTPUT, COLUMN_STATUS},
		[]interface{}{m.Id, m.Input, m.Output, status})
}

func main() {
	masteringRunner := CreateMasteringRunner()
	go masteringRunner.Run()
	masteringId := 0

	gtk.Init(nil)

	win, err := gtk.WindowNew(gtk.WINDOW_TOPLEVEL)
	if err != nil {
		log.Fatal("Unable to create window:", err)
	}
	win.SetTitle("phaselimiter-gui")
	win.SetDefaultSize(400, 400)
	win.Connect("destroy", func() {
		masteringRunner.Terminate()
		gtk.MainQuit()
	})

	targets, err := gtk.TargetEntryNew("text/uri-list", gtk.TARGET_OTHER_APP, 1)
	if err != nil {
		log.Fatal("Unable to create target entry:", err)
	}
	win.DragDestSet(gtk.DEST_DEFAULT_ALL, []gtk.TargetEntry{*targets}, gdk.ACTION_LINK)

	box, err := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 0)
	win.Add(box)

	entryLabel, err := gtk.LabelNew("Output directory")
	box.Add(entryLabel)
	entry, err := gtk.EntryNew()
	entry.SetText(getDefaultOutputDir())
	box.Add(entry)

	loudnessLabel, err := gtk.LabelNew("Target loudness")
	box.Add(loudnessLabel)
	loudness, err := gtk.SpinButtonNewWithRange(-20, 0.0, 0.01)
	loudness.SetValue(-9)
	box.Add(loudness)

	masteringLevelLabel, err := gtk.LabelNew("Mastering intensity")
	box.Add(masteringLevelLabel)
	masteringLevel, err := gtk.SpinButtonNewWithRange(0.0, 1.0, 0.01)
	masteringLevel.SetValue(1)
	box.Add(masteringLevel)

	bassPreservation, err := gtk.CheckButtonNewWithLabel("Preserve bass")
	box.Add(bassPreservation)

	// Advanced (glitch-reduction) section — collapsed by default. These act on the
	// limiter / ceiling / pre-compression stages, which produce crunch/clicks/pumping
	// even at gentle loudness & intensity.
	advExpander, err := gtk.ExpanderNew("Advanced (glitch reduction)")
	box.Add(advExpander)
	advBox, err := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 0)
	advExpander.Add(advBox)

	ceilingLabel, err := gtk.LabelNew("True-peak ceiling (dB) — lower reduces clicks")
	advBox.Add(ceilingLabel)
	ceiling, err := gtk.SpinButtonNewWithRange(-3.0, 0.0, 0.1)
	ceiling.SetValue(-1.0)
	advBox.Add(ceiling)

	oversampleLabel, err := gtk.LabelNew("Limiter oversampling (×) — higher reduces crunch")
	advBox.Add(oversampleLabel)
	oversample, err := gtk.ComboBoxTextNew()
	oversample.AppendText("1")
	oversample.AppendText("2")
	oversample.AppendText("4")
	oversample.SetActive(0)
	advBox.Add(oversample)

	limiterQualityLabel, err := gtk.LabelNew("Limiter quality (iterations) — higher = cleaner, slower")
	advBox.Add(limiterQualityLabel)
	limiterQuality, err := gtk.SpinButtonNewWithRange(100, 400, 50)
	limiterQuality.SetValue(100)
	advBox.Add(limiterQuality)

	preComp, err := gtk.CheckButtonNewWithLabel("Pre-compression (uncheck to remove pumping)")
	preComp.SetActive(true)
	advBox.Add(preComp)

	preCompThresholdLabel, err := gtk.LabelNew("Pre-comp threshold (dB) — higher = more dynamics")
	advBox.Add(preCompThresholdLabel)
	preCompThreshold, err := gtk.SpinButtonNewWithRange(0, 18, 0.5)
	preCompThreshold.SetValue(6)
	advBox.Add(preCompThreshold)

	preCompWindowLabel, err := gtk.LabelNew("Pre-comp window (s) — longer = less pumping")
	advBox.Add(preCompWindowLabel)
	preCompWindow, err := gtk.SpinButtonNewWithRange(0.05, 1.0, 0.05)
	preCompWindow.SetValue(0.2)
	advBox.Add(preCompWindow)

	notes, err := gtk.LabelNew(`Drop audio files.

Process
1. The input audio files are mastered
2. The output files are saved to output directory

Notes
- Same algorithm with bakuage.com/aimastering.com
- No internet access`)
	box.Add(notes)

	ls, err := gtk.ListStoreNew(glib.TYPE_INT, glib.TYPE_STRING,
		glib.TYPE_STRING, glib.TYPE_STRING)

	tv, err := gtk.TreeViewNewWithModel(ls)
	tv.AppendColumn(createTreeViewColumn("input file", COLUMN_INPUT))
	tv.AppendColumn(createTreeViewColumn("output file", COLUMN_OUTPUT))
	tv.AppendColumn(createTreeViewColumn("status", COLUMN_STATUS))
	box.Add(tv)

	var destInData = func(lbi *gtk.Window,
		context *gdk.DragContext,
		x, y int,
		data_ptr *gtk.SelectionData,
		info, time uint) {

		s := string(data_ptr.GetData())
		fmt.Println(s)
		lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")

		for _, line := range lines {
			fileUrl, _ := url.Parse(line)
			if line == "" || fileUrl == nil {
				continue
			}

			m := Mastering{}
			m.Status = MasteringStatusWaiting
			m.Id = masteringId
			masteringId += 1
			m.Ffmpeg = "ffmpeg"
			m.PhaselimiterPath = filepath.Join(getExecDir(), "phaselimiter/bin/phase_limiter")
			m.SoundQuality2Cache = filepath.Join(getExecDir(), "phaselimiter/resource/sound_quality2_cache")

			m.Input = fileUrl.Path
			if runtime.GOOS == "windows" {
				r := regexp.MustCompile("^/([a-zA-Z]:/)")
				m.Input = r.ReplaceAllString(m.Input, "$1")
			}
			outputDir, _ := entry.GetText()
			m.Output = filepath.Base(m.Input)
			m.Output = strings.TrimSuffix(m.Output, filepath.Ext(m.Output))
			m.Output += "_output.wav"
			m.Output = filepath.Join(outputDir, m.Output)

			m.Loudness = loudness.GetValue()
			m.Level = masteringLevel.GetValue()
			m.BassPreservation = bassPreservation.GetActive()

			m.Ceiling = ceiling.GetValue()
			oversampleVal, _ := strconv.Atoi(oversample.GetActiveText())
			if oversampleVal < 1 {
				oversampleVal = 1
			}
			m.LimiterOversample = oversampleVal
			m.LimiterMaxIter = int(limiterQuality.GetValue())
			m.PreCompression = preComp.GetActive()
			m.PreCompressionThreshold = preCompThreshold.GetValue()
			m.PreCompressionMeanSec = preCompWindow.GetValue()

			masteringRunner.Add(m)

			iter := ls.Insert(0)
			updateListItem(ls, iter, m)
		}
	}
	win.Connect("drag-data-received", destInData)

	go func() {
		for {
			m := <-masteringRunner.MasteringUpdate
			fmt.Printf("%#v\n", m)

			glib.IdleAdd(func() {
				iter, _ := ls.GetIterFirst()
				if iter == nil {
					return
				}
				for {
					v, _ := ls.GetValue(iter, COLUMN_ID)
					id, _ := v.GoValue()
					if m.Id == id {
						updateListItem(ls, iter, m)
					}
					if ls.IterNext(iter) == false {
						break
					}
				}
			})
		}
	}()

	win.ShowAll()
	gtk.Main()
}
