package main

import (
	"fmt"

	"github.com/gotk3/gotk3/gtk"
)

// showReportDialog presents a before/after comparison: a numeric scorecard
// (F4b), auto-detected quiet sections (F4a), and engine-rendered analysis images
// input vs output (F2A). Missing images are shown as "(not available)" so the
// scorecard still works if PNG rendering is unsupported on this build.
func showReportDialog(parent gtk.IWindow, in, out AudioAnalysis, imgsIn, imgsOut ImagePaths, sections []Section) {
	dialog, err := gtk.DialogNew()
	if err != nil {
		return
	}
	dialog.SetTitle("Before / after report")
	dialog.SetTransientFor(parent)
	dialog.SetModal(true)
	dialog.SetDefaultSize(760, 640)
	dialog.AddButton("Close", gtk.RESPONSE_CLOSE)

	content, err := dialog.GetContentArea()
	if err != nil {
		dialog.Destroy()
		return
	}

	scroll, _ := gtk.ScrolledWindowNew(nil, nil)
	scroll.SetVExpand(true)
	scroll.SetHExpand(true)
	content.Add(scroll)

	box, _ := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 8)
	box.SetMarginTop(8)
	box.SetMarginBottom(8)
	box.SetMarginStart(8)
	box.SetMarginEnd(8)
	scroll.Add(box)

	addBoldLabel(box, "Measurements (input → output)")
	box.Add(buildScorecardGrid(in, out))

	if len(sections) > 0 {
		addBoldLabel(box, fmt.Sprintf("Quiet sections detected (%d)", len(sections)))
		text := ""
		for _, s := range sections {
			text += "• " + s.String() + "\n"
		}
		text += "These sit well below the loud parts; a global master tends to over-process them."
		addLabel(box, text)
	}

	addImagePair(box, "Spectrogram", imgsIn.Spectrogram, imgsOut.Spectrogram)
	addImagePair(box, "Spectrum balance", imgsIn.SpectrumDistribution, imgsOut.SpectrumDistribution)
	addImagePair(box, "Stereo image", imgsIn.StereoDistribution, imgsOut.StereoDistribution)

	dialog.ShowAll()
	dialog.Run()
	dialog.Destroy()
}

// buildScorecardGrid lays out key metrics for input vs output with simple warnings.
func buildScorecardGrid(in, out AudioAnalysis) *gtk.Grid {
	grid, _ := gtk.GridNew()
	grid.SetColumnSpacing(16)
	grid.SetRowSpacing(2)

	row := 0
	header := func(cols ...string) {
		for c, text := range cols {
			lbl, _ := gtk.LabelNew("")
			lbl.SetMarkup("<b>" + text + "</b>")
			lbl.SetHAlign(gtk.ALIGN_START)
			grid.Attach(lbl, c, row, 1, 1)
		}
		row++
	}
	line := func(name, inVal, outVal, note string) {
		cells := []string{name, inVal, outVal, note}
		for c, text := range cells {
			lbl, _ := gtk.LabelNew(text)
			lbl.SetHAlign(gtk.ALIGN_START)
			grid.Attach(lbl, c, row, 1, 1)
		}
		row++
	}

	header("Metric", "Input", "Output", "")
	line("Loudness (LUFS)", fmt.Sprintf("%.1f", in.Loudness), fmt.Sprintf("%.1f", out.Loudness), "")
	lraNote := ""
	if in.LoudnessRange > 0 && out.LoudnessRange < 0.4*in.LoudnessRange {
		lraNote = "⚠ dynamics squashed"
	}
	line("Loudness range (LU)", fmt.Sprintf("%.1f", in.LoudnessRange), fmt.Sprintf("%.1f", out.LoudnessRange), lraNote)
	tpNote := ""
	if out.TruePeak > 0 {
		tpNote = "⚠ over 0 dBFS"
	}
	line("True peak (dBFS)", fmt.Sprintf("%.1f", in.TruePeak), fmt.Sprintf("%.1f", out.TruePeak), tpNote)
	line("Dynamics", fmt.Sprintf("%.1f", in.Dynamics), fmt.Sprintf("%.1f", out.Dynamics), "")
	line("Stereo (space)", fmt.Sprintf("%.1f", in.Space), fmt.Sprintf("%.1f", out.Space), "")
	line("Sound quality 2", fmt.Sprintf("%.2f", in.SoundQuality2), fmt.Sprintf("%.2f", out.SoundQuality2), "")

	return grid
}

func addImagePair(box *gtk.Box, title, inPath, outPath string) {
	addBoldLabel(box, title)
	row, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 8)
	row.Add(labeledImage("Input", inPath))
	row.Add(labeledImage("Output", outPath))
	box.Add(row)
}

func labeledImage(caption, path string) *gtk.Box {
	b, _ := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 2)
	capLbl, _ := gtk.LabelNew(caption)
	capLbl.SetHAlign(gtk.ALIGN_START)
	b.Add(capLbl)
	if path != "" {
		if img, err := gtk.ImageNewFromFile(path); err == nil {
			b.Add(img)
			return b
		}
	}
	na, _ := gtk.LabelNew("(not available)")
	b.Add(na)
	return b
}

func addBoldLabel(box *gtk.Box, text string) {
	lbl, _ := gtk.LabelNew("")
	lbl.SetMarkup("<b>" + text + "</b>")
	lbl.SetHAlign(gtk.ALIGN_START)
	box.Add(lbl)
}

func addLabel(box *gtk.Box, text string) {
	lbl, _ := gtk.LabelNew(text)
	lbl.SetHAlign(gtk.ALIGN_START)
	box.Add(lbl)
}
