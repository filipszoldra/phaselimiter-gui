# Plan: Section-aware mastering — "different vibe per section, one cohesive song"

> Status: **proposed, gated.** Do not build until the diagnostic confirms the cause
> (see Gate). All work is GUI/Go orchestration — **no C++ engine recompile**.

## Problem

Loud sections (chorus, solo) master almost fine, but quiet sections (intros,
pre-climax breaks) come out distorted. Root cause, confirmed in the engine source:
the pipeline is **global** — AutoMastering5 fits **one** multiband M/S compressor to
the **whole-song** statistics (dominated by the loud sections), and applies one global
gain. `Normalize()` is a single peak scalar ([main.cpp:161-168]), so the loud/quiet
**arc is preserved**, but the reference-matching is tuned to the loud-section average
and **over-processes sparse quiet material** (boosts near-empty bands → harshness).

## Gate (decide BEFORE building)

Use the **Limiter only** toggle + drop **intensity to 0.2–0.3**. If quiet-section
distortion largely disappears, the global lever already solves it and this feature is
unnecessary. Only build if the global fixes are insufficient.

## Core principle (avoids the two traps)

Naive "chop → master each piece → glue" fails twice: each engine run re-normalizes +
re-targets loudness (**flattens the arc**), and per-section settings create **seams**.
Instead:

> Keep **one global master** as the base (owns the loudness arc + overall tone). Use
> section processing only to **rescue** problem sections with gentler settings, then
> **loudness-match each rescue back into the global master at that spot** and
> **crossfade** the joins.

## Architecture (new `sections.go`, orchestrating `phase_limiter` + `ffmpeg`)

Engine capabilities relied on (all confirmed in source):
`--start_at` / `--end_at` (process a time range, main.cpp:459),
`--mastering5_mastering_reference_file` (external shared reference, auto_mastering5.cpp:125),
`--reference_mode`, `--ceiling`; ffmpeg for slice/measure/crossfade.

### Phase 1 — MVP "section rescue" (manual marks)
1. Produce the global master normally (current pipeline) = base + arc reference.
2. User marks problem sections: start/end + per-section overrides (intensity, ceiling,
   pre-comp, or limiter-only). Simple UI table or sidecar `.txt` (`start end intensity`).
3. Re-render each marked range with `--start_at/--end_at` + the section's gentler flags.
4. Measure loudness of the global-master region vs. the rescued render; apply one gain so
   the rescue **matches the master's level at that spot** (arc preserved).
5. Overlap-add / `acrossfade` the rescued region back into the global master (50–200 ms).
6. Emit one file.

### Phase 2 — shared reference (kills tonal drift)
Analyze the whole mix once → export a reference JSON → feed every section run via
`--mastering5_mastering_reference_file`, so sections aim at the same target as the global
master. **Open task:** confirm the engine's reference-*export* path (audio_analyzer /
sound_quality2_preparation) and whether that binary ships with the GUI.

### Phase 3 — auto-detect sections
ffmpeg short-term-loudness scan suggests quiet regions; user confirms/edits. Manual first.

## Risks → mitigations

| Risk | Mitigation |
|---|---|
| Arc flattening | Global master is the base; sections gain-matched to it (step 4), never re-targeted |
| Tonal/level seams | Crossfades + shared reference (Phase 2) |
| Reference unstable on short sparse clips | Always match to the shared whole-song reference, never per-clip stats |
| Slower (N extra engine runs) | Only re-render marked regions, not the whole song repeatedly |

## Test
CI build as usual. Acceptance: a track with loud chorus + quiet intro → intro distortion
gone, no audible level jump or tonal seam at boundaries.

## Open decisions (needed before implementation)
1. **Section marking:** manual time entry first (reliable, fast) vs. auto-detect up front.
2. **Blend model:** rescue-in-place (recommended — gentle, preserves current sound) vs.
   fully independent per-section masters concatenated (more character, higher seam/arc risk).

## Related analysis features (implemented / planned)
These were built/planned on top of the bundled analysis binaries (`audio_analyzer` etc.), no
engine recompile — see the approved plan and feature docs:
- **F3 "Analyze & suggest"** (implemented) — fills the global controls from input metrics; the
  gentle suggestions are the first thing to try before any section work (this plan's Gate).
- **F4a auto-detect sections** (implemented core, `sections.go`) — derives quiet spans from
  `loudness_time_series`; this is now the entry point for **Open decision #1** (auto + editable),
  replacing the old "Phase 3 ffmpeg scan".
- **F2/F4b before-after report** (implemented) — the verification loop (see the loudness arc and
  confirm a rescue matched levels / didn't over-limit).
- **Reference EQ** (planned, [reference-eq-feature.md](reference-eq-feature.md)) — a tweaked
  reference can serve as the shared target across sections (Phase 2).

## References (engine source)
- Pipeline / Normalize / start_at-end_at: `../phaselimiter/src/phase_limiter/main.cpp`
- AutoMastering5 (global reference matching): `../phaselimiter/src/phase_limiter/auto_mastering5.cpp`
- Why only `mastering5_mastering_level` applies in mastering5 mode: main.cpp:499-546
