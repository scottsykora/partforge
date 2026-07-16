// @vitest-environment happy-dom
// The mount() embedding contract: element refs, { ready, dispose }, onBuild, onPick.
// The viewer and selection adapters are mocked (WebGL + raycasting are browser-only);
// everything else — status-ui, view-tabs, controls, regen-loop, mesh-cache,
// geometry-service — runs for real against fake workers.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fakeViewers = [];
vi.mock("../../src/framework/viewer.js", () => ({
  createViewer: vi.fn(() => {
    const built = new Set();
    const v = {
      domElement: document.createElement("div"),
      showAssembly: vi.fn(),
      hideAssembly: vi.fn(),
      setSubGeometry: vi.fn((name) => built.add(name)),
      hasSubMesh: (name) => built.has(name),
      subTriangles: () => 0,
      frame: vi.fn(),
      setAutoRotate: vi.fn(),
      setTheme: vi.fn(),
      getCameraState: vi.fn(() => ({ pos: [0, 0, 0], target: [0, 0, 0] })),
      setCameraState: vi.fn(),
      onCameraEnd: vi.fn(),
      camera: {},
      _subMeshes: {},
      flashPoint: vi.fn(),
      dispose: vi.fn(),
    };
    fakeViewers.push(v);
    return v;
  }),
}));

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal(); // keep formatSelection real — the prompt text matters
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../../src/framework/pick-request/index.js", () => ({
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

import { mount } from "../../src/framework/mount.js";
import { attachPicker, attachPickToggle, attachHoverLabels } from "../../src/framework/selection/index.js";

const makePart = () => ({
  meta: { title: "Test Part", backend: "manifold" }, // pinned backend: no probe run
  defaults: { h: 4 },
  views: { main: { label: "Main" } },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box?.(p.h, p.h, p.h) } },
  parameters: [{ id: "size", title: "Size",
    advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
});

function makeWorkers() {
  const workers = {};
  const createWorker = (name) => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    workers[name] = w;
    return w;
  };
  return { workers, createWorker };
}

function makeElements() {
  const mk = (tag = "div") => document.createElement(tag);
  const els = {
    viewer: mk(), controls: mk(),
    status: { status: mk(), busy: mk(), phase: mk() },
    tabs: mk(),
    exports: { stl: mk("button"), step: mk("button"), threeMf: mk("button") },
    chrome: { pause: mk("button"), reframe: mk("button"), theme: mk("button") },
  };
  document.body.append(els.viewer, els.controls, els.tabs,
    els.status.status, els.status.busy, els.status.phase,
    els.exports.stl, els.exports.step, els.exports.threeMf,
    els.chrome.pause, els.chrome.reframe, els.chrome.theme);
  return els;
}

// Drive the fake manifold worker: kernel ready, then one successful build.
function finishFirstBuild(workers, ms = 42) {
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms } });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test("ready resolves after the first successful build; no getElementById with full refs", () => {
  const spy = vi.spyOn(document, "getElementById");
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  expect(spy).not.toHaveBeenCalled();
  finishFirstBuild(workers);
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("ready rejects when the first build errors", () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "error", message: "boom" } });
  return expect(runtime.ready).rejects.toThrow("boom");
});

