import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { zipSync } from "fflate";
import { createViewer } from "./viewer.js";
import { loadRotating, saveRotating, loadCamera, saveCamera, loadView, saveView } from "./view-state.js";
import { buildControls } from "./controls.js";
import { relevantParamKeys, subPartReadKeys, relevanceHash, RELEVANT_ALL } from "./param-deps.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./jobs.js";
import { detectBackend } from "./geometry/probe.js";

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
  let framedView = null; // the view the camera was last framed to (null until first show)
  let cameraRestored = false; // saved camera applied once, on the first frame after load
  let generating = false;
  let paramsVersion = 0; // bumped on every settings edit
  let genVersion = -1;   // the params version the in-flight generate is building
  let genTimer = null;   // debounce timer for auto-regenerate
  const cacheHash = {}; // n -> relevance hash each sub-part's cached mesh was built at

  // Memoize the per-sub-part read-key map per (paramsVersion, view): subPartReadKeys
  // runs probe builds, so we compute it once per change, not per sub-part.
  let _readsKey = null, _readsMap = null;
  const readsFor = () => {
    const key = `${paramsVersion}|${view}`;
    if (_readsKey !== key) { _readsKey = key; _readsMap = subPartReadKeys(part, view, params); }
    return _readsMap;
  };
  // The relevance hash for one sub-part at the current params (RELEVANT_ALL → hash
  // over ALL params, so any edit invalidates it — the safe fallback).
  const hashFor = (n) => {
    const reads = readsFor();
    const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(n) ?? Object.keys(params))];
    return relevanceHash(keys, params);
  };

  // A cached sub-part is current only if its relevance hash is unchanged.
  const isCurrent = (n) => !!viewer._subCache[n] && cacheHash[n] === hashFor(n);
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
      const tris = needed.reduce((s, n) => s + viewer._subCache[n].userData.triangles, 0);
      setStatus(`${tris.toLocaleString()} triangles`);
    } else if (needed.every((n) => viewer._subCache[n])) {
      showView(needed); // stale but present — keep it visible during regenerate
      setExportEnabled(false);
    } else {
      viewer.hideAssembly();
      setExportEnabled(false);
    }
  }

  showBusy("booting kernel"); // visible from first paint until the kernel is ready

  // --- download helpers ------------------------------------------------------
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
    triggerDownload(zipSync(entries, { level: 0 }), `${part.meta?.title ?? "parts"}.zip`.toLowerCase().replace(/\s+/g, "-"), "application/zip");
  }

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
          if (viewer._subCache[m.name]) { viewer._subCache[m.name].userData.edges?.dispose(); viewer._subCache[m.name].dispose(); }
          viewer.setSubGeometry(m.name, m);
          cacheHash[m.name] = hashFor(m.name);
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
    const missing = missingParts();
    if (missing.length === 0) return;
    generating = true;
    genVersion = paramsVersion;
    showBusy("generating");
    service.generate({ type: "generate", subparts: missing, view, params }, backendFor());
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
    service.exportStl({ type: "export-stl", view, params }, backendFor());
  });

  dlStepBtn.addEventListener("click", () => {
    showBusy("exporting STEP");
    service.exportStep({ type: "export-step", view, params });
  });

  dl3mfBtn?.addEventListener("click", () => {
    showBusy("exporting 3MF");
    service.export3mf({ type: "export-3mf", view, params }, backendFor());
  });

  // --- viewer controls (optional host-page buttons: #pause / #reframe / #theme) --
  const pauseBtn = document.getElementById("pause");
  const reframeBtn = document.getElementById("reframe");
  const themeBtn = document.getElementById("theme");

  // Theme: toggle the page chrome (CSS vars keyed off <html data-theme>) and the
  // scene together; remember the choice across reloads.
  let theme = localStorage.getItem("theme") || "dark";
  function applyTheme(mode) {
    theme = mode;
    document.documentElement.dataset.theme = mode;
    viewer.setTheme(mode);
    themeBtn?.classList.toggle("on", mode === "light");
    localStorage.setItem("theme", mode);
  }
  applyTheme(theme);
  themeBtn?.addEventListener("click", () => applyTheme(theme === "light" ? "dark" : "light"));

  // Pause/resume the idle auto-rotation.
  let rotating = loadRotating();
  viewer.setAutoRotate(rotating);
  if (pauseBtn) {
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
  }
  pauseBtn?.addEventListener("click", () => {
    rotating = !rotating;
    viewer.setAutoRotate(rotating);
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
    saveRotating(rotating);
  });

  // Re-fit the camera to the current view.
  reframeBtn?.addEventListener("click", () => viewer.frame());

  // Persist the camera when the user finishes an orbit/zoom, and right before a
  // reload (captures the latest pose, including auto-rotation drift).
  viewer.onCameraEnd(() => saveCamera(viewer.getCameraState()));
  window.addEventListener("pagehide", () => saveCamera(viewer.getCameraState()));
}
