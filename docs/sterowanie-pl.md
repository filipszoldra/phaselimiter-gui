# phaselimiter-gui — opis kontrolek (PL)

Przewodnik po ustawieniach masteringu i ich wpływie na dźwięk.
Sekcja **Zaawansowane** służy do usuwania „glitchy" (trzasków, chrupania, pompowania),
które pojawiają się nawet przy spokojnym poziomie głośności i intensywności.

> **Skrót dla niecierpliwych.** Słyszysz trzaski przy `-13 LUFS` i intensywności `0,4`?
> To nie wina głośności — winne są etapy **limitera**, **sufitu** i **pre‑kompresji**.
> Znajdziesz je w sekcji Zaawansowane poniżej.

---

## Ustawienia podstawowe

### Katalog wyjściowy (Output directory)
Folder, do którego zapisywane są pliki wynikowe (domyślnie `Pobrane` / `Pulpit`).
Plik dostaje przyrostek `_output.wav`.

### Docelowa głośność (Target loudness) → `--reference`
**Zakres:** −20 … 0 LUFS · **Domyślnie:** −9 LUFS

Najważniejszy „duży" regulator. Określa, jak głośno ma być wyrównany utwór przed limiterem.
Niższa wartość (np. `−13` / `−14`) = mniej wzmocnienia wpychanego w limiter = mniej chrupania
i pompowania. **Zalecane −12 do −14** dla muzyki z zachowaną dynamiką.

### Intensywność masteringu (Mastering intensity) → `--mastering5_mastering_level`
**Zakres:** 0,0 … 1,0 · **Domyślnie:** 1,0

Określa, jak mocno AutoMastering5 przekształca brzmienie w stronę wyuczonego wzorca
(korekcja pasmowa + kompresja M/S, dobierana optymalizacją różnicowo‑ewolucyjną).
Niżej = delikatniej, bliżej oryginału.

### Zachowaj bas (Preserve bass) → `--erb_eval_func_weighting`
Włącza percepcyjne ważenie błędu limitera chroniące niskie częstotliwości.

---

## Zaawansowane — redukcja glitchy

Te etapy działają **niezależnie** od głośności i intensywności — dlatego potrafią psuć
dźwięk nawet przy spokojnych ustawieniach podstawowych.

### Tylko limiter (diagnostyka) → `--mastering false`
**Domyślnie:** wyłączone

Pomija etap AutoMastering5 i uruchamia **sam limiter**. Służy do diagnozy: jeśli ciche
fragmenty przestają być zniekształcone, winowajcą jest globalne dopasowanie AutoMastering5
→ obniż **Intensywność** (np. do 0,2–0,3). Nie jest to tryb produkcyjny.

### Sufit true‑peak (dB) → `--ceiling`
**Zakres:** −3,0 … 0,0 dB · **Domyślnie:** −1,0 dB

Maksymalny poziom szczytu między‑próbkowego. Przy `0 dB` szczyty po kodowaniu do MP3/AAC
„wyskakują" ponad zero i słychać trzaski. Ustawienie **−1,0 dB** daje zapas i eliminuje
większość kliknięć.

### Nadpróbkowanie limitera (×) → `--limiter_internal_oversample`
**Opcje:** 1 / 2 / 4 · **Domyślnie:** 1

Twarde limitowanie przy 44,1 kHz tworzy aliasing (szorstkie chrupanie). Praca limitera
w `2×` lub `4×` usuwa większość tego efektu. **Zalecane 2×**.

### Jakość limitera (iteracje) → `--max_iter1`
**Zakres:** 100 … 400 (co 50) · **Domyślnie:** 100

Limiter to iteracyjny optymalizator (FISTA). Zbyt mała liczba = słyszalny błąd (chrupanie)
i pre‑ringing (rozmycie transjentów). **Spróbuj 200** jeśli słyszysz zniekształcenia.

### Pre‑kompresja → `--pre_compression`
**Domyślnie:** włączona

Kompresor działający **przed** limiterem. Wyrównuje najgłośniejsze fragmenty. Bywa źródłem
**pompowania**. Odznacz, aby zachować pełną dynamikę.

### Próg pre‑kompresji (dB) → `--pre_compression_threshold`
**Zakres:** 0 … 18 dB · **Domyślnie:** 6 dB

O ile dB ponad zmierzoną głośność zaczyna działać pre‑kompresor.
Wyżej = kompresor reaguje rzadziej = więcej dynamiki, mniej pompowania.

### Okno pre‑kompresji (s) → `--pre_compression_mean_sec`
**Zakres:** 0,05 … 1,0 s · **Domyślnie:** 0,2 s

Długość okna uśredniania. **Wydłużenie do ~0,4 s** wygładza działanie i redukuje pompowanie.

### Siła dopasowania stereo → `--mastering_ms_matching_level`
**Zakres:** 0 … 1 · **Domyślnie:** 1,0

Określa, jak mocno AutoMastering5 przekształca pole stereo (balans M/S) w kierunku wzorca.
Przy `1,0` w pełni dopasowuje szerokość stereo per pasmo do wzorca referencyjnego. Obniżenie do
`0,5`–`0,7` zachowuje więcej oryginalnego obrazu stereo i redukuje nadmierne poszerzanie
hihatsów lub przestrzenne rozmycie na materiale ze rzadkimi górami.

### Limit wzmocnienia per pasmo → `--mastering5_eq_band_levels`
**Zakres:** 0,0 … 2,0 per pasmo · **Domyślnie:** 1,0 (neutralnie)

