# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is (and is not)

`phaselimiter-gui` is a thin **Go + GTK3** desktop frontend. It does **no audio processing**.
It builds a command line and runs the real mastering engine, `phase_limiter`, as a child
process, then scrapes `progression: <float>` lines from the child's stdout to drive a progress bar.

The actual DSP engine is a **separate C++ project**, `phaselimiter`, included in this workspace
as a sibling directory (`../phaselimiter`). Any change to *how the music is processed* lives
there or in its runtime data files — not in this repo.

## Architecture

- `main.go` — GTK window, output-dir / target-loudness / intensity / preserve-bass controls,
  drag-and-drop handler. On file drop it builds a `Mastering` struct and enqueues it.
- `mastering.go` — `MasteringRunner` runs a goroutine that pulls `Mastering` jobs off a channel
  and runs them serially. `Mastering.execute()` is where the `phase_limiter` argument list is
  assembled (`exec.Command`) and stdout is scanned for progress. **This is the single place that
  controls what the engine is told to do.**
- `cmd_hide_window_windows.go` / `cmd_hide_window.go` — build-tagged; hide the child console on
  Windows, no-op elsewhere.

The engine binary is expected at `phaselimiter/bin/phase_limiter` relative to the GUI executable
(see `mastering.go`), with reference data under `phaselimiter/resource/sound_quality2_cache`.
The binary is NOT in either repo's source tree — it ships prebuilt from phaselimiter releases.

### Flags the GUI currently passes to the engine

`--mastering true --mastering_mode mastering5`, intensity wired to
`--mastering5_mastering_level`, stereo-field match to `--mastering_ms_matching_level`,
`--erb_eval_func_weighting` (Preserve bass), `--reference` (Target loudness, LUFS),
`--ceiling`, `--limiter_internal_oversample`, `--max_iter1`,
`--pre_compression` / `--pre_compression_threshold` / `--pre_compression_mean_sec`,
and (when any band ≠ 1.0) `--mastering5_eq_band_levels` (CSV of 9 per-band
optimizer upper-bound multipliers — see `EQBandLevels [9]float64` in `Mastering` struct).
The engine exposes many more flags the GUI does not pass — all defined as `DEFINE_*` in
`../phaselimiter/src/phase_limiter/main.cpp`.

### Engine control surface (flag → stage → audible effect)

Use this to tune output WITHOUT recompiling the engine (just change the args in `mastering.go`).
Pipeline stages are in `../phaselimiter/src/phase_limiter/main.cpp` `MainFunc()`.

- **Loudness target — biggest lever.** `--reference` (LUFS; GUI default **-9** = very loud).
  Lower (-12/-14) → less gain into the limiter → less crunch/pumping/smearing and fewer true-peak
  clicks. `--reference_mode` = loudness/youtube_loudness/rms/peak/zero.
- **AutoMastering5 (tone/dynamics match; `auto_mastering5.cpp`).** Per-band mid/side compressor
  whose params are found by differential-evolution optimization to match a learned reference.
  `--mastering5_mastering_level` (0–1, GUI "intensity") = how hard it reshapes; lower = gentler.
  `--mastering_matching_level` / `--mastering_ms_matching_level` (0–1) = loudness / stereo match
  strength. Target profile = runtime JSON `../phaselimiter/resource/mastering_reference.json`
  (editable, no recompile).
- **Pre-compression (`pre_compression.cpp`).** `--pre_compression` (toggle),
  `--pre_compression_threshold` (default +6 dB over loudness; raise for more dynamics),
  `--pre_compression_mean_sec` (default 0.2 s; longer = smoother, less pumping).
- **Phase limiter (`GradCalculator.h`, the crunch source).** `--limiting_mode phase|simple`;
  `--max_iter1`/`--max_iter2` (100/400; more = fewer audible limiting errors, slower);
  `--limiter_external_oversample`/`--limiter_internal_oversample` (oversampling = fewer aliasing
  artifacts, more CPU/RAM); `--noise_update_*`; `--erb_eval_func_weighting` (perceptual weighting).
- **Ceiling / encode (clicks).** `--ceiling` (default 0 dB → set ~-1.0 dB for true-peak headroom);
  `--ceiling_mode` peak/true_peak/lowpass_true_peak; `--true_peak_oversample` (default 4).

**Decision gate:** exhaust flags + reference JSON before considering an engine recompile (Path B —
blocked by proprietary Intel IPP, heavy deps, and the maintainer's Docker build image).

## Build & run

There is no local build toolchain configured on this machine (no `go`, `gcc`/mingw, `ffmpeg`,
or `docker` on PATH). Builds happen in CI.

- CI (`.github/workflows/build-win.yml`) cross-compiles a Windows .exe from a Fedora container:
  installs `mingw64-gtk3`, then
  `CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc GOOS=windows GOARCH=amd64 go build -ldflags -H=windowsgui`
  for the windowed build, plus a second `go build -o phaselimiter-gui-console.exe` for a
  console/debug build that logs to stdout.
- This is a **cgo** project (gotk3); it cannot be built without a C toolchain + GTK3 dev libs.
- Runtime deps (Windows): MSVC Redistributable, `ffmpeg.exe` on PATH or beside the exe, and the
  prebuilt `phaselimiter/` engine directory beside the exe.

## The engine (../phaselimiter), in brief

C++ with Intel **IPP** + **TBB**, Eigen/Armadillo/BLAS/LAPACK, libsndfile, gflags, and 9 git
submodules. Pipeline in `src/phase_limiter/main.cpp` `MainFunc()`: decode→band-cut→
AutoMastering5 (reference-matching multiband EQ/stereo/parallel-compression via differential-
evolution optimization)→pre-compression→gain-to-target-loudness→**phase limiter** (iterative
FFT optimization in `GradCalculator.h`, minimizes audible limiting error)→true-peak ceiling→encode.

**Rebuilding the engine is the hard part**: it requires the proprietary Intel IPP library and the
maintainer's Docker build image; the project is officially "inactive". Prefer changes that need no
engine recompile: GUI-passed flags (`mastering.go`) and the engine's runtime JSON
(`../phaselimiter/resource/mastering_reference.json`, `progression_mapping.json`).

## Context for current work: reducing glitches / "more elastic" output

The GUI defaults to **-9 LUFS** target with **intensity 1.0**, which drives the limiter very hard
and produces the typical over-limiting artifacts (crunch on peaks, pumping, true-peak clicks,
smearing). Lowering the loudness target and/or intensity, and exposing the engine's existing
pre-compression / limiter flags, are the low-risk levers — all editable in `mastering.go` /
`main.go` with no C++ rebuild.

To add a new GUI control: add the widget in `main.go` (`SpinButtonNewWithRange` /
`CheckButtonNewWithLabel`, added to `box`), add a field to the `Mastering` struct in
`mastering.go`, populate it in the `drag-data-received` handler in `main.go`, and append the
corresponding `--flag` to the `args` slice in `Mastering.execute()`.
