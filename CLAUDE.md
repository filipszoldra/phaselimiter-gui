# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is (and is not)

`phaselimiter-gui` is a thin **Go + WebView2** desktop frontend. It does **no audio processing**.
It builds a command line and runs the real mastering engine, `phase_limiter`, as a child
process, then scrapes `progression: <float>` lines from the child's stdout to drive a progress bar.

The actual DSP engine is a **separate C++ project**, `phaselimiter`, included in this workspace
as a sibling directory (`../phaselimiter`). Any change to *how the music is processed* lives
there or in its runtime data files — not in this repo.

## Architecture

The UI is an embedded **web frontend** (HTML/CSS/JS in `web/`) rendered by the Microsoft Edge
**WebView2** runtime. Go is a thin native host: it serves `web/` over loopback HTTP, exposes a
handful of bound functions, and runs the engine. This is a **pure-Go, CGO-free** project
(no GTK, no mingw) — the old gotk3 GUI is gone.

- `main_windows.go` — entry point (Windows). Serves the embedded `web/` FS over `127.0.0.1`,
  creates the WebView2 window, and `Bind`s the JS bridge functions (`plPickInputFiles`,
  `plPickOutputDir`, `plDefaultOutputDir`, `plStartMastering`, `plAnalyze`, `plAnalyzeFull`,
  `plGetReference`). Pushes job updates to the page via `window.plOnJobUpdate`.
- `main_other.go` — non-Windows stub so the module still compiles cross-platform.
- `bridge.go` — the `App` type and the bound-function implementations (file pickers, start
  mastering, analyze, get reference profile) + `serveLocalFile` (`/local?path=` serves analysis
  PNGs to the page).
- `mastering.go` — `MasteringRunner` pulls `Mastering` jobs off a channel and runs them serially.
  `buildEngineArgs()` assembles the `phase_limiter` argument list and `execute()` runs it and
  scans stdout for `progression:`. **This is the single place that controls what the engine is
  told to do.** The `Mastering`/`JobSettings` structs carry every setting from the UI.
- `analyzer.go` — runs `audio_analyzer` (per-band spectrum, LUFS, true-peak, LRA, dynamics) and
  `ffmpeg` (decode to temp WAV, loudness-over-time, spectrogram PNG). `AnalyzeWithImages` produces
  the spectrogram served to the drawer / comparison panel.
- `sections.go` — quiet-section detection from the loudness-over-time curve.
- `suggest.go` — "Analyze & suggest": derives glitch-avoiding settings from the analysis.
- `filedialog.go` — native open/folder dialogs (via `zenity`).
- `web/` — the entire UI: `index.html`, `app.js` (state, SVG charts, bridge calls, mock fallback),
  `app.css`. `web/server.js` is a tiny dev server to open the UI in a plain browser (the bridge
  falls back to mocks when the `pl*` bindings are absent — lets you test layout/interactions
  without Go or the engine).
- `cmd_hide_window_windows.go` / `cmd_hide_window.go` — build-tagged; hide the child engine
  console on Windows, no-op elsewhere.

The engine binary is expected at `phaselimiter/bin/phase_limiter` relative to the GUI executable
(see `mastering.go`), with reference data under `phaselimiter/resource/`. The binary is NOT in
either repo's source tree — it ships prebuilt from the `phaselimiter` fork's CI.

### Flags the GUI passes to the engine (assembled in `mastering.go` `buildEngineArgs`)

`--mastering true --mastering_mode mastering5` (or `--mastering false` for Limiter-only diag),
intensity → `--mastering5_mastering_level`, stereo-field match → `--mastering_ms_matching_level`,
`--erb_eval_func_weighting` (Preserve bass), `--reference` (Target loudness, LUFS), `--ceiling`,
`--limiter_internal_oversample`, `--max_iter1`,
`--pre_compression` / `--pre_compression_threshold` / `--pre_compression_mean_sec`, and the
fork-added EQ / section flags (only sent when non-neutral):

- `--mastering5_eq_band_levels` — CSV of 9 optimizer upper-bound multipliers (per-band optimizer).
- `--mastering5_eq_transform_levels` (+ `--mastering5_eq_transform_symmetric`) — CSV of 9
  post-optimization realized wet-gain multipliers.
- `--eq_analysis_target` — CSV of 9 per-band dB modifications (the analysis "EQ correction").
  Engine applies `clamp((delta - normalized_change) * mastering_level, -6, +6)` as static gain
  after AutoMastering5, before pre-compression.
- `--mastering5_section_ranges` + `--mastering5_section_intensity` — section-aware wet/dry blend.

The engine exposes many more flags the GUI does not pass — all defined as `DEFINE_*` in
`../phaselimiter/src/phase_limiter/main.cpp`.