Dziewięć pokręteł — po jednym na każde pasmo częstotliwościowe silnika — skalujących **górną
granicę wet-gain** optymalizatora AutoMastering5 (mid + side). Wartość < 1 ogranicza, ile AI
może wzmocnić lub poszerzyć dane pasmo; > 1 pozwala na więcej. Ograniczenie jest miękkie
(kara w funkcji kosztu), więc efekt jest proporcjonalny, nie twardy.

| Pasmo | Zakres | Kiedy obniżyć |
|---|---|---|
| Sub | 0–148 Hz | gdy bas ulega deformacji |
| Low | 148–392 Hz | gdy kopnięcie kopyta jest pompowane |
| Low-mid | 392–795 Hz | |
| Mid | 795–1458 Hz | |
| Upper-mid | 1458–2550 Hz | |
| Presence | 2550–4349 Hz | gdy wokale stają się szorstkie |
| High | 4349–7314 Hz | gdy talerze są przejaskrawione |
| Very-high | 7314–12k Hz | gdy hihatsy rozmywają się / poszerzają |
| Air | 12k+ Hz | przy nagraniach ze rzadkimi górami |

Flaga jest wysyłana tylko gdy co najmniej jedno pasmo różni się od 1,0. Wszystkie 1,0 = domyślne zachowanie silnika.

---

## Analiza i sugestie

### Analizuj utwór i zasugeruj ustawienia
Przycisk mierzy wybrany plik audio (`audio_analyzer`) i automatycznie wypełnia wszystkie
kontrolki łagodnymi wartościami na podstawie LRA, true‑peak i balansu pasm.
Pliki inne niż WAV są dekodowne przez `ffmpeg` do tymczasowego WAV.

Po analizie lista **Wykryte sekcje ciche** uzupełnia się automatycznie.

### Raport przed/po (dwuklik gotowego wiersza)
Otwiera okno z:
- **Tabelą pomiarów** — LUFS, LRA, True‑peak, Dynamika, Stereo, Sound Quality 2
- **Obrazami** — spektrogram, rozkład widma, obraz stereo (input vs. output)
- **Listą sekcji cichych** wykrytych w pliku wejściowym

---

## Wykryte sekcje ciche

Algorytm szuka fragmentów, gdzie krótkoterminowa głośność jest ≥9 LU poniżej typowego
poziomu głośnego fragmentu (95. percentyl krzywej). Globalny mastering zwykle nadmiernie
przetwarza takie miejsca — AutoMastering5 dopasowuje się do statystyk całości i podbija
niemal puste pasma w cichych momentach.

**Edycja listy:**
- **+ Add** — ręcznie dodaj sekcję podając start i koniec w sekundach.
- **Remove** — usuń zaznaczony wiersz.

**Intensywność sekcji** — delikatniejszy poziom masteringu używany do re‑renderowania
cichych fragmentów (domyślnie `0,25`).

**Section-aware mastering** — gdy zaznaczony:
1. Silnik masteruje cały utwór normalnie (zachowuje łuk głośności).
2. Każdą cichą sekcję masteruje ponownie z delikatniejszą intensywnością.
3. Uratowaną sekcję wyrównuje głośnościowo do global mastera.
4. Wkleja ją z powrotem z 80 ms cross‑fade na granicach.

Jeśli rescue nie powiodło się, plik wynikowy pozostaje global masterem.

---

## Ton referencyjny (EQ) → `--mastering5_mastering_reference_file`

AutoMastering5 dopasowuje brzmienie do **wzorca referencyjnego** — tablicy wartości
`mid_mean` (docelowy poziom każdego pasma ERB w dB): **docelowa krzywa tonalna AI**.
Cztery suwaki pozwalają ją przechylić bez przebudowania silnika:

| Suwak | Zakres częst. | Efekt +dB |
|---|---|---|
| Low | <250 Hz | bassowszy dźwięk |
| Low-mid | 250–2000 Hz | cieplejszy środek |
| High-mid | 2000–6000 Hz | obecność / jasność |
| High | >6000 Hz | więcej powietrza |

**Zakres:** ±6 dB · **Domyślnie:** 0 (brak zmiany)

GUI modyfikuje `mid_mean` w tymczasowej kopii `mastering_reference.json` i przekazuje
ją przez `--mastering5_mastering_reference_file`. Pola `covariance`, `side_mean`
i inne pozostają niezmienione.

> **⚠ Zbyt duże wzmocnienie pustego pasma** (np. +6 dB High przy nagraniu bez wysokich
> harmonicznych) walczy z limiterem i może **pogorszyć** artefakty. Zacznij od ±2 dB.

---

## Objaw → lekarstwo

| Co słyszysz | Najpierw zmień | Potem |
|---|---|---|
| Trzaski / kliknięcia | Sufit true‑peak → **−1,0 dB** | Sprawdź format wyjścia (WAV jest najbezpieczniejszy) |
| Chrupanie na szczytach | Nadpróbkowanie limitera → **2×** | Jakość limitera → **200**; niższa głośność |
| Pompowanie / oddychanie | Okno pre‑komp. → **0,4 s** | Próg pre‑komp. wyżej lub wyłącz pre‑kompresję |
| Rozmycie / utrata klarowności | Jakość limitera → **200** | Niższa intensywność masteringu |
| Zła barwa — za jasno lub ciemno | Ton referencyjny (EQ) → przechyl suwaki | Zacznij od ±2 dB; użyj raportu przed/po |
| Distortion na cichym intro / break | Sekcje ciche + intensywność sekcji 0,15–0,25 | Włącz Section-aware mastering |
| Deformacja kopnięcia / hihatsy się poszerzają | Limit per pasmo: obniż Sub/Low (kopnięcie) lub High/Very-high/Air (hihats) | Połącz z niższą siłą dopasowania stereo |
