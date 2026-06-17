# phaselimiter-gui — controls reference (EN)

Guide to mastering settings and their effect on the audio.
The **Advanced** controls target glitch reduction — crunch, pumping, true-peak clicks, smearing —
that persists even at gentle loudness and intensity.

> **Quick summary.** Hearing crunch at `-13 LUFS` / intensity `0.4`?
> That's not loudness — it's the **limiter**, **ceiling** and **pre-compression** stages.
> Fix them before touching Target loudness.

Controls map to numbered cards in the UI. Each engine flag is shown so the console build
(`phaselimiter-gui-console.exe`) output is easy to read.

---

## 1 · Loudness

### Target loudness → `--reference`
**Range:** −20 … 0 LUFS · **Default:** −14 LUFS

The biggest lever. Sets how loud the track is pushed before the limiter.
Lower (e.g. `−14`) = less gain into the limiter = less crunch and pumping.
**Recommended −9 to −14.**

## 2 · AutoMastering5 (tone & stereo)

### Intensity → `--mastering5_mastering_level`
**Range:** 0.0 … 1.0 · **Default:** 0.4

How strongly AutoMastering5 reshapes the tone toward the learned reference (per-band M/S
compressor tuned by differential-evolution optimisation). Lower = gentler, closer to the original.
**Recommended 0.3–0.5.**

### Stereo match → `--mastering_ms_matching_level`
**Range:** 0 … 1 · **Default:** 1.0

How strongly the stereo field (M/S balance) is matched to the reference. Lowering to `0.5`–`0.7`
preserves more of the original stereo image and reduces over-widening of hihats / spatial smear.

### EQ correction (per-band target) → `--eq_analysis_target`
Enable **"EQ correction"** to drag a per-band **pink curve** (±12 dB) over the analyzed spectrum.
The value you set is your per-band **modification**; a **dashed-red curve + red fill** show the
**predicted applied change** = `modification × intensity`, **capped at ±6 dB** (the engine clamps
it). Move the intensity slider and the prediction updates live.

The engine applies this as a static per-band gain **after** AutoMastering5 and **before**
pre-compression. The GUI sends the modification array directly; intensity scaling and the ±6 dB
clamp happen inside the engine. Frequency labels under each band show the band's center.

> Over-boosting an empty band (e.g. +12 dB Air on a track with little high content) fights the
> limiter and can worsen artifacts. Use the before/after comparison to check.

### Preserve bass → `--erb_eval_func_weighting`
Perceptual weighting in the limiter that protects low frequencies from over-limiting. Keep on.

### Limiter only (diagnostic) → `--mastering false`
Skips AutoMastering5 and runs only the limiter. A/B test: if quiet sections stop distorting with
this on, the reference-matching is the culprit — lower Intensity. Not a production mode.

### Advanced: per-band optimizer → `--mastering5_eq_band_levels` / `--mastering5_eq_transform_levels`
A 9-band curve (0–2, **1 = neutral**) restraining how aggressively AutoMastering5 reshapes each
band. **Ceiling** mode (`--mastering5_eq_band_levels`) scales the optimizer's wet-gain upper
bound (soft penalty, proportional). **Transform** mode (`--mastering5_eq_transform_levels`) scales
the realized wet-gain after optimization (deterministic). The "Parameter affects" selector and
per-band overrides choose which mode each band uses; **Symmetric transform** also scales cuts.

| Band | Frequency | Lower it when |
|---|---|---|
| Sub | ~54 Hz | bass is deformed |
| Low | ~240 Hz | kick body gets pumped |
| Lo-mid | ~560 Hz | |
| Mid | ~1.1k | |
| Up-mid | ~1.9k | |
| Pres | ~3.3k | vocals get harsh |
| High | ~5.6k | cymbals over-brightened |
| V-hi | ~9.4k | hihats smear / over-widen |
| Air | ~16k | sparse-highs material |

Only sent when at least one band differs from 1.0.

## 3 · Pre-compression

### Enabled → `--pre_compression`
**Default:** on. Loudness-domain compressor before the limiter; evens out the loudest moments.
Can be a source of **pumping**. Disable to preserve full dynamics.

### Threshold offset → `--pre_compression_threshold`
**Range:** 0 … 18 dB · **Default:** 6 dB. How many dB above measured loudness it activates.
Higher = activates less often = more dynamics, less pumping.

### Window → `--pre_compression_mean_sec`
**Range:** 0.05 … 1.0 s · **Default:** 0.2 s. Averaging window. **~0.4 s** smooths the action.

## 4 · Phase limiter

### Oversampling → `--limiter_internal_oversample`
**1 / 2 / 4 · Default 1.** Hard limiting at 44.1 kHz aliases (harsh **crunch**); `2×`/`4×` removes
most of it. **Recommended 2×.** CPU/RAM cost scales with the factor.

### Quality (iterations) → `--max_iter1`
**40 … 400 · Default 100.** The limiter is an iterative FISTA optimizer. Too few = audible error
(crunch) and pre-ringing (transient smear). **Try 200** for a final master.

## 5 · Ceiling

### True-peak ceiling → `--ceiling`
**Range:** −3.0 … 0.0 dB · **Default:** −1.0 dB. Maximum inter-sample peak. At `0 dB`, peaks can
exceed 0 dBFS after MP3/AAC encoding → audible **clicks**. **−1.0 dB** gives headroom.

## 6 · Section-aware mastering → `--mastering5_section_ranges` / `--mastering5_section_intensity`

Detected quiet spans (intros, breaks) are blended toward the **dry** (unprocessed) signal in a
single engine pass, so they get gentler processing without a separate re-render or splice.

- **Section intensity** (default `0.25`): wet/dry blend strength inside sections. `1` = full
  AutoMastering5, `0` = fully dry.
- A **1 s raised-cosine ramp** at each boundary prevents clicks.
- The list is editable: **+ Add** a span (start/end seconds), **Remove** a row.

Detection: spans where short-term loudness sits well below the track's loud-section reference.
Only sent when the feature is enabled and at least one section exists.

---

## Track analysis & comparison

- **Track analysis** (drawer): LUFS, true-peak, LRA, dynamics, sample rate, duration, and a
  **spectrogram** (Time × Frequency axes, with a help popover).
- **Analyze & suggest**: measures the track (`audio_analyzer`; non-WAV decoded via `ffmpeg`) and
  fills controls with glitch-avoiding values; also populates detected sections.
- **Mastering comparison** (expand a finished job): input vs output **metrics** (LUFS / true-peak /
  LRA with deltas), **per-band level** with the dB change printed per band, **loudness over time**,
  and **input/output spectrograms**.

---

## Symptom → fix

| What you hear | First fix | Then |
|---|---|---|
| Clicks / crackles | True-peak ceiling → **−1.0 dB** | Output as WAV |
| Crunch on peaks | Limiter oversampling → **2×** | Limiter quality → **200**; lower loudness |
| Pumping / breathing | Pre-comp window → **0.4 s** | Raise threshold or disable pre-compression |
| Smearing / loss of clarity | Limiter quality → **200** | Lower Intensity |
| Wrong tone — too bright/dark | EQ correction → drag the band(s) | Watch the dashed-red prediction; verify in comparison |
| Distortion on quiet intro / break | Section-aware + section intensity 0.15–0.25 | — |
| Kick deformation / hihat over-widening | Per-band optimizer: lower Sub/Low (kick) or High/V-hi/Air (hihats) | Combine with lower Stereo match |