test("legacy host page: default IDs still resolve (no elements option)", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>`;
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker });
  finishFirstBuild(workers);
  expect(document.getElementById("status").textContent).toContain("triangles");
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("onBuild reports success with ms, and error with the message", () => {
  const onBuild = vi.fn();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onBuild });
  finishFirstBuild(workers, 42);
  expect(onBuild).toHaveBeenCalledWith({ status: "success", ms: 42 });
  workers.manifold.onmessage({ data: { type: "error", message: "later failure" } });
  expect(onBuild).toHaveBeenCalledWith({ status: "error", error: "later failure" });
});

test("onBuild skips a stale build (param changed mid-flight)", () => {
  const onBuild = vi.fn();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els, onBuild });
  workers.manifold.onmessage({ data: { type: "ready" } }); // build 1 in flight
  // edit the Height param while the build is in flight → the result is stale
  const box = els.controls.querySelector("input.num");
  box.value = "7";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 9 } });
  expect(onBuild).not.toHaveBeenCalled(); // stale result discarded silently
  // the loop re-kicks; the redo build completes and reports
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 11 } });
  expect(onBuild).toHaveBeenCalledWith({ status: "success", ms: 11 });
});

test("dispose() tears everything down and is idempotent", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  runtime.dispose();
  runtime.dispose(); // idempotent
  expect(workers.manifold.terminate).toHaveBeenCalledTimes(1);
  expect(workers.occt.terminate).toHaveBeenCalledTimes(1);
  expect(fakeViewers[0].dispose).toHaveBeenCalledTimes(1);
  expect(attachHoverLabels.mock.results[0].value.detach).toHaveBeenCalled();
  expect(document.body.querySelector(".popover")).toBeNull(); // controls panel disposed
  expect(els.controls.children.length).toBe(0);               // host emptied, not removed
  expect(els.tabs.children.length).toBe(0);
  // export listeners removed: a click after dispose posts nothing
  workers.manifold.postMessage.mockClear();
  els.exports.stl.click();
  expect(workers.manifold.postMessage).not.toHaveBeenCalled();
});

test("deprecated container/controls aliases still work", () => {
  document.body.innerHTML = `
    <div id="status"></div><div id="busy"><div id="phase"></div></div><div id="part"></div>`;
  const viewerEl = document.createElement("div");
  const controlsEl = document.createElement("div");
  document.body.append(viewerEl, controlsEl);
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, container: viewerEl, controls: controlsEl });
  expect(controlsEl.querySelector("input.num")).not.toBeNull(); // panel built into the alias target
  finishFirstBuild(workers);
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("onPick arms the picker permanently and delivers label/prompt/token", () => {
  const onPick = vi.fn();
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick });

  expect(attachPicker).toHaveBeenCalledTimes(1);
  const pickerHandle = attachPicker.mock.results[0].value;
  expect(pickerHandle.setActive).toHaveBeenCalledWith(true); // always-on

  // simulate a click resolving to a Selection (the picker core is tested elsewhere)
  const armed = attachPicker.mock.calls[0][1];
  armed.onPick({ subPart: "body", point: [0, 0, 1.5], normal: [0, 0, -1],
                 params: { h: 4 }, feature: { label: "Drainage hole" } });

  expect(onPick).toHaveBeenCalledTimes(1);
  const payload = onPick.mock.calls[0][0];
  expect(payload.label).toBe("Drainage hole"); // feature label wins
  expect(payload.prompt).toBe(
    "On sub-part **body**, the user pointed at **Drainage hole**, local point (0, 0, 1.5), normal -Z, with params {h: 4}."
  );
  expect(payload.token).toBe("@body · Drainage hole · pt(0,0,1.5) n(-Z) · {h:4}");
  expect(payload.selection.subPart).toBe("body");
});

test("label falls back to the sub-part label, then the sub-part name", () => {
  const onPick = vi.fn();
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick });
  const armed = attachPicker.mock.calls[0][1];

  armed.onPick({ subPart: "body", point: [0, 0, 0], normal: [0, 0, 1], params: {} });
  expect(onPick.mock.calls[0][0].label).toBe("Body"); // part.parts.body.label

  armed.onPick({ subPart: "ghost", point: [0, 0, 0], normal: [0, 0, 1], params: {} });
  expect(onPick.mock.calls[1][0].label).toBe("ghost"); // unknown sub-part → name
});

test("onPick wins over ?pick and ?pickserver (one click listener ever live)", async () => {
  vi.stubGlobal("location", { search: "?pick&pickserver" });
  const { createPickRequestClient } = await import("../../src/framework/pick-request/index.js");
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn() });
  expect(attachPicker).toHaveBeenCalledTimes(1);
  expect(attachPickToggle).not.toHaveBeenCalled();
  expect(createPickRequestClient).not.toHaveBeenCalled();
});

test("without onPick, ?pick still enables the clipboard toggle", () => {
  vi.stubGlobal("location", { search: "?pick" });
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements() });
  expect(attachPickToggle).toHaveBeenCalledTimes(1);
  expect(attachPicker).not.toHaveBeenCalled();
});

test("dispose() detaches the onPick picker", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els, onPick: vi.fn() });
  runtime.dispose();
  expect(attachPicker.mock.results[0].value.detach).toHaveBeenCalled();

  // Task 9 review follow-up: dispose() must also detach the viewer chrome —
  // a reframe click after dispose must not reach the (now-disposed) viewer.
  els.chrome.reframe.click();
  expect(fakeViewers.at(-1).frame).not.toHaveBeenCalled();
});

test("dispose() before the first build rejects ready instead of hanging", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  runtime.dispose(); // no build ever completed
  return expect(runtime.ready).rejects.toThrow("disposed before first build");
});
