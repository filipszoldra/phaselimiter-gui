# phaselimiter-gui (filipszoldra fork)

A GUI frontend for **phaselimiter** — the same AI mastering algorithm used on
[bakuage.com](https://bakuage.com) / [aimastering.com](https://aimastering.com).
Processes locally, no internet required.

## About this fork

This fork by **Filip Szołdra** builds on the original upstream project
([ai-mastering/phaselimiter-gui](https://github.com/ai-mastering/phaselimiter-gui))
and adds a set of practical controls and analysis tools aimed at reducing glitches
("crunch", pumping, true-peak clicks, smearing) and giving the user more control
over the mastering output — **without recompiling the C++ DSP engine**.

### What's changed vs. upstream

| Feature | Description |
|---|---|
| **Advanced glitch-reduction controls** | Limiter oversampling (1×/2×/4×), limiter quality (iterations), true-peak ceiling, pre-compression on/off + threshold + smoothing window |
| **Diagnostic "Limiter only" mode** | Bypasses AutoMastering5 for A/B testing whether quiet-section distortion is caused by the reference-matching stage |
| **"Analyze & suggest settings"** | Runs the bundled `audio_analyzer` on any audio file and auto-fills every control with gentle, glitch-avoiding settings derived from LRA, true-peak and spectral balance |
| **Detected quiet sections** | Automatically finds fragments that sit >9 LU below the loud sections; displayed in an editable table; used by section-aware mastering |
| **Section-aware mastering** | Re-renders each quiet section with a gentler mastering level, loudness-matches it to the global master, and splices it back with cross-fades — no arc flattening |
| **Reference-tone EQ** | Tilts the AI's tonal target (mid_mean per ERB band group) via ±6 dB sliders: Low / Low-mid / High-mid / High; passed as a temp `--mastering5_mastering_reference_file` |
| **Before/after report** | Double-click a finished mastering job to see a scorecard (LUFS, LRA, true-peak, dynamics, stereo, sound quality) plus input-vs-output spectrogram, spectrum and stereo images |
| **Bigger default window** | 720×600 instead of 400×400 |
| **Polish UI guide** | `docs/sterowanie-pl.html` — detailed Polish description of every control and its effect |

All new features are Go-level changes to the GUI; no C++ code was modified.

## Install (Windows)

1. Install [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170) if not already present.
2. Download the build artifact from [GitHub Actions](../../actions) (branch `advanced-glitch-controls`) and extract it.
3. Place [ffmpeg.exe](https://ffmpeg.org/) in the same directory as `phaselimiter-gui.exe` (or add it to `%PATH%`).
4. Run `phaselimiter-gui.exe`.

The `phaselimiter/` engine directory (with `bin/phase_limiter.exe`, `bin/audio_analyzer.exe` and `resource/`) must sit beside the exe — it is NOT included in the repository source but ships with the engine release.

## How to use

Drop audio files onto the app window to start mastering.

**Workflow for best results:**
1. Click **"Analyze a track & suggest settings"** → pick your track → controls auto-fill with gentle values tuned to its dynamics.
2. Expand **"Detected quiet sections"** to review auto-detected problem spans (quiet intros, breaks).
3. (Optional) Enable **"Section-aware mastering"** to rescue those sections with a gentler level.
4. (Optional) Expand **"Reference tone (EQ)"** to tilt the AI's tonal target.
5. Drop the file to master it. Double-click the finished row for a before/after report.

## Debug / console build

Use `phaselimiter-gui-console.exe` — identical to the windowed build but logs all engine output and progress to the console window.

## Runtime dependencies (Windows)

- Microsoft Visual C++ Redistributable
- `ffmpeg.exe` (on `%PATH%` or beside the exe)
- `phaselimiter/` engine directory beside the exe

## Build

No local Go/GTK toolchain is required for contributors — all builds run in GitHub Actions (`.github/workflows/build-win.yml`) using a Fedora cross-compile container with `mingw64-gtk3`.

To build locally with Docker:
```sh
docker run --rm -v "$PWD:/src" -w /src fedora:39 bash -c "
  yum install -y mingw64-gtk3 go glib2-devel mingw64-gcc.x86_64 &&
  sed -i -e 's/-Wl,-luuid/-luuid/g' /usr/x86_64-w64-mingw32/sys-root/mingw/lib/pkgconfig/gdk-3.0.pc &&
  PKG_CONFIG_PATH=/usr/x86_64-w64-mingw32/sys-root/mingw/lib/pkgconfig \
    CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc GOOS=windows GOARCH=amd64 \
    go build -o phaselimiter-gui-console.exe
"
```

## License

- MIT
- Third-party: [licenses/](licenses/)

---

*Original project: [ai-mastering/phaselimiter-gui](https://github.com/ai-mastering/phaselimiter-gui) by ai-mastering.*
