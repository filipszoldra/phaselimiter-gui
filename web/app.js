"use strict";

// ---------------------------------------------------------------------------
// Go bridge with mock fallback. When the bound functions (injected by
// go-webview2) are missing (opened in a plain browser / Playwright), we
// fall back to mocks so the layout and interactions stay testable.
// ---------------------------------------------------------------------------
const HAS_GO = typeof window.plStartMastering === "function";
const IS_SERVER = !!(window.__webServerMode);

// Analysis runs in a Go goroutine (the WebView2 UI thread invokes bound functions
// synchronously, so a blocking analyze would freeze the window). The bound function
// is fire-and-forget: we hand it a request id, and Go resolves the matching promise
// later via window.__plAnalyzeResolve. This keeps every `await bridge.analyze*` site working.
let _analyzeSeq = 0;
const _analyzePending = new Map();
window.__plAnalyzeResolve = (id, result, err) => {
  const p = _analyzePending.get(id);
  if (!p) return;
  _analyzePending.delete(id);
  err ? p.reject(new Error(err)) : p.resolve(result);
};
const wrapAnalyze = (fn) => (path) => new Promise((resolve, reject) => {
  const id = ++_analyzeSeq;
  _analyzePending.set(id, { resolve, reject });
  fn(id, path);
});

const bridge = {
  pickInputFiles: HAS_GO ? window.plPickInputFiles
    : IS_SERVER ? serverPickFiles
    : async () => ["C:\\Music\\demo track.wav", "C:\\Music\\second take.mp3"],
  pickOutputDir: HAS_GO ? window.plPickOutputDir
    : IS_SERVER ? async () => ""
    : async () => "C:\\Users\\you\\Downloads",
  defaultOutputDir: HAS_GO ? window.plDefaultOutputDir
    : IS_SERVER ? async () => ""
    : async () => "C:\\Users\\you\\Downloads",
  startMastering: HAS_GO ? window.plStartMastering
    : IS_SERVER ? serverStartMastering
    : mockStartMastering,
  analyze: typeof window.plAnalyze === "function" ? wrapAnalyze(window.plAnalyze)
    : IS_SERVER ? serverAnalyzeFull
    : mockAnalyze,
  analyzeFull: typeof window.plAnalyzeFull === "function" ? wrapAnalyze(window.plAnalyzeFull)
    : IS_SERVER ? serverAnalyzeFull
    : mockAnalyzeFull,
  getReference: typeof window.plGetReference === "function" ? window.plGetReference
    : IS_SERVER ? serverGetReference
    : mockGetReference,
};

const state = {
  inputs: [],
  outputDir: "",
  eqBands: [1, 1, 1, 1, 1, 1, 1, 1, 1],
  eqMode: "oba",                                  // global target: "sufit" | "transformacja" | "oba"
  eqBandModes: [null, null, null, null, null, null, null, null, null], // per-band override (null = inherit global)
  eqTransformSymmetric: false,                    // transform scales cuts too (else boost-only)
  sections: [],
  loudnessSeries: [],
  secTotalSec: 0,
  analyzedPath: "",
  jobs: new Map(),
  referenceProfile: null,    // RefProfile from plGetReference (9 bands from mastering_reference.json)
  analysisBands: null,       // BandSample[9] from last plAnalyze (null if audio_analyzer absent)
  analysisTarget: null,      // [9] per-band modification in dB (-12..+12, 0 = no change); null until EQ enabled
  eqAnalysisEnabled: false,  // whether EQ correction (--eq_analysis_target) will be sent to engine
};

// Effective target mode for band i (per-band override falls back to the global mode).
function eqBandMode(i) { return state.eqBandModes[i] || state.eqMode; }

// Route the single EQ curve into the two engine arrays per each band's mode:
//   sufit → {ceiling:v, transform:1}; transformacja → {ceiling:1, transform:v}; oba → both v.
function routeEqLevels() {
  const ceiling = [], transform = [];
  state.eqBands.forEach((v, i) => {
    const m = eqBandMode(i);
    ceiling.push(m === "transformacja" ? 1 : v);
    transform.push(m === "sufit" ? 1 : v);
  });
  return { ceiling, transform };
}

const el = (id) => document.getElementById(id);
const num = (id) => parseFloat(el(id).value);
const chk = (id) => el(id).checked;
const baseName = (p) => p instanceof File ? p.name : String(p).replace(/^.*[\\/]/, "");

const _jobStartTime    = new Map(); // jobId -> performance.now() when progress first > 0
const _jobBlobUrls     = new Map(); // jobId -> blob: URL of mastered output (cached immediately on success)
const _incomingChunks  = new Map(); // jobId -> base64 chunk array (assembled on file-done SSE event)

// ---------------------------------------------------------------------------
// Settings <-> live readouts
// ---------------------------------------------------------------------------
function bindReadout(id, outId, fmt) {
  const input = el(id), out = el(outId);
  const update = () => { out.textContent = fmt(parseFloat(input.value)); };
  input.addEventListener("input", update);
  update();
}

function setupReadouts() {
  bindReadout("loudness", "loudnessOut", (v) => `${v < 0 ? "–" : ""}${Math.abs(v).toFixed(0)} LUFS`);
  bindReadout("intensity", "intensityOut", (v) => v.toFixed(2));
  bindReadout("stereo", "stereoOut", (v) => v.toFixed(2));
  bindReadout("precompThreshold", "precompThresholdOut", (v) => `+${v.toFixed(1)} dB`);
  bindReadout("precompWindow", "precompWindowOut", (v) => `${v.toFixed(2)} s`);
  bindReadout("quality", "qualityOut", (v) => `${v.toFixed(0)}`);
  bindReadout("ceiling", "ceilingOut", (v) => `${v < 0 ? "–" : ""}${Math.abs(v).toFixed(1)} dB`);
  bindReadout("sectionIntensity", "sectionIntensityOut", (v) => v.toFixed(2));
}

