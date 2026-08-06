// @vitest-environment happy-dom
// renderMeshPayloads assembles a THROWAWAY scene from worker mesh payloads and
// renders it offscreen from a canonical angle — the seam a non-active view uses
// for a thumbnail without disturbing the live scene/camera. Exercised through the
// same faked-WebGLRenderer harness as viewer-frame-guard/viewer-pose (no real GL).
//
// happy-dom has no 2D canvas (getContext("2d") === null), so the real
// renderOffscreen readback path can't produce real pixels here. We shim a minimal
// 2D context + toDataURL so the real code completes, then assert the BEHAVIOURAL
// contract from the real render: which scene was drawn, that live state is
// untouched, and that every temp geometry is disposed. No pixels are asserted.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  renderer: null,
  lastRenderScene: null,
  disposeCounts: null,
}));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.frames = 0;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    getPixelRatio() { return 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    // Record which scene was handed to render(), and arm dispose counters on the
    // meshes present at draw time — the finally-block disposal fires afterwards.
    render(scene) {
      this.frames += 1;
      state.lastRenderScene = scene;
      state.disposeCounts = { geo: 0, edges: 0 };
      scene.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        o.geometry.addEventListener("dispose", () => { state.disposeCounts.geo += 1; });
        o.geometry.userData.edges?.addEventListener("dispose", () => { state.disposeCounts.edges += 1; });
      });
    }
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

// A 1mm triangle in the XY plane — a real bbox for framing, real edges for buildGeometry.
const cubePayload = (name) => ({
  name,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

// Parts must be declared (materialFor reads part.parts[name]); "a" is never given
// live geometry, so hasSubMesh("a") staying false proves the live cache untouched.
const newViewer = () => createViewer(createContainer(), { meta: {}, parts: { a: {}, b: {} } });

let origGetContext;
let origToDataURL;

beforeEach(() => {
  state.renderer = null;
  state.lastRenderScene = null;
  state.disposeCounts = null;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // Shim the 2D canvas the headless env lacks so the real readback path completes.
  origGetContext = HTMLCanvasElement.prototype.getContext;
  origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.getContext = function getContext(type) {
    if (type !== "2d") return null;
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    };
  };
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/jpeg;base64,TEST";
});

afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toDataURL = origToDataURL;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("renderMeshPayloads returns a JPEG data URL and never touches the live scene/camera", () => {
  const viewer = newViewer();
  // The live scene is subMesh -> partsGroup -> pivot -> scene.
  const liveScene = viewer._subMeshes.a.parent.parent.parent;
  const cameraBefore = viewer.camera.position.toArray();

  const url = viewer.renderMeshPayloads([cubePayload("a")], { angle: "iso", size: 64 });

  // (contract) returns a JPEG data URL
  expect(url).toMatch(/^data:image\/jpeg;base64,/);

  // (a) live state untouched: camera unmoved, nothing added to the live sub-cache
  expect(viewer.camera.position.toArray()).toEqual(cameraBefore);
  expect(viewer.hasSubMesh("a")).toBe(false);

  // (c) it rendered the TEMP scene, not the live one — and that temp scene carried
  // the built payload geometry (userData.triangles from buildGeometry).
  expect(state.renderer.frames).toBe(1);
  expect(state.lastRenderScene).not.toBe(liveScene);
  const rendered = [];
  state.lastRenderScene.traverse((o) => { if (o.isMesh && o.geometry) rendered.push(o); });
  expect(rendered).toHaveLength(1);
  expect(rendered[0].geometry.userData.triangles).toBe(1);

  // (b) every temp resource disposed: the mesh geometry AND its edge lines.
  expect(state.disposeCounts).toEqual({ geo: 1, edges: 1 });

  viewer.dispose();
});

test("renderMeshPayloads disposes geometry even for multiple payloads", () => {
  const viewer = newViewer();

  viewer.renderMeshPayloads([cubePayload("a"), cubePayload("b")], { size: 64 });

  expect(state.disposeCounts).toEqual({ geo: 2, edges: 2 });
  expect(viewer.hasSubMesh("a")).toBe(false);
  expect(viewer.hasSubMesh("b")).toBe(false);

  viewer.dispose();
});
