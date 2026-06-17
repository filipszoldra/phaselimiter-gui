# phaselimiter-gui — opis kontrolek (PL)

Przewodnik po ustawieniach masteringu i ich wpływie na dźwięk.
Kontrolki **zaawansowane** służą do usuwania glitchy (trzasków, chrupania, pompowania),
które pojawiają się nawet przy spokojnym poziomie głośności i intensywności.

> **Skrót dla niecierpliwych.** Słyszysz chrupanie przy `-13 LUFS` i intensywności `0,4`?
> To nie wina głośności — winne są etapy **limitera**, **sufitu** i **pre-kompresji**.
> Napraw je zanim ruszysz Docelową głośność.

Kontrolki odpowiadają numerowanym kartom w UI. Każda flaga silnika jest podana, by łatwiej
czytać logi builda konsolowego (`phaselimiter-gui-console.exe`).

---

## 1 · Głośność

### Docelowa głośność (Target loudness) → `--reference`
**Zakres:** −20 … 0 LUFS · **Domyślnie:** −14 LUFS

Najważniejszy regulator. Określa, jak głośno wyrównać utwór przed limiterem.
Niżej (np. `−14`) = mniej wzmocnienia w limiter = mniej chrupania i pompowania.
**Zalecane −9 do −14.**

## 2 · AutoMastering5 (ton i stereo)

### Intensywność (Intensity) → `--mastering5_mastering_level`
**Zakres:** 0,0 … 1,0 · **Domyślnie:** 0,4

Jak mocno AutoMastering5 przekształca brzmienie w stronę wyuczonego wzorca (kompresja M/S per
pasmo, dobierana optymalizacją różnicowo-ewolucyjną). Niżej = delikatniej, bliżej oryginału.
**Zalecane 0,3–0,5.**

### Dopasowanie stereo (Stereo match) → `--mastering_ms_matching_level`
**Zakres:** 0 … 1 · **Domyślnie:** 1,0

Jak mocno pole stereo (balans M/S) jest dopasowane do wzorca. Obniżenie do `0,5`–`0,7` zachowuje
więcej oryginalnego obrazu stereo i redukuje nadmierne poszerzanie hihatsów / rozmycie przestrzeni.

### Korekcja EQ (cel per pasmo) → `--eq_analysis_target`
Włącz **„EQ correction"**, by przeciągać **różową krzywą** per pasmo (±12 dB) nad zanalizowanym
widmem. Ustawiona wartość to Twoja **modyfikacja** pasma; **czerwona przerywana krzywa + czerwone
wypełnienie** pokazują **przewidywany efekt** = `modyfikacja × intensywność`, **maks. ±6 dB**
(silnik to przycina). Ruch suwakiem intensywności aktualizuje podgląd na żywo.

Silnik aplikuje to jako statyczne wzmocnienie per pasmo **po** AutoMastering5 a **przed**
pre-kompresją. GUI wysyła tablicę modyfikacji wprost; skalowanie przez intensywność i przycięcie
±6 dB dzieje się w silniku. Etykiety pod pasmami pokazują częstotliwość środkową pasma.

> Zbyt duże wzmocnienie pustego pasma (np. +12 dB Air przy ubogich górach) walczy z limiterem i
> może pogorszyć artefakty. Sprawdź w porównaniu przed/po.

### Zachowaj bas (Preserve bass) → `--erb_eval_func_weighting`
Percepcyjne ważenie błędu limitera chroniące niskie częstotliwości. Trzymaj włączone.

### Tylko limiter (diagnostyka) → `--mastering false`
Pomija AutoMastering5, uruchamia sam limiter. A/B: jeśli ciche fragmenty przestają być
zniekształcone — winne jest dopasowanie referencji → obniż Intensywność. Nie tryb produkcyjny.

### Zaawansowane: optymalizator per pasmo → `--mastering5_eq_band_levels` / `--mastering5_eq_transform_levels`
Krzywa 9-pasmowa (0–2, **1 = neutralnie**) ograniczająca, jak agresywnie AutoMastering5 przekształca
dane pasmo. Tryb **Ceiling** (`--mastering5_eq_band_levels`) skaluje górną granicę wet-gain
optymalizatora (miękka kara, proporcjonalnie). Tryb **Transform** (`--mastering5_eq_transform_levels`)
skaluje zrealizowany wet-gain po optymalizacji (deterministycznie). Selektor „Parameter affects" i
nadpisania per pasmo wybierają tryb; **Symmetric transform** skaluje też cięcia.

| Pasmo | Częstotliwość | Kiedy obniżyć |
|---|---|---|
| Sub | ~54 Hz | gdy bas się deformuje |
| Low | ~240 Hz | gdy korpus stopy jest pompowany |
| Lo-mid | ~560 Hz | |
| Mid | ~1.1k | |
| Up-mid | ~1.9k | |
| Pres | ~3.3k | gdy wokale są szorstkie |
| High | ~5.6k | gdy talerze przejaskrawione |
| V-hi | ~9.4k | gdy hihatsy rozmywają / poszerzają |
| Air | ~16k | przy ubogich górach |

