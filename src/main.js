import { zipSync } from "fflate";
import { DEFAULTS } from "./parts/drum/params.js";
import { buildControls } from "./controls.js";
import { viewParts } from "./geometry-jobs.js";
import { createViewer } from "./framework/viewer.js";
import drumPart from "./parts/drum.js";

// --- three.js viewer -------------------------------------------------------
const viewer = createViewer(document.getElementById("app"), drumPart);

// --- workers (geometry) ----------------------------------------------------
// Dev toggle: ?backend=occt routes preview generate through the OCCT worker.
const useOcctPreview = new URLSearchParams(location.search).get("backend") === "occt";

// One worker entry, spawned twice and tagged by name; each loads only its backend.
// NB: the `new URL(...)` must stay inline in `new Worker(...)` or Vite won't bundle
// the worker (and its backend chunks) — a hoisted variable defeats its analysis.
const previewWorker = new Worker(new URL("./part-worker.js", import.meta.url), { type: "module", name: "manifold" });
const exportWorker = new Worker(new URL("./part-worker.js", import.meta.url), { type: "module", name: "occt" });

// preview defaults to Manifold; ?backend=occt routes preview generate to the OCCT worker
const genWorker = useOcctPreview ? exportWorker : previewWorker;

const statusEl = document.getElementById("status");
const dlBtn = document.getElementById("download");
const dlStepBtn = document.getElementById("download-step");
const busyEl = document.getElementById("busy");
const phaseEl = document.getElementById("phase");
let kernelReady = false;

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", isErr);
}
function showBusy(phase) {
  phaseEl.textContent = `${phase}…`;
  busyEl.classList.add("show");
}
function hideBusy() {
  busyEl.classList.remove("show");
}

// --- per-sub-part mesh cache + auto-regenerating view composition -----------
const params = { ...DEFAULTS };
let part = "both"; // active tab (view)
let generating = false;
let paramsVersion = 0; // bumped on every settings edit
let genVersion = -1; // the params version the in-flight generate is building
let genTimer = null; // debounce timer for auto-regenerate
const cacheVersion = { small: -1, big: -1, block: -1 }; // params version each was built at

// A cached sub-part is current only if it was built at the latest params version.
const isCurrent = (n) => viewer._subCache[n] && cacheVersion[n] === paramsVersion;
const missingParts = () => viewParts(part, params).filter((n) => !isCurrent(n));

// Reflect the active view. If every needed part is current, show it and enable
// export. If they're stale (a regenerate is in flight), keep showing the old
// mesh so the view doesn't flicker. If nothing's been built yet, show nothing.
function refreshView() {
  const needed = viewParts(part, params);
  if (needed.every(isCurrent)) {
    viewer.showAssembly(needed);
    dlBtn.disabled = false;
    dlStepBtn.disabled = false;
    const tris = needed.reduce((s, n) => s + viewer._subCache[n].userData.triangles, 0);
    setStatus(`${tris.toLocaleString()} triangles`);
  } else if (needed.every((n) => viewer._subCache[n])) {
    viewer.showAssembly(needed); // stale but present — keep it visible during regenerate
    dlBtn.disabled = true;
    dlStepBtn.disabled = true;
  } else {
    viewer.hideAssembly();
    dlBtn.disabled = true;
    dlStepBtn.disabled = true;
  }
}

showBusy("booting kernel"); // visible from first paint until the kernel is ready

// --- download helpers -------------------------------------------------------
function triggerDownload(arrayBuffer, filename, mime) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function onDownloadParts({ parts, ext, mime }) {
  if (parts.length === 1) return triggerDownload(parts[0].data, `${parts[0].name}.${ext}`, mime);
  const entries = {};
  for (const p of parts) entries[`${p.name}.${ext}`] = new Uint8Array(p.data);
  triggerDownload(zipSync(entries, { level: 0 }), "drums.zip", "application/zip");
}

// --- shared message handler -------------------------------------------------
function onWorkerMessage({ data }) {
  switch (data.type) {
    case "ready":
      kernelReady = true;
      maybeGenerate(); // auto-build the default view (keeps the busy spinner up)
      break;
    case "progress":
      showBusy(data.phase);
      setStatus(`${data.phase}…`);
      break;
    case "meshes": {
      generating = false;
      if (genVersion !== paramsVersion) { maybeGenerate(); break; } // changed mid-build → redo
      for (const m of data.meshes) {
        if (viewer._subCache[m.name]) { viewer._subCache[m.name].userData.edges?.dispose(); viewer._subCache[m.name].dispose(); }
        viewer.setSubGeometry(m.name, m);
        cacheVersion[m.name] = genVersion;
      }
      hideBusy();
      refreshView();
      if (data.ms && missingParts().length === 0) {
        setStatus(`${statusEl.textContent} · ${(data.ms / 1000).toFixed(1)} s`);
      }
      maybeGenerate(); // active view may still need parts (tab switched during build)
      break;
    }
    case "download-parts":
      hideBusy();
      onDownloadParts(data);
      setStatus(`${data.parts.length} part(s) downloaded`);
      break;
    case "download":
      hideBusy();
      triggerDownload(data.data, data.filename, data.mime);
      setStatus(`${data.filename} downloaded`);
      break;
    case "error":
      generating = false;
      hideBusy();
      setStatus(`failed: ${data.message}`, true);
      refreshView();
      break;
  }
}

previewWorker.onmessage = onWorkerMessage;
exportWorker.onmessage = onWorkerMessage;

buildControls(document.getElementById("controls"), params, onParamChange);

function onParamChange() {
  paramsVersion++; // every edit invalidates the caches (by version)
  refreshView(); // keep showing the now-stale mesh (no flicker); disable export
  scheduleGenerate(); // debounced auto-regenerate
}

// Debounce auto-regeneration so dragging a slider doesn't queue a build per pixel.
function scheduleGenerate() {
  clearTimeout(genTimer);
  genTimer = setTimeout(maybeGenerate, 180);
}

// Build whatever the active view is missing — automatic, no Generate button.
function maybeGenerate() {
  if (!kernelReady || generating) return; // retried when the current build finishes
  const missing = missingParts();
  if (missing.length === 0) return;
  generating = true;
  genVersion = paramsVersion;
  showBusy("generating");
  genWorker.postMessage({ type: "generate", subparts: missing, view: part, params });
}

const partSeg = document.getElementById("part");
partSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-part]");
  if (!btn) return;
  part = btn.dataset.part;
  for (const b of partSeg.children) b.classList.toggle("on", b === btn);
  refreshView(); // instant if the view's parts are cached + current
  maybeGenerate(); // else auto-build the missing pieces
});

dlBtn.addEventListener("click", () => {
  showBusy("exporting STL");
  previewWorker.postMessage({ type: "export-stl", view: part, params });
});

dlStepBtn.addEventListener("click", () => {
  showBusy("exporting STEP");
  exportWorker.postMessage({ type: "export-step", view: part, params });
});
