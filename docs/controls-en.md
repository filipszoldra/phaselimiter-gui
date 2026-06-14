# phaselimiter-gui — controls reference (EN)

Guide to mastering settings and their effect on the audio.
The **Advanced** section targets glitch reduction — crunch, pumping, true-peak clicks, smearing —
that persists even at gentle loudness and intensity.

> **Quick summary.** Hearing crunch at `-13 LUFS` / intensity `0.4`?
> That's not loudness — it's the **limiter**, **ceiling** and **pre-compression** stages.
> Fix them in the Advanced section before touching Target loudness.

---

## Basic controls

### Output directory
Folder where mastered files are saved (defaults to `Downloads` / `Desktop`).
Output files get the suffix `_output.wav`.

### Target loudness → `--reference`
**Range:** −20 … 0 LUFS · **Default:** −9 LUFS

The biggest lever. Sets how loud the track is pushed before the limiter.
Lower (e.g. `−13` / `−14`) = less gain into the limiter = less crunch and pumping.
**Recommended −12 to −14** for music with preserved dynamics.

### Mastering intensity → `--mastering5_mastering_level`
**Range:** 0.0 … 1.0 · **Default:** 1.0

Controls how strongly AutoMastering5 reshapes the tone toward the learned reference
(per-band M/S compressor, tuned by differential-evolution optimisation).
Lower = gentler, closer to the original.

### Preserve bass → `--erb_eval_func_weighting`
Enables perceptual weighting in the limiter to protect low frequencies from over-limiting.

---

## Advanced — glitch reduction

These stages run **independently** of loudness and intensity — they can degrade the sound
even at gentle basic settings.

### Limiter only (diagnostic) → `--mastering false`
**Default:** off

Skips AutoMastering5 and runs only the limiter. Use for A/B diagnosis: if quiet sections
stop distorting with this on, the global reference-matching is the culprit — lower
**Mastering intensity** (e.g. to 0.2–0.3). Not a production mode.

### True-peak ceiling (dB) → `--ceiling`
**Range:** −3.0 … 0.0 dB · **Default:** −1.0 dB

Maximum inter-sample peak level. At `0 dB` peaks can exceed 0 dBFS after MP3/AAC encoding
and produce audible **clicks**. Setting **−1.0 dB** provides headroom and eliminates most.

### Limiter oversampling (×) → `--limiter_internal_oversample`
**Options:** 1 / 2 / 4 · **Default:** 1

Hard limiting at 44.1 kHz creates aliasing (harsh **crunch**). Running at `2×` or `4×`
removes most of it. **Recommended 2×**. CPU/RAM cost scales with the factor.

### Limiter quality (iterations) → `--max_iter1`
**Range:** 100 … 400 (step 50) · **Default:** 100

The limiter is an iterative FISTA optimizer. Too few iterations = audible error (crunch)
and pre-ringing (transient smearing). **Try 200** if you hear distortion.

### Pre-compression → `--pre_compression`
**Default:** on

Loudness-domain compressor running **before** the limiter. Evens out the loudest moments.
Can be the source of **pumping**. Uncheck to preserve full dynamics.

### Pre-comp threshold (dB) → `--pre_compression_threshold`
**Range:** 0 … 18 dB · **Default:** 6 dB

How many dB above measured loudness the pre-compressor activates.
Higher = activates less often = more dynamics, less pumping.

### Pre-comp window (s) → `--pre_compression_mean_sec`
**Range:** 0.05 … 1.0 s · **Default:** 0.2 s

Averaging window length. **Extending to ~0.4 s** smooths the action and reduces pumping.

### Stereo match strength → `--mastering_ms_matching_level`
**Range:** 0 … 1 · **Default:** 1.0

Controls how strongly AutoMastering5 reshapes the stereo field (M/S balance) toward the
reference. At `1.0` it fully matches the reference's stereo width per band. Lowering to
`0.5`–`0.7` preserves more of the original stereo image and reduces over-widening of hihats
or spatial smearing on sparse material.

### Per-band boost limit → `--mastering5_eq_band_levels`
**Range:** 0.0 … 2.0 per band · **Default:** 1.0 (neutral)

