package main

import (
	"fmt"
	"github.com/gotk3/gotk3/gdk"
	"github.com/gotk3/gotk3/glib"
	"github.com/gotk3/gotk3/gtk"
	"log"
	"net/url"
	"os"
	"os/exec"
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

// findFfmpeg returns an absolute path to ffmpeg. It checks beside the exe first
// (the expected install layout), then falls back to the system PATH. Using an
// absolute path avoids Go 1.19+'s refusal to run executables found in "."
// (exec: "ffmpeg": cannot run executable found relative to current directory).
func findFfmpeg() string {
	beside := filepath.Join(getExecDir(), "ffmpeg")
	if runtime.GOOS == "windows" {
		beside += ".exe"
	}
	if _, err := os.Stat(beside); err == nil {
		return beside
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return "ffmpeg"
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

	ffmpegPath := findFfmpeg()
	analyzer := NewAnalyzer(getExecDir(), ffmpegPath)

	// GTK on Windows requires GSettings schemas; point GLib to the bundled copy
	// (placed at share/glib-2.0/schemas/gschemas.compiled by the CI workflow).
	os.Setenv("GSETTINGS_SCHEMA_DIR",
		filepath.Join(getExecDir(), "share", "glib-2.0", "schemas"))
	gtk.Init(nil)

	win, err := gtk.WindowNew(gtk.WINDOW_TOPLEVEL)
	if err != nil {
		log.Fatal("Unable to create window:", err)
	}
	win.SetTitle("phaselimiter-gui")
	win.SetDefaultSize(720, 600)
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
	scroll, _ := gtk.ScrolledWindowNew(nil, nil)
	scroll.SetPolicy(gtk.POLICY_NEVER, gtk.POLICY_AUTOMATIC)
	scroll.Add(box)
	win.Add(scroll)

	entryLabel, err := gtk.LabelNew("Output directory")
	box.Add(entryLabel)
	entry, err := gtk.EntryNew()
	entry.SetText(getDefaultOutputDir())
	box.Add(entry)

	loudnessLabel, err := gtk.LabelNew("Target loudness (LUFS, −20 … 0, default −9)")
	box.Add(loudnessLabel)
	loudness, err := gtk.SpinButtonNewWithRange(-20, 0.0, 0.01)
	loudness.SetValue(-9)
	box.Add(loudness)

	masteringLevelLabel, err := gtk.LabelNew("Mastering intensity (0.0 … 1.0, default 1.0)")
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

	limiterOnly, err := gtk.CheckButtonNewWithLabel("Limiter only (diagnostic — bypass auto-mastering)")
	advBox.Add(limiterOnly)

	ceilingLabel, err := gtk.LabelNew("True-peak ceiling (dB, −3 … 0, default −1) — lower reduces clicks")
	advBox.Add(ceilingLabel)
	ceiling, err := gtk.SpinButtonNewWithRange(-3.0, 0.0, 0.1)
	ceiling.SetValue(-1.0)
	advBox.Add(ceiling)

	oversampleLabel, err := gtk.LabelNew("Limiter oversampling (×, default 1) — higher reduces crunch")
	advBox.Add(oversampleLabel)
	oversample, err := gtk.ComboBoxTextNew()
	oversample.AppendText("1")
	oversample.AppendText("2")
	oversample.AppendText("4")
	oversample.SetActive(0)
	advBox.Add(oversample)

	limiterQualityLabel, err := gtk.LabelNew("Limiter quality (iterations, 100 … 400, default 100) — higher = cleaner, slower")
	advBox.Add(limiterQualityLabel)
	limiterQuality, err := gtk.SpinButtonNewWithRange(100, 400, 50)
	limiterQuality.SetValue(100)
	advBox.Add(limiterQuality)

	preComp, err := gtk.CheckButtonNewWithLabel("Pre-compression (uncheck to remove pumping)")
	preComp.SetActive(true)
	advBox.Add(preComp)

	preCompThresholdLabel, err := gtk.LabelNew("Pre-comp threshold (dB, 0 … 18, default 6) — higher = more dynamics")
	advBox.Add(preCompThresholdLabel)
	preCompThreshold, err := gtk.SpinButtonNewWithRange(0, 18, 0.5)
	preCompThreshold.SetValue(6)
	advBox.Add(preCompThreshold)

	preCompWindowLabel, err := gtk.LabelNew("Pre-comp window (s, 0.05 … 1.0, default 0.2) — longer = less pumping")
	advBox.Add(preCompWindowLabel)
	preCompWindow, err := gtk.SpinButtonNewWithRange(0.05, 1.0, 0.05)
	preCompWindow.SetValue(0.2)
	advBox.Add(preCompWindow)

	// Reference-tone EQ: tilt the AI's target tonal curve (mid_mean) per band group.
	eqExpander, err := gtk.ExpanderNew("Reference tone (EQ) — tilt the AI target (±6 dB)")
	box.Add(eqExpander)
	eqBox, err := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 0)
	eqExpander.Add(eqBox)
	eqLowLabel, err := gtk.LabelNew("Low (<250 Hz)  dB  (±6, default 0)")
	eqBox.Add(eqLowLabel)
	eqLow, err := gtk.SpinButtonNewWithRange(-6, 6, 0.5)
	eqLow.SetValue(0)
	eqBox.Add(eqLow)
	eqLowMidLabel, err := gtk.LabelNew("Low-mid (250–2000 Hz)  dB  (±6, default 0)")
	eqBox.Add(eqLowMidLabel)
	eqLowMid, err := gtk.SpinButtonNewWithRange(-6, 6, 0.5)
	eqLowMid.SetValue(0)
	eqBox.Add(eqLowMid)
	eqHighMidLabel, err := gtk.LabelNew("High-mid (2000–6000 Hz)  dB  (±6, default 0)")
	eqBox.Add(eqHighMidLabel)
	eqHighMid, err := gtk.SpinButtonNewWithRange(-6, 6, 0.5)
	eqHighMid.SetValue(0)
	eqBox.Add(eqHighMid)
	eqHighLabel, err := gtk.LabelNew("High (>6000 Hz)  dB  (±6, default 0)")
	eqBox.Add(eqHighLabel)
	eqHigh, err := gtk.SpinButtonNewWithRange(-6, 6, 0.5)
	eqHigh.SetValue(0)
	eqBox.Add(eqHigh)

	// Section display: declared early so the analyzeBtn callback can populate them.
	var detectedSections []Section
	secListStore, _ := gtk.ListStoreNew(glib.TYPE_STRING, glib.TYPE_STRING, glib.TYPE_STRING, glib.TYPE_STRING)
	secExpander, _ := gtk.ExpanderNew("Detected quiet sections (analyze first)")
	secBox, _ := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 0)
	secExpander.Add(secBox)

	addSectionRow := func(s Section) {
		iter := secListStore.Append()
		secListStore.Set(iter, []int{0, 1, 2, 3}, []interface{}{
			fmt.Sprintf("%.1f", s.StartSec),
			fmt.Sprintf("%.1f", s.EndSec),
			fmt.Sprintf("%.1f", s.DurationSec()),
			fmt.Sprintf("%.0f LU", s.GapDB),
		})
	}

	// Feature 3: analyze a track and fill all controls with gentle, glitch-avoiding
	// settings derived from its loudness range, true peak and spectral balance.
	analyzeBtn, err := gtk.ButtonNewWithLabel("Analyze a track & suggest settings")
	box.Add(analyzeBtn)
	analyzeBtnLabel := "Analyze a track & suggest settings"
	analyzeBtn.Connect("clicked", func() {
		chooser, err := gtk.FileChooserDialogNewWith2Buttons(
			"Choose a track to analyze", win, gtk.FILE_CHOOSER_ACTION_OPEN,
			"Cancel", gtk.RESPONSE_CANCEL, "Analyze", gtk.RESPONSE_ACCEPT)
		if err != nil {
			return
		}
		filename := ""
		if chooser.Run() == gtk.RESPONSE_ACCEPT {
			filename = chooser.GetFilename()
		}
		chooser.Destroy()
		if filename == "" {
			return
		}

		analyzeBtn.SetSensitive(false)
		analyzeBtn.SetLabel("Analyzing…")
		go func() {
			a, analyzeErr := analyzer.Analyze(filename)
			glib.IdleAdd(func() {
				analyzeBtn.SetSensitive(true)
				analyzeBtn.SetLabel(analyzeBtnLabel)
				if analyzeErr != nil {
					showInfoDialog(win, "Analysis failed",
						"Could not analyze the track:\n"+analyzeErr.Error())
					return
				}
				s := suggestSettings(a)
				loudness.SetValue(s.Loudness)
				masteringLevel.SetValue(s.Level)
				bassPreservation.SetActive(s.BassPreservation)
				ceiling.SetValue(s.Ceiling)
				oversample.SetActive(oversampleIndex(s.LimiterOversample))
				limiterQuality.SetValue(float64(s.LimiterMaxIter))
				preComp.SetActive(s.PreCompression)
				preCompThreshold.SetValue(s.PreCompressionThreshold)
				preCompWindow.SetValue(s.PreCompressionMeanSec)
				// Populate section table from the loudness curve.
				secs := detectQuietSections(a.LoudnessTimeSeries, DefaultSectionDetectOptions())
				detectedSections = secs
				secListStore.Clear()
				for _, sec := range secs {
					addSectionRow(sec)
				}
				if len(secs) > 0 {
					secExpander.SetLabel(fmt.Sprintf("Detected quiet sections (%d found)", len(secs)))
					secExpander.SetExpanded(true)
				} else {
					secExpander.SetLabel("Detected quiet sections (none found)")
				}
				showInfoDialog(win, "Suggested settings applied", formatSuggestionMessage(a, s))
			})
		}()
	})

	// Build section expander content and add it after the Analyze button.
	secTV, _ := gtk.TreeViewNewWithModel(secListStore)
	secTV.AppendColumn(createTreeViewColumn("Start (s)", 0))
	secTV.AppendColumn(createTreeViewColumn("End (s)", 1))
	secTV.AppendColumn(createTreeViewColumn("Duration (s)", 2))
	secTV.AppendColumn(createTreeViewColumn("Gap below loud", 3))
	secBox.Add(secTV)

	secBtnRow, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 4)
	secBox.Add(secBtnRow)

	addSecBtn, _ := gtk.ButtonNewWithLabel("+ Add")
	secBtnRow.Add(addSecBtn)
	addSecBtn.Connect("clicked", func() {
		dlg, _ := gtk.DialogNew()
		dlg.SetTitle("Add section")
		dlg.SetTransientFor(win)
		dlg.SetModal(true)
		dlg.AddButton("Cancel", gtk.RESPONSE_CANCEL)
		dlg.AddButton("Add", gtk.RESPONSE_ACCEPT)
		content, _ := dlg.GetContentArea()
		grid, _ := gtk.GridNew()
		grid.SetColumnSpacing(8)
		grid.SetRowSpacing(4)
		grid.SetMarginTop(8)
		grid.SetMarginBottom(8)
		grid.SetMarginStart(8)
		grid.SetMarginEnd(8)
		sLbl, _ := gtk.LabelNew("Start (s):")
		grid.Attach(sLbl, 0, 0, 1, 1)
		sSpin, _ := gtk.SpinButtonNewWithRange(0, 9999, 1)
		grid.Attach(sSpin, 1, 0, 1, 1)
		eLbl, _ := gtk.LabelNew("End (s):")
		grid.Attach(eLbl, 0, 1, 1, 1)
		eSpin, _ := gtk.SpinButtonNewWithRange(0, 9999, 1)
		eSpin.SetValue(30)
		grid.Attach(eSpin, 1, 1, 1, 1)
		content.Add(grid)
		dlg.ShowAll()
		if dlg.Run() == gtk.RESPONSE_ACCEPT {
			start := sSpin.GetValue()
			end := eSpin.GetValue()
			if end > start {
				sec := Section{StartSec: start, EndSec: end}
				detectedSections = append(detectedSections, sec)
				addSectionRow(sec)
			}
		}
		dlg.Destroy()
	})

	editSecBtn, _ := gtk.ButtonNewWithLabel("Edit")
	secBtnRow.Add(editSecBtn)

	openEditDialog := func() {
		sel, err := secTV.GetSelection()
		if err != nil {
			return
		}
		_, iter, ok := sel.GetSelected()
		if !ok {
			return
		}
		path, err := secListStore.GetPath(iter)
		if err != nil {
			return
		}
		indices := path.GetIndices()
		if len(indices) == 0 {
			return
		}
		idx := indices[0]
		if idx < 0 || idx >= len(detectedSections) {
			return
		}
		existing := detectedSections[idx]

		dlg, _ := gtk.DialogNew()
		dlg.SetTitle("Edit section")
		dlg.SetTransientFor(win)
		dlg.SetModal(true)
		dlg.AddButton("Cancel", gtk.RESPONSE_CANCEL)
		dlg.AddButton("Save", gtk.RESPONSE_ACCEPT)
		content, _ := dlg.GetContentArea()
		grid, _ := gtk.GridNew()
		grid.SetColumnSpacing(8)
		grid.SetRowSpacing(4)
		grid.SetMarginTop(8)
		grid.SetMarginBottom(8)
		grid.SetMarginStart(8)
		grid.SetMarginEnd(8)
		sLbl, _ := gtk.LabelNew("Start (s):")
		grid.Attach(sLbl, 0, 0, 1, 1)
		sSpin, _ := gtk.SpinButtonNewWithRange(0, 9999, 1)
		sSpin.SetValue(existing.StartSec)
		grid.Attach(sSpin, 1, 0, 1, 1)
		eLbl, _ := gtk.LabelNew("End (s):")
		grid.Attach(eLbl, 0, 1, 1, 1)
		eSpin, _ := gtk.SpinButtonNewWithRange(0, 9999, 1)
		eSpin.SetValue(existing.EndSec)
		grid.Attach(eSpin, 1, 1, 1, 1)
		content.Add(grid)
		dlg.ShowAll()
		if dlg.Run() == gtk.RESPONSE_ACCEPT {
			start := sSpin.GetValue()
			end := eSpin.GetValue()
			if end > start {
				detectedSections[idx].StartSec = start
				detectedSections[idx].EndSec = end
				updated := detectedSections[idx]
				secListStore.Set(iter, []int{0, 1, 2, 3}, []interface{}{
					fmt.Sprintf("%.1f", updated.StartSec),
					fmt.Sprintf("%.1f", updated.EndSec),
					fmt.Sprintf("%.1f", updated.DurationSec()),
					fmt.Sprintf("%.0f LU", updated.GapDB),
				})
			}
		}
		dlg.Destroy()
	}
	editSecBtn.Connect("clicked", func() { openEditDialog() })
	secTV.Connect("row-activated", func() { openEditDialog() })

	removeSecBtn, _ := gtk.ButtonNewWithLabel("Remove")
	secBtnRow.Add(removeSecBtn)
	removeSecBtn.Connect("clicked", func() {
		sel, err := secTV.GetSelection()
		if err != nil {
			return
		}
		_, iter, ok := sel.GetSelected()
		if !ok {
			return
		}
		path, err := secListStore.GetPath(iter)
		if err != nil {
			return
		}
		indices := path.GetIndices()
		if len(indices) > 0 {
			idx := indices[0]
			if idx >= 0 && idx < len(detectedSections) {
				detectedSections = append(detectedSections[:idx], detectedSections[idx+1:]...)
			}
		}
		secListStore.Remove(iter)
	})

	secIntensityLabel, _ := gtk.LabelNew("Section intensity (0 … 1, default 0.25) — gentler level for rescued sections")
	secBox.Add(secIntensityLabel)
	secIntensity, _ := gtk.SpinButtonNewWithRange(0, 1, 0.05)
	secIntensity.SetValue(0.25)
	secBox.Add(secIntensity)

	secMasteringCheck, _ := gtk.CheckButtonNewWithLabel("Section-aware mastering (re-render quiet sections gently)")
	secBox.Add(secMasteringCheck)

	box.Add(secExpander)

	notes, err := gtk.LabelNew(`Drop audio files.

Process
1. The input audio files are mastered
2. The output files are saved to output directory

Notes
- Same algorithm with bakuage.com/aimastering.com
- No internet access
- Double-click a finished row for a before/after report`)
	box.Add(notes)

	ls, err := gtk.ListStoreNew(glib.TYPE_INT, glib.TYPE_STRING,
		glib.TYPE_STRING, glib.TYPE_STRING)

	tv, err := gtk.TreeViewNewWithModel(ls)
	tv.AppendColumn(createTreeViewColumn("input file", COLUMN_INPUT))
	tv.AppendColumn(createTreeViewColumn("output file", COLUMN_OUTPUT))
	tv.AppendColumn(createTreeViewColumn("status", COLUMN_STATUS))
	box.Add(tv)

	// Features 2/4b: double-click a finished row to open a before/after report
	// (scorecard + spectrogram/spectrum/stereo images + detected quiet sections).
	tv.Connect("row-activated", func() {
		sel, err := tv.GetSelection()
		if err != nil {
			return
		}
		_, iter, ok := sel.GetSelected()
		if !ok {
			return
		}
		getStr := func(col int) string {
			v, err := ls.GetValue(iter, col)
			if err != nil {
				return ""
			}
			gv, err := v.GoValue()
			if err != nil {
				return ""
			}
			s, _ := gv.(string)
			return s
		}
		if getStr(COLUMN_STATUS) != string(MasteringStatusSucceeded) {
			showInfoDialog(win, "Report not ready",
				"Open the before/after report after mastering finishes (status: succeeded).")
			return
		}
		inputPath := getStr(COLUMN_INPUT)
		outputPath := getStr(COLUMN_OUTPUT)
		go func() {
			tmpIn, _ := os.MkdirTemp("", "pl_report_in_*")
			tmpOut, _ := os.MkdirTemp("", "pl_report_out_*")
			aIn, imgIn, e1 := analyzer.AnalyzeWithImages(inputPath, tmpIn)
			aOut, imgOut, e2 := analyzer.AnalyzeWithImages(outputPath, tmpOut)
			glib.IdleAdd(func() {
				defer os.RemoveAll(tmpIn)
				defer os.RemoveAll(tmpOut)
				if e1 != nil {
					showInfoDialog(win, "Report failed", "Input analysis failed:\n"+e1.Error())
					return
				}
				if e2 != nil {
					showInfoDialog(win, "Report failed", "Output analysis failed:\n"+e2.Error())
					return
				}
				secs := detectQuietSections(aIn.LoudnessTimeSeries, DefaultSectionDetectOptions())
				showReportDialog(win, aIn, aOut, imgIn, imgOut, secs)
			})
		}()
	})

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
			m.Ffmpeg = ffmpegPath
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

			m.LimiterOnly = limiterOnly.GetActive()
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

			m.ReferenceBasePath = filepath.Join(getExecDir(), "phaselimiter/resource/mastering_reference.json")
			m.ReferenceEQ = ReferenceEQ{
				LowDB:     eqLow.GetValue(),
				LowMidDB:  eqLowMid.GetValue(),
				HighMidDB: eqHighMid.GetValue(),
				HighDB:    eqHigh.GetValue(),
			}
			m.SectionMasteringEnable = secMasteringCheck.GetActive()
			m.Sections = append([]Section(nil), detectedSections...) // copy slice
			m.SectionIntensity = secIntensity.GetValue()

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
