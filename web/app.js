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
  node.innerHTML = jobRowHTML(j);
  updateOverallProgress();
}

function updateOverallProgress() {
  const jobs = [...state.jobs.values()];
  const active = jobs.filter((j) => j.status === "processing" || j.status === "waiting");
  const strip = el("progressStrip");
  if (!active.length) {
    const done = jobs.filter((j) => j.status === "succeeded").length;
    el("progressFill").style.width = jobs.length ? "100%" : "0%";
    el("progressLabel").textContent = jobs.length ? `Done: ${done}/${jobs.length} succeeded` : "Idle";
    if (jobs.length) setTimeout(() => strip.classList.add("hidden"), 1500);
    return;
  }
  strip.classList.remove("hidden");
  const avg = jobs.reduce((s, j) => s + (j.status === "succeeded" ? 1 : j.progress || 0), 0) / jobs.length;
  el("progressFill").style.width = `${Math.round(avg * 100)}%`;
  const cur = active.find((j) => j.status === "processing");
  el("progressLabel").textContent = cur ? `Mastering ${baseName(cur.input)}…` : "Queued…";
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
  };
}

function mockAnalyze() {
  return new Promise(resolve => setTimeout(() => resolve(mockAnalysisData()), 700));
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
function eqY(v) { return EQ_PT + EQ_CH * (1 - v / 2); }
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

let _eqDotEls = [], _eqValEls = [], _eqPathEl = null, _eqAreaEl = null;

function initEQ() {
  const container = el("eqCurve");
  container.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${EQ_W} ${EQ_H}`);
  svg.classList.add("eq-svg");

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
    t.textContent = v % 1 ? v.toFixed(1) : v.toFixed(0);
    svg.appendChild(t);
  });

  // area fill between curve and neutral line
  const area = document.createElementNS(ns, "path");
  area.setAttribute("class", "eq-area");
  svg.appendChild(area);
  _eqAreaEl = area;

  // smooth curve line
  const path = document.createElementNS(ns, "path");
  path.setAttribute("class", "eq-curve");
  svg.appendChild(path);
  _eqPathEl = path;

  // one group per band: hit circle, visible dot, value label, band name
  _eqDotEls = []; _eqValEls = [];
  state.eqBands.forEach((v, i) => {
    const cx = eqX(i), cy = eqY(v);

    const hit = document.createElementNS(ns, "circle");
    hit.setAttribute("cx", cx); hit.setAttribute("cy", cy); hit.setAttribute("r", "16");
    hit.setAttribute("class", "eq-hit");

    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("r", "7");
    dot.setAttribute("class", "eq-dot");

    const valTxt = document.createElementNS(ns, "text");
    valTxt.setAttribute("x", cx); valTxt.setAttribute("y", cy - 13);
    valTxt.setAttribute("class", "eq-val");
    valTxt.textContent = v.toFixed(2);

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
    svg.appendChild(hit);   // last = on top, catches all pointer events
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
      const newV = Math.round(eqVfromY(rawY) * 100) / 100;
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
  const curvePath = eqSmooth(pts);
  _eqPathEl.setAttribute("d", curvePath);

  // area between curve and neutral (y=1 line)
  const ny = eqY(1);
  const first = pts[0], last = pts[pts.length - 1];
  _eqAreaEl.setAttribute("d",
    curvePath + ` L ${last.x.toFixed(1)} ${ny.toFixed(1)} L ${first.x.toFixed(1)} ${ny.toFixed(1)} Z`
  );

  _eqDotEls.forEach(({ hit, dot }, i) => {
    const cx = eqX(i), cy = eqY(state.eqBands[i]);
    hit.setAttribute("cx", cx); hit.setAttribute("cy", cy);
    dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
    _eqValEls[i].setAttribute("x", cx);
    _eqValEls[i].setAttribute("y", (cy - 13).toFixed(1));
    _eqValEls[i].textContent = state.eqBands[i].toFixed(2);
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
async function startAnalyze() {
  // If no file in the mastering queue, pick one just for analysis.
  let inputPath = state.inputs[0] || "";
  if (HAS_GO && !inputPath) {
    const picked = await bridge.pickInputFiles();
    if (!picked || !picked.length) return;
    inputPath = picked[0];
  }

  const btn = el("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  try {
    const result = await bridge.analyze(inputPath);
    if (result) {
      state.analyzedPath = inputPath;
      state.loudnessSeries = result.loudnessSeries || [];
      state.secTotalSec = result.totalSec
        || (state.loudnessSeries.length ? state.loudnessSeries[state.loudnessSeries.length - 1].sec : 0);
      state.sections = (result.sections || []).map(s => ({ startSec: s.startSec, endSec: s.endSec }));
      buildSectionsChart();
      buildSectionsList();
      el("analysisDrawer").classList.remove("hidden");
    }
  } catch (err) {
    alert("Analyze failed: " + err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze";
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
async function init() {
  setupReadouts();
  setupDnd();
  initEQ();
  setupEQModes();
  el("addFilesBtn").addEventListener("click", addFiles);
  el("browseDirBtn").addEventListener("click", async () => {
    const d = await bridge.pickOutputDir();
    if (d) el("outputDir").value = d;
  });
  el("masterBtn").addEventListener("click", startMastering);
  el("analyzeBtn").addEventListener("click", startAnalyze);
  el("secPlayBtn").addEventListener("click", () => {
    const audio = getAudio();
    if (audio.paused) { audio.play(); } else { audio.pause(); }
  });
  el("eqReset").addEventListener("click", () => {
    state.eqBands = state.eqBands.map(() => 1);
    updateEQ();
  });
  el("analysisToggle").addEventListener("click", () => el("analysisDrawer").classList.toggle("hidden"));
  el("analysisClose").addEventListener("click", () => el("analysisDrawer").classList.add("hidden"));

  el("outputDir").value = (await bridge.defaultOutputDir()) || "";
  afterFilesChanged();
  buildSectionsChart();
}

document.addEventListener("DOMContentLoaded", init);