function collectSettings() {
  const eq = routeEqLevels();
  return {
    outputName: el("outputName").value.trim(),
    loudness: num("loudness"),
    level: num("intensity"),
    bassPreservation: chk("preserveBass"),
    ceiling: num("ceiling"),
    limiterOversample: Math.round(parseFloat(el("oversample").value)),
    limiterMaxIter: Math.round(num("quality")),
    preCompression: chk("precomp"),
    preCompressionThreshold: num("precompThreshold"),
    preCompressionMeanSec: num("precompWindow"),
    msMatchingLevel: num("stereo"),
    eqBandLevels: eq.ceiling,
    eqTransformLevels: eq.transform,
    eqTransformSymmetric: state.eqTransformSymmetric,
    sections: state.sections,
    sectionIntensity: num("sectionIntensity"),
    sectionMasteringEnable: chk("sectionEnable"),
    eqAnalysisEnabled: state.eqAnalysisEnabled && !!state.analysisTarget && !!state.analysisBands,
    // analysisTarget IS the per-band modification (delta in dB). The engine scales it by
    // intensity and clamps the applied change to +/-6 dB internally (auto_mastering5.cpp).
    eqAnalysisTarget: state.analysisTarget ? state.analysisTarget.slice() : new Array(9).fill(0),
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function renderChips() {
  const wrap = el("fileChips");
  wrap.innerHTML = "";
  state.inputs.forEach((path, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span>${baseName(path)}</span>`;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.addEventListener("click", () => { state.inputs.splice(i, 1); afterFilesChanged(); });
    chip.appendChild(x);
    wrap.appendChild(chip);
  });
  el("dropHint").classList.toggle("hidden", state.inputs.length > 0);
}

function afterFilesChanged() {
  renderChips();
  // Prefill the output filename from the first/single file.
  const nameInput = el("outputName");
  if (state.inputs.length === 1) {
    const b = baseName(state.inputs[0]).replace(/\.[^.]+$/, "");
    nameInput.value = `${b}_output.wav`;
    nameInput.disabled = false;
  } else {
    nameInput.value = "";
    nameInput.placeholder = state.inputs.length > 1 ? "(auto per file)" : "track_output.wav";
    nameInput.disabled = state.inputs.length > 1;
  }
  // Auto-analyze first file when it changes (skip if already in flight).
  const first = state.inputs[0];
  if (first && first !== state.analyzedPath && !state._analyzeInFlight) {
    startAnalyze(first);
  }
}

async function addFiles() {
  const files = await bridge.pickInputFiles();
  if (Array.isArray(files) && files.length) {
    for (const f of files) {
      if (!f) continue;
      if (IS_SERVER || !state.inputs.includes(f)) state.inputs.push(f);
    }
    afterFilesChanged();
  }
}

// ---------------------------------------------------------------------------
// Mastering + queue
// ---------------------------------------------------------------------------
function jobRowHTML(j) {
  const statusClass = j.status === "processing" ? "processing"
    : j.status === "succeeded" ? "succeeded"
    : j.status === "failed" ? "failed" : "";
  const pct = Math.round((j.progress || 0) * 100);
  let statusText = j.status;
  if (j.status === "processing") {
    const p = j.progress || 0;
    const start = _jobStartTime.get(j.id);
    if (p > 0.02 && start != null) {
      const elapsed = (performance.now() - start) / 1000;
      const remaining = Math.ceil(elapsed * (1 - p) / p);
      const mins = Math.ceil(remaining / 60);
      statusText = mins >= 1 ? `${pct}% · ~${mins} min left` : `${pct}% · <1 min left`;
    } else {
      statusText = `${pct}%`;
    }
  }
  const downloadHref = _jobBlobUrls.get(j.id) || j.output || "";
  const outDisplay = IS_SERVER && j.status === "succeeded" && j.output
    ? `<a href="${downloadHref}" download="output.wav" class="job-download-link">⬇ Download</a>`
    : `→ ${j.output || ""}${j.message ? " · " + j.message : ""}`;
  const outClass = j.status === "failed" ? "job-out job-out-failed" : "job-out";
  return `
    <div class="job-top">
      <span class="job-name" title="${baseName(j.input)}">${baseName(j.input)}</span>
      <span class="job-status ${statusClass}">${statusText}</span>
    </div>
    <p class="${outClass}">${outDisplay}</p>
    <div class="job-bar"><div style="width:${pct}%"></div></div>`;
}

function renderJob(j) {
  state.jobs.set(j.id, j);
  if (j.status === "processing" && j.progress > 0 && !_jobStartTime.has(j.id)) {
    _jobStartTime.set(j.id, performance.now());
  }
  if (j.status !== "processing") _jobStartTime.delete(j.id);
  let node = document.querySelector(`.job[data-id="${j.id}"]`);
  const list = el("jobList");
  const empty = list.querySelector(".empty");
  if (empty) empty.remove();
  if (!node) {
    node = document.createElement("div");
    node.className = "job";
    node.dataset.id = j.id;
    list.prepend(node);
  }
  // Preserve result panel across re-renders caused by progress updates
  const savedResult = node.querySelector(".job-result");
  node.innerHTML = jobRowHTML(j);
  if (savedResult) node.appendChild(savedResult);

  if (j.status === "succeeded" && !node.dataset.resultFetched) {
    node.dataset.resultFetched = "1";
    // Fetch and cache output as blob immediately — before Cloud Run can replace the instance.
    // The Download link uses the cached blob URL so a future instance swap doesn't break it.
    if (IS_SERVER && j.output && !_jobBlobUrls.has(j.id)) cacheOutputBlob(j);
    fetchJobResult(j, node);
  }
  updateOverallProgress();
}

async function cacheOutputBlob(j) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      const resp = await fetch(j.output);
      if (!resp.ok) return; // 404 — token wygasł, retry bez sensu
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      _jobBlobUrls.set(j.id, blobUrl);
      const link = document.querySelector(`.job[data-id="${j.id}"] .job-download-link`);
      if (link) link.href = blobUrl;
      return;
    } catch (e) {
      if (attempt === 3) console.warn("output blob cache failed after retries:", e);
    }
  }
}

async function fetchJobResult(j, node) {
  const loadBar = document.createElement("div");
  loadBar.className = "job-result";
  loadBar.innerHTML = '<div class="bar-indeterminate" style="margin:4px 0 0"></div>';
  node.appendChild(loadBar);
  try {
    let inAnalyzePromise, outAnalyzePromise;
    let meta = null;
    if (IS_SERVER) {
      meta = _serverJobMeta.get(j.id);
      if (!meta || !meta.outputToken) { loadBar.remove(); return; }
      inAnalyzePromise = meta.inputAnalysisPromise || Promise.resolve(null);
      outAnalyzePromise = fetch("/api/analyze-by-token/" + meta.outputToken)
        .then(r => r.ok ? r.json() : null).catch(() => null)
        .then(async result => {
          if (result) return result;
          // Token lookup failed (wrong instance after deploy). Wait for the inline SSE blob
          // then re-upload it for analysis — gives us spectrograms + per-band data anyway.
          for (let i = 0; i < 90 && !_jobBlobUrls.has(j.id); i++) {
            await new Promise(r => setTimeout(r, 1000));
          }
          const blobUrl = _jobBlobUrls.get(j.id);
          if (!blobUrl) return null;
          try {
            const r = await fetch(blobUrl);
            const blob = await r.blob();
            return await bridge.analyzeFull(new File([blob], "output.wav"));
          } catch { return null; }
        });
    } else {
      inAnalyzePromise = bridge.analyzeFull(j.input);
      outAnalyzePromise = bridge.analyzeFull(j.output);
    }
    const [inResult, outResult] = await Promise.all([inAnalyzePromise, outAnalyzePromise]);
    loadBar.remove();
    if (!inResult && !outResult) return;
    const panel = document.createElement("div");
    panel.className = "job-result";
    panel.innerHTML = renderJobResultHTML(inResult, outResult);
    node.appendChild(panel);
    if (IS_SERVER && meta?.inputFile) {
      renderABPlayer(panel, meta.inputFile, _jobBlobUrls.get(j.id) || j.output, inResult, outResult);
    }
    renderJobCompareEQ(panel.querySelector(".jr-eq-canvas"), inResult, outResult);
    renderJobCompareLoudness(panel.querySelector(".jr-loud-canvas"), inResult, outResult);
    panel.querySelector(".job-result-head").addEventListener("click", () => {
      const body = panel.querySelector(".job-result-body");
      const tog = panel.querySelector(".job-result-toggle");
      body.classList.toggle("hidden");
      tog.textContent = body.classList.contains("hidden") ? "+" : "-";
    });
  } catch (e) {
    loadBar.remove();
    console.warn("analyze output failed:", e);
  }
}

function renderABPlayer(panel, inFile, outUrl, inResult, outResult) {
  const inLufs  = inResult?.globalLoudness  ?? null;
  const outLufs = outResult?.globalLoudness ?? null;
  // Gain to bring output to the same LUFS as input (input plays unmodified).
  const normOutGain = (inLufs != null && outLufs != null)
    ? Math.min(2.0, Math.pow(10, (inLufs - outLufs) / 20))
    : 1;
  const canNorm = inLufs != null && outLufs != null;

  let inSrc  = inFile instanceof File ? URL.createObjectURL(inFile) : String(inFile);
  const outSrc = String(outUrl);

  const normLabel = canNorm
    ? `Match output loudness to input (${inLufs.toFixed(1)} LUFS)`
    : "Normalize (no loudness data available)";

  const div = document.createElement("div");
  div.className = "abp";
  div.innerHTML = `
    <div class="abp-controls">
      <div class="abp-sel">
        <button class="abp-sel-btn active" data-which="in">Input</button>
        <button class="abp-sel-btn"        data-which="out">Output</button>
      </div>
      <button class="abp-play">▶</button>
      <input  class="abp-seek" type="range" min="0" max="100" step="0.1" value="0" />
      <span   class="abp-time">0:00</span>
    </div>
    <label class="abp-norm-row">
      <input class="abp-norm-chk" type="checkbox" ${canNorm ? "checked" : "disabled"} />
      <span class="abp-norm-label">${normLabel}</span>
    </label>`;

  // Insert between .job-result-head and .job-result-body
  panel.querySelector(".job-result-head").insertAdjacentElement("afterend", div);

  const audio   = new Audio();
  const playBtn = div.querySelector(".abp-play");
  const seekEl  = div.querySelector(".abp-seek");
  const timeEl  = div.querySelector(".abp-time");
  const normChk = div.querySelector(".abp-norm-chk");

  let actx = null, gainNode = null;
  let currentWhich = "in";
  let seeking = false;

  const ensureCtx = () => {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      gainNode = actx.createGain();
      actx.createMediaElementSource(audio).connect(gainNode);
      gainNode.connect(actx.destination);
    }
    return actx;
  };

  const applyGain = () => {
    if (!gainNode) return;
    gainNode.gain.value = (currentWhich === "out" && normChk.checked) ? normOutGain : 1;
  };

  const setSource = (which, keepTime) => {
    const wasTime    = keepTime ? audio.currentTime : 0;
    const wasPlaying = !audio.paused;
    audio.pause();
    currentWhich = which;
    audio.src = which === "in" ? inSrc : outSrc;
    audio.load();
    applyGain();
    audio.addEventListener("loadedmetadata", () => {
      audio.currentTime = Math.min(wasTime, audio.duration || 0);
      if (wasPlaying) audio.play().catch(() => {});
    }, { once: true });
    div.querySelectorAll(".abp-sel-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.which === which));
  };

  playBtn.addEventListener("click", () => {
    ensureCtx().resume();
    if (audio.paused) {
      if (!audio.src) setSource("in", false);
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });

  div.querySelectorAll(".abp-sel-btn").forEach(btn =>
    btn.addEventListener("click", () => setSource(btn.dataset.which, true)));

  normChk.addEventListener("change", applyGain);

  audio.addEventListener("play",  () => { playBtn.textContent = "⏸"; });
  audio.addEventListener("pause", () => { playBtn.textContent = "▶"; });
  audio.addEventListener("ended", () => {
    playBtn.textContent = "▶"; seekEl.value = 0;
    if (currentWhich === "out" && inSrc.startsWith("blob:")) { URL.revokeObjectURL(inSrc); inSrc = ""; }
  });

  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  audio.addEventListener("timeupdate", () => {
    if (seeking) return;
    const dur = audio.duration || 0;
    if (dur > 0) seekEl.value = (audio.currentTime / dur) * 100;
    timeEl.textContent = dur > 0 ? `${fmtT(audio.currentTime)} / ${fmtT(dur)}` : fmtT(audio.currentTime);
  });

  seekEl.addEventListener("mousedown",  () => { seeking = true; });
  seekEl.addEventListener("touchstart", () => { seeking = true; }, { passive: true });
  seekEl.addEventListener("input", () => {
    const dur = audio.duration || 0;
    if (dur > 0) audio.currentTime = (seekEl.value / 100) * dur;
  });
  seekEl.addEventListener("mouseup",  () => { seeking = false; });
  seekEl.addEventListener("touchend", () => { seeking = false; });

  setSource("in", false);
}

const SPECTRO_HELP = "A spectrogram shows how the track's frequency content evolves over time: " +
  "x = time (left to right), y = frequency (low at the bottom, high at the top), and brightness = " +
  "how much energy is present at that frequency and moment. Frequency ticks are approximate.";

// Wrap a spectrogram PNG with Time (x) / Frequency (y) axis labels and a help popover.
function spectroFigureHTML(src, caption, durationSec) {
  if (!src) return "";
  const dur = durationSec ? fmtSec(durationSec) : "";
  const help = caption ? "" : ` <button class="help" type="button" data-help="${SPECTRO_HELP}">?</button>`;
  const head = `<span class="spectro-title">${caption || "Spectrogram"}</span>${help}`
    + ` <button class="spectro-zoom" type="button" title="Enlarge">⤢</button>`;
  return `<figure class="spectro-fig">
      <div class="spectro-head">${head}</div>
      <div class="spectro-body">
        <div class="spectro-yaxis"><span>20k</span><span>5k</span><span>1k</span><span>0&#8201;Hz</span></div>
        <img class="spectro" src="${src}" data-duration="${durationSec || 0}" alt="Spectrogram${caption ? " " + caption : ""}" onerror="const f=this.closest('.spectro-fig');if(f)f.hidden=true" />
      </div>
      <div class="spectro-xaxis"><span>0:00</span><span>Time</span><span>${dur}</span></div>
    </figure>`;
}

function renderJobResultHTML(inR, outR) {
  const fmt1 = (v, unit) => v != null ? `${v.toFixed(1)}${unit}` : "n/a";
  const delta = (a, b, unit) => {
    if (a == null || b == null) return "";
    const d = b - a;
    const sign = d >= 0 ? "+" : "";
    return `<span class="jr-delta ${d >= 0 ? "pos" : "neg"}">${sign}${d.toFixed(1)}${unit}</span>`;
  };
  const rows = [
    ["LUFS",      fmt1(inR?.globalLoudness, ""),   fmt1(outR?.globalLoudness, ""),   delta(inR?.globalLoudness, outR?.globalLoudness, "")],
    ["True-peak", fmt1(inR?.truePeak, " dBTP"),    fmt1(outR?.truePeak, " dBTP"),    ""],
    ["LRA",       fmt1(inR?.loudnessRange, " LU"), fmt1(outR?.loudnessRange, " LU"), delta(inR?.loudnessRange, outR?.loudnessRange, " LU")],
    ["Dynamics",  fmt1(inR?.dynamics, " dB"),      fmt1(outR?.dynamics, " dB"),      delta(inR?.dynamics, outR?.dynamics, " dB")],
  ];
  const metricsHTML = `<table class="jr-metrics">
    <tr><th></th><th class="jr-col-in">Input</th><th class="jr-col-out">Output</th><th></th></tr>
    ${rows.map(([label, i, o, d]) => `<tr><td class="jr-label">${label}</td><td class="jr-val-in">${i}</td><td class="jr-val-out">${o}</td><td>${d}</td></tr>`).join("")}
  </table>`;
  const spectrosHTML = [
    spectroFigureHTML(inR?.spectrogramURL,  "Input",  inR?.totalSec),
    spectroFigureHTML(outR?.spectrogramURL, "Output", outR?.totalSec),
  ].filter(Boolean).join("");
  return `
    <div class="job-result-head">
      <span class="job-result-toggle">-</span>
      <span>Input / Output comparison</span>
    </div>
    <div class="job-result-body">
      ${metricsHTML}
      <div class="jr-chart-section"><span class="jr-chart-label">Per-band level</span><div class="jr-eq-canvas"></div></div>
      <div class="jr-chart-section"><span class="jr-chart-label">Loudness over time</span><div class="jr-loud-canvas"></div></div>
      ${spectrosHTML ? `<div class="jr-chart-section"><span class="jr-chart-label">Spectrogram <button class="help" type="button" data-help="${SPECTRO_HELP}">?</button></span><div class="jr-spectro-pair">${spectrosHTML}</div></div>` : ""}
    </div>`;
}

function renderJobCompareEQ(container, inR, outR) {
  if (!container) return;
  const inBands  = inR?.bands  || inR?.analysisBands;
  const outBands = outR?.bands || outR?.analysisBands;
  if (!inBands?.length && !outBands?.length) { container.innerHTML = '<p class="muted" style="font-size:11px">No band data</p>'; return; }
  const allBands = [...(inBands || []), ...(outBands || [])];
  const allDb = allBands.map(b => b.loudness).filter(v => v != null);
  const yMin = Math.floor((Math.min(...allDb) - 3) / 5) * 5;
  const yMax = allDb.length ? Math.min(-4, Math.ceil((Math.max(...allDb) + 3) / 5) * 5) : -4;
  const W = 320, H = 110, PL = 32, PR = 6, PT = 8, PB = 22;
  const CW = W - PL - PR, CH = H - PT - PB;
  const xOf = i => PL + (i / 8) * CW;
  const yOf = db => PT + CH * (1 - (db - yMin) / (yMax - yMin));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.add("ab-svg");
  [-60,-50,-40,-30,-20,-10].forEach(db => {
    if (db < yMin || db > yMax) return;
    const y = yOf(db);
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", PL); ln.setAttribute("x2", W - PR);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("class", "ab-guide");
    svg.appendChild(ln);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", PL - 3); t.setAttribute("y", y);
    t.setAttribute("class", "ab-scale"); t.textContent = db;
    svg.appendChild(t);
  });
  const drawLine = (bands, cls, dotCls, r) => {
    if (!bands?.length) return;
    const pts = bands.map((b, i) => `${xOf(i).toFixed(1)},${yOf(b.loudness).toFixed(1)}`).join(" ");
    const pl = document.createElementNS(ns, "polyline");
    pl.setAttribute("points", pts); pl.setAttribute("class", cls);
    svg.appendChild(pl);
    bands.forEach((b, i) => {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("cx", xOf(i)); c.setAttribute("cy", yOf(b.loudness)); c.setAttribute("r", r);
      c.setAttribute("class", dotCls);
      svg.appendChild(c);
    });
  };
  drawLine(inBands,  "ab-curve-input",  "ab-dot-input",        2.5);
  drawLine(outBands, "jr-curve-out",    "jr-dot-out",          2.5);
  // Per-band change (output - input) in dB, printed above each band
  if (inBands?.length && outBands?.length) {
    EQ_BANDS.forEach((_, i) => {
      const iv = inBands[i]?.loudness, ov = outBands[i]?.loudness;
      if (iv == null || ov == null) return;
      const d = ov - iv;
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", xOf(i));
      t.setAttribute("y", (Math.min(yOf(iv), yOf(ov)) - 4).toFixed(1));
      t.setAttribute("class", "ab-delta " + (d >= 0 ? "pos" : "neg"));
      t.textContent = (d >= 0 ? "+" : "") + d.toFixed(1);
      svg.appendChild(t);
    });
  }
  EQ_BANDS.forEach((label, i) => {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", xOf(i)); t.setAttribute("y", H - 3);
    t.setAttribute("class", "ab-band-label"); t.textContent = label;
    svg.appendChild(t);
  });
  container.appendChild(svg);
}

function renderJobCompareLoudness(container, inR, outR) {
  if (!container) return;
  const inS  = inR?.loudnessSeries;
  const outS = outR?.loudnessSeries;
  if (!inS?.length && !outS?.length) { container.innerHTML = '<p class="muted" style="font-size:11px">No loudness data</p>'; return; }
  const allSec = Math.max(inR?.totalSec || 0, outR?.totalSec || 0) || 210;
  const allDb  = [...(inS||[]), ...(outS||[])].map(p => p.db).filter(v => v != null);
  const yMin = Math.floor((Math.min(...allDb) - 2) / 5) * 5;
  const yMax = Math.ceil((Math.max(...allDb) + 2) / 5) * 5;
  const W = 320, H = 80, PL = 30, PR = 6, PT = 6, PB = 18;
  const CW = W - PL - PR, CH = H - PT - PB;
  const xOf = sec => PL + (sec / allSec) * CW;
  const yOf = db  => PT + CH * (1 - (db - yMin) / (yMax - yMin));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.add("ab-svg");
  [yMin, Math.round((yMin + yMax) / 2), yMax].forEach(db => {
    const y = yOf(db);
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", PL); ln.setAttribute("x2", W - PR);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("class", "ab-guide"); svg.appendChild(ln);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", PL - 3); t.setAttribute("y", y);
    t.setAttribute("class", "ab-scale"); t.textContent = db;
    svg.appendChild(t);
  });
  const drawSeries = (series, cls) => {
    if (!series?.length) return;
    const pts = series.map(p => `${xOf(p.sec).toFixed(1)},${yOf(p.db).toFixed(1)}`).join(" ");
    const pl = document.createElementNS(ns, "polyline");
    pl.setAttribute("points", pts); pl.setAttribute("class", cls);
    svg.appendChild(pl);
  };
  drawSeries(inS,  "jr-loud-in");
  drawSeries(outS, "jr-loud-out");
  // Legend in top-right corner
  [{ label: "Output", cls: "jr-loud-out", xEnd: W - PR }, { label: "Input", cls: "jr-loud-in", xEnd: W - PR - 46 }].forEach(({ label, cls, xEnd }) => {
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", xEnd - 12); ln.setAttribute("x2", xEnd);
    ln.setAttribute("y1", PT + 4); ln.setAttribute("y2", PT + 4);
    ln.setAttribute("class", cls); svg.appendChild(ln);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", xEnd - 14); t.setAttribute("y", PT + 7);
    t.setAttribute("class", "ab-scale"); t.setAttribute("text-anchor", "end");
    t.textContent = label; svg.appendChild(t);
  });
  [0, Math.round(allSec / 2), allSec].forEach(sec => {
    const x = xOf(sec);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", x); t.setAttribute("y", H - 3);
    t.setAttribute("class", "ab-band-label");
    t.setAttribute("text-anchor", sec === 0 ? "start" : sec === allSec ? "end" : "middle");
    t.textContent = fmtSec(sec);
    svg.appendChild(t);
  });
  container.appendChild(svg);
}

function updateOverallProgress() {
  const jobs = [...state.jobs.values()];
  const strip = el("progressStrip");
  if (!jobs.length) {
    el("progressFill").style.width = "0%";
    el("progressLabel").textContent = "Idle";
    strip.classList.add("hidden");
    return;
  }
  const processing = jobs.find(j => j.status === "processing");
  const finished = jobs.filter(j => j.status !== "processing" && j.status !== "waiting").length;
  const total = jobs.length;

  if (!processing) {
    const succeeded = jobs.filter(j => j.status === "succeeded").length;
    el("progressFill").style.width = finished === total ? "100%" : "0%";
    el("progressLabel").textContent = finished === total
      ? `Done: ${succeeded}/${total} succeeded`
      : "Queued...";
    if (finished === total) setTimeout(() => strip.classList.add("hidden"), 1500);
    return;
  }
  strip.classList.remove("hidden");
  const pct = Math.round((processing.progress || 0) * 100);
  el("progressFill").style.width = `${pct}%`;
  el("progressLabel").textContent = `Song ${finished + 1}/${total} - ${baseName(processing.input)}`;
}

window.plOnJobUpdate = (j) => renderJob(j);

async function startMastering() {
  if (!state.inputs.length) { flash(el("addFilesBtn")); return; }
  el("progressStrip").classList.remove("hidden");
  const req = { inputs: state.inputs, outputDir: el("outputDir").value, settings: collectSettings() };
  const views = await bridge.startMastering(req);
  if (Array.isArray(views)) views.forEach(renderJob);
}

function flash(node) {
  node.animate(
    [{ boxShadow: "0 0 0 0 rgba(214,64,159,.6)" }, { boxShadow: "0 0 0 8px rgba(214,64,159,0)" }],
    { duration: 600 }
  );
}

// ---------------------------------------------------------------------------
// Mock mastering (browser/Playwright only)
// ---------------------------------------------------------------------------
function mockStartMastering(req) {
  return new Promise((resolve) => {
    const views = req.inputs.map((inp, i) => ({
      id: i, input: inp,
      output: `${req.outputDir}\\${baseName(inp).replace(/\.[^.]+$/, "")}_output.wav`,
      status: "waiting", progress: 0, message: "",
    }));
    views.forEach((v, idx) => {
      let p = 0;
      setTimeout(() => {
        const t = setInterval(() => {
          p += 0.08;
          if (p >= 1) { window.plOnJobUpdate({ ...v, status: "succeeded", progress: 1 }); clearInterval(t); }
          else window.plOnJobUpdate({ ...v, status: "processing", progress: p });
        }, 180);
      }, idx * 400);
    });
    resolve(views);
  });
}

// ---------------------------------------------------------------------------
// Mock analysis (browser / Playwright only)
// ---------------------------------------------------------------------------
function mockAnalysisData() {
  const totalSec = 210;
  const series = [];
  for (let t = 0; t <= totalSec; t += 0.5) {
    let db;
    if (t < 18)       db = -36 + (t / 18) * 14;
    else if (t < 48)  db = -18 + Math.sin((t - 18) * 0.4) * 3;
    else if (t < 78)  db = -12 + Math.sin((t - 48) * 0.3) * 2;
    else if (t < 108) db = -17 + Math.sin((t - 78)  * 0.4) * 2.5;
    else if (t < 138) db = -11 + Math.sin((t - 108) * 0.3) * 2;
    else if (t < 163) db = -22 + Math.sin((t - 138) * 0.5) * 4;
    else if (t < 195) db = -10 + Math.sin((t - 163) * 0.25) * 2;
    else              db = -12 - ((t - 195) / 15) * 24;
    db += (Math.random() - 0.5) * 1.5;
    series.push({ sec: t, db: Math.max(-46, Math.min(-6, db)) });
  }
  return {
    totalSec,
    loudnessSeries: series,
    sections: [
      { startSec: 0,   endSec: 17  },
      { startSec: 136, endSec: 162 },
      { startSec: 196, endSec: 210 },
    ],
    globalLoudness: -10.5,
    bands: [
      { lowFreq: 0,     highFreq: 148,   loudness: -24.2, midMean: -20.1, sideMean: -48.0 },
      { lowFreq: 148,   highFreq: 392,   loudness: -22.8, midMean: -19.5, sideMean: -32.1 },
      { lowFreq: 392,   highFreq: 795,   loudness: -24.6, midMean: -21.8, sideMean: -33.4 },
      { lowFreq: 795,   highFreq: 1458,  loudness: -25.3, midMean: -22.9, sideMean: -30.5 },
      { lowFreq: 1458,  highFreq: 2550,  loudness: -25.8, midMean: -23.4, sideMean: -28.2 },
      { lowFreq: 2550,  highFreq: 4349,  loudness: -26.9, midMean: -24.6, sideMean: -29.7 },
      { lowFreq: 4349,  highFreq: 7314,  loudness: -28.4, midMean: -26.2, sideMean: -32.1 },
      { lowFreq: 7314,  highFreq: 12199, loudness: -30.1, midMean: -28.0, sideMean: -35.3 },
      { lowFreq: 12199, highFreq: 22050, loudness: -33.5, midMean: -31.4, sideMean: -39.8 },
    ],
  };
}

function mockAnalyze() {
  return new Promise(resolve => setTimeout(() => resolve(mockAnalysisData()), 700));
}

function mockAnalyzeFull(path) {
  return new Promise(resolve => setTimeout(() => {
    const base = mockAnalysisData();
    resolve({
      ...base,
      truePeak: -0.8,
      loudnessRange: 6.2,
      dynamics: 3.1,
      sharpness: 1.2,
      space: -3.5,
      sampleRate: 44100,
      peak: -0.5,
      spectrogramURL: "",
    });
  }, 1800));
}

function mockGetReference() {
  return Promise.resolve({
    bands: [
      { lowFreq: 0,     highFreq: 148,   loudness: -21.5, midMean: -17.9, sideMean: -45.0 },
      { lowFreq: 148,   highFreq: 392,   loudness: -20.9, midMean: -17.7, sideMean: -29.4 },
      { lowFreq: 392,   highFreq: 795,   loudness: -22.1, midMean: -19.2, sideMean: -31.0 },
      { lowFreq: 795,   highFreq: 1458,  loudness: -22.8, midMean: -20.1, sideMean: -28.5 },
      { lowFreq: 1458,  highFreq: 2550,  loudness: -23.2, midMean: -21.0, sideMean: -26.1 },
      { lowFreq: 2550,  highFreq: 4349,  loudness: -24.1, midMean: -21.9, sideMean: -27.3 },
      { lowFreq: 4349,  highFreq: 7314,  loudness: -25.6, midMean: -23.4, sideMean: -29.8 },
      { lowFreq: 7314,  highFreq: 12199, loudness: -27.3, midMean: -25.1, sideMean: -32.4 },
      { lowFreq: 12199, highFreq: 22050, loudness: -30.1, midMean: -28.2, sideMean: -36.0 },
    ],
    loudness: -7.42,
  });
}

// ---------------------------------------------------------------------------
// Server mode bridge (window.__webServerMode = true)
// ---------------------------------------------------------------------------
const _serverJobMeta = new Map(); // jobId → { inputFile, outputToken }

function serverPickFiles() {
  return new Promise((resolve) => {
    const input = document.getElementById("fileInput");
    input.onchange = () => {
      const files = Array.from(input.files || []);
      input.value = "";
      resolve(files.length ? files : []);
    };
    input.click();
  });
}

async function serverGetReference() {
  const resp = await fetch("/api/reference");
  if (!resp.ok) throw new Error("getReference failed: " + resp.status);
  return resp.json();
}

// Split file into chunks and upload to /api/upload-chunk.
// Returns the fileToken once all chunks are assembled server-side.
const CHUNK_SIZE = 24 * 1024 * 1024; // 24 MB — safely under Cloud Run's 32 MB request limit

async function uploadFileChunked(file) {
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  let sessionId = "";
  let fileToken = "";
  const ext = file.name.includes(".") ? "." + file.name.split(".").pop() : ".wav";

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_SIZE;
    const chunk = file.slice(start, start + CHUNK_SIZE);
    const resp = await fetch("/api/upload-chunk", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Session-ID": sessionId,
        "X-Chunk-Index": String(i),
        "X-Total-Chunks": String(total),
        "X-File-Ext": ext,
      },
      body: chunk,
    });
    if (!resp.ok) throw new Error("upload chunk " + i + " failed: " + resp.status + " " + await resp.text());
    const data = await resp.json();
    sessionId = data.sessionId || sessionId;
    if (data.fileToken) fileToken = data.fileToken;
  }
  if (!fileToken) throw new Error("upload did not return fileToken");
  return fileToken;
}

async function serverAnalyzeFull(fileOrPath) {
  let form;
  if (fileOrPath instanceof File) {
    const tok = await uploadFileChunked(fileOrPath);
    form = new FormData();
    form.append("fileToken", tok);
  } else if (typeof fileOrPath === "string" && fileOrPath.startsWith("/api/")) {
    // Output file already on server — fetch and re-upload only if not a download token
    const r = await fetch(fileOrPath);
    if (!r.ok) throw new Error("fetch file: " + r.status);
    const blob = await r.blob();
    const tok = await uploadFileChunked(new File([blob], "audio.wav"));
    form = new FormData();
    form.append("fileToken", tok);
  } else {
    throw new Error("serverAnalyzeFull: unsupported input " + typeof fileOrPath);
  }
  const resp = await fetch("/api/analyze", { method: "POST", body: form });
  if (!resp.ok) throw new Error("analyze failed: " + resp.status + " " + await resp.text());
  return resp.json();
}

async function serverStartMastering(req) {
  // Jobs are processed sequentially in the background; rendering via window.plOnJobUpdate.
  (async () => {
    for (const file of req.inputs) {
      await _streamOneMasterJob(file, req.settings).catch((err) => {
        alert("Master failed: " + err.message);
      });
    }
  })();
  return [];
}

async function _streamOneMasterJob(file, settings) {
  const label = el("progressLabel");
  if (label) label.textContent = "Uploading " + baseName(file) + "…";
  const fileToken = await uploadFileChunked(file);
  if (label) label.textContent = "Queuing…";
  const form = new FormData();
  form.append("fileToken", fileToken);
  form.append("fileName", file.name || "input.wav");
  form.append("settings", JSON.stringify(settings));

  const resp = await fetch("/api/master", { method: "POST", body: form });
  if (!resp.ok) throw new Error("master request failed: " + resp.status + " " + await resp.text());

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastId = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by double newlines; split on them.
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const evt of events) {
        for (const line of evt.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const jv = JSON.parse(line.slice(6));

            // File-chunk: accumulate base64 data from inline SSE transfer.
            if (jv.type === "file-chunk") {
              let chunks = _incomingChunks.get(jv.id);
              if (!chunks) { chunks = []; _incomingChunks.set(jv.id, chunks); }
              chunks[jv.index] = jv.data;
              continue;
            }

            // File-done: assemble all chunks into a blob URL.
            if (jv.type === "file-done") {
              const chunks = _incomingChunks.get(jv.id);
              _incomingChunks.delete(jv.id);
              if (chunks && chunks.length > 0) {
                try {
                  const combined = chunks.join("");
                  const raw = atob(combined);
                  const bytes = new Uint8Array(raw.length);
                  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                  const blob = new Blob([bytes], { type: "audio/wav" });
                  const url = URL.createObjectURL(blob);
                  _jobBlobUrls.set(jv.id, url);
                  const link = document.querySelector(`.job[data-id="${jv.id}"] .job-download-link`);
                  if (link) link.href = url;
                } catch (assembleErr) {
                  console.warn("file-done assembly failed:", assembleErr);
                }
              }
              continue; // wait for input-analysis SSE event before closing
            }

            // Input-analysis: server finished analyzing the original file inline.
            if (jv.type === "input-analysis") {
              const meta = _serverJobMeta.get(lastId);
              if (meta?.resolveInputAnalysis) meta.resolveInputAnalysis(jv.inputAnalysis || null);
              return; // end of SSE stream
            }

            lastId = jv.id;
            // Set metadata BEFORE plOnJobUpdate so fetchJobResult can read it synchronously.
            if (jv.status === "succeeded") {
              const tok = jv.output ? jv.output.replace("/api/download/", "") : null;
              let resolveInputAnalysis;
              const inputAnalysisPromise = new Promise(resolve => {
                resolveInputAnalysis = resolve;
                setTimeout(() => resolve(null), 10000);
              });
              _serverJobMeta.set(jv.id, { inputFile: file, outputToken: tok, inputAnalysisPromise, resolveInputAnalysis });
            }
            window.plOnJobUpdate(jv);
            // Do NOT return after succeeded — wait for file-done (file data streams next).
            if (jv.status === "failed") return;
          } catch (_) {}
        }
      }
    }
  // Stream ended without explicit input-analysis handler — resolve with null so
  // fetchJobResult is not held up by the 10-second timeout.
  if (lastId !== null) {
    const meta = _serverJobMeta.get(lastId);
    if (meta?.resolveInputAnalysis) meta.resolveInputAnalysis(null);
  }
  } catch (err) {
    if (lastId !== null) {
      const meta = _serverJobMeta.get(lastId);
      if (meta?.resolveInputAnalysis) meta.resolveInputAnalysis(null);
      window.plOnJobUpdate({ id: lastId, status: "failed", progress: 0, message: String(err) });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Drag & drop (WebView2 may not expose real paths; picker is the primary path)
// ---------------------------------------------------------------------------
function setupDnd() {
  const dz = el("dropzone");
  ["dragenter", "dragover"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (ev) => {
    const paths = [];
    for (const f of ev.dataTransfer.files || []) if (f.path) paths.push(f.path);
    if (paths.length) { for (const p of paths) if (!state.inputs.includes(p)) state.inputs.push(p); afterFilesChanged(); }
  });
}

// ---------------------------------------------------------------------------
// EQ Curve (Phase C) -- SVG, 9 draggable dots, catmull-rom smoothed
// ---------------------------------------------------------------------------
const EQ_BANDS = ["Sub", "Low", "Lo-mid", "Mid", "Up-mid", "Pres", "High", "V-hi", "Air"];
const EQ_HZ   = ["75", "240", "560", "1.1k", "2k", "3.3k", "5.6k", "9.5k", ">12k"];
const EQ_W = 540, EQ_H = 164;
const EQ_PL = 8, EQ_PR = 28, EQ_PT = 20, EQ_PB = 46;
const EQ_CW = EQ_W - EQ_PL - EQ_PR;
const EQ_CH = EQ_H - EQ_PT - EQ_PB;

function eqX(i) { return EQ_PL + (i / 8) * EQ_CW; }
function eqY(v) { return EQ_PT + EQ_CH * (1 - v / 2); }   // 0..2, 1=neutral
function eqVfromY(y) { return Math.max(0, Math.min(2, (1 - (y - EQ_PT) / EQ_CH) * 2)); }

function eqSmooth(pts) {
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
    const p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6, cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6, cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)},${cp2x.toFixed(1)} ${cp2y.toFixed(1)},${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

let _eqDotEls = [], _eqValEls = [], _eqPathEl = null, _eqAreaEl = null, _eqSvgEl = null;

function initEQ() {
  const container = el("eqCurve");
  container.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${EQ_W} ${EQ_H}`);
  svg.classList.add("eq-svg");
  _eqSvgEl = svg;

  // horizontal guides at 0, 0.5, 1, 1.5, 2
  [0, 0.5, 1, 1.5, 2].forEach(v => {
    const ln = document.createElementNS(ns, "line");
    const y = eqY(v);
    ln.setAttribute("x1", EQ_PL); ln.setAttribute("x2", EQ_W - EQ_PR);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("class", v === 1 ? "eq-guide eq-neutral" : "eq-guide");
    svg.appendChild(ln);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", EQ_W - EQ_PR + 5); t.setAttribute("y", y);
    t.setAttribute("class", "eq-scale");
    t.textContent = v === 1 ? "1" : v.toFixed(1);
    svg.appendChild(t);
  });

  // pink smooth curve (user's intent)
  const path = document.createElementNS(ns, "path");
  path.setAttribute("class", "eq-curve");
  svg.appendChild(path);
  _eqPathEl = path;

  // dots + hits + labels per band
  _eqDotEls = []; _eqValEls = [];
  state.eqBands.forEach((db, i) => {
    const cx = eqX(i), cy = eqY(db);

    const hit = document.createElementNS(ns, "circle");
    hit.setAttribute("cx", cx); hit.setAttribute("cy", cy); hit.setAttribute("r", "16");
    hit.setAttribute("class", "eq-hit");

    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("r", "7");
    dot.setAttribute("class", "eq-dot");

    const valTxt = document.createElementNS(ns, "text");
    valTxt.setAttribute("x", cx); valTxt.setAttribute("y", (cy - 12).toFixed(1));
    valTxt.setAttribute("class", "eq-val");
    valTxt.textContent = "";

    const bandTxt = document.createElementNS(ns, "text");
    bandTxt.setAttribute("x", cx); bandTxt.setAttribute("y", EQ_H - 22);
    bandTxt.setAttribute("class", "eq-band-label eq-band-name");
    bandTxt.textContent = EQ_BANDS[i];

    const hzTxt = document.createElementNS(ns, "text");
    hzTxt.setAttribute("x", cx); hzTxt.setAttribute("y", EQ_H - 8);
    hzTxt.setAttribute("class", "eq-band-label eq-hz");
    hzTxt.textContent = EQ_HZ[i];

    svg.appendChild(dot);
    svg.appendChild(valTxt);
    svg.appendChild(bandTxt);
    svg.appendChild(hzTxt);
    svg.appendChild(hit);
    _eqDotEls.push({ hit, dot });
    _eqValEls.push(valTxt);

    let dragging = false;
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault(); dragging = true;
      hit.setPointerCapture(e.pointerId);
      dot.classList.add("active");
    });
    hit.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const rawY = (e.clientY - rect.top) / rect.height * EQ_H;
      const newV = Math.round(eqVfromY(rawY) * 20) / 20;  // snap to 0.05
      if (state.eqBands[i] === newV) return;
      state.eqBands[i] = newV;
      updateEQ();
    });
    hit.addEventListener("pointerup", () => { dragging = false; dot.classList.remove("active"); });
    hit.addEventListener("dblclick", () => { state.eqBands[i] = 1; updateEQ(); });
  });

  container.appendChild(svg);
  updateEQ();
}

