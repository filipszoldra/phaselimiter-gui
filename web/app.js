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

function setupReadouts() {
  bindReadout("loudness", "loudnessOut", (v) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(0)} LUFS`);
  bindReadout("intensity", "intensityOut", (v) => v.toFixed(2));
  bindReadout("stereo", "stereoOut", (v) => v.toFixed(2));
  bindReadout("precompThreshold", "precompThresholdOut", (v) => `${v.toFixed(1)} dB`);
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
// Wire up
// ---------------------------------------------------------------------------
async function init() {
  setupReadouts();
  setupDnd();
  el("addFilesBtn").addEventListener("click", addFiles);
  el("browseDirBtn").addEventListener("click", async () => {
    const d = await bridge.pickOutputDir();
    if (d) el("outputDir").value = d;
  });
  el("masterBtn").addEventListener("click", startMastering);
  el("eqReset").addEventListener("click", () => { state.eqBands = state.eqBands.map(() => 1); });
  el("analysisToggle").addEventListener("click", () => el("analysisDrawer").classList.toggle("hidden"));
  el("analysisClose").addEventListener("click", () => el("analysisDrawer").classList.add("hidden"));

  el("outputDir").value = (await bridge.defaultOutputDir()) || "";
  afterFilesChanged();
}

document.addEventListener("DOMContentLoaded", init);
