"use strict";

// ---------------------------------------------------------------------------
// Go bridge with mock fallback. When the bound functions (injected by
// go-webview2) are missing (opened in a plain browser / Playwright), we
// fall back to mocks so the layout and interactions stay testable.
// ---------------------------------------------------------------------------
const HAS_GO = typeof window.plStartMastering === "function";

const bridge = {
  pickInputFiles: HAS_GO ? window.plPickInputFiles : async () =>
    ["C:\\Music\\demo track.wav", "C:\\Music\\second take.mp3"],
  pickOutputDir: HAS_GO ? window.plPickOutputDir : async () => "C:\\Users\\you\\Downloads",
  defaultOutputDir: HAS_GO ? window.plDefaultOutputDir : async () => "C:\\Users\\you\\Downloads",
  startMastering: HAS_GO ? window.plStartMastering : mockStartMastering,
  analyze: typeof window.plAnalyze === "function" ? window.plAnalyze : mockAnalyze,
  analyzeFull: typeof window.plAnalyzeFull === "function" ? window.plAnalyzeFull : mockAnalyzeFull,
  getReference: typeof window.plGetReference === "function" ? window.plGetReference : mockGetReference,
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
const baseName = (p) => p.replace(/^.*[\\/]/, "");

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
    limiterOnly: chk("limiterOnly"),
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
    for (const f of files) if (f && !state.inputs.includes(f)) state.inputs.push(f);
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
  const statusText = j.status === "processing" ? `${pct}%` : j.status;
  return `
    <div class="job-top">
      <span class="job-name" title="${j.input}">${baseName(j.input)}</span>
      <span class="job-status ${statusClass}">${statusText}</span>
    </div>
    <p class="job-out" title="${j.output}">→ ${j.output}${j.message ? " · " + j.message : ""}</p>
    <div class="job-bar"><div style="width:${pct}%"></div></div>`;
}

function renderJob(j) {
  state.jobs.set(j.id, j);
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
    fetchJobResult(j, node);
  }
  updateOverallProgress();
}

async function fetchJobResult(j, node) {
  const loadBar = document.createElement("div");
  loadBar.className = "job-result";
  loadBar.innerHTML = '<div class="bar-indeterminate" style="margin:4px 0 0"></div>';
  node.appendChild(loadBar);
  try {
    const [inResult, outResult] = await Promise.all([
      bridge.analyzeFull(j.input),
      bridge.analyzeFull(j.output),
    ]);
    loadBar.remove();
    if (!outResult) return;
    const panel = document.createElement("div");
    panel.className = "job-result";
    panel.innerHTML = renderJobResultHTML(inResult, outResult);
    node.appendChild(panel);
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

const SPECTRO_HELP = "A spectrogram shows how the track's frequency content evolves over time: " +
  "x = time (left to right), y = frequency (low at the bottom, high at the top), and brightness = " +
  "how much energy is present at that frequency and moment. Frequency ticks are approximate.";

// Wrap a spectrogram PNG with Time (x) / Frequency (y) axis labels and a help popover.
function spectroFigureHTML(src, caption, durationSec) {
  if (!src) return "";
  const dur = durationSec ? fmtSec(durationSec) : "";
  const help = caption ? "" : ` <button class="help" type="button" data-help="${SPECTRO_HELP}">?</button>`;
  const head = caption
    ? `<span class="spectro-title">${caption}</span>`
    : `<span class="spectro-title">Spectrogram</span>${help}`;
  return `<figure class="spectro-fig">
      <div class="spectro-head">${head}</div>
      <div class="spectro-body">
        <div class="spectro-yaxis"><span>20k</span><span>5k</span><span>1k</span><span>0&#8201;Hz</span></div>
        <img class="spectro" src="${src}" alt="Spectrogram${caption ? " " + caption : ""}" />
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
  ];
  const metricsHTML = `<table class="jr-metrics">
    <tr><th></th><th class="jr-col-in">Input</th><th class="jr-col-out">Output</th><th></th></tr>
    ${rows.map(([label, i, o, d]) => `<tr><td class="jr-label">${label}</td><td class="jr-val-in">${i}</td><td class="jr-val-out">${o}</td><td>${d}</td></tr>`).join("")}
  </table>`;
  const spectrosHTML = [
    spectroFigureHTML(inR?.spectrogramURL,  "Input",  inR?.totalSec),
    spectroFigureHTML(outR?.spectrogramURL, "Output", outR?.totalSec),
  ].join("");
  return `
    <div class="job-result-head">
      <span class="job-result-toggle">+</span>
      <span>Mastering comparison</span>
    </div>
    <div class="job-result-body hidden">
      ${metricsHTML}
      <div class="jr-chart-section"><span class="jr-chart-label">Per-band level</span><div class="jr-eq-canvas"></div></div>
      <div class="jr-chart-section"><span class="jr-chart-label">Loudness over time</span><div class="jr-loud-canvas"></div></div>
      ${spectrosHTML ? `<div class="jr-chart-section"><span class="jr-chart-label">Spectrogram <button class="help" type="button" data-help="${SPECTRO_HELP}">?</button></span>${spectrosHTML}</div>` : ""}
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
  const yMax = -4;
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

  // Band name labels
  EQ_BANDS.forEach((label, i) => {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", abX(i)); t.setAttribute("y", AB_H - 3);
    t.setAttribute("class", "ab-band-label");
    t.textContent = label;
    svg.appendChild(t);
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
    return;
  }

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

  // Click on chart: if playing → pause; if paused → seek + play
  svg.addEventListener("click", (e) => {
    if (e.target.classList.contains("sec-hit")) return;
    const audio = getAudio();
    if (!audio.paused) { audio.pause(); return; }
    const rect = svg.getBoundingClientRect();
    const sec = secSecFromX((e.clientX - rect.left) / rect.width * SEC_W);
    playfrom(sec);
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
  const src = "/local?path=" + encodeURIComponent(state.analyzedPath);
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
  try {
    const result = await bridge.analyzeFull(inputPath);
    if (result) {
      state.analyzedPath = inputPath;
      state.loudnessSeries = result.loudnessSeries || [];
      state.secTotalSec = result.totalSec
        || (state.loudnessSeries.length ? state.loudnessSeries[state.loudnessSeries.length - 1].sec : 0);
      state.sections = (result.sections || []).map(s => ({ startSec: s.startSec, endSec: s.endSec }));
      state.analysisBands = (result.bands && result.bands.length) ? result.bands : null;
      buildSectionsChart();
      buildSectionsList();
      renderAnalysisDrawer(result);
      el("analysisDrawer").classList.remove("hidden");
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
  el("analysisToggle").addEventListener("click", () => el("analysisDrawer").classList.toggle("hidden"));
  el("analysisClose").addEventListener("click", () => el("analysisDrawer").classList.add("hidden"));
  el("analysisEqEnable").addEventListener("change", (e) => {
    state.eqAnalysisEnabled = e.target.checked;
    if (e.target.checked && !state.analysisTarget) {
      state.analysisTarget = new Array(9).fill(0);  // start neutral (no modification)
    }
    updateAnalysisBandChart();
  });

  el("outputDir").value = (await bridge.defaultOutputDir()) || "";
  initReferenceProfile();
  afterFilesChanged();
  buildSectionsChart();
}

document.addEventListener("DOMContentLoaded", init);