Nine spinbuttons — one per engine frequency band — scaling the AutoMastering5 optimizer's
**wet-gain upper bound** for that band (mid + side). Values < 1 reduce how much the AI is
allowed to boost or widen that band; > 1 permit more. The constraint is soft (a penalty
in the optimizer's cost function), so the effect is proportional rather than a hard clip.

| Band | Frequency range | Typical use |
|---|---|---|
| Sub | 0–148 Hz | leave at 1.0 unless bass is deformed |
| Low | 148–392 Hz | reduce if kick body gets pumped |
| Low-mid | 392–795 Hz | |
| Mid | 795–1458 Hz | |
| Upper-mid | 1458–2550 Hz | |
| Presence | 2550–4349 Hz | reduce if vocals become harsh |
| High | 4349–7314 Hz | reduce if cymbals are over-brightened |
| Very-high | 7314–12k Hz | reduce if hihats smear / over-widen |
| Air | 12k+ Hz | reduce on tracks with sparse highs |

The flag is only sent when at least one band differs from 1.0. All-1.0 = engine default.

---

## Analysis & suggestions

### Analyze a track & suggest settings
Measures the chosen audio file (`audio_analyzer`) and auto-fills every control with
gentle, glitch-avoiding values derived from LRA, true-peak and spectral balance.
Non-WAV inputs are decoded to a temp WAV via `ffmpeg` automatically.

After analysis the **Detected quiet sections** list is also populated.

### Before/after report (double-click a finished row)
Opens a dialog showing:
- **Metrics scorecard** — LUFS, LRA, True-peak, Dynamics, Stereo, Sound Quality 2 (input → output, with warnings)
- **Analysis images** — spectrogram, spectrum balance, stereo image (input vs. output side by side)
- **Detected quiet sections** from the input file

---

## Detected quiet sections

The algorithm finds spans where the short-term loudness sits ≥9 LU below the track's
loud-section reference (95th percentile of the curve). A single global master tends to
over-process these spots — AutoMastering5 fits one compressor to whole-song statistics
(dominated by the loud sections) and boosts near-empty bands in sparse material.

**Editing the list:**
- **+ Add** — manually add a section by entering start and end times in seconds.
- **Remove** — delete the selected row.

**Section intensity** — the gentler mastering level used to re-render quiet sections
(default `0.25`).

**Section-aware mastering** — when enabled and sections are present:
1. The engine masters the whole track normally (preserves the loudness arc).
2. Each quiet section is re-mastered from the original input with the gentler level.
3. The rescued section is loudness-matched to the global master at that point.
4. It is spliced back with 80 ms cross-fades at the boundaries.

If any rescue step fails, the output falls back to the global master — the base is never lost.

---

## Reference tone (EQ) → `--mastering5_mastering_reference_file`

AutoMastering5 targets a **reference** — a per-ERB-band array of `mid_mean` values (target
mono level in dB): the **AI's target tonal curve**. The four sliders tilt it without
recompiling the engine:

| Slider | Frequency range | Effect at +dB |
|---|---|---|
| Low | <250 Hz | bassier target |
| Low-mid | 250–2000 Hz | warmer mids |
| High-mid | 2000–6000 Hz | more presence / brightness |
| High | >6000 Hz | more air |

**Range:** ±6 dB · **Default:** 0 (no change)

The GUI applies the offsets to `mid_mean` in a temp copy of `mastering_reference.json`
and passes it via `--mastering5_mastering_reference_file`. The `covariance`, `side_mean`
and all other fields are preserved verbatim.

> **⚠ Over-boosting an empty band** (e.g. +6 dB High on a track with little high-frequency
> content) fights the limiter and can **worsen** artifacts. Start with ±2 dB and check
> the before/after report spectrum image.

---

## Symptom → fix

| What you hear | First fix | Then |
|---|---|---|
| Clicks / crackles | True-peak ceiling → **−1.0 dB** | Check output format (WAV is safest) |
| Crunch on peaks | Limiter oversampling → **2×** | Limiter quality → **200**; lower loudness |
| Pumping / breathing | Pre-comp window → **0.4 s** | Raise threshold or disable pre-compression |
| Smearing / loss of clarity | Limiter quality → **200** | Lower mastering intensity |
| Wrong tone — too bright or dark | Reference tone (EQ) → tilt sliders | Start with ±2 dB; verify with before/after report |
| Distortion on quiet intro / break | Detected sections + section intensity 0.15–0.25 | Enable Section-aware mastering |
| Kick deformation / hihat over-widening | Per-band boost limit: lower Sub/Low (kick) or High/Very-high/Air (hihats) | Combine with lower Stereo match strength |
