import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { attachCutawayControls } from "./cutaway-controls.js";
import { createTooltipPresenter } from "./tooltip.js";
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
import { attachPickToggle, attachHoverLabels, attachPicker, formatSelection } from "./selection/index.js";
import { createPickRequestClient } from "./pick-request/index.js";

// Mount a full parametric-part app from a PartDefinition. mount is WIRING: the
// pieces it composes each live (and are tested) in their own module — the viewer,
// the schema-driven control panel, the regenerate state machine (regen-loop.js),
// the view tabs (view-tabs.js), the status chrome (status-ui.js), the per-sub-part
// mesh-validity cache, and the geometry workers. The app supplies `createWorker(name)`
// so Vite can bundle the worker (see geometry-service.js).
//
// Embedding contract (0.12.0):
//   const runtime = mount(part, { createWorker, elements, onBuild, onPick });
//   await runtime.ready;   // first successful build of the default view
//   runtime.dispose();     // full teardown
// Every `elements` entry defaults to the legacy global-ID lookup (below), resolved
// exactly once here — submodules take element refs and never query the document.
// `container`/`controls` remain as deprecated aliases for elements.viewer/.controls.
export function mount(part, { createWorker, elements = {}, onBuild, onPick,
                              container: legacyContainer, controls: legacyControls } = {}) {
  // --- element resolution (the only getElementById calls in the framework, save the ?pickserver client's optional #viewbar lookup) ----
  const byId = (id) => document.getElementById(id);
  const els = {
    viewer: elements.viewer ?? legacyContainer ?? byId("app"),
    controls: elements.controls ?? legacyControls ?? byId("controls"),
    status: {
      status: elements.status?.status ?? byId("status"),
      busy: elements.status?.busy ?? byId("busy"),
      phase: elements.status?.phase ?? byId("phase"),
    },
    tabs: elements.tabs ?? byId("part"),
    exports: {
      stl: elements.exports?.stl ?? byId("download"),
      step: elements.exports?.step ?? byId("download-step"),
      threeMf: elements.exports?.threeMf ?? byId("download-3mf"),
    },
    chrome: {
      pause: elements.chrome?.pause ?? byId("pause"),
      reframe: elements.chrome?.reframe ?? byId("reframe"),
      theme: elements.chrome?.theme ?? byId("theme"),
      cutaway: elements.chrome?.cutaway ?? byId("cutaway"),
    },
  };

  const viewer = createViewer(els.viewer, part);
  const tooltip = createTooltipPresenter();
  const cutawayChrome = attachCutawayControls(viewer, {
    cutaway: els.chrome.cutaway,
  }, { tooltip });
  const hover = attachHoverLabels(viewer, { part, tooltip }); // always-on hover inspection (no-op on touch-only devices)
  const ui = createStatusUi({ ...els.status, exports: [els.exports.stl, els.exports.step, els.exports.threeMf] });

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

  // View tabs (generated from part.views) + live params. A tab switch shows the
  // cached assembly instantly if it's current, else auto-builds what's missing.
  const tabsCtl = createViewTabs(els.tabs, part, {
    onChange: () => { cutawayChrome.reset(); refreshView(); updateRelevance(); loop.kick(); },
  });
  const view = () => tabsCtl.current();
  const params = { ...part.defaults };

  // Current selection context for the pickers: the active view + live params +
  // derived values. Shared by every pick mode below.
  const getContext = () => {
    let derived = {};
    // A throwing derive must not crash the pick flow — proceed without derived context.
    try { derived = resolveDerived(part, { ...part.defaults, ...params }); } catch { /* derived stays {} */ }
    return { view: view(), params, derived };
  };

  // Click-to-select. Precedence (one click listener is ever live): the programmatic
  // onPick option, else the ?pick clipboard toggle, else the ?pickserver client.
  let picker = null;      // { setActive, detach } — armed permanently for onPick
  let pickToggle = null;  // { detach }
  let pickClient = null;  // { detach }
  if (onPick) {
    picker = attachPicker(viewer, {
      part, getContext,
      onPick: (selection) => onPick({
        selection,
        label: selection.feature?.label ?? part.parts[selection.subPart]?.label ?? selection.subPart,
        prompt: formatSelection(selection, { style: "prompt" }),
        token: formatSelection(selection, { style: "token" }),
      }),
    });
    picker.setActive(true);
  } else if (qs.has("pick")) {
    pickToggle = attachPickToggle(viewer, { part, getContext });
  } else if (qs.has("pickserver")) {
    // Agent-driven mode: arm the picker only when the local pick-server asks for a
    // click. `?pickserver` or `?pickserver=http://host:port`.
    const serverUrl = typeof qs.get("pickserver") === "string" && qs.get("pickserver")
      ? qs.get("pickserver") : "http://127.0.0.1:4518";
    pickClient = createPickRequestClient({ serverUrl, viewer, part, getContext });
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

  // First-build readiness: resolves on the first accepted meshes result, rejects on
  // a first-build error. Guarded against unhandled rejection when never awaited.
  let readySettled = false;
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});

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
          onBuild?.({ status: "success", ms: data.ms });
          if (!readySettled) { readySettled = true; resolveReady(); }
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
        onBuild?.({ status: "error", error: data.message });
        if (!readySettled) { readySettled = true; rejectReady(new Error(data.message)); }
        break;
    }
  }

  const service = createGeometryService({ createWorker, onMessage: onWorkerMessage });

  const panel = buildControls(els.controls, part.parameters, params, onParamChange);
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

  const onStlClick = () => {
    ui.showBusy("exporting STL");
    service.send({ type: "export-stl", view: view(), params, quality: "print" }, backendFor());
  };
  els.exports.stl?.addEventListener("click", onStlClick);

  const onStepClick = () => {
    ui.showBusy("exporting STEP");
    service.send({ type: "export-step", view: view(), params }, "occt"); // STEP is always OCCT
  };
  els.exports.step?.addEventListener("click", onStepClick);

  const on3mfClick = () => {
    ui.showBusy("exporting 3MF");
    service.send({ type: "export-3mf", view: view(), params, quality: "print" }, backendFor());
  };
  els.exports.threeMf?.addEventListener("click", on3mfClick);

  // Optional host-page viewer chrome (pause / reframe / theme) + camera persistence.
  const chrome = attachViewerControls(viewer, els.chrome, { tooltip });

  // Full teardown of everything this mount created. Idempotent. A disposed runtime
  // can never surface a late build result (workers are terminated, the loop is
  // terminal), which is what makes cross-mount swap races safe for embedders.
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (!readySettled) { readySettled = true; rejectReady(new Error("disposed before first build")); }
    picker?.detach();
    pickToggle?.detach();
    pickClient?.detach();
    hover.detach();
    loop.dispose();
    service.terminate();
    els.exports.stl?.removeEventListener("click", onStlClick);
    els.exports.step?.removeEventListener("click", onStepClick);
    els.exports.threeMf?.removeEventListener("click", on3mfClick);
    chrome.detach();
    cutawayChrome.detach();
    tooltip.dispose();
    tabsCtl.detach();
    panel.dispose();
    dbg?.detach();
    ui.hideBusy();
    ui.setStatus("");
    viewer.dispose();
  }

  return { ready, dispose };
}
