import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { attachCutawayControls } from "./cutaway-controls.js";
import { attachRail } from "./rail.js";
import { attachMobileTabs } from "./mobile-tabs.js";
import { createTooltipPresenter, attachButtonTooltips } from "./tooltip.js";
import { loadCamera } from "./view-state.js";
import { buildControls } from "./controls.js";
import { relevantParamKeys } from "./param-deps.js";
import { createMeshCache } from "./mesh-cache.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./part-model.js";
import { resolveDerived } from "./derive.js";
import { detectBackend } from "./backend-select.js";
import { createDebugOverlay } from "./debug-overlay.js";
import { createRegenLoop } from "./regen-loop.js";
import { createPoseFastPath } from "./pose-fast-path.js";
import { createStatusUi } from "./status-ui.js";
import { createViewTabs } from "./view-tabs.js";
import { attachPickToggle, attachHoverLabels, attachPicker, formatSelection } from "./selection/index.js";
import { createPickRequestClient, resolvePickServerUrl, PICK_SERVER_DEFAULT_URL } from "./pick-request/index.js";
import { exportablePartNames, partLabel } from "./export-select.js";
import { createExportController, backendForFormat } from "./export-controller.js";
import { createCaptureBuild } from "./capture-build.js";
import { attachAnimationControls } from "./animation-controls.js";
import { resolveDefaultView } from "./default-view.js";
import { createMeasureMode } from "./measure/measure-mode.js";
import { attachMeasureControls } from "./measure/measure-controls.js";

// The mount handle, factored out so its shape is unit-testable without booting
// the full mount() pipeline (WASM + workers + DOM).
// The default no-op tooltip binding, so a host can hold on to whatever
// attachTooltips returned without caring whether this mount resolved one.
const NOOP_TOOLTIP_BINDING = { sync: () => {}, hide: () => {}, detach: () => {} };
// Same no-op-default stance as attachTooltips/setHostPane below, for a
// makeHandle caller (or a direct test) that doesn't wire measure mode.
const NOOP_MEASURE = { isEnabled: () => false, setEnabled: () => {}, getOverlaySvg: () => null };

export function makeHandle({ ready, dispose, viewer, setParams, listExportableParts, exportParts, setHostPane, animation, getView, setView, captureView, attachTooltips, measure }) {
  return {
    ready, dispose, setParams,
    // Part-declared animation playback (spec 2026-08-02): animations are
    // VIEW-owned, so this is null only when NO view declares any.
    // { play(name?), pause(), seek(t), stop(), state() } — play(name) resolves
    // within the ACTIVE view's set, and state() reports that view.
    animation: animation ?? null,
    // Active view name (never null once mounted). See onViewChange for the push side.
    getView,
    // Programmatic tab switch; false for a name the part doesn't declare.
    setView,
    // Offscreen render of a named view (default when omitted, or on an unknown name).
    captureView,
    captureViews: (viewNames) => viewer.captureCanonicalViews(viewNames),
    captureCurrent: (opts) => viewer.captureCurrent(opts),
    // Park/unpark the viewer: stops the render loop and frees the drawing
    // buffer and the cached capture target. For an embedder that hides the
    // canvas without unmounting it — `visibility: hidden`, an off-screen tab —
    // where nothing collapses the container and the loop would otherwise run
    // forever. See the setActive comment in viewer.js for what it costs.
    setActive: (active) => viewer.setActive(active),
    // Subscribe to WebGL context loss (returns an unsubscribe), so a host can
    // say "the 3D view ran out of memory" instead of showing a dead canvas.
    onContextLost: (listener) => viewer.onContextLost(listener),
    listExportableParts,
    exportParts,
    // Narrow-layout pane selection, for a host that draws its own tab bar
    // (partforge-cloud does, at the window level). Defaulted to a no-op so the
    // handle's shape never depends on whether this mount resolved a rail.
    setHostPane: setHostPane ?? (() => {}),
    // Join host-owned chrome buttons to this mount's shared hover tooltip, so
    // a host's own viewbar/rail-foot buttons match the built-in ones. Entries
    // are [{ element, getLabel? }] (label falls back to the button's
    // title/aria-label); returns { sync, hide, detach }. Same no-op default
    // stance as setHostPane above.
    attachTooltips: attachTooltips ?? (() => NOOP_TOOLTIP_BINDING),
    // Measurement-mode capture API (spec Goal 3): { isEnabled, setEnabled,
    // getOverlaySvg } — an embedder pairs getOverlaySvg() with
    // compositeOverlay()/overlaySvgString() (exported from the main entry) to
    // build a dimensioned capture, or drives the mode without the built-in
    // ruler button entirely.
    measure: measure ?? NOOP_MEASURE,
  };
}