### Engine control surface (flag → stage → audible effect)

Use this to tune output WITHOUT recompiling the engine (just change the args in `mastering.go`).
Pipeline stages are in `../phaselimiter/src/phase_limiter/main.cpp` `MainFunc()`.

- **Loudness target — biggest lever.** `--reference` (LUFS; GUI default **-14**).
  Lower (-12/-14) → less gain into the limiter → less crunch/pumping/smearing and fewer true-peak
  clicks. `--reference_mode` = loudness/youtube_loudness/rms/peak/zero.
- **AutoMastering5 (tone/dynamics match; `auto_mastering5.cpp`).** Per-band mid/side compressor
  whose params are found by differential-evolution optimization to match a learned reference.
  `--mastering5_mastering_level` (0–1, GUI "intensity", default **0.4**) = how hard it reshapes;
  lower = gentler. `--mastering_ms_matching_level` (0–1) = stereo match strength. Target profile =
  runtime JSON `../phaselimiter/resource/mastering_reference.json` (editable, no recompile).
- **EQ correction (`eq_analysis_target`).** Static per-band gain after AutoMastering5; scaled by
  intensity and clamped to ±6 dB inside the engine. The GUI sends the user's per-band dB
  modification directly.
- **Section-aware blend (`mastering5_section_ranges`/`_section_intensity`).** Single-pass wet/dry
  blend toward the dry signal inside marked ranges, with a 1 s raised-cosine ramp at boundaries
  (`auto_mastering5.cpp`). Replaced the old re-render + splice approach.
- **Pre-compression (`pre_compression.cpp`).** `--pre_compression` (toggle),
  `--pre_compression_threshold` (default +6 dB over loudness), `--pre_compression_mean_sec`
  (default 0.2 s; longer = smoother, less pumping).
- **Phase limiter (`GradCalculator.h`, the crunch source).** `--max_iter1` (100; more = fewer
  audible limiting errors, slower); `--limiter_internal_oversample` (oversampling = fewer aliasing
  artifacts, more CPU/RAM); `--erb_eval_func_weighting` (perceptual weighting).
- **Ceiling / encode (clicks).** `--ceiling` (set ~-1.0 dB for true-peak headroom).

**Decision gate:** exhaust flags + reference JSON before considering an engine recompile (blocked
by proprietary Intel IPP, heavy deps, and the maintainer's Docker build image).

## Build & run

There is no local build toolchain configured on this machine (no `go`, `ffmpeg`, or `docker` on
PATH). Builds happen in CI. The web frontend, however, can be opened in any browser via
`node web/server.js` (mock bridge) to iterate on UI without a build.

- CI (`.github/workflows/build-win.yml`) runs on **ubuntu-latest** and cross-builds the Windows
  exe with **`CGO_ENABLED=0 GOOS=windows GOARCH=amd64`** — no mingw, GTK, or Node needed.
  It produces `phaselimiter-gui.exe` (windowed, `-ldflags "-H windowsgui"`) and
  `phaselimiter-gui-console.exe` (logs engine stdout), uploaded as artifact `build-results`.
- Runtime deps (Windows): **Microsoft Edge WebView2 Runtime** (ships with current Windows 10/11),
  MSVC Redistributable (for the engine), `ffmpeg.exe` on PATH or beside the exe, and the prebuilt
  `phaselimiter/` engine directory beside the exe.

## The engine (../phaselimiter), in brief

C++ with Intel **IPP** + **TBB**, Eigen/Armadillo/BLAS/LAPACK, libsndfile, gflags, 9 git submodules.
Pipeline in `src/phase_limiter/main.cpp` `MainFunc()`: decode→band-cut→AutoMastering5
(reference-matching multiband EQ/stereo/parallel-compression via differential-evolution
optimization; the fork adds per-band EQ/transform limits, static EQ correction, and per-section
wet/dry blend)→pre-compression→gain-to-target-loudness→**phase limiter** (iterative FFT
optimization in `GradCalculator.h`)→true-peak ceiling→encode.

**Rebuilding the engine is the hard part**: it requires the proprietary Intel IPP library and the
maintainer's Docker build image; upstream is "inactive". Prefer changes that need no engine
recompile: GUI-passed flags (`mastering.go`) and the engine's runtime JSON
(`../phaselimiter/resource/mastering_reference.json`, `progression_mapping.json`).

## Branches

- `faza3-webview-ui` — the WebView2 rewrite + all current UI/feature work (the active branch).
- `master` — release branch; merge `faza3-webview-ui` into it for releases.

To add a new control: add the widget in `web/index.html` + wire it in `web/app.js`
(`collectSettings`), add the field to `JobSettings`/`Mastering` in `mastering.go`, and append the
`--flag` in `buildEngineArgs`.