Wysyłane tylko gdy co najmniej jedno pasmo różni się od 1,0.

## 3 · Pre-kompresja

### Włączona → `--pre_compression`
**Domyślnie:** włączona. Kompresor przed limiterem; wyrównuje najgłośniejsze fragmenty.
Bywa źródłem **pompowania**. Wyłącz, by zachować pełną dynamikę.

### Próg (offset) → `--pre_compression_threshold`
**Zakres:** 0 … 18 dB · **Domyślnie:** 6 dB. O ile dB ponad zmierzoną głośność zaczyna działać.
Wyżej = reaguje rzadziej = więcej dynamiki, mniej pompowania.

### Okno → `--pre_compression_mean_sec`
**Zakres:** 0,05 … 1,0 s · **Domyślnie:** 0,2 s. Okno uśredniania. **~0,4 s** wygładza działanie.

## 4 · Phase limiter

### Nadpróbkowanie → `--limiter_internal_oversample`
**1 / 2 / 4 · Domyślnie 1.** Twarde limitowanie przy 44,1 kHz aliasuje (szorstkie **chrupanie**);
`2×`/`4×` usuwa większość. **Zalecane 2×.** Koszt CPU/RAM rośnie z mnożnikiem.

### Jakość (iteracje) → `--max_iter1`
**40 … 400 · Domyślnie 100.** Limiter to iteracyjny optymalizator (FISTA). Za mało = słyszalny błąd
(chrupanie) i pre-ringing (rozmycie transjentów). **Spróbuj 200** na finalny master.

## 5 · Sufit

### Sufit true-peak → `--ceiling`
**Zakres:** −3,0 … 0,0 dB · **Domyślnie:** −1,0 dB. Maks. szczyt między-próbkowy. Przy `0 dB` szczyty
po kodowaniu MP3/AAC wyskakują ponad 0 dBFS → słyszalne **trzaski**. **−1,0 dB** daje zapas.

## 6 · Mastering świadomy sekcji → `--mastering5_section_ranges` / `--mastering5_section_intensity`

Wykryte ciche fragmenty (intra, breaki) są mieszane w stronę sygnału **dry** (nieprzetworzonego)
w **jednym przebiegu** silnika — dostają delikatniejsze przetwarzanie bez osobnego re-renderu i
sklejania.

- **Intensywność sekcji** (domyślnie `0,25`): siła blendu wet/dry w sekcji. `1` = pełny
  AutoMastering5, `0` = całkowicie dry.
- **Rampa 1 s** (raised-cosine) na każdej granicy zapobiega kliknięciom.
- Lista jest edytowalna: **+ Add** (start/koniec w sekundach), **Remove**.

Wykrywanie: fragmenty gdzie krótkoterminowa głośność jest wyraźnie poniżej poziomu głośnych
fragmentów utworu. Wysyłane tylko gdy funkcja włączona i istnieje sekcja.

---

## Analiza i porównanie

- **Track analysis** (panel boczny): LUFS, true-peak, LRA, dynamika, sample rate, czas oraz
  **spektrogram** (osie Czas × Częstotliwość, z helperem).
- **Analyze & suggest**: mierzy utwór (`audio_analyzer`; nie-WAV dekodowane przez `ffmpeg`) i
  wypełnia kontrolki łagodnymi wartościami; uzupełnia też wykryte sekcje.
- **Mastering comparison** (rozwiń gotowy wiersz): metryki input vs output (LUFS / true-peak / LRA
  z deltami), **poziom per pasmo** z wypisaną zmianą dB, **głośność w czasie** oraz
  **spektrogramy input/output**.

---

## Objaw → lekarstwo

| Co słyszysz | Najpierw zmień | Potem |
|---|---|---|
| Trzaski / kliknięcia | Sufit true-peak → **−1,0 dB** | Wyjście jako WAV |
| Chrupanie na szczytach | Nadpróbkowanie limitera → **2×** | Jakość limitera → **200**; niższa głośność |
| Pompowanie / oddychanie | Okno pre-komp. → **0,4 s** | Próg wyżej lub wyłącz pre-kompresję |
| Rozmycie / utrata klarowności | Jakość limitera → **200** | Niższa Intensywność |
| Zła barwa — za jasno/ciemno | Korekcja EQ → przeciągnij pasmo(a) | Patrz na czerwoną przerywaną; sprawdź w porównaniu |
| Distortion na cichym intro / break | Section-aware + intensywność sekcji 0,15–0,25 | — |
| Deformacja stopy / hihatsy się poszerzają | Optymalizator per pasmo: obniż Sub/Low (stopa) lub High/V-hi/Air (hihats) | Połącz z niższym Dopasowaniem stereo |