function createCleanupStack() {
  const cleanups = [];
  let disposed = false;
  return {
    defer(cleanup) {
      cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "partforge mount cleanup failed");
      }
    },
  };
}

// Mount a full parametric-part app from a PartDefinition. mount is WIRING: the
// pieces it composes each live (and are tested) in their own module — the viewer,
// the schema-driven control panel, the regenerate state machine (regen-loop.js),
// the view tabs (view-tabs.js), the status chrome (status-ui.js), the per-sub-part
// mesh-validity cache, and the geometry workers. The app supplies `createWorker(name)`
// so Vite can bundle the worker (see geometry-service.js).
//
// Embedding contract (0.45.0):
//   const runtime = mount(part, { createWorker, elements, onBuild, onPick, onDownload, onViewChange });
//   await runtime.ready;   // first successful build of the default view
//   runtime.setParams({ openAngle: 45 }); // programmatic edit; pose-only changes apply instantly
//   runtime.getView();     // active view name (string), never null once mounted
//   runtime.setView("lid");       // switch tab programmatically; returns false (and leaves the
//                                 // active tab untouched) for a name the part doesn't declare
//   await runtime.captureView();  // JPEG data URL of the DEFAULT view rendered offscreen (pass
//                                 // a name for a specific view, falling back to the default for
//                                 // an unknown one), never disturbing the active tab or the live
//                                 // scene; null on failure (never throws)
//   runtime.captureCurrent({ size: 2048 });  // one offscreen render of the user's current
//                                         // framing (live camera pose + viewport aspect) at the
//                                         // given long-edge resolution → JPEG data URL, or null
//                                         // when disposed / nothing built yet
//   runtime.listExportableParts();        // [{ name, label }] — every exportable sub-part,
//                                         // independent of the active view (for an embedder-drawn export UI)
//   await runtime.exportParts({ parts: ["base"], format: "stl", onProgress });
//                                         // headless export of a chosen subset; resolves when the file is
//                                         // written (handed to your onDownload sink, or downloaded directly
//                                         // if you don't supply one), rejects on failure
//   runtime.setHostPane("rail");  // narrow layout only: show just the controls
//                                 // rail ('stage' | 'rail'), suppressing the
//                                 // built-in tab bar. null hands selection back.
//   runtime.attachTooltips([{ element: myButton }]);  // host chrome buttons join the
//                                 // mount's shared hover tooltip (the viewbar one).
//                                 // Label = the button's title (or aria-label), or a
//                                 // per-entry getLabel(); the title attribute is
//                                 // absorbed while attached so it can't double up as a
//                                 // native tooltip, and restored on detach. Returns
//                                 // { sync, hide, detach } — call sync() after you
//                                 // toggle a button's disabled state. Detached
//                                 // automatically on dispose().
//   runtime.setActive(false);     // park the viewer: stop the render loop and release
//                                 // both large GPU allocations (the drawing buffer and
//                                 // the cached capture target). For a host that hides the
//                                 // canvas WITHOUT unmounting it (`visibility: hidden`, an
//                                 // inactive tab) — nothing else can detect that, and the
//                                 // loop would otherwise render a hidden pane forever.
//                                 // Captures still work while parked (they re-allocate).
//                                 // setActive(true) restores it. Safe after dispose().
//   runtime.animation?.play("open");  // part-declared animation playback: animations are
//                                 // VIEW-owned, so this is null only when NO view
//                                 // declares any, else
//                                 // { play(name?), pause(), seek(t), stop(), state() }.
//                                 // play(name) resolves within the ACTIVE view's set —
//                                 // an unknown name (including one declared by a
//                                 // different view) warns and does nothing; state()
//                                 // reports the view it applies to. Switching views
//                                 // restores the outgoing animation's params, then
//                                 // presents the incoming view's own set (empty in a
//                                 // view that declares none). Any user/host param edit
//                                 // pauses playback. A view's `autoplay: true` animation
//                                 // self-starts when that view is first shown and on
//                                 // each switch to it, until the user touches the
//                                 // transport — no runtime call needed for that part.
//   const off = runtime.onContextLost(() => …);  // WebGL context loss, i.e. the GPU or the
//                                 // OS gave up — surface it rather than showing a dead
//                                 // canvas. Returns an unsubscribe.
//   runtime.dispose();     // full teardown
// onBuild fires per completed build, so it does NOT fire for a pose-only edit —
// those are repaired in the viewer and produce no build at all.
// onViewChange fires once synchronously during mount with the initial resolved
// view (before ready), then again on every subsequent view change (user click
// or a programmatic setView) — always the new view name.
// onParamsCommit({ changed, params })   // the user FINISHED editing a panel control (slider
//                                         // released, box committed, checkbox ticked, preset
//                                         // applied): `changed` lists the keys written, `params`
//                                         // is a snapshot copy. Never fired by setParams or
//                                         // animation playback — hosts call setParams from their
//                                         // own undo/reset, and firing here would loop.
// Every `elements` entry defaults to the legacy global-ID lookup (below), resolved
// exactly once here — submodules take element refs and never query the document.
// `container`/`controls` remain as deprecated aliases for elements.viewer/.controls.
export function mount(part, { createWorker, elements = {}, onBuild, onPick, onDownload, onViewChange, onParamsCommit,
                              container: legacyContainer, controls: legacyControls } = {}) {
  // --- element resolution (the only getElementById calls in the framework, save the ?pickserver client's optional #viewbar lookup) ----
  const byId = (id) => document.getElementById(id);
  const els = {
    viewer: elements.viewer ?? legacyContainer ?? byId("app"),
    controls: elements.controls ?? legacyControls ?? byId("controls"),
    rail: elements.rail ?? byId("panel"),
    // No id fallback: attachRail defaults shell to rail.parentElement, which is
    // right for the standard markup (rail is a direct child of .pf-shell). A
    // host that wraps its rail in an extra element (e.g. a React layout div)
    // must pass this explicitly, or the seam ends up positioned against the
    // wrong ancestor. Left undefined (not null) when unsupplied so rail.js's
    // own default still applies.
    shell: elements.shell,
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
      reframe: elements.chrome?.reframe ?? byId("reframe"),
      theme: elements.chrome?.theme ?? byId("theme"),
      cutaway: elements.chrome?.cutaway ?? byId("cutaway"),
      measure: elements.chrome?.measure ?? byId("measure"),
      railToggle: elements.chrome?.railToggle ?? byId("rail-toggle"),
    },
  };

  const cleanup = createCleanupStack();
  try {
    const viewer = createViewer(els.viewer, part);
    cleanup.defer(() => viewer.dispose());
    const tooltip = createTooltipPresenter({ id: null });
    cleanup.defer(() => tooltip.dispose());
    // cutawayChrome + measureMode/measureChrome are attached further down (just
    // after `params` exists — measure's getContext needs both `view()` and
    // `params`, and cutaway needs measureMode for its escapeGuard). Nothing
    // between here and there depends on cutawayChrome except the view-tabs
    // onChange closure below, which only runs on a later user/programmatic tab
    // change, never during this synchronous setup.
    // Resizable/collapsible controls rail. No-ops when the host lays out the
    // framework itself (no #panel / no elements.rail).
    const railChrome = attachRail({ rail: els.rail, toggle: els.chrome.railToggle, shell: els.shell, tooltip });
    cleanup.defer(() => railChrome.detach());
    // Narrow-layout pane tabs. Below RAIL_NARROW_BREAKPOINT the rail cannot sit
    // beside the viewer, so exactly one pane shows and this bar picks it. Same
    // resolution and same no-op-when-absent contract as the rail above — the
    // shell default mirrors attachRail's (rail.parentElement).
    const paneTabs = attachMobileTabs({
      shell: els.shell ?? els.rail?.parentElement,
      stage: els.viewer,
      rail: els.rail,
    });
    cleanup.defer(() => paneTabs.detach());
    const hover = attachHoverLabels(viewer, { part, tooltip }); // always-on hover inspection (no-op on touch-only devices)
    cleanup.defer(() => hover.detach());
    const ui = createStatusUi({ ...els.status, exports: [els.exports.stl, els.exports.step, els.exports.threeMf] });
    cleanup.defer(() => ui.setStatus(""));
    cleanup.defer(() => ui.hideBusy());

    // ?backend=occt|manifold forces the backend; otherwise it's detected per part.
    let forcedBackend = new URLSearchParams(location.search).get("backend");
    if (forcedBackend !== "occt" && forcedBackend !== "manifold") forcedBackend = null;
    const backendFor = () => forcedBackend ?? detectBackend(part, params);

    // ?debug shows the cache debug overlay; ?debug&nocache starts with caching off.
    const qs = new URLSearchParams(location.search);
    const debug = qs.has("debug");
    let cachingOn = !(debug && qs.has("nocache"));
    let lastGen = { skipped: 0, rebuilt: 0, posed: 0 }; // Layer-0/1 counts for the most recent generate
    // Sub-parts the pose fast path has repaired since the last build was dispatched.
    // A SET of names, not a running total: a slider drag re-repairs the same
    // sub-part on every input event, and "247 posed" for a one-sub-part app would
    // be nonsense. A build dispatched in the SAME dirty cycle takes the count into
    // its report — a mixed edit re-poses one sub-part and rebuilds another, and the
    // overlay should say so. Anything that kicks a build for an unrelated reason
    // (view switch / forceRegen) clears it first, so it can't be miscredited.
    const pendingPosed = new Set();
    const dbg = debug
      ? createDebugOverlay({ initialCachingOn: cachingOn, onToggle: (on) => { cachingOn = on; forceRegen(); } })
      : null;
    if (dbg) cleanup.defer(() => dbg.detach());

    // View tabs (generated from part.views) + live params. A tab switch shows the
    // cached assembly instantly if it's current, else auto-builds what's missing.
    const tabsCtl = createViewTabs(els.tabs, part, {
      onChange: (name) => {
        // FIRST: the outgoing animation restores its param snapshot, so the
        // incoming view composes its assembly from un-animated params. Anything
        // that reads params (refreshView / updateRelevance / the loop kick) must
        // run after it. autoplayKick stays LAST — it starts the new view's own.
        animCtl?.viewChanged();
        pendingPosed.clear(); cutawayChrome.reset(); refreshView(); updateRelevance(); loop.kick(); animCtl?.autoplayKick();
        onViewChange?.(name);
      },
    });
    cleanup.defer(() => tabsCtl.detach());
    const view = () => tabsCtl.current();
    // Tell the embedder the starting tab exactly once, synchronously, so a host
    // (partforge-cloud) never has to poll getView() to learn where we opened.
    onViewChange?.(tabsCtl.current());
    const params = { ...part.defaults };

    // Measurement mode: overlay + pins + dimension->control reveal. The panel
    // is built later in this function, so revealParam is a late-bound thunk.
    let panelRef = null;
    const measureMode = createMeasureMode(viewer, {
      part,
      getContext: () => ({ view: view(), params }),
      revealParam: (key) => panelRef?.revealParam(key),
    });
    cleanup.defer(() => measureMode.detach());
    const measureChrome = attachMeasureControls(viewer, measureMode, {
      measure: els.chrome.measure,
    }, { tooltip });
    cleanup.defer(() => measureChrome.detach());
    const cutawayChrome = attachCutawayControls(viewer, {
      cutaway: els.chrome.cutaway,
    }, { tooltip, escapeGuard: () => measureMode.isEnabled() });
    cleanup.defer(() => cutawayChrome.detach());
    // Suppress the always-on hover tooltip while measure mode is active — its
    // own feature highlight + dims take over the pointer.
    const offMeasureHover = measureMode.onModeChange(() =>
      hover.setSuppressed(measureMode.isEnabled()));
    cleanup.defer(offMeasureHover);

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
      cleanup.defer(() => picker.detach());
      picker.setActive(true);
    } else if (qs.has("pick")) {
      pickToggle = attachPickToggle(viewer, { part, getContext });
      cleanup.defer(() => pickToggle.detach());
    } else if (qs.has("pickserver")) {
      // Agent-driven mode: arm the picker only when the local pick-server asks for a
      // click. `?pickserver&picktoken=<token>` or `?pickserver=http://host:port&picktoken=…`.
      // The URL is attacker-suppliable (anyone can hand the user a link), so a
      // non-loopback target is refused rather than honoured — otherwise every click,
      // with its live parameter values, would stream to a remote host.
      const serverUrl = resolvePickServerUrl(qs.get("pickserver"), {
        onReject: (raw) => console.warn(
          `partforge: ignoring non-loopback ?pickserver=${raw} — using ${PICK_SERVER_DEFAULT_URL}`,
        ),
      });
      const token = qs.get("picktoken") || "";
      pickClient = createPickRequestClient({ serverUrl, token, viewer, part, getContext });
      cleanup.defer(() => pickClient.detach());
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
        // for the overlay; this build reports the poses repaired in its own cycle.
        lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length, posed: pendingPosed.size };
        pendingPosed.clear(); // consumed — never counted against a second build
        ui.showBusy("generating");
        service.send({ type: "generate", subparts: missing, view: view(), params, cache: cachingOn }, backendFor());
      },
    });
    cleanup.defer(() => loop.dispose());

    // Pose fast path (Layer 0): a param edit that only re-poses a sub-part is
    // repaired synchronously in the viewer — no debounce, no worker job.
    const fastPath = createPoseFastPath(part, viewer, cache, {
      params, getView: view, getParamsVersion: () => loop.version(),
    });

    // paramsVersion of the most recent animation-frame apply. It is what lets
    // the meshes handler tell "stale because playback moved on" (show it — that
    // IS best-effort playback) from "stale because the user edited" (discard).
    let lastAnimApplyVersion = -1;

    // First-build readiness: resolves on the first accepted meshes result, rejects on
    // a first-build error. Guarded against unhandled rejection when never awaited.
    let readySettled = false;
    // First-show autoplay latch: separate from `readySettled`, which the error
    // branch also settles — a part whose first build fails but whose retry
    // succeeds still deserves its autoplay.
    let autoplayKicked = false;
    let resolveReady, rejectReady;
    const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    ready.catch(() => {});
    cleanup.defer(() => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(new Error("disposed before first build"));
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
      // Headless exportParts() correlation: consume its own replies first.
      if (exportCtl.handleMessage(data, onDownload)) return;
      // captureView's off-loop build channel: consume its replies before the
      // live `meshes` case — capture-meshes must never touch live cache/display.
      if (captureBuild.handleMessage(data)) return;
      switch (data.type) {
        case "ready":
          loop.ready(); // auto-build the default view (keeps the busy spinner up)
          break;
        case "progress":
          ui.showBusy(data.phase);
          ui.setStatus(`${data.phase}…`);
          break;
        case "meshes": {
          const fresh = loop.buildDone();
          if (fresh) { // stale results (params changed mid-build) are discarded
            for (const m of data.meshes) {
              viewer.setSubGeometry(m.name, m); // disposes any previous mesh for this name
              cache.record(m.name);
              // Stamp the fast path's pose baseline. Only here, inside the
              // non-stale branch: the stamp must describe the geometry actually
              // delivered, which buildDone() true guarantees is at the live params.
              fastPath.recordDelivered(m.name);
            }
            ui.hideBusy();
            refreshView();
            if (data.ms && missingParts().length === 0) {
              ui.setStatus(`${ui.statusText()} · ${(data.ms / 1000).toFixed(1)} s`);
            }
            dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt, posed: lastGen.posed });
            onBuild?.({ status: "success", ms: data.ms });
            if (!readySettled) { readySettled = true; resolveReady(); }
            // First-show autoplay: latched separately from `ready`, which the
            // error branch also settles — a part whose first build fails but
            // whose retry succeeds still deserves its autoplay.
            if (!autoplayKicked) { autoplayKicked = true; animCtl?.autoplayKick(); }
          } else if (lastAnimApplyVersion === loop.version()) {
            // Stale ONLY because animation frames kept bumping the version:
            // show the delivered meshes anyway — that IS best-effort playback —
            // but record NOTHING. Cache and fast-path stamps must describe
            // geometry built at the live params, and this delivery wasn't; the
            // fast-path stamp is dropped too, so a later pose-only repair can
            // never re-pose this newer geometry off an older delivery's stamp.
            // A user edit mid-play pauses playback and bumps the version WITHOUT
            // touching lastAnimApplyVersion, so a genuinely user-stale result
            // fails this test and is discarded exactly as before.
            for (const m of data.meshes) {
              viewer.setSubGeometry(m.name, m);
              fastPath.forget(m.name);
            }
            ui.hideBusy();
            refreshView();
          }
          loop.kick(); // stale → rebuild; fresh → the view may still need parts (tab switched mid-build)
          break;
        }
        case "download-parts":
          ui.hideBusy();
          downloadParts(data, zipName, onDownload);
          ui.setStatus(`${data.parts.length} part(s) downloaded`);
          break;
        case "download":
          ui.hideBusy();
          triggerDownload(data.data, data.filename, data.mime, onDownload);
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
    cleanup.defer(() => service.terminate());

    const captureBuild = createCaptureBuild({ send: (msg, backend) => service.send(msg, backend) });
    cleanup.defer(() => captureBuild.dispose());

    const exportCtl = createExportController({
      send: (msg, backend) => service.send(msg, backend),
      currentView: () => view(),
      title: () => part.meta?.title ?? "parts",
      defaultBackend: () => backendFor(),
      currentParams: () => params,
    });
    cleanup.defer(() => exportCtl.dispose("viewer disposed"));

    let animCtl = null; // assigned below; panel edits must pause active playback
    const panel = buildControls(els.controls, part.parameters, params, () => {
      animCtl?.notifyUserEdit();
      onParamChange();
    }, onParamsCommit
      ? (changed) => onParamsCommit({ changed, params: { ...params } })
      : undefined);
    cleanup.defer(() => panel.dispose());
    panelRef = panel;
    const updateRelevance = () => {
      // A throwing derive() must not break every slider drag — mount's pick
      // flow already guards its own resolveDerived call the same way
      // (mount.js ~:250). Readouts simply stay em-dashed.
      let derived = {};
      try { derived = resolveDerived(part, params); } catch { /* diagnosed by lint/build */ }
      panel.refresh({ relevant: relevantParamKeys(part, view(), params), derived });
    };
    updateRelevance(); // initial view

    // The ONLY caller of fastPath.repair(). It must never move into the regen /
    // forceRegen path: forceRegen() forgets cache stamps WITHOUT bumping the params
    // version, so a repair there would re-stamp everything current off the memoized
    // probe and the forced rebuild would silently no-op.
    function onParamChange({ debounce = true } = {}) {
      loop.markDirty({ debounce }); // bump the version first: refreshView below must see the parts as stale
      // Pose-only edits: re-posed + re-stamped current, no job. Skipped entirely
      // when caching is off — ?debug&nocache is there to measure true uncached
      // rebuilds, which the fast path would otherwise hide.
      const posed = cachingOn ? fastPath.repair() : [];
      if (posed.length) {
        for (const name of posed) pendingPosed.add(name);
        dbg?.update({ posed: pendingPosed.size }); // partial: merges over the last build's numbers
      }
      refreshView();    // keep showing the now-stale mesh (no flicker); disable export
      updateRelevance();
    }

    // Programmatic param entry point — the animation-system hook. Same change
    // path as a slider edit: pose-only changes repair synchronously (no worker
    // job, no debounce); geometry changes fall through to the regen loop.
    function setParams(partial) {
      animCtl?.notifyUserEdit();
      Object.assign(params, partial);
      panel.syncValues(Object.keys(partial));
      onParamChange();
    }

    // Animation-frame param entry point: same change path as setParams, minus
    // the regen debounce. The explicit kick after repair is what makes playback
    // best-effort — a pose-only frame finds nothing missing (repair re-stamped
    // it) and sends no job; a geometry frame dispatches immediately when the
    // worker is idle and is otherwise absorbed until buildDone re-kicks.
    function applyAnimationValues(values) {
      Object.assign(params, values);
      panel.syncValues(Object.keys(values));
      onParamChange({ debounce: false });
      lastAnimApplyVersion = loop.version(); // this version came from playback, not a user edit
      loop.kick();
    }

    // Animation transport + driver (null when NO view declares animations).
    // Animations are view-owned: `getView` is how the driver knows which view's
    // set is live, both at attach and after every `viewChanged()`.
    animCtl = attachAnimationControls(viewer, part, {
      container: els.viewer,
      applyValues: applyAnimationValues,
      getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
      getView: view,
    });
    if (animCtl) cleanup.defer(() => animCtl.detach());

    // Re-run the active view under the current caching setting, so toggling the
    // ?debug switch updates the readout for the same design without a param change.
    function forceRegen() {
      pendingPosed.clear(); // this rebuild is not the pose edit's — don't credit it
      for (const n of viewSubParts(part, view(), params)) cache.forget(n);
      refreshView();
      loop.kick();
    }

    const onStlClick = () => {
      ui.showBusy("exporting STL");
      service.send({ type: "export-stl", view: view(), params, quality: "print" }, backendFor());
    };
    if (els.exports.stl) {
      els.exports.stl.addEventListener("click", onStlClick);
      cleanup.defer(() => els.exports.stl.removeEventListener("click", onStlClick));
    }

    const onStepClick = () => {
      ui.showBusy("exporting STEP");
      service.send({ type: "export-step", view: view(), params }, backendForFormat("step", backendFor));
    };
    if (els.exports.step) {
      els.exports.step.addEventListener("click", onStepClick);
      cleanup.defer(() => els.exports.step.removeEventListener("click", onStepClick));
    }

    const on3mfClick = () => {
      ui.showBusy("exporting 3MF");
      service.send({ type: "export-3mf", view: view(), params, quality: "print" }, backendFor());
    };
    if (els.exports.threeMf) {
      els.exports.threeMf.addEventListener("click", on3mfClick);
      cleanup.defer(() => els.exports.threeMf.removeEventListener("click", on3mfClick));
    }

    // Optional host-page viewer chrome (reframe / theme) + camera persistence.
    const chrome = attachViewerControls(viewer, els.chrome, { tooltip });
    cleanup.defer(() => chrome.detach());

    // Full teardown of everything this mount created. Idempotent. A disposed runtime
    // can never surface a late build result (workers are terminated, the loop is
    // terminal), which is what makes cross-mount swap races safe for embedders.
    function dispose() {
      cleanup.dispose();
    }

    // Off-loop offscreen thumbnail: builds `viewName` (or the part's resolved
    // default when omitted/unknown) via captureBuild's correlated channel, then
    // renders it in a throwaway scene via viewer.renderMeshPayloads. Never
    // touches the active tab, getView(), or the live scene — best-effort: any
    // failure, including a resolved-null from a worker build failure (4A
    // settles rather than throwing), returns null. `opts` is spread last, so
    // renderMeshPayloads' own options (including `background`) pass straight
    // through from the caller.
    const captureView = async (viewName, opts = {}) => {
      try {
        const target = (viewName && part.views?.[viewName]) ? viewName : resolveDefaultView(part);
        const subparts = viewSubParts(part, target, params);
        if (!subparts.length) return null;
        const meshes = await captureBuild.request({ subparts, view: target, params, backend: backendFor() });
        if (!meshes || !meshes.length) return null; // 4A resolves null on a worker build failure
        return viewer.renderMeshPayloads(meshes, { size: 640, quality: 0.8, angle: "iso", ...opts });
      } catch {
        return null; // best-effort: a failed thumbnail never breaks the caller
      }
    };

    // Host chrome buttons joining the mount's shared tooltip (the one the
    // viewbar and cutaway buttons already use). Bindings are detached by
    // dispose() via the cleanup stack; a host detaching earlier is fine —
    // attachButtonTooltips.detach is idempotent.
    const attachHostTooltips = (entries) => {
      const binding = attachButtonTooltips(tooltip, entries);
      cleanup.defer(() => binding.detach());
      return binding;
    };

    return makeHandle({
      ready, dispose, viewer, setParams,
      attachTooltips: attachHostTooltips,
      setHostPane: paneTabs.setHostPane,
      getView: view,                         // () => tabsCtl.current()
      setView: (name) => tabsCtl.select(name),
      captureView,
      listExportableParts: () =>
        exportablePartNames(part, params).map((name) => ({ name, label: partLabel(part, name) })),
      exportParts: (opts) => exportCtl.exportParts(opts),
      animation: animCtl?.runtime ?? null,
      measure: {
        isEnabled: measureMode.isEnabled,
        setEnabled: measureMode.setEnabled,
        getOverlaySvg: measureMode.getOverlaySvg,
      },
    });
  } catch (error) {
    try {
      cleanup.dispose();
    } catch (cleanupError) {
      const cleanupErrors = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupErrors],
        "partforge mount construction and cleanup failed",
      );
    }
    throw error;
  }
}
