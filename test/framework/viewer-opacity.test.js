// @vitest-environment happy-dom
// Display-layer per-sub-part opacity overrides (spec 2026-08-10-per-view-animations):
// the animation driver fades a part in/out without touching geometry, params, or
// exports. Same faked-WebGLRenderer harness as viewer-pose.test.js — material and
// visibility bookkeeping needs no real GL context.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ cutaway: null, renderer: null }));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio(value) { this.pixelRatio = value; }
    getPixelRatio() { return this.pixelRatio; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn(() => state.cutaway),
}));

import { createViewer } from "../../src/framework/viewer.js";

function createFakeCutaway() {
  return {
    isSupported: true,
    isEnabled: false,
    setSubpart: vi.fn(),
    updateGeometry: vi.fn(),
    setVisible: vi.fn(),
    setEnabled: vi.fn(),
    flip: vi.fn(),
    reset: vi.fn(),
    setTheme: vi.fn(),
    setViewportSize: vi.fn(),
    isPointVisible: vi.fn(() => true),
    registerClippableMaterial: vi.fn(),
    onHandleHoverChange: vi.fn(),
    updateForCamera: vi.fn(),
    renderOverlay: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  state.cutaway = createFakeCutaway();
  state.renderer = null;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
});

const part = {
  meta: { title: "t" },
  parts: {
    base: { views: ["v"], build: () => {} },
    lid: { views: ["v"], build: () => {} },
    ghost: { views: ["v"], display: { opacity: 0.5 }, build: () => {} },
  },
  views: { v: { label: "V" } },
};

// A minimal worker-mesh payload: one triangle, enough for buildGeometry.
const payload = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
  edges: new Float32Array(0),
});

function setup() {
  state.cutaway = createFakeCutaway();
  const container = document.createElement("div");
  document.body.append(container);
  const viewer = createViewer(container, part);
  for (const n of ["base", "lid", "ghost"]) viewer.setSubGeometry(n, payload());
  viewer.showAssembly(["base", "lid", "ghost"]);
  return viewer;
}

// Same, but with a container whose reported size can change mid-test. The viewer
// only re-reads it in resize(), which setActive(false)/setActive(true) drives.
function setupResizable(size) {
  state.cutaway = createFakeCutaway();
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { get: () => size.w },
    clientHeight: { get: () => size.h },
  });
  document.body.append(container);
  const viewer = createViewer(container, part);
  for (const n of ["base", "lid", "ghost"]) viewer.setSubGeometry(n, payload());
  viewer.showAssembly(["base", "lid", "ghost"]);
  return viewer;
}

test("fade clones the material; clear restores the shared one", () => {
  const viewer = setup();
  const mesh = viewer.__subMesh("lid"), lines = viewer.__subLines("lid");
  const baseMat = mesh.material;
  viewer.setSubPartOpacity("lid", 0.4);
  expect(mesh.visible).toBe(true);
  expect(mesh.material).not.toBe(baseMat);
  expect(mesh.material.transparent).toBe(true);
  expect(mesh.material.depthWrite).toBe(false);
  expect(mesh.material.opacity).toBeCloseTo(0.4);
  expect(lines.material.opacity).toBeCloseTo(0.4);
  viewer.setSubPartOpacity("lid", null);
  expect(mesh.material).toBe(baseMat);
  expect(mesh.visible).toBe(true);
});

test("opacity 0 hides mesh + lines and leaves the cutaway set", () => {
  const viewer = setup();
  const mesh = viewer.__subMesh("lid"), lines = viewer.__subLines("lid");
  viewer.setSubPartOpacity("lid", 0);
  expect(mesh.visible).toBe(false);
  expect(lines.visible).toBe(false);
  expect(state.cutaway.setVisible).toHaveBeenLastCalledWith(["base", "ghost"]);
  viewer.setSubPartOpacity("lid", 1);
  expect(mesh.visible).toBe(true);
  expect(state.cutaway.setVisible).toHaveBeenLastCalledWith(["base", "lid", "ghost"]);
});