function updateEQ() {
  const pts = state.eqBands.map((v, i) => ({ x: eqX(i), y: eqY(v) }));
  _eqPathEl.setAttribute("d", eqSmooth(pts));

  _eqDotEls.forEach(({ hit, dot }, i) => {
    const v = state.eqBands[i];
    const cx = eqX(i), cy = eqY(v);
    hit.setAttribute("cx", cx); hit.setAttribute("cy", cy);
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
    _eqValEls[i].setAttribute("x", cx);
    _eqValEls[i].setAttribute("y", (cy > eqY(1.5) ? cy - 12 : cy + 18).toFixed(1));
    if (Math.abs(v - 1) >= 0.05) {
      _eqValEls[i].textContent = `×${v.toFixed(2)}`;
      _eqValEls[i].removeAttribute("visibility");
    } else {
      _eqValEls[i].setAttribute("visibility", "hidden");
    }
  });
}

// EQ target mode: global select + advanced per-band overrides + symmetric toggle.
function setupEQModes() {
  el("eqMode").addEventListener("change", (e) => { state.eqMode = e.target.value; });
  el("eqTransformSymmetric").addEventListener("change", (e) => { state.eqTransformSymmetric = e.target.checked; });

  const wrap = el("eqBandModes");
  wrap.innerHTML = "";
  EQ_BANDS.forEach((label, i) => {
    const row = document.createElement("label");
    row.className = "eq-band-mode";
    const name = document.createElement("span");
    name.textContent = label;
    const sel = document.createElement("select");
    [["", "global"], ["sufit", "Ceiling"], ["transformacja", "Transform"], ["oba", "Both"]]
      .forEach(([val, txt]) => {
        const o = document.createElement("option");
        o.value = val; o.textContent = txt;
        sel.appendChild(o);
      });
    sel.value = state.eqBandModes[i] || "";
    sel.addEventListener("change", (e) => { state.eqBandModes[i] = e.target.value || null; });
    row.appendChild(name);
    row.appendChild(sel);
    wrap.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Analysis band chart — per-band spectrum (red=input, blue=target draggable)
// ---------------------------------------------------------------------------
const AB_W = 320, AB_H = 160;
const AB_PL = 34, AB_PR = 8, AB_PT = 10, AB_PB = 28;
const AB_CW = AB_W - AB_PL - AB_PR;
const AB_CH = AB_H - AB_PT - AB_PB;
let AB_DB_MIN = -42, AB_DB_MAX = -4;

function fmtHz(hz) {
  if (hz >= 1000) return (hz / 1000).toFixed(hz < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return Math.round(hz) + "";
}
// Representative center frequency for a band, derived from the analyzer's actual edges when
// present (geometric mean, low edge floored at 20 Hz), else the canonical EQ_HZ fallback.
function bandHzLabel(band, i) {
  if (band && band.highFreq) {
    const lo = band.lowFreq > 20 ? band.lowFreq : 20;
    return fmtHz(Math.sqrt(lo * band.highFreq));
  }
  return EQ_HZ[i];
}

function abX(i) { return AB_PL + (i / 8) * AB_CW; }
function abY(db) { return AB_PT + AB_CH * (1 - (db - AB_DB_MIN) / (AB_DB_MAX - AB_DB_MIN)); }
function abDbFromY(y) {
  return Math.max(AB_DB_MIN, Math.min(AB_DB_MAX,
    AB_DB_MIN + (1 - (y - AB_PT) / AB_CH) * (AB_DB_MAX - AB_DB_MIN)));
}

let _abBlueDots = [], _abBlueLine = null, _abDeltaLabels = [], _abBlueHits = [];
let _abPredictLine = null, _abPredictFill = null;

// Predicted applied change per band: modification * intensity, clamped to +/-6 dB (mirrors the
// engine's clamp((delta - normalized_change) * mastering_level, -6, +6) in auto_mastering5.cpp).
function abPredictDb(i) {
  const mod = state.analysisTarget?.[i] ?? 0;
  const intensity = num("intensity");
  return Math.max(-6, Math.min(6, mod * intensity));
}

function initAnalysisBandChart() {
  const container = el("analysisBandChart");
  container.innerHTML = "";
  const bands = state.analysisBands;
  if (!bands || !bands.length) {
    container.innerHTML = '<p class="muted" style="font-size:12px;margin:16px 0">No per-band data — audio_analyzer not available.</p>';
    _abBlueDots = []; _abBlueLine = null; _abDeltaLabels = []; _abBlueHits = [];
    _abPredictLine = null; _abPredictFill = null;
    return;
  }

  // Modifications default to 0 (neutral) unless the user already set some this session.
  if (!state.analysisTarget) state.analysisTarget = bands.map(() => 0);

  // Dynamic Y range: fit input + max boost headroom with 3 dB margin, snapped to 5 dB grid
  const minData = Math.min(...bands.map(b => b.loudness));
  AB_DB_MIN = Math.floor((minData - 3) / 5) * 5;
  AB_DB_MAX = -4;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${AB_W} ${AB_H}`);
  svg.classList.add("ab-svg");

  // Y axis guide lines
  [-65, -60, -55, -50, -45, -40, -35, -30, -25, -20, -15, -10, -5].forEach(db => {
    if (db < AB_DB_MIN || db > AB_DB_MAX) return;
    const y = abY(db);
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", AB_PL); ln.setAttribute("x2", AB_W - AB_PR);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("class", "ab-guide");
    svg.appendChild(ln);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", AB_PL - 3); t.setAttribute("y", y);
    t.setAttribute("class", "ab-scale");
    t.textContent = db;
    svg.appendChild(t);
  });

  // Red input polyline
  const redPts = bands.map((b, i) => ({ x: abX(i), y: abY(b.loudness) }));
  const redLine = document.createElementNS(ns, "polyline");
  redLine.setAttribute("points", redPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
  redLine.setAttribute("class", "ab-curve-input");
  svg.appendChild(redLine);

  redPts.forEach((p, i) => {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("r", 3);
    dot.setAttribute("class", "ab-dot-input");
    svg.appendChild(dot);
  });

  // Predicted-effect fill + dashed curve (red), drawn under the pink target line.
  const predictFill = document.createElementNS(ns, "path");
  predictFill.setAttribute("class", "ab-predict-fill" + (state.eqAnalysisEnabled ? "" : " hidden"));
  svg.appendChild(predictFill);
  _abPredictFill = predictFill;

  const predictLine = document.createElementNS(ns, "polyline");
  predictLine.setAttribute("class", "ab-curve-predict" + (state.eqAnalysisEnabled ? "" : " hidden"));
  svg.appendChild(predictLine);
  _abPredictLine = predictLine;

  // Pink target polyline (= input + modification; hidden until EQ enabled)
  const blueLine = document.createElementNS(ns, "polyline");
  blueLine.setAttribute("class", "ab-curve-target" + (state.eqAnalysisEnabled ? "" : " hidden"));
  svg.appendChild(blueLine);
  _abBlueLine = blueLine;
  _abBlueDots = [];
  _abDeltaLabels = [];
  _abBlueHits = [];

  bands.forEach((_, i) => {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("r", 4);
    dot.setAttribute("class", "ab-dot-target" + (state.eqAnalysisEnabled ? "" : " hidden"));
    svg.appendChild(dot);
    _abBlueDots.push(dot);

    const delta = document.createElementNS(ns, "text");
    delta.setAttribute("class", "ab-delta" + (state.eqAnalysisEnabled ? "" : " hidden"));
    svg.appendChild(delta);
    _abDeltaLabels.push(delta);

    const hit = document.createElementNS(ns, "circle");
    hit.setAttribute("r", 14);
    hit.setAttribute("class", "ab-dot-hit" + (state.eqAnalysisEnabled ? "" : " hidden"));
    svg.appendChild(hit);
    _abBlueHits.push(hit);

    let dragging = false;
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault(); dragging = true;
      hit.setPointerCapture(e.pointerId);
      dot.classList.add("active");
    });
    hit.addEventListener("pointermove", (e) => {
      if (!dragging || !state.analysisTarget) return;
      const rect = svg.getBoundingClientRect();
      const rawY = (e.clientY - rect.top) / rect.height * AB_H;
      // Pink dot sits at input + modification; the dragged absolute level minus input = modification.
      const inputDb = state.analysisBands[i].loudness;
      const newMod = Math.max(-12, Math.min(12, Math.round((abDbFromY(rawY) - inputDb) * 10) / 10));
      if (state.analysisTarget[i] === newMod) return;
      state.analysisTarget[i] = newMod;
      updateAnalysisBandChart();
    });
    hit.addEventListener("pointerup", () => { dragging = false; dot.classList.remove("active"); });
    hit.addEventListener("dblclick", () => {
      if (state.analysisTarget) {
        state.analysisTarget[i] = 0;  // reset band to neutral (no modification)
        updateAnalysisBandChart();
      }
    });
  });

  // Band name + representative frequency labels
  EQ_BANDS.forEach((label, i) => {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", abX(i)); t.setAttribute("y", AB_H - 13);
    t.setAttribute("class", "ab-band-label");
    t.textContent = label;
    svg.appendChild(t);
    const hz = document.createElementNS(ns, "text");
    hz.setAttribute("x", abX(i)); hz.setAttribute("y", AB_H - 3);
    hz.setAttribute("class", "ab-band-hz");
    hz.textContent = bandHzLabel(bands[i], i);
    svg.appendChild(hz);
  });

  container.appendChild(svg);
  updateAnalysisBandChart();
}

function updateAnalysisBandChart() {
  if (!_abBlueLine) return;
  const mods  = state.analysisTarget;
  const bands = state.analysisBands;
  const show  = state.eqAnalysisEnabled && !!mods;

  const toggleClass = (el, cls, show) => {
    if (show) el.classList.remove(cls); else el.classList.add(cls);
  };
  toggleClass(_abBlueLine, "hidden", show);
  toggleClass(_abPredictLine, "hidden", show);
  toggleClass(_abPredictFill, "hidden", show);
  _abBlueDots.forEach(d => toggleClass(d, "hidden", show));
  _abDeltaLabels.forEach(d => toggleClass(d, "hidden", show));
  _abBlueHits.forEach(d => toggleClass(d, "hidden", show));

  if (!show || !mods || !bands) return;

  // Pink = input + modification (at rest mods are 0, so pink lies on the red input curve).
  const pinkPts    = bands.map((b, i) => ({ x: abX(i), y: abY(b.loudness + mods[i]) }));
  const inputPts   = bands.map((b, i) => ({ x: abX(i), y: abY(b.loudness) }));
  // Dashed red = input + predicted applied change (modification * intensity, clamped +/-6 dB).
  const predictPts = bands.map((b, i) => ({ x: abX(i), y: abY(b.loudness + abPredictDb(i)) }));

  _abBlueLine.setAttribute("points", pinkPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
  _abPredictLine.setAttribute("points", predictPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));

  // Red fill band between predicted curve (top) and input curve (bottom), closed polygon.
  const fillD = "M " + predictPts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")
    + " L " + inputPts.slice().reverse().map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ")
    + " Z";
  _abPredictFill.setAttribute("d", fillD);

  pinkPts.forEach((p, i) => {
    _abBlueDots[i].setAttribute("cx", p.x); _abBlueDots[i].setAttribute("cy", p.y);
    _abBlueHits[i].setAttribute("cx", p.x); _abBlueHits[i].setAttribute("cy", p.y);

    const mod = mods[i];
    const lbl = _abDeltaLabels[i];
    if (Math.abs(mod) >= 0.05) {
      lbl.setAttribute("x", p.x);
      lbl.setAttribute("y", (Math.min(p.y, abY(bands[i].loudness)) - 5).toFixed(1));
      lbl.textContent = (mod >= 0 ? "+" : "") + mod.toFixed(1);
      lbl.setAttribute("class", "ab-delta " + (mod >= 0 ? "pos" : "neg"));
    } else {
      lbl.setAttribute("class", "ab-delta hidden");
    }
  });
}

// ---------------------------------------------------------------------------
// Sections chart (Phase D) — loudness-by-time + draggable section boundaries
// ---------------------------------------------------------------------------
const SEC_W = 540, SEC_H = 110;
const SEC_PL = 32, SEC_PR = 8, SEC_PT = 12, SEC_PB = 22;
const SEC_CW = SEC_W - SEC_PL - SEC_PR;   // 500
const SEC_CH = SEC_H - SEC_PT - SEC_PB;   // 76
const SEC_DB_MIN = -42, SEC_DB_MAX = -6;

function fmtSec(s) {
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(1);
  return `${m}:${sec.padStart(4, "0")}`;
}
function parseSec(str) {
  const p = (str || "0").trim().split(":");
  return p.length === 2 ? parseFloat(p[0]) * 60 + parseFloat(p[1]) : parseFloat(p[0]) || 0;
}

function secX(sec) { return SEC_PL + (sec / (state.secTotalSec || 1)) * SEC_CW; }
function secY(db)  { return SEC_PT + SEC_CH * (1 - (db - SEC_DB_MIN) / (SEC_DB_MAX - SEC_DB_MIN)); }
function secSecFromX(x) {
  const tot = state.secTotalSec || 1;
  return Math.max(0, Math.min(tot, (x - SEC_PL) / SEC_CW * tot));
}

let _secSvg = null;
let _secHandleEls = [];
let _secDrawMode = false;

function buildSectionsChart() {
  const ns = "http://www.w3.org/2000/svg";
  const container = el("sectionsChart");
  container.innerHTML = "";
  _secHandleEls = [];

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${SEC_W} ${SEC_H}`);
  svg.classList.add("sec-svg");
  _secSvg = svg;

  if (!state.loudnessSeries.length) {
    const pBg = document.createElementNS(ns, "rect");
    pBg.setAttribute("x", "1"); pBg.setAttribute("y", "1");
    pBg.setAttribute("width", SEC_W - 2); pBg.setAttribute("height", SEC_H - 2);
    pBg.setAttribute("rx", "6"); pBg.setAttribute("class", "sec-placeholder-bg");
    svg.appendChild(pBg);
    const msg = document.createElementNS(ns, "text");
    msg.setAttribute("x", SEC_W / 2); msg.setAttribute("y", SEC_H / 2);
    msg.setAttribute("class", "sec-empty");
    msg.textContent = "Run Analyze to see loudness timeline & auto-detected sections";
    svg.appendChild(msg);
    container.appendChild(svg);
    el("secAddRow")?.classList.add("hidden");
    return;
  }

  el("secAddRow")?.classList.remove("hidden");
  if (_secDrawMode) svg.classList.add("draw-mode");

  // Background
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("x", "0"); bg.setAttribute("y", "0");
  bg.setAttribute("width", SEC_W); bg.setAttribute("height", SEC_H);
  bg.setAttribute("rx", "6"); bg.setAttribute("class", "sec-bg");
  svg.appendChild(bg);

  // Horizontal guides at -10, -20, -30, -40 LUFS
  [-10, -20, -30, -40].forEach(db => {
    const y = secY(db);
    if (y < SEC_PT - 2 || y > SEC_PT + SEC_CH + 2) return;
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", SEC_PL); ln.setAttribute("x2", SEC_W - SEC_PR);
    ln.setAttribute("y1", y.toFixed(1)); ln.setAttribute("y2", y.toFixed(1));
    ln.setAttribute("class", "sec-guide");
    svg.appendChild(ln);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", SEC_PL - 4); t.setAttribute("y", y.toFixed(1));
    t.setAttribute("class", "sec-guide-label");
    t.textContent = String(db);
    svg.appendChild(t);
  });

  // Time labels
  const total = state.secTotalSec;
  const step = total > 180 ? 60 : total > 90 ? 30 : 15;
  for (let s = 0; s <= total; s += step) {
    const x = secX(s);
    const min = Math.floor(s / 60), srem = s % 60;
    const label = srem === 0 ? `${min}m` : `${min}:${String(srem).padStart(2, "0")}`;
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", x.toFixed(1)); t.setAttribute("y", (SEC_H - 4).toFixed(1));
    t.setAttribute("class", "sec-time-label");
    t.textContent = label;
    svg.appendChild(t);
  }

  // Loudness curve
  let d = "";
  state.loudnessSeries.forEach((pt, i) => {
    const x = secX(pt.sec).toFixed(1), y = secY(pt.db).toFixed(1);
    d += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
  });
  const curve = document.createElementNS(ns, "path");
  curve.setAttribute("d", d); curve.setAttribute("class", "sec-curve");
  svg.appendChild(curve);

  // Section shade areas (below handles in z-order)
  const shadeEls = state.sections.map(sec => {
    const x1 = secX(sec.startSec), x2 = secX(sec.endSec);
    const shade = document.createElementNS(ns, "rect");
    shade.setAttribute("x", x1.toFixed(1)); shade.setAttribute("y", String(SEC_PT));
    shade.setAttribute("width", (x2 - x1).toFixed(1)); shade.setAttribute("height", String(SEC_CH));
    shade.setAttribute("class", "sec-shade");
    svg.appendChild(shade);
    return shade;
  });

  // Section handles (rendered after shades = on top)
  state.sections.forEach((sec, si) => {
    const groupEls = { shade: shadeEls[si] };

    ["start", "end"].forEach((which) => {
      const xPos = secX(which === "start" ? sec.startSec : sec.endSec);

      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", xPos.toFixed(1)); line.setAttribute("x2", xPos.toFixed(1));
      line.setAttribute("y1", String(SEC_PT)); line.setAttribute("y2", String(SEC_PT + SEC_CH));
      line.setAttribute("class", "sec-line");
      svg.appendChild(line);

      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", xPos.toFixed(1)); dot.setAttribute("cy", String(SEC_PT + 8));
      dot.setAttribute("r", "7"); dot.setAttribute("class", "sec-handle");
      svg.appendChild(dot);

      // Invisible wide hit rect (18px, full height) — on top for events
      const hit = document.createElementNS(ns, "rect");
      hit.setAttribute("x", (xPos - 9).toFixed(1)); hit.setAttribute("y", String(SEC_PT));
      hit.setAttribute("width", "18"); hit.setAttribute("height", String(SEC_CH));
      hit.setAttribute("class", "sec-hit");
      svg.appendChild(hit);

      groupEls[which] = { line, dot, hit };

      let dragging = false;
      hit.addEventListener("pointerdown", (e) => {
        e.preventDefault(); dragging = true;
        hit.setPointerCapture(e.pointerId);
        dot.classList.add("active");
      });
      hit.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = svg.getBoundingClientRect();
        const rawX = (e.clientX - rect.left) / rect.width * SEC_W;
        let newSec = secSecFromX(rawX);
        if (which === "start") {
          state.sections[si].startSec = Math.round(Math.min(state.sections[si].endSec - 1, newSec) * 10) / 10;
        } else {
          state.sections[si].endSec = Math.round(Math.max(state.sections[si].startSec + 1, Math.min(state.secTotalSec, newSec)) * 10) / 10;
        }
        updateSectionPos(si);
      });
      hit.addEventListener("pointerup", () => { dragging = false; dot.classList.remove("active"); buildSectionsList(); });
      hit.addEventListener("pointerenter", () => { if (!dragging) dot.classList.add("active"); });
      hit.addEventListener("pointerleave", () => { if (!dragging) dot.classList.remove("active"); });
      hit.addEventListener("dblclick", (e) => {
        e.preventDefault();
        state.sections.splice(si, 1);
        buildSectionsChart();
      });
    });

    _secHandleEls.push(groupEls);
  });

  // Playhead line (on top of everything)
  const phLine = document.createElementNS(ns, "line");
  phLine.setAttribute("y1", String(SEC_PT)); phLine.setAttribute("y2", String(SEC_PT + SEC_CH));
  phLine.setAttribute("x1", "0"); phLine.setAttribute("x2", "0");
  phLine.setAttribute("class", "sec-playhead");
  phLine.setAttribute("visibility", "hidden");
  svg.appendChild(phLine);
  _playheadEl = phLine;

  // Click on chart: if playing → pause; if paused → seek + play (skipped in draw mode)
  svg.addEventListener("click", (e) => {
    if (_secDrawMode) return;
    if (e.target.classList.contains("sec-hit")) return;
    const audio = getAudio();
    if (!audio.paused) { audio.pause(); return; }
    const rect = svg.getBoundingClientRect();
    const sec = secSecFromX((e.clientX - rect.left) / rect.width * SEC_W);
    playfrom(sec);
  });

  // Drag on SVG background in draw mode creates a new section
  let _drawStartSec = null, _drawEl = null, _drawMoved = false;
  svg.addEventListener("pointerdown", (e) => {
    if (!_secDrawMode) return;
    if (e.target.classList.contains("sec-hit")) return;
    e.preventDefault(); e.stopPropagation();
    svg.setPointerCapture(e.pointerId);
    const rect = svg.getBoundingClientRect();
    _drawStartSec = secSecFromX((e.clientX - rect.left) / rect.width * SEC_W);
    _drawMoved = false;
    _drawEl = document.createElementNS(ns, "rect");
    _drawEl.setAttribute("class", "sec-shade sec-drawing");
    _drawEl.setAttribute("x", secX(_drawStartSec).toFixed(1));
    _drawEl.setAttribute("y", String(SEC_PT));
    _drawEl.setAttribute("width", "1");
    _drawEl.setAttribute("height", String(SEC_CH));
    svg.appendChild(_drawEl);
  });
  svg.addEventListener("pointermove", (e) => {
    if (_drawStartSec === null || !_drawEl) return;
    _drawMoved = true;
    const rect = svg.getBoundingClientRect();
    const curSec = secSecFromX((e.clientX - rect.left) / rect.width * SEC_W);
    const s = Math.min(_drawStartSec, curSec);
    const end = Math.max(_drawStartSec, curSec);
    _drawEl.setAttribute("x", secX(s).toFixed(1));
    _drawEl.setAttribute("width", Math.max(1, secX(end) - secX(s)).toFixed(1));
  });
  svg.addEventListener("pointerup", (e) => {
    if (_drawStartSec === null) return;
    const rect = svg.getBoundingClientRect();
    const curSec = secSecFromX((e.clientX - rect.left) / rect.width * SEC_W);
    if (_drawMoved && Math.abs(curSec - _drawStartSec) >= 1) {
      const s = Math.round(Math.min(_drawStartSec, curSec) * 10) / 10;
      const end = Math.round(Math.max(_drawStartSec, curSec) * 10) / 10;
      state.sections.push({ startSec: s, endSec: end });
      _secDrawMode = false;
      const btn = el("addSectionBtn"); if (btn) btn.textContent = "+ Draw section";
      const hint = el("addSectionHint"); if (hint) hint.textContent = "";
      buildSectionsChart();
      buildSectionsList();
    } else {
      if (_drawEl) _drawEl.remove();
    }
    _drawStartSec = null; _drawEl = null; _drawMoved = false;
  });

  container.appendChild(svg);
}

function updateSectionPos(si) {
  const sec = state.sections[si];
  const els = _secHandleEls[si];
  const x1 = secX(sec.startSec), x2 = secX(sec.endSec);

  els.shade.setAttribute("x", x1.toFixed(1));
  els.shade.setAttribute("width", (x2 - x1).toFixed(1));

  ["start", "end"].forEach((which) => {
    const x = which === "start" ? x1 : x2;
    const { line, dot, hit } = els[which];
    line.setAttribute("x1", x.toFixed(1)); line.setAttribute("x2", x.toFixed(1));
    dot.setAttribute("cx", x.toFixed(1));
    hit.setAttribute("x", (x - 9).toFixed(1));
  });
}

// ---------------------------------------------------------------------------
// Section list (below chart) + audio preview + playhead
// ---------------------------------------------------------------------------
let _previewAudio = null;
let _playheadEl = null;
let _rafId = null;

function getAudio() {
  if (!_previewAudio) {
    _previewAudio = new Audio();
    _previewAudio.addEventListener("play",  refreshPlayBtns);
    _previewAudio.addEventListener("pause", refreshPlayBtns);
    _previewAudio.addEventListener("ended", refreshPlayBtns);
  }
  return _previewAudio;
}

function refreshPlayBtns() {
  const audio = getAudio();
  const playing = !audio.paused;
  document.querySelectorAll(".sec-play-btn").forEach(btn => {
    const si = +btn.dataset.si;
    const sec = state.sections[si];
    if (!sec) return;
    const inSection = playing && audio.currentTime >= sec.startSec && audio.currentTime <= sec.endSec;
    btn.textContent = inSection ? "⏸" : "▶";
  });
  const globalBtn = el("secPlayBtn");
  if (globalBtn) globalBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
  if (!playing) {
    el("secPlayheadTime").textContent = state.analyzedPath ? fmtSec(audio.currentTime) : "";
  }
}

function animatePlayhead() {
  const audio = getAudio();
  if (_playheadEl && _secSvg && state.secTotalSec > 0) {
    if (!audio.paused) {
      const x = secX(audio.currentTime).toFixed(1);
      _playheadEl.setAttribute("x1", x); _playheadEl.setAttribute("x2", x);
      _playheadEl.setAttribute("visibility", "visible");
      el("secPlayheadTime").textContent = fmtSec(audio.currentTime);
      refreshPlayBtns();
    } else {
      _playheadEl.setAttribute("visibility", "hidden");
    }
  }
  _rafId = requestAnimationFrame(animatePlayhead);
}

function playfrom(sec) {
  if (!state.analyzedPath) return;
  const audio = getAudio();
  let src;
  if (IS_SERVER && state.analyzedPath instanceof File) {
    if (!state._analyzedObjectURL) {
      state._analyzedObjectURL = URL.createObjectURL(state.analyzedPath);
    }
    src = state._analyzedObjectURL;
  } else if (IS_SERVER && typeof state.analyzedPath === "string" && state.analyzedPath.startsWith("/api/")) {
    src = state.analyzedPath;
  } else {
    src = "/local?path=" + encodeURIComponent(state.analyzedPath);
  }
  if (audio.getAttribute("data-src") !== src) {
    audio.src = src;
    audio.setAttribute("data-src", src);
  }
  // Toggle pause if already playing near this position (within 2s).
  if (!audio.paused && Math.abs(audio.currentTime - sec) < 2) {
    audio.pause();
    return;
  }
  audio.currentTime = sec;
  audio.play();
  el("secPlayRow").classList.remove("hidden");
  if (!_rafId) animatePlayhead();
}

function buildSectionsList() {
  const list = el("sectionsList");
  list.innerHTML = "";
  if (!state.sections.length) return;

  const tbl = document.createElement("table");
  tbl.className = "sec-table";
  state.sections.forEach((sec, i) => {
    const dur = (sec.endSec - sec.startSec).toFixed(1);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="sec-num">${i + 1}</td>` +
      `<td><input class="sec-time-input" data-si="${i}" data-field="startSec" value="${fmtSec(sec.startSec)}" /></td>` +
      `<td class="muted" style="padding:0 4px">–</td>` +
      `<td><input class="sec-time-input" data-si="${i}" data-field="endSec" value="${fmtSec(sec.endSec)}" /></td>` +
      `<td class="muted sec-dur">${dur}s</td>` +
      `<td><button class="btn tiny sec-play-btn" data-si="${i}">▶</button></td>` +
      `<td><button class="btn tiny sec-del-btn" data-si="${i}">×</button></td>`;
    tbl.appendChild(tr);
  });
  list.appendChild(tbl);

  list.querySelectorAll(".sec-time-input").forEach(inp => {
    inp.addEventListener("change", () => {
      const si = +inp.dataset.si, field = inp.dataset.field;
      let v = Math.max(0, Math.min(state.secTotalSec, parseSec(inp.value)));
      if (field === "startSec") v = Math.min(v, state.sections[si].endSec - 1);
      if (field === "endSec")   v = Math.max(v, state.sections[si].startSec + 1);
      state.sections[si][field] = v;
      inp.value = fmtSec(v);
      updateSectionPos(si);
      buildSectionsList();
    });
  });
  list.querySelectorAll(".sec-play-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const si = +btn.dataset.si;
      const audio = getAudio();
      const sec = state.sections[si];
      // If playing inside this section → pause; else play from start.
      if (!audio.paused && audio.currentTime >= sec.startSec && audio.currentTime <= sec.endSec) {
        audio.pause();
      } else {
        playfrom(sec.startSec);
      }
    });
  });
  list.querySelectorAll(".sec-del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.sections.splice(+btn.dataset.si, 1);
      buildSectionsChart();
      buildSectionsList();
    });
  });
  refreshPlayBtns();
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------
async function startAnalyze(forcePath) {
  let inputPath = forcePath || state.inputs[0] || "";
  if (HAS_GO && !inputPath) {
    const picked = await bridge.pickInputFiles();
    if (!picked || !picked.length) return;
    inputPath = picked[0];
  }
  if (!inputPath) return;

  state._analyzeInFlight = true;
  const btn = el("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing...";
  el("analysisProgress").classList.remove("hidden");
  // Open the drawer immediately with a loading note so user knows it's running
  el("analysisMetrics").innerHTML = `<div class="analysis-loading-note">Analyzing track — this may take a few minutes...</div>`;
  el("analysisMetrics").classList.remove("hidden");
  el("analysisSpectro").innerHTML = "";
  el("analysisSpectro").classList.add("hidden");
  openAnalysisDrawer();
  try {
    const result = await bridge.analyzeFull(inputPath);
    if (result) {
      if (state._analyzedObjectURL) { URL.revokeObjectURL(state._analyzedObjectURL); state._analyzedObjectURL = null; }
      state.analyzedPath = inputPath;
      state.loudnessSeries = result.loudnessSeries || [];
      state.secTotalSec = result.totalSec
        || (state.loudnessSeries.length ? state.loudnessSeries[state.loudnessSeries.length - 1].sec : 0);
      state.sections = (result.sections || []).map(s => ({ startSec: s.startSec, endSec: s.endSec }));
      state.analysisBands = (result.bands && result.bands.length) ? result.bands : null;
      buildSectionsChart();
      buildSectionsList();
      renderAnalysisDrawer(result);
      openAnalysisDrawer();
    }
  } catch (err) {
    alert("Analyze failed: " + err);
  } finally {
    state._analyzeInFlight = false;
    el("analysisProgress").classList.add("hidden");
    btn.disabled = false;
    btn.textContent = "Analyze";
  }
}

function renderAnalysisDrawer(result) {
  // Extended metrics in the drawer
  const metricsEl = el("analysisMetrics");
  const parts = [];
  if (result.globalLoudness) parts.push(`<div class="metric-row"><span>Loudness</span><strong>${result.globalLoudness.toFixed(1)} LUFS</strong></div>`);
  if (result.truePeak)       parts.push(`<div class="metric-row"><span>True-peak</span><strong>${result.truePeak.toFixed(1)} dBTP</strong></div>`);
  if (result.loudnessRange)  parts.push(`<div class="metric-row"><span>LRA</span><strong>${result.loudnessRange.toFixed(1)} LU</strong></div>`);
  if (result.dynamics)       parts.push(`<div class="metric-row"><span>Dynamics</span><strong>${result.dynamics.toFixed(1)} dB</strong></div>`);
  if (result.totalSec)       parts.push(`<div class="metric-row"><span>Duration</span><strong>${fmtSec(result.totalSec)}</strong></div>`);
  if (result.sampleRate)     parts.push(`<div class="metric-row"><span>Sample rate</span><strong>${(result.sampleRate / 1000).toFixed(1)} kHz</strong></div>`);
  if (parts.length) {
    metricsEl.innerHTML = parts.join("");
    metricsEl.classList.remove("hidden");
  } else {
    metricsEl.classList.add("hidden");
  }

  // Spectrogram with axis labels + help
  const spectroEl = el("analysisSpectro");
  if (result.spectrogramURL) {
    spectroEl.innerHTML = spectroFigureHTML(result.spectrogramURL, "", result.totalSec);
    spectroEl.classList.remove("hidden");
  } else {
    spectroEl.innerHTML = "";
    spectroEl.classList.add("hidden");
  }

  // Per-band chart now lives in card 2
  initAnalysisBandChart();

  // Show EQ enable row only when bands available
  el("analysisEqRow").classList.toggle("hidden", !state.analysisBands);
}

// ---------------------------------------------------------------------------
// Help popovers
// ---------------------------------------------------------------------------
function setupHelp() {
  let activePop = null;
  let activeBtn = null;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".help");
    if (activePop) { activePop.remove(); activePop = null; }
    if (!btn || btn === activeBtn) { activeBtn = null; return; }
    activeBtn = btn;
    const pop = document.createElement("div");
    pop.className = "help-pop";
    pop.textContent = btn.dataset.help;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 252))}px`;
    activePop = pop;
  });
}

// Spectrogram lightbox: click a spectrogram (or its enlarge button) to view the
// native-resolution PNG full-window with Hz and time axis labels.
// Close via backdrop, the close button, or Esc.
function setupSpectroLightbox() {
  const box = el("spectroLightbox");
  if (!box) return;
  const content = el("spectroLightboxContent");

  const open = (src, alt, durationSec) => {
    const dur = durationSec ? fmtSec(durationSec) : "";
    content.innerHTML = `
      <div class="spectro-body lb-body">
        <div class="spectro-yaxis lb-yaxis"><span>20k</span><span>10k</span><span>5k</span><span>2k</span><span>1k</span><span>500</span><span>200</span><span>0&#8201;Hz</span></div>
        <img class="spectro lb-img" src="${src}" alt="${alt || "Spectrogram (full size)"}" />
      </div>
      <div class="spectro-xaxis lb-xaxis"><span>0:00</span><span>Time</span><span>${dur}</span></div>`;
    box.classList.remove("hidden");
  };
  const close = () => { box.classList.add("hidden"); content.innerHTML = ""; };

  document.addEventListener("click", (e) => {
    const fig = e.target.closest(".spectro-fig");
    if (fig && (e.target.closest(".spectro-zoom") || e.target.matches(".spectro-body img.spectro"))) {
      const figImg = fig.querySelector(".spectro-body img.spectro");
      if (figImg && figImg.src) open(figImg.src, figImg.alt, parseFloat(figImg.dataset.duration || "0"));
      return;
    }
    // Click on backdrop or close button dismisses
    if (e.target === box || e.target.id === "spectroLightboxClose") close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.classList.contains("hidden")) close();
  });
}

