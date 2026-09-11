// @vitest-environment happy-dom
// The live camera's depth planes, driven through a real viewer. depth-range.js
// owns the arithmetic and is tested on its own; what this file asserts is the
// wiring — that the render loop re-derives the planes from what is on screen,
// so nothing the user can do to the camera puts the part outside them.
//
// The bug: near/far were fixed at 0.1/1000 and frameTo frames at 2.6r + 6, so a
// 300mm box was viewed from 786mm with its far corner 260mm further out again.
// The back of it was not drawn, and zooming out removed the part entirely.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({ renderer: null }));

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
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

import { createViewer } from "../../src/framework/viewer.js";

function createContainer() {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  return container;
}
const newViewer = () => createViewer(createContainer(), { meta: {}, parts: { body: {} } });

// An axis-aligned cube `mm` on a side, centred on the model origin, as the
// worker delivers one. Its corners are what the far plane has to clear.
function cube(mm) {
  const geo = new THREE.BoxGeometry(mm, mm, mm);
  const positions = new Float32Array(geo.attributes.position.array);
  return { positions, normals: new Float32Array(positions.length), triangles: positions.length / 9 };
}

// Every corner of the shown part, in world space, as seen down the camera's
// own forward axis: the depth each one lands at. `near <= every depth <= far`
// is the whole property.
function cornerDepths(viewer, mm) {
  const cam = viewer.camera;
  cam.updateMatrixWorld(true);
  const half = mm / 2;
  const depths = [];
  for (const x of [-half, half]) {
    for (const y of [-half, half]) {
      for (const z of [-half, half]) {
        // The viewer's pivot stands model Z up, so a model corner (x, y, z)
        // is world (x, z, -y); partsGroup then recentres it, and a cube
        // centred on the origin is already centred.
        const world = new THREE.Vector3(x, z, -y);
        depths.push(world.applyMatrix4(cam.matrixWorldInverse).z * -1);
      }
    }
  }
  return depths;
}

function expectNothingClipped(viewer, mm) {
  const { near, far } = viewer.camera;
  const depths = cornerDepths(viewer, mm);
  // Far is unconditional: nothing the viewer draws may ever be beyond it.
  for (const depth of depths) expect(depth).toBeLessThanOrEqual(far);
  // Near is conditional in exactly one honest way. A corner BEHIND the camera
  // (negative depth) is out of the picture by geometry, not by the depth
  // range, and a perspective near plane cannot be zero — so the guarantee is
  // over what is actually in front of the lens.
  for (const depth of depths.filter((d) => d > mm * 1e-3)) {
    expect(depth).toBeGreaterThanOrEqual(near);
  }
}

beforeEach(() => {
  state.renderer = null;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test.each([12, 300, 1000])("a %imm part is inside the planes as framed", (mm) => {
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(mm));
  viewer.showAssembly(["body"], { frame: true });
  state.renderer.animationLoop(0);

  expectNothingClipped(viewer, mm);
  viewer.dispose();
});

test("the far plane follows the camera out, so zooming out cannot lose the part", () => {
  const mm = 300;
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(mm));
  viewer.showAssembly(["body"], { frame: true });
  state.renderer.animationLoop(0);
  const framed = viewer.camera.far;

  // OrbitControls dollies a perspective camera by moving it; 2200mm is roughly
  // where a couple of scroll flicks land, and used to be past far = 1000.
  for (const distance of [1200, 2200, 20000]) {
    viewer.camera.position.setLength(distance);
    state.renderer.animationLoop(0);
    expectNothingClipped(viewer, mm);
  }
  expect(viewer.camera.far).toBeGreaterThan(framed);
  viewer.dispose();
});

test("the near plane follows the camera in, so zooming in cannot eat the part", () => {
  const mm = 300;
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(mm));
  viewer.showAssembly(["body"], { frame: true });

  // Dollied in but still clear of the part: near stays in front of every corner.
  for (const distance of [600, 400]) {
    viewer.camera.position.setLength(distance);
    state.renderer.animationLoop(0);
    expectNothingClipped(viewer, mm);
    expect(viewer.camera.near).toBeLessThanOrEqual(Math.min(...cornerDepths(viewer, mm)));
  }

  // Inside the part, where there is no nearest visible point to stand in front
  // of. The near plane becomes a sliver at the lens rather than a plane that
  // slices the part open — and stays positive, which a perspective projection
  // requires.
  viewer.camera.position.setLength(40);
  state.renderer.animationLoop(0);
  expect(viewer.camera.near).toBeGreaterThan(0);
  expect(viewer.camera.near).toBeLessThan(mm * 0.01);
  expect(viewer.camera.far).toBeGreaterThanOrEqual(40 + (mm * Math.sqrt(3)) / 2);
  viewer.dispose();
});

test("a part that grows under a regenerate takes the planes with it", () => {
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(20));
  viewer.showAssembly(["body"], { frame: true });
  state.renderer.animationLoop(0);

  // A regenerate deliberately does NOT reframe — zoom and orbit survive an
  // edit — so the camera stays put while the part gets twenty times bigger.
  viewer.setSubGeometry("body", cube(400));
  viewer.showAssembly(["body"]);
  state.renderer.animationLoop(0);

  expectNothingClipped(viewer, 400);
  viewer.dispose();
});

test("the planes stay put while the camera barely moves", () => {
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(300));
  viewer.showAssembly(["body"], { frame: true });
  state.renderer.animationLoop(0);
  const { near, far } = viewer.camera;

  // Quantized: a depth buffer whose resolution changed every frame of an orbit
  // would make the part and the feature-edge lines drawn on it shimmer.
  viewer.camera.position.setLength(viewer.camera.position.length() * 1.02);
  state.renderer.animationLoop(0);

  expect(viewer.camera.near).toBe(near);
  expect(viewer.camera.far).toBe(far);
  viewer.dispose();
});

test("the grid is inside the planes too, even beside a tiny part", () => {
  // The floor grid is 300mm across whatever the part is, so a 12mm spacer's
  // own bounds are nowhere near the whole of what gets drawn.
  const viewer = newViewer();
  viewer.setSubGeometry("body", cube(12));
  viewer.showAssembly(["body"], { frame: true });
  state.renderer.animationLoop(0);

  const cam = viewer.camera;
  cam.updateMatrixWorld(true);
  for (const x of [-150, 150]) {
    for (const z of [-150, 150]) {
      const depth = new THREE.Vector3(x, -6, z).applyMatrix4(cam.matrixWorldInverse).z * -1;
      expect(depth).toBeLessThanOrEqual(cam.far);
    }
  }
  viewer.dispose();
});
