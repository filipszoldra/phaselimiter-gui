# Feature proposal: "Master to match a reference track" (Reference Matching)

> Status: **proposed, feasibility confirmed in source.** No C++ engine recompile.
> Gating dependency: the `audio_analyzer` binary must ship beside `phase_limiter`
> (it is a first-class CMake target — CMakeLists.txt:278 — so it should be in releases).

## The idea
Drop a reference song whose sound you love; the engine masters **your** track to match
its tonal + stereo balance, instead of matching the generic built-in learned target.
This is the headline feature of premium tools (iZotope Ozone Match, LANDR reference).

## Why it fits the engine's core
mastering5's entire job is matching your track's per-band mid/side statistics to a
reference distribution via differential-evolution optimization. By default the reference
is the built-in learned model (`sound_quality2_cache`). The engine **already** supports
overriding it per run with `--mastering5_mastering_reference_file`
(auto_mastering5.cpp:125-129; when set, `main_eval = CalculateDistance(mastering_reference,
target)` at auto_mastering5.cpp:373-378). So "match this track" = produce that reference
file from the dropped song.

## Feasibility chain (all existing binaries)
1. Decode reference track → WAV via ffmpeg (already bundled; analyzer only accepts WAV —
   single_mode.h:122-129).
2. Run `audio_analyzer --input ref.wav --sound_quality2 false` → stdout JSON containing
   `bands` (mid_mean/side_mean/low_freq/high_freq) + `covariance`
   (single_mode.h:590-628) — exactly the format `ParseReference` reads
   (sound_quality2.h:139-189). `--sound_quality2 false` avoids needing the cache, since we
   only need bands+covariance (computed unconditionally).
3. Pass that JSON to `phase_limiter` as `--mastering5_mastering_reference_file`. Done.

## Gating dependency (the one real risk)
The GUI bundle currently references only `phaselimiter/bin/phase_limiter`. This feature
also needs `phaselimiter/bin/audio_analyzer(.exe)`.
- It is built as a standard target (CMakeLists.txt:278), so it is very likely in the
  engine release zip already — **verify in the user's install.**
- If missing: instruct the user to drop in that one extra .exe from a phaselimiter
  release; GUI shows a clear "analyzer not found" message and falls back to normal mode.

## Synergy with section-mastering plan
A chosen reference track gives a better-suited target than the generic model for songs with
unusual dynamics (helps the quiet-section distortion in `section-mastering-plan.md`), and
the same reference JSON can serve as the **shared reference** in that plan's Phase 2. The
two features compose.

## GUI / UX
- Add a "Reference track" file picker (or a second drop zone).
- On master, if a reference is set: analyze it once, **cache the JSON keyed by file
  hash/path+mtime** to skip re-analysis, then add `--mastering5_mastering_reference_file`.
- Optional later: a small library of saved reference profiles ("my targets").
- Wiring follows the existing pattern: new `Mastering` fields + flag append in
  `mastering.go`; analysis is one extra `exec.Command(audioAnalyzerPath, ...)` before the
  limiter run.

## Risks
- Analyzer binary availability (above) — the real gate.
- Reference should be a finished/mastered song (matching a rough mix → rough target).
- Adds a few seconds for analysis (one-time per reference; cache it).

## Effort
Small-to-medium (file picker + one extra child process + JSON cache + flag wiring) — much
smaller than section-mastering, high perceived value, and a natural showcase of the engine's
reference-matching core.

## References (engine source)
- Analyzer entry / modes: `../phaselimiter/src/audio_analyzer/main.cpp`
- Analysis JSON (bands + covariance) output: `../phaselimiter/src/audio_analyzer/single_mode.h:590-628`
- Reference JSON parser (consumer side): `../phaselimiter/deps/bakuage/include/bakuage/sound_quality2.h:139-189`
- mastering5 external-reference path: `../phaselimiter/src/phase_limiter/auto_mastering5.cpp:125,373-378`
- Build targets (analyzer ships with limiter): `../phaselimiter/CMakeLists.txt:278,298`
