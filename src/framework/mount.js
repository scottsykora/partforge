import { zipSync } from "fflate";
import { createViewer } from "./viewer.js";
import { buildControls } from "./controls.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./jobs.js";

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

  // ?backend=occt routes preview generate through the OCCT worker (dev toggle).
  const occtPreview = new URLSearchParams(location.search).get("backend") === "occt";

  const statusEl = document.getElementById("status");
  const dlBtn = document.getElementById("download");
  const dlStepBtn = document.getElementById("download-step");
  const busyEl = document.getElementById("busy");
  const phaseEl = document.getElementById("phase");
  const partSeg = document.getElementById("part");
  let kernelReady = false;

  const setStatus = (msg, isErr = false) => { statusEl.textContent = msg; statusEl.classList.toggle("err", isErr); };
  const showBusy = (phase) => { phaseEl.textContent = `${phase}…`; busyEl.classList.add("show"); };
  const hideBusy = () => busyEl.classList.remove("show");

  // --- per-sub-part mesh cache + auto-regenerating view composition ----------
  // The host page owns the view-tab markup (#part buttons, data-part = view name);
  // `part.views` documents the available views and their labels for that page.
  // The initial view is whichever tab the page marks active (else the first tab).
  const params = { ...part.defaults };
  let view = partSeg.querySelector("button.on")?.dataset.part ?? partSeg.querySelector("button")?.dataset.part;
  let generating = false;
  let paramsVersion = 0; // bumped on every settings edit
  let genVersion = -1;   // the params version the in-flight generate is building
  let genTimer = null;   // debounce timer for auto-regenerate
  const cacheVersion = Object.fromEntries(names.map((n) => [n, -1])); // params version each was built at

  // A cached sub-part is current only if it was built at the latest params version.
  const isCurrent = (n) => viewer._subCache[n] && cacheVersion[n] === paramsVersion;
  const missingParts = () => viewSubParts(part, view, params).filter((n) => !isCurrent(n));

  // Reflect the active view. If every needed part is current, show it and enable
  // export. If stale (a regenerate is in flight), keep the old mesh visible so the
  // view doesn't flicker. If nothing's built yet, show nothing.
  function refreshView() {
    const needed = viewSubParts(part, view, params);
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

  const service = createGeometryService({ createWorker, onMessage: onWorkerMessage, occtPreview });

  buildControls(controls, part.parameters, params, onParamChange);

  function onParamChange() {
    paramsVersion++; // every edit invalidates the caches (by version)
    refreshView();   // keep showing the now-stale mesh (no flicker); disable export
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
    service.generate({ type: "generate", subparts: missing, view, params });
  }

  partSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    for (const b of partSeg.children) b.classList.toggle("on", b === btn);
    refreshView();  // instant if the view's parts are cached + current
    maybeGenerate(); // else auto-build the missing pieces
  });

  dlBtn.addEventListener("click", () => {
    showBusy("exporting STL");
    service.exportStl({ type: "export-stl", view, params });
  });

  dlStepBtn.addEventListener("click", () => {
    showBusy("exporting STEP");
    service.exportStep({ type: "export-step", view, params });
  });
}
