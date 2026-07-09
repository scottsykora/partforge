import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { loadCamera } from "./view-state.js";
import { buildControls } from "./controls.js";
import { relevantParamKeys } from "./param-deps.js";
import { createMeshCache } from "./mesh-cache.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./jobs.js";
import { resolveDerived } from "./derive.js";
import { detectBackend } from "./geometry/probe.js";
import { createDebugOverlay } from "./debug-overlay.js";
import { createRegenLoop } from "./regen-loop.js";
import { createStatusUi } from "./status-ui.js";
import { createViewTabs } from "./view-tabs.js";
import { attachPickToggle, attachHoverLabels } from "./selection/index.js";
import { createPickRequestClient } from "./pick-request/index.js";

// Mount a full parametric-part app from a PartDefinition. mount is WIRING: the
// pieces it composes each live (and are tested) in their own module — the viewer,
// the schema-driven control panel, the regenerate state machine (regen-loop.js),
// the view tabs (view-tabs.js), the status chrome (status-ui.js), the per-sub-part
// mesh-validity cache, and the geometry workers. The app supplies `createWorker(name)`
// so Vite can bundle the worker (see geometry-service.js). DOM element ids match the
// host page: #app (viewer), #controls, #status, #download, #download-step, #busy,
// #phase, #part (the view-tab segmented control).
export function mount(part, { createWorker, container = document.getElementById("app"),
                              controls = document.getElementById("controls") } = {}) {
  const viewer = createViewer(container, part);
  attachHoverLabels(viewer, { part }); // always-on hover inspection (no-op on touch-only devices)
  const ui = createStatusUi();

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

  const dlBtn = document.getElementById("download");
  const dlStepBtn = document.getElementById("download-step");
  const dl3mfBtn = document.getElementById("download-3mf");

  // View tabs (generated from part.views) + live params. A tab switch shows the
  // cached assembly instantly if it's current, else auto-builds what's missing.
  const tabs = createViewTabs(document.getElementById("part"), part, {
    onChange: () => { refreshView(); updateRelevance(); loop.kick(); },
  });
  const view = () => tabs.current();
  const params = { ...part.defaults };

  // Current selection context for the pickers: the active view + live params +
  // derived values. Shared by both ?pick modes below.
  const getContext = () => ({ view: view(), params, derived: resolveDerived(part, { ...part.defaults, ...params }) });

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

  // Per-sub-part cache-validity tracker (Layer 1): view/version/caching change over
  // time, so they're passed as getters; params is a stable in-place-mutated object.
  const cache = createMeshCache(part, viewer, {
    params,
    getView: view,
    getParamsVersion: () => loop.version(),
    isCaching: () => cachingOn,
  });
  const isCurrent = cache.isCurrent;
  const missingParts = () => viewSubParts(part, view(), params).filter((n) => !isCurrent(n));

  // The regenerate state machine (ready gating / debounce / stale-redo) lives in
  // regen-loop.js; this send callback is the one place a build job is dispatched.
  const loop = createRegenLoop({
    missingParts,
    send: (missing) => {
      const needed = viewSubParts(part, view(), params);
      lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length }; // for the overlay
      ui.showBusy("generating");
      service.send({ type: "generate", subparts: missing, view: view(), params, cache: cachingOn }, backendFor());
    },
  });

  // Reflect the active view. If every needed part is current, show it and enable
  // export. If stale (a regenerate is in flight), keep the old mesh visible so the
  // view doesn't flicker. If nothing's built yet, show nothing.
  // Show the assembly, framing the camera only the first time we show a given view
  // (initial load / tab switch) — never on a regenerate, so zoom/orbit are kept.
  function showView(needed) {
    const frame = view() !== framedView;
    viewer.showAssembly(needed, { frame });
    if (frame) {
      framedView = view();
      if (!cameraRestored) {
        const cam = loadCamera();
        if (cam) viewer.setCameraState(cam);
        cameraRestored = true;
      }
    }
  }

  function refreshView() {
    const needed = viewSubParts(part, view(), params);
    if (needed.every(isCurrent)) {
      showView(needed);
      ui.setExportEnabled(true);
      const tris = needed.reduce((s, n) => s + viewer.subTriangles(n), 0);
      ui.setStatus(`${tris.toLocaleString()} triangles`);
    } else if (needed.every((n) => viewer.hasSubMesh(n))) {
      showView(needed); // stale but present — keep it visible during regenerate
      ui.setExportEnabled(false);
    } else {
      viewer.hideAssembly();
      ui.setExportEnabled(false);
    }
  }

  ui.showBusy("booting kernel"); // visible from first paint until the kernel is ready

  // Bundle filename for a multi-part export (single parts download under their own name).
  const zipName = `${part.meta?.title ?? "parts"}.zip`.toLowerCase().replace(/\s+/g, "-");

  // --- shared message handler ------------------------------------------------
  function onWorkerMessage({ data }) {
    switch (data.type) {
      case "ready":
        loop.ready(); // auto-build the default view (keeps the busy spinner up)
        break;
      case "progress":
        ui.showBusy(data.phase);
        ui.setStatus(`${data.phase}…`);
        break;
      case "meshes": {
        if (loop.buildDone()) { // stale results (params changed mid-build) are discarded
          for (const m of data.meshes) {
            viewer.setSubGeometry(m.name, m); // disposes any previous mesh for this name
            cache.record(m.name);
          }
          ui.hideBusy();
          refreshView();
          if (data.ms && missingParts().length === 0) {
            ui.setStatus(`${ui.statusText()} · ${(data.ms / 1000).toFixed(1)} s`);
          }
          dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt });
        }
        loop.kick(); // stale → rebuild; fresh → the view may still need parts (tab switched mid-build)
        break;
      }
      case "download-parts":
        ui.hideBusy();
        downloadParts(data, zipName);
        ui.setStatus(`${data.parts.length} part(s) downloaded`);
        break;
      case "download":
        ui.hideBusy();
        triggerDownload(data.data, data.filename, data.mime);
        ui.setStatus(`${data.filename} downloaded`);
        break;
      case "needs-occt":
        forcedBackend = "occt"; // probe missed; this part needs OCCT — stick to it
        loop.buildDone();
        loop.kick();
        break;
      case "error":
        loop.buildDone();
        ui.hideBusy();
        ui.setStatus(`failed: ${data.message}`, true);
        refreshView();
        break;
    }
  }

  const service = createGeometryService({ createWorker, onMessage: onWorkerMessage });

  const panel = buildControls(controls, part.parameters, params, onParamChange);
  const updateRelevance = () => panel.applyRelevance(relevantParamKeys(part, view(), params));
  updateRelevance(); // initial view

  function onParamChange() {
    loop.markDirty(); // bump the version first: refreshView below must see the parts as stale
    refreshView();    // keep showing the now-stale mesh (no flicker); disable export
    updateRelevance();
  }

  // Re-run the active view under the current caching setting, so toggling the
  // ?debug switch updates the readout for the same design without a param change.
  function forceRegen() {
    for (const n of viewSubParts(part, view(), params)) cache.forget(n);
    refreshView();
    loop.kick();
  }

  dlBtn.addEventListener("click", () => {
    ui.showBusy("exporting STL");
    service.send({ type: "export-stl", view: view(), params, quality: "print" }, backendFor());
  });

  dlStepBtn.addEventListener("click", () => {
    ui.showBusy("exporting STEP");
    service.send({ type: "export-step", view: view(), params }, "occt"); // STEP is always OCCT
  });

  dl3mfBtn?.addEventListener("click", () => {
    ui.showBusy("exporting 3MF");
    service.send({ type: "export-3mf", view: view(), params, quality: "print" }, backendFor());
  });

  // Optional host-page viewer chrome (#pause / #reframe / #theme) + camera persistence.
  attachViewerControls(viewer);
}
