import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { loadCamera, loadView, saveView } from "./view-state.js";
import { buildControls } from "./controls.js";
import { relevantParamKeys } from "./param-deps.js";
import { createMeshCache } from "./mesh-cache.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./jobs.js";
import { detectBackend } from "./geometry/probe.js";
import { createDebugOverlay } from "./debug-overlay.js";
import { attachPickToggle } from "./selection/index.js";
import { createPickRequestClient } from "./pick-request/index.js";

// Mount a full parametric-part app from a PartDefinition: 3-D viewer + control
// panel + the two geometry workers + the auto-regenerating view/cache loop +
// STL/STEP export. The app supplies `createWorker(name)` so Vite can bundle the
// worker (see geometry-service.js). DOM element ids match the host page:
// #app (viewer), #controls, #status, #download, #download-step, #busy, #phase,
// #part (the view-tab segmented control).
export function mount(part, { createWorker, container = document.getElementById("app"),
                              controls = document.getElementById("controls") } = {}) {
  const names = Object.keys(part.parts);
  const viewer = createViewer(container, part);

  // ?backend=occt|manifold forces the backend; otherwise it's detected per part.
  let forcedBackend = new URLSearchParams(location.search).get("backend");
  if (forcedBackend !== "occt" && forcedBackend !== "manifold") forcedBackend = null;
  const backendFor = () => forcedBackend ?? detectBackend(part, params);

  // ?debug shows the cache debug overlay; ?debug&nocache starts with caching off.
  const qs = new URLSearchParams(location.search);
  const debug = qs.has("debug");
  let cachingOn = !(debug && qs.has("nocache"));
  let lastGen = { skipped: 0, rebuilt: 0 }; // Layer-1 counts for the most recent generate
  const dbg = debug
    ? createDebugOverlay({ initialCachingOn: cachingOn, onToggle: (on) => { cachingOn = on; forceRegen(); } })
    : null;

  const statusEl = document.getElementById("status");
  const dlBtn = document.getElementById("download");
  const dlStepBtn = document.getElementById("download-step");
  const dl3mfBtn = document.getElementById("download-3mf");
  const busyEl = document.getElementById("busy");
  const phaseEl = document.getElementById("phase");
  const partSeg = document.getElementById("part");
  let kernelReady = false;

  const exportBtns = [dlBtn, dlStepBtn, dl3mfBtn].filter(Boolean);
  const setExportEnabled = (on) => exportBtns.forEach((b) => { b.disabled = !on; });

  const setStatus = (msg, isErr = false) => { statusEl.textContent = msg; statusEl.classList.toggle("err", isErr); };
  const showBusy = (phase) => { phaseEl.textContent = `${phase}…`; busyEl.classList.add("show"); };
  const hideBusy = () => busyEl.classList.remove("show");

  // --- per-sub-part mesh cache + auto-regenerating view composition ----------
  // The view-tab buttons are generated from `part.views` (the single source of truth):
  // each entry becomes a <button data-part=view>label</button> inside #part, with the
  // first view marked active by default. (A saved view, below, overrides the default.)
  if (partSeg && part.views) {
    partSeg.innerHTML = Object.entries(part.views)
      .map(([key, v], i) => `<button data-part="${key}"${i === 0 ? ' class="on"' : ""}>${v?.label ?? key}</button>`)
      .join("");
  }
  // The initial view is whichever tab is marked active (else the first tab).
  const params = { ...part.defaults };
  const defaultView = partSeg.querySelector("button.on")?.dataset.part ?? partSeg.querySelector("button")?.dataset.part;
  const savedView = loadView();
  const savedBtn = savedView ? [...partSeg.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === savedView) : null;
  let view = savedBtn ? savedView : defaultView;
  if (savedBtn) for (const b of partSeg.children) b.classList.toggle("on", b === savedBtn);

  // Current selection context for the pickers: the active view + live params +
  // derived values. Shared by both ?pick modes below.
  const getContext = () => ({ view, params, derived: part.derive ? part.derive({ ...part.defaults, ...params }) : {} });

  // ?pick enables click-to-select: a toggle button + a transient toast. Off by
  // default — no button, no listener, no behavior change. Deleting this block and
  // the selection/ dir reverts the app exactly.
  if (qs.has("pick")) {
    attachPickToggle(viewer, { part, getContext });
  } else if (qs.has("pickserver")) {
    // Agent-driven mode: arm the picker only when the local pick-server asks for a
    // click. Mutually exclusive with the clipboard ?pick toggle (else-if), so only one
    // click listener is ever live. `?pickserver` or `?pickserver=http://host:port`.
    const serverUrl = typeof qs.get("pickserver") === "string" && qs.get("pickserver")
      ? qs.get("pickserver") : "http://127.0.0.1:4518";
    createPickRequestClient({ serverUrl, viewer, part, getContext });
  }

  let framedView = null; // the view the camera was last framed to (null until first show)
  let cameraRestored = false; // saved camera applied once, on the first frame after load
  let generating = false;
  let paramsVersion = 0; // bumped on every settings edit
  let genVersion = -1;   // the params version the in-flight generate is building
  let genTimer = null;   // debounce timer for auto-regenerate

  // Per-sub-part cache-validity tracker (Layer 1): view/version/caching change over
  // time, so they're passed as getters; params is a stable in-place-mutated object.
  const cache = createMeshCache(part, viewer, {
    params,
    getView: () => view,
    getParamsVersion: () => paramsVersion,
    isCaching: () => cachingOn,
  });
  const isCurrent = cache.isCurrent;
  const missingParts = () => viewSubParts(part, view, params).filter((n) => !isCurrent(n));

  // Reflect the active view. If every needed part is current, show it and enable
  // export. If stale (a regenerate is in flight), keep the old mesh visible so the
  // view doesn't flicker. If nothing's built yet, show nothing.
  // Show the assembly, framing the camera only the first time we show a given view
  // (initial load / tab switch) — never on a regenerate, so zoom/orbit are kept.
  function showView(needed) {
    const frame = view !== framedView;
    viewer.showAssembly(needed, { frame });
    if (frame) {
      framedView = view;
      if (!cameraRestored) {
        const cam = loadCamera();
        if (cam) viewer.setCameraState(cam);
        cameraRestored = true;
      }
    }
  }

  function refreshView() {
    const needed = viewSubParts(part, view, params);
    if (needed.every(isCurrent)) {
      showView(needed);
      setExportEnabled(true);
      const tris = needed.reduce((s, n) => s + viewer.subTriangles(n), 0);
      setStatus(`${tris.toLocaleString()} triangles`);
    } else if (needed.every((n) => viewer.hasSubMesh(n))) {
      showView(needed); // stale but present — keep it visible during regenerate
      setExportEnabled(false);
    } else {
      viewer.hideAssembly();
      setExportEnabled(false);
    }
  }

  showBusy("booting kernel"); // visible from first paint until the kernel is ready

  // Bundle filename for a multi-part export (single parts download under their own name).
  const zipName = `${part.meta?.title ?? "parts"}.zip`.toLowerCase().replace(/\s+/g, "-");

  // --- shared message handler ------------------------------------------------
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
          viewer.setSubGeometry(m.name, m); // disposes any previous mesh for this name
          cache.record(m.name);
        }
        hideBusy();
        refreshView();
        if (data.ms && missingParts().length === 0) {
          setStatus(`${statusEl.textContent} · ${(data.ms / 1000).toFixed(1)} s`);
        }
        dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt });
        maybeGenerate(); // active view may still need parts (tab switched during build)
        break;
      }
      case "download-parts":
        hideBusy();
        downloadParts(data, zipName);
        setStatus(`${data.parts.length} part(s) downloaded`);
        break;
      case "download":
        hideBusy();
        triggerDownload(data.data, data.filename, data.mime);
        setStatus(`${data.filename} downloaded`);
        break;
      case "needs-occt":
        forcedBackend = "occt"; // probe missed; this part needs OCCT — stick to it
        generating = false;
        maybeGenerate();
        break;
      case "error":
        generating = false;
        hideBusy();
        setStatus(`failed: ${data.message}`, true);
        refreshView();
        break;
    }
  }

  const service = createGeometryService({ createWorker, onMessage: onWorkerMessage });

  const panel = buildControls(controls, part.parameters, params, onParamChange);
  const updateRelevance = () => panel.applyRelevance(relevantParamKeys(part, view, params));
  updateRelevance(); // initial view

  function onParamChange() {
    paramsVersion++; // every edit invalidates the caches (by version)
    refreshView();   // keep showing the now-stale mesh (no flicker); disable export
    updateRelevance();
    scheduleGenerate();
  }

  // Debounce auto-regeneration so dragging a slider doesn't queue a build per pixel.
  function scheduleGenerate() {
    clearTimeout(genTimer);
    genTimer = setTimeout(maybeGenerate, 180);
  }

  // Build whatever the active view is missing — automatic, no Generate button.
  function maybeGenerate() {
    if (!kernelReady || generating) return; // retried when the current build finishes
    const needed = viewSubParts(part, view, params);
    const missing = needed.filter((n) => !isCurrent(n));
    if (missing.length === 0) return;
    generating = true;
    genVersion = paramsVersion;
    lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length }; // for the overlay
    showBusy("generating");
    service.send({ type: "generate", subparts: missing, view, params, cache: cachingOn }, backendFor());
  }

  // Re-run the active view under the current caching setting, so toggling the
  // ?debug switch updates the readout for the same design without a param change.
  function forceRegen() {
    for (const n of viewSubParts(part, view, params)) cache.forget(n);
    refreshView();
    maybeGenerate();
  }

  partSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(view);
    for (const b of partSeg.children) b.classList.toggle("on", b === btn);
    refreshView();  // instant if the view's parts are cached + current
    updateRelevance();
    maybeGenerate(); // else auto-build the missing pieces
  });

  dlBtn.addEventListener("click", () => {
    showBusy("exporting STL");
    service.send({ type: "export-stl", view, params }, backendFor());
  });

  dlStepBtn.addEventListener("click", () => {
    showBusy("exporting STEP");
    service.send({ type: "export-step", view, params }, "occt"); // STEP is always OCCT
  });

  dl3mfBtn?.addEventListener("click", () => {
    showBusy("exporting 3MF");
    service.send({ type: "export-3mf", view, params }, backendFor());
  });

  // Optional host-page viewer chrome (#pause / #reframe / #theme) + camera persistence.
  attachViewerControls(viewer);
}