// ---------------------------------------------------------------------------
// Section draw-mode toggle (activated by the Add section button)
// ---------------------------------------------------------------------------
function setupSectionDraw() {
  const btn = el("addSectionBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    _secDrawMode = !_secDrawMode;
    btn.textContent = _secDrawMode ? "✕ Cancel" : "+ Draw section";
    const hint = el("addSectionHint");
    if (hint) hint.textContent = _secDrawMode ? "Drag on the timeline to mark a section" : "";
    // Rebuild so SVG picks up draw-mode class immediately
    buildSectionsChart();
  });
}

// ---------------------------------------------------------------------------
// Analysis drawer open/close (overlay mode — click outside to close)
// ---------------------------------------------------------------------------
function openAnalysisDrawer() {
  el("analysisDrawer").classList.remove("hidden");
  let bd = document.getElementById("analysisBackdrop");
  if (!bd) {
    bd = document.createElement("div");
    bd.id = "analysisBackdrop";
    bd.className = "analysis-backdrop";
    bd.addEventListener("click", closeAnalysisDrawer);
    document.body.appendChild(bd);
  }
  bd.classList.remove("hidden");
}
function closeAnalysisDrawer() {
  el("analysisDrawer").classList.add("hidden");
  const bd = document.getElementById("analysisBackdrop");
  if (bd) bd.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
async function initReferenceProfile() {
  try {
    state.referenceProfile = await bridge.getReference();
  } catch (e) {
    console.warn("plGetReference failed:", e);
  }
}

async function init() {
  setupReadouts();
  setupDnd();
  setupHelp();
  setupSpectroLightbox();
  setupSectionDraw();
  initEQ();
  setupEQModes();
  el("addFilesBtn").addEventListener("click", addFiles);
  el("browseDirBtn").addEventListener("click", async () => {
    const d = await bridge.pickOutputDir();
    if (d) el("outputDir").value = d;
  });
  el("masterBtn").addEventListener("click", startMastering);
  el("analyzeBtn").addEventListener("click", () => startAnalyze());
  el("secPlayBtn").addEventListener("click", () => {
    const audio = getAudio();
    if (audio.paused) { audio.play(); } else { audio.pause(); }
  });
  el("eqReset").addEventListener("click", () => {
    state.eqBands = state.eqBands.map(() => 1);
    updateEQ();
  });
  // Intensity drives the per-band optimizer curve and the EQ predicted-effect overlay.
  el("intensity").addEventListener("input", () => {
    if (_eqPathEl) updateEQ();
    if (_abBlueLine) updateAnalysisBandChart();
  });
  el("analysisToggle").addEventListener("click", () => {
    if (el("analysisDrawer").classList.contains("hidden")) openAnalysisDrawer();
    else closeAnalysisDrawer();
  });
  el("analysisClose").addEventListener("click", closeAnalysisDrawer);

  el("analysisEqEnable").addEventListener("change", (e) => {
    state.eqAnalysisEnabled = e.target.checked;
    if (e.target.checked && !state.analysisTarget) {
      state.analysisTarget = new Array(9).fill(0);  // start neutral (no modification)
    }
    updateAnalysisBandChart();
  });

  if (IS_SERVER) {
    const outRow = el("outputDir").closest(".field-row");
    if (outRow) outRow.style.display = "none";
    const docsLink = document.getElementById("docsLink");
    if (docsLink) docsLink.style.display = "";
  } else {
    el("outputDir").value = (await bridge.defaultOutputDir()) || "";
  }
  initReferenceProfile();
  afterFilesChanged();
  buildSectionsChart();
}

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("beforeunload", () => {
  for (const url of _jobBlobUrls.values()) URL.revokeObjectURL(url);
});