test("fade multiplies a static display.opacity", () => {
  const viewer = setup();
  viewer.setSubPartOpacity("ghost", 0.5);
  expect(viewer.__subMesh("ghost").material.opacity).toBeCloseTo(0.25); // 0.5 authored × 0.5 animated
});

test("showAssembly keeps overrides; clearSubPartOpacities restores everything", () => {
  const viewer = setup();
  viewer.setSubPartOpacity("lid", 0);
  viewer.showAssembly(["base", "lid"]); // regen re-show mid-animation
  expect(viewer.__subMesh("lid").visible).toBe(false); // override survives the re-show
  viewer.clearSubPartOpacities();
  expect(viewer.__subMesh("lid").visible).toBe(true);
});

test("a part outside the shown set stays hidden regardless of override", () => {
  const viewer = setup();
  viewer.showAssembly(["base"]);
  viewer.setSubPartOpacity("lid", 0.7);
  expect(viewer.__subMesh("lid").visible).toBe(false);
});

test("unknown names are a no-op", () => {
  const viewer = setup();
  expect(() => viewer.setSubPartOpacity("nope", 0.5)).not.toThrow();
});

test("showAssembly leaves a non-overridden part's materials untouched", () => {
  // The cutaway OWNS mesh.material while it is enabled: createSectionRenderSet
  // swaps in clipped clones on setEnabled(true), and mount.js's refreshView calls
  // showAssembly on every regen WITHOUT disabling it. An unconditional restore in
  // applySubOpacity would silently drop clipping on every sub-part, with the
  // stencil caps still drawing. Stand in for those clones with sentinels.
  const viewer = setup();
  const mesh = viewer.__subMesh("lid"), lines = viewer.__subLines("lid");
  const clippedMesh = mesh.material.clone(), clippedLines = lines.material.clone();
  mesh.material = clippedMesh;
  lines.material = clippedLines;

  viewer.showAssembly(["base", "lid", "ghost"]); // regen re-show, no overrides anywhere

  expect(mesh.material).toBe(clippedMesh);
  expect(lines.material).toBe(clippedLines);
  expect(mesh.visible).toBe(true);
});

test("resize fans the viewport size out to the fade line-material clones", () => {
  const size = { w: 400, h: 300 };
  const viewer = setupResizable(size);
  viewer.setSubPartOpacity("lid", 0.4);
  const faded = viewer.__subLines("lid").material;
  const shared = viewer.__subLines("base").material; // no override -> the singleton
  expect(faded).not.toBe(shared);

  size.w = 800; size.h = 600;
  viewer.setActive(false);
  viewer.setActive(true); // the one resize() path reachable from the handle

  expect(shared.resolution.x).toBeCloseTo(800); // the resize really happened
  expect(faded.resolution.x).toBeCloseTo(shared.resolution.x);
  expect(faded.resolution.y).toBeCloseTo(shared.resolution.y);
});

test("setTheme recolours the fade line-material clones", () => {
  const viewer = setup();
  viewer.setSubPartOpacity("lid", 0.4);
  const faded = viewer.__subLines("lid").material;
  const shared = viewer.__subLines("base").material;
  const darkHex = shared.color.getHex();

  viewer.setTheme("light");

  expect(shared.color.getHex()).not.toBe(darkHex); // the theme really moved
  expect(faded.color.getHex()).toBe(shared.color.getHex());
});

test("dispose frees the cloned fade materials", () => {
  const viewer = setup();
  viewer.setSubPartOpacity("lid", 0.4);
  const meshMat = viewer.__subMesh("lid").material;
  const lineMat = viewer.__subLines("lid").material;
  const meshDispose = vi.spyOn(meshMat, "dispose");
  const lineDispose = vi.spyOn(lineMat, "dispose");

  viewer.dispose();

  expect(meshDispose).toHaveBeenCalled();
  expect(lineDispose).toHaveBeenCalled();
});
