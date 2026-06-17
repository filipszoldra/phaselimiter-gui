# phaselimiter-gui (filipszoldra fork)

A desktop GUI for **phaselimiter** — the same AI mastering algorithm used on
[bakuage.com](https://bakuage.com) / [aimastering.com](https://aimastering.com).
Processes locally, no internet required.

The UI is a modern web frontend (HTML/CSS/JS) rendered in a **WebView2** window; Go is a thin
native host that runs the C++ engine as a child process. No audio is processed in this repo.

## What this fork adds

This fork by **Filip Szołdra** extends the original upstream project
([ai-mastering/phaselimiter-gui](https://github.com/ai-mastering/phaselimiter-gui)) with a
redesigned UI and controls aimed at reducing mastering glitches ("crunch", pumping, true-peak
clicks, smearing) and giving fine-grained control over the AutoMastering5 engine.

Most features pass existing engine flags and need no engine recompile. A few required a fork and
rebuild of the C++ engine ([filipszoldra/phaselimiter](https://github.com/filipszoldra/phaselimiter))
to add new flags — see that repo's README.

| Feature | What it does |
|---|---|
| **Modern WebView2 UI** | Card-based layout, live SVG charts, help popovers, drag-and-drop, in-app before/after comparison |
| **Analysis EQ correction** | Drag a per-band curve (±12 dB) to shape the target; a dashed-red overlay + fill show the predicted result (your move × intensity, capped ±6 dB). Sent via `--eq_analysis_target` |
| **Per-band optimizer (advanced)** | 9-band curve (0–2, 1 = neutral) restraining how aggressively AutoMastering5 reshapes each band, with ceiling / transform modes (`--mastering5_eq_band_levels`, `--mastering5_eq_transform_levels`) |
| **Section-aware mastering** | Detects quiet sections and blends them toward the dry signal in a single engine pass with 1 s raised-cosine ramps (`--mastering5_section_ranges` / `--mastering5_section_intensity`) — no re-render/splice |
| **Glitch-reduction controls** | Limiter oversampling (1×/2×/4×), limiter quality (iterations), true-peak ceiling, pre-compression on/off + threshold + window |
| **Stereo match strength** | `--mastering_ms_matching_level`; lower reduces over-widening on sparse-stereo material |
| **Track analysis** | Per-band spectrum, LUFS / true-peak / LRA / dynamics, and a spectrogram with Time/Frequency axes |
| **Before/after comparison** | Per finished job: input vs output metrics, per-band dB change, loudness-over-time, and input/output spectrograms |
| **Analyze & suggest** | Measures a track and fills controls with glitch-avoiding values |
| **Diagnostic "Limiter only"** | Bypasses AutoMastering5 to isolate limiter vs reference-matching artifacts |

## Install (Windows)

### Option A — unified download (recommended)

1. Download **`phaselimiter-gui-win64.zip`** from the
   [latest release](https://github.com/filipszoldra/phaselimiter-gui/releases/latest).
   It bundles the GUI, the engine (`phaselimiter/`), and `ffmpeg.exe` — everything needed.
2. Unzip anywhere (e.g. `C:\phaselimiter-gui\`).
3. Run **`phaselimiter-gui.exe`** (or `phaselimiter-gui-console.exe` to see engine logs).

Prerequisites (both ship with current Windows 10/11; install only if missing):
- [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) — the UI renderer.
- [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) — for the engine.

### Option B — assemble from CI artifacts (advanced)

CI artifacts are split across two repos and require a GitHub login (they also expire). Use this
only if you want a bleeding-edge build:

1. Download the **GUI artifact** (`build-results`) from this repo's
   [Actions](https://github.com/filipszoldra/phaselimiter-gui/actions) → `build-win` → latest run.
2. Download the **engine artifact** (`engine-bin`) from
   [filipszoldra/phaselimiter](https://github.com/filipszoldra/phaselimiter/actions) → `build-engine` → latest run.
3. Add `ffmpeg.exe` ([ffmpeg.org](https://ffmpeg.org/)) beside the GUI exe (or on `%PATH%`).
4. Assemble the layout below (the `resource/` dir comes from an
   [upstream release](https://github.com/ai-mastering/phaselimiter/releases) — CI does not regenerate it).

Expected layout (same for both options):
```
phaselimiter-gui.exe
phaselimiter-gui-console.exe
ffmpeg.exe
phaselimiter/
  bin/
    phase_limiter.exe
    audio_analyzer.exe
    *.dll              (IPP, TBB, Boost, sndfile, ...)
  resource/
    sound_quality2_cache/
    mastering_reference.json
    ...
```

## How to use

1. **Drop audio files** on the window (or **+ Add files**). Analysis starts automatically and
   fills the per-band spectrum chart.
2. Set **Target loudness** (−9 to −14 LUFS) and **Intensity** (0.3–0.5 is a good start).
3. (Optional) **Enable EQ correction** and drag the pink curve per band; the dashed-red overlay
   shows the predicted applied change at the current intensity.
4. (Optional) **Section-aware mastering** to gentle-ify detected quiet sections.
5. (Optional) **Advanced: per-band optimizer** to restrain specific bands.
6. **Master**. When a job finishes, expand **Mastering comparison** for the input/output report.

See the controls reference for every control and the engine flag it maps to:
- [English controls reference](docs/controls-en.md)
- [Polski opis sterowania](docs/sterowanie-pl.md)

## Debug / console build

`phaselimiter-gui-console.exe` is identical to the windowed build but logs all engine output and
the flags being passed. Useful for verifying what the engine is told to do.

## Develop the UI without a build

The web frontend runs in any browser with a mock bridge (no Go, no engine):
```sh
node web/server.js   # serves the UI at http://localhost:7734
```
When the `pl*` bindings are absent the bridge returns mock data, so layout and interactions stay
testable.

## Build

Pure-Go, CGO-free — no mingw/GTK/Node toolchain. CI (`.github/workflows/build-win.yml`) builds on
ubuntu:
```sh
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui" -o phaselimiter-gui.exe
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o phaselimiter-gui-console.exe
```

## Runtime dependencies

- Microsoft Edge WebView2 Runtime (UI)
- Microsoft Visual C++ Redistributable (engine)
- `ffmpeg.exe` (on `%PATH%` or beside the exe)
- `phaselimiter/` engine directory with `bin/` and `resource/` (see Install)

## License

MIT — see [licenses/](licenses/) for third-party notices.

---

*Original project: [ai-mastering/phaselimiter-gui](https://github.com/ai-mastering/phaselimiter-gui) by ai-mastering.*
