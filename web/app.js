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
};

const state = {
  inputs: [],
  outputDir: "",
  eqBands: [1, 1, 1, 1, 1, 1, 1, 1, 1],
  sections: [],
  jobs: new Map(),
};

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

function updatePrecompThreshold() {
  const loudness = parseFloat(el("loudness").value);
  const offset   = parseFloat(el("precompThreshold").value);
  const actual   = loudness + offset;
  const sign     = actual < 0 ? "−" : "";
  el("precompThresholdOut").textContent = `${sign}${Math.abs(actual).toFixed(0)} dB`;
}

function setupReadouts() {
  bindReadout("loudness", "loudnessOut", (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(0)} LUFS`);
  bindReadout("intensity", "intensityOut", (v) => v.toFixed(2));
  bindReadout("stereo", "stereoOut", (v) => v.toFixed(2));
  // precompThreshold readout is loudness + offset (actual LUFS that the engine sees)
  el("precompThreshold").addEventListener("input", updatePrecompThreshold);
  el("loudness").addEventListener("input", updatePrecompThreshold);
  updatePrecompThreshold();
  bindReadout("precompWindow", "precompWindowOut", (v) => `${v.toFixed(2)} s`);
  bindReadout("quality", "qualityOut", (v) => `${v.toFixed(0)}`);
  bindReadout("ceiling", "ceilingOut", (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dB`);
  bindReadout("sectionIntensity", "sectionIntensityOut", (v) => v.toFixed(2));
}

function collectSettings() {
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
    eqBandLevels: state.eqBands.slice(),
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

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
async function init() {
  setupReadouts();
  setupDnd();
  initEQ();
  el("addFilesBtn").addEventListener("click", addFiles);
  el("browseDirBtn").addEventListener("click", async () => {
    const d = await bridge.pickOutputDir();
    if (d) el("outputDir").value = d;
  });
  el("masterBtn").addEventListener("click", startMastering);
  el("eqReset").addEventListener("click", () => {
    state.eqBands = state.eqBands.map(() => 1);
    updateEQ();
  });
  el("analysisToggle").addEventListener("click", () => el("analysisDrawer").classList.toggle("hidden"));
  el("analysisClose").addEventListener("click", () => el("analysisDrawer").classList.add("hidden"));

  el("outputDir").value = (await bridge.defaultOutputDir()) || "";
  afterFilesChanged();
}

document.addEventListener("DOMContentLoaded", init);
