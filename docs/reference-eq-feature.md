# Feature proposal: "Reference EQ" — steer the AI's target tone

> Status: **implemented** — macro-tilt (4 band groups), tone only (mid_mean). No C++ engine recompile.
> Composes with the deferred reference-matching feature ([reference-matching-feature.md](reference-matching-feature.md)).

## The idea
mastering5 reshapes your track to match a **reference** — and that reference is, at its
core, a **per-band target tonal curve**. Today it's a fixed learned model. This feature lets the
user *tilt that target tone* with an EQ-style control, so the AI masters toward the balance you
want, without hand-editing JSON or recompiling.

## What a reference actually is (verified in source)
A reference is an analysis JSON parsed by `ParseReference`
([sound_quality2.h:139-189](../../phaselimiter/deps/bakuage/include/bakuage/sound_quality2.h#L139)).
Per ERB band (`resource/mastering_reference.json` is the shipped example, with `bands`+`covariance`):

- **`mid_mean`** (dB) — target mono level in that band → **this is the target EQ / tonal curve**.
- **`side_mean`** (dB) — target side level in that band → target **stereo width vs frequency**.
- `low_freq`/`high_freq` — band edges (≈148, 392, 795, 1458 Hz, …).
- `loudness`, `loudness_range`, `mid_to_side_*` — per-band stats.
- top-level **`covariance`** — how bands co-vary; weights the match-distance metric.

The engine can take such a JSON per run via `--mastering5_mastering_reference_file`
([auto_mastering5.cpp:125](../../phaselimiter/src/phase_limiter/auto_mastering5.cpp#L125)).

## How the control works (no recompile)
1. Pick a **base reference**: the shipped `resource/mastering_reference.json` (has bands+covariance),
   or a reference track analyzed via `audio_analyzer` (the reference-matching feature).
2. The GUI EQ control adds dB offsets per band to **`mid_mean`** (tone) and optionally **`side_mean`**
   (width). Two UI options:
   - **Macro tilt**: low / low-mid / high-mid / high sliders (maps to band groups). Simple, safe.
   - **Multiband curve**: a draggable curve over the ERB bands (one handle per band). More power.
3. Write the modified JSON to a temp file; pass `--mastering5_mastering_reference_file <tmp>`.
4. Leave **`covariance` untouched** — editing only the means keeps the target stable; covariance only
   reweights the distance metric.

## Wiring (follows existing patterns)
- New `reference_eq.go`: load base reference JSON → apply per-band dB offsets → write temp JSON.
  Reuse the `AudioAnalysis`/`Band` structs in [analyzer.go](../analyzer.go) (same schema).
- `Mastering` struct ([mastering.go](../mastering.go)) gains a `ReferenceFile string`; if set,
  `execute()` appends `--mastering5_mastering_reference_file`.
- `main.go`: an EQ widget block (sliders or a `gtk.DrawingArea` curve), populated into the struct
  in the drag handler like the other controls.

## Synergy
- With **reference-matching**: analyze a loved track → use it as the base, then nudge with the EQ.
- With **F2 visualization**: the spectrum-balance view shows the input vs the (re)mastered tone, so
  the user can dial the EQ against a real picture.
- With **section-mastering**: the same tweaked reference can be the shared target for every section
  (the section plan's Phase 2), keeping tone consistent across rescued sections.

## Risks
- Over-tilting `mid_mean` fights the limiter (boosting an empty band → harshness); clamp offsets
  (e.g. ±6 dB) and show the resulting curve.
- The shipped `mastering_reference.json` is one fixed target; for genre-appropriate bases, allow
  loading alternates or analyzing a reference track.

## Effort
Small-to-medium: JSON load/edit/write + flag wiring (small) + the EQ widget (medium if a draggable
curve, small for macro sliders). High perceived value — it turns the "black box AI" into something
the user can aim.
