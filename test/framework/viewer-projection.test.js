// @vitest-environment happy-dom
// The projection swap. happy-dom has no WebGL, so this asserts the pure
// framing half of captureCurrentFromScene plus the camera-identity contract
// that every downstream consumer (measure, annotate, selection) depends on.
//
// The second half runs a REAL viewer against the same faked-WebGLRenderer
// harness as viewer-frame-guard/viewer-pose, because the property that actually
// matters — the part does not change size when the projection is toggled — is a
// property of createViewer's two cameras together, not of projection.js alone.
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import * as THREE from "three";
// vi.mock is hoisted above these imports, so the fakes below are in force here.
import { captureCurrentFromScene, createViewer } from "../../src/framework/viewer.js";
import { orthoFrustum } from "../../src/framework/projection.js";

function liveCamera({ ortho = false } = {}) {
  const cam = {
    aspect: 2,
    fov: 45,
    position: { toArray: () => [0, 0, 100], clone: () => ({ copy: () => {} }), copy: () => {} },
    up: { toArray: () => [0, 1, 0] },
  };
  if (ortho) {
    cam.isOrthographicCamera = true;
    cam.fov = undefined;
    cam.top = 20;
    cam.bottom = -20;
    cam.zoom = 1;
  }
  return cam;
}

describe("captureCurrentFromScene", () => {
  it("captures in perspective by default, carrying the live fov", () => {
    const renderOffscreen = vi.fn(() => "data:image/jpeg;base64,x");
    captureCurrentFromScene({}, {
      renderer: { renderOffscreen },
      liveCamera: liveCamera(),
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
    });
    const opts = renderOffscreen.mock.calls[0][1];
    expect(opts.fov).toBe(45);
    expect(opts.projection ?? "perspective").toBe("perspective");
  });

  it("captures orthographically, with the live half-height, when told to", () => {
    const renderOffscreen = vi.fn(() => "data:image/jpeg;base64,x");
    captureCurrentFromScene({}, {
      renderer: { renderOffscreen },
      liveCamera: liveCamera({ ortho: true }),
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
      projection: "orthographic",
      orthoHalfH: 20,
    });
    const opts = renderOffscreen.mock.calls[0][1];
    expect(opts.projection).toBe("orthographic");
    expect(opts.orthoHalfH).toBe(20);
  });

  it("still honours the long-edge clamp in either projection", () => {
    const renderOffscreen = vi.fn(() => "x");
    captureCurrentFromScene({ size: 99999 }, {
      renderer: { renderOffscreen },
      liveCamera: liveCamera({ ortho: true }),
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
      projection: "orthographic",
      orthoHalfH: 20,
    });
    expect(renderOffscreen.mock.calls[0][1].width).toBe(4096);
  });

  // A real OrthographicCamera has no `aspect` at all — its aspect lives in the
  // frustum — so reading `liveCamera.aspect || 1` alone would silently capture
  // SQUARE from a wide viewport the moment the user toggled to ortho.
  it("takes the aspect from the frustum when the live camera is orthographic", () => {
    const renderOffscreen = vi.fn(() => "x");
    captureCurrentFromScene({ size: 1000 }, {
      renderer: { renderOffscreen },
      liveCamera: {
        isOrthographicCamera: true,
        left: -40, right: 40, top: 20, bottom: -20, zoom: 1,
        position: { toArray: () => [0, 0, 100], clone: () => ({ copy: () => {} }), copy: () => {} },
        up: { toArray: () => [0, 1, 0] },
      },
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
      projection: "orthographic",
      orthoHalfH: 20,
    });
    const opts = renderOffscreen.mock.calls[0][1];
    expect(opts.width).toBe(1000);
    expect(opts.height).toBe(500); // 2:1 frustum, not 1:1
  });
});

describe("orthoFrustum round trip through a resize", () => {
  it("holds the vertical extent when only the aspect changes", () => {
    const before = orthoFrustum({ fovDeg: 45, distance: 100, aspect: 1 });
    const after = orthoFrustum({ fovDeg: 45, distance: 100, aspect: 2.5 });
    expect(after.halfH).toBeCloseTo(before.halfH, 12);
  });
});

// --- the live viewer -------------------------------------------------------

const state = vi.hoisted(() => ({ renderer: null, cutaway: null, resize: null, lastCamera: null }));

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
    getPixelRatio() { return this.pixelRatio ?? 1; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    // Record the temp camera renderOffscreen built — the only place the capture
    // path's projection decisions are observable without a GL context.
    render(scene, camera) { state.lastCamera = camera; }
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

// The real cutaway wants a GL context for its gizmo; all this suite needs from
// it is that setProjection hands it the camera that is now live.
vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn(() => state.cutaway),
}));

function createFakeCutaway() {
  return {
    isSupported: true,
    isEnabled: false,
    setSubpart: vi.fn(),
    updateGeometry: vi.fn(),
    setVisible: vi.fn(),
    setEnabled: vi.fn(),
    setCamera: vi.fn(),
    flip: vi.fn(),
    reset: vi.fn(),
    setTheme: vi.fn(),
    setViewportSize: vi.fn(),
    isPointVisible: vi.fn(() => true),
    registerClippableMaterial: vi.fn(() => () => {}),
    resyncSubpart: vi.fn(),
    onHandleHoverChange: vi.fn(),
    updateForCamera: vi.fn(),
    renderOverlay: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

// Mutable through getters so a test can drive the ResizeObserver callback.
function createContainer(box = { w: 400, h: 300 }) {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { get: () => box.w },
    clientHeight: { get: () => box.h },
  });
  document.body.appendChild(container);
  return container;
}

const triangle = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

const HALF_FOV_TAN = Math.tan((45 * Math.PI) / 360);
const distanceOf = (viewer) => {
  const { pos, target } = viewer.getCameraState();
  return Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
};

let origGetContext;
let origToDataURL;

beforeEach(() => {
  state.renderer = null;
  state.cutaway = createFakeCutaway();
  state.resize = null;
  state.lastCamera = null;
  globalThis.ResizeObserver = class {
    constructor(cb) { state.resize = cb; }
    observe() {}
    disconnect() {}
  };
  // Shim the 2D canvas the headless env lacks (same trick as
  // viewer-capture-view.test.js) so the REAL capture path runs to completion.
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

const makeViewer = (box) =>
  createViewer(createContainer(box), { meta: {}, parts: { body: {} } });

test("starts perspective, and viewer.camera is the live camera", () => {
  const viewer = makeViewer();
  expect(viewer.getProjection()).toBe("perspective");
  expect(viewer.camera.isPerspectiveCamera).toBe(true);
  viewer.dispose();
});

test("swapping to orthographic keeps the part the same size on screen", () => {
  const viewer = makeViewer();
  const before = viewer.camera;
  const distance = distanceOf(viewer);

  expect(viewer.setProjection("orthographic")).toBe("orthographic");

  const cam = viewer.camera;
  expect(cam.isOrthographicCamera).toBe(true);
  expect(cam).not.toBe(before);
  // The frustum half-height IS the perspective camera's half-height at this
  // distance — that identity is the whole "no size jump" guarantee.
  expect(cam.top).toBeCloseTo(distance * HALF_FOV_TAN, 9);
  expect(cam.bottom).toBeCloseTo(-distance * HALF_FOV_TAN, 9);
  expect(cam.right).toBeCloseTo(cam.top * (400 / 300), 9);
  expect(cam.zoom).toBe(1);
  // The pose carries over, or the swap would also be a camera move. Compared to
  // a tolerance rather than exactly: controls.update() recomputes the position
  // from its spherical coordinates, which costs a few ulps either way.
  cam.position.toArray().forEach((v, i) => {
    expect(v).toBeCloseTo(before.position.toArray()[i], 9);
  });
  viewer.dispose();
});

test("the swap hands the cutaway the camera that is now live", () => {
  const viewer = makeViewer();
  viewer.setProjection("orthographic");
  expect(state.cutaway.setCamera).toHaveBeenCalledWith(viewer.camera);
  viewer.setProjection("perspective");
  expect(state.cutaway.setCamera).toHaveBeenLastCalledWith(viewer.camera);
  viewer.dispose();
});

test("a dolly performed while orthographic survives the trip back", () => {
  const viewer = makeViewer();
  const distance = distanceOf(viewer);
  viewer.setProjection("orthographic");
  // OrbitControls dollies an ortho camera by changing zoom, not by moving it.
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();

  viewer.setProjection("perspective");

  expect(viewer.camera.isPerspectiveCamera).toBe(true);
  // Zoomed 2x in ortho == half the perspective distance.
  expect(distanceOf(viewer)).toBeCloseTo(distance / 2, 6);
  viewer.dispose();
});

test("a resize holds the ortho vertical extent and lets the width follow", () => {
  const box = { w: 400, h: 300 };
  const viewer = makeViewer(box);
  viewer.setProjection("orthographic");
  const halfH = viewer.camera.top;

  box.w = 900;
  state.resize();

  expect(viewer.camera.top).toBeCloseTo(halfH, 9);
  expect(viewer.camera.right).toBeCloseTo(halfH * (900 / 300), 9);
  viewer.dispose();
});

test("reframing while orthographic re-derives the frustum", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"], { frame: true });
  viewer.setProjection("orthographic");
  const halfH = viewer.camera.top;
  // Dolly in, then reframe: the frustum must come back, not just the distance.
  viewer.camera.zoom = 4;
  viewer.camera.updateProjectionMatrix();

  viewer.frame();

  expect(viewer.camera.zoom).toBe(1);
  expect(viewer.camera.top).toBeCloseTo(halfH, 9);
  expect(viewer.camera.top).toBeCloseTo(distanceOf(viewer) * HALF_FOV_TAN, 9);
  viewer.dispose();
});

test("projection listeners fire on a real change only, and unsubscribe", () => {
  const viewer = makeViewer();
  const seen = [];
  const off = viewer.onProjectionChange((mode) => seen.push(mode));

  viewer.setProjection("orthographic");
  expect(viewer.setProjection("orthographic")).toBe("orthographic"); // no-op
  off();
  viewer.setProjection("perspective");

  expect(seen).toEqual(["orthographic"]);
  expect(viewer.getProjection()).toBe("perspective");
  viewer.dispose();
});

// The camera that becomes live has never been rendered, so nothing has composed
// its matrixWorld — and the listeners fire synchronously, before any frame. Both
// halves matter, because raycaster.setFromCamera (selection, measure) reads the
// origin AND the direction out of matrixWorld.
//
// A CONTRACT test, not a regression pin: it also passes without setProjection's
// explicit updateMatrixWorld(), because controls.update() ends in
// Object3D.lookAt, which itself calls updateWorldMatrix — and by then the
// quaternion has already been copied from the outgoing camera, so the composed
// matrix is right. The explicit call still earns its place (lookAt refreshes the
// matrix BEFORE writing the quaternion, so a rotation applied inside the same
// update — damping momentum still decaying when the toggle lands — would leave
// the rotation one frame stale), but that case can't be reached through the
// public handle, so this asserts the invariant rather than pinning the line.
test("the newly live camera's world matrix is current before anyone is told", () => {
  const viewer = makeViewer();
  const seen = [];
  viewer.onProjectionChange(() => {
    const cam = viewer.camera;
    seen.push({
      drift: new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).distanceTo(cam.position),
      // The view direction as matrixWorld encodes it — what a picker would use.
      dir: new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld),
    });
  });

  viewer.setProjection("orthographic");
  viewer.setProjection("perspective");

  expect(seen).toHaveLength(2);
  for (const { drift, dir } of seen) {
    expect(drift).toBeLessThan(1e-9);
    // Pointing at the orbit target (the origin) rather than down -Z.
    const toTarget = viewer.camera.position.clone().negate().normalize();
    expect(dir.distanceTo(toTarget)).toBeLessThan(1e-6);
  }
  viewer.dispose();
});

// The two corrections to the brief both lived here, and both were invisible:
// wrong only in the saved image. This is the regression pin for both.
test("captureCurrent under ortho carries the zoomed half-height and the viewport aspect", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"], { frame: true });
  viewer.setProjection("orthographic");
  const halfH = viewer.camera.top;
  viewer.camera.zoom = 2; // a dolly performed in ortho
  viewer.camera.updateProjectionMatrix();

  const url = viewer.captureCurrent({ size: 512 });

  expect(url).toBe("data:image/jpeg;base64,TEST");
  const cam = state.lastCamera;
  expect(cam.isOrthographicCamera).toBe(true);
  // Half-height DIVIDED BY the zoom, or the capture ignores the user's dolly.
  expect(cam.top).toBeCloseTo(halfH / 2, 9);
  // Aspect from the frustum, not the ortho camera's absent `aspect` (which would
  // have made this 1 and captured square from a 4:3 viewport).
  expect(cam.right / cam.top).toBeCloseTo(400 / 300, 9);
  viewer.dispose();
});

test("captureCurrent stays perspective while perspective is live", () => {
  const viewer = makeViewer();
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"], { frame: true });

  viewer.captureCurrent({ size: 512 });

  expect(state.lastCamera.isPerspectiveCamera).toBe(true);
  expect(state.lastCamera.fov).toBe(45);
  viewer.dispose();
});

test("a degenerate ortho zoom cannot strand the camera past the far plane", () => {
  const viewer = makeViewer();
  viewer.setProjection("orthographic");
  viewer.camera.zoom = 0; // guarded, or perspectiveDistance returns Infinity
  viewer.setProjection("perspective");
  expect(Number.isFinite(distanceOf(viewer))).toBe(true);

  viewer.setProjection("orthographic");
  viewer.camera.zoom = 1e-4; // ortho zoom-out is unbounded and looks harmless
  viewer.setProjection("perspective");
  // Clamped instead of ~281,000mm — beyond far = 1000 the viewer just goes blank.
  expect(distanceOf(viewer)).toBeCloseTo(viewer.camera.far / 2, 6);
  viewer.dispose();
});

test("an unrecognised mode resolves to perspective", () => {
  const viewer = makeViewer();
  viewer.setProjection("orthographic");
  expect(viewer.setProjection("nonsense")).toBe("perspective");
  expect(viewer.camera.isPerspectiveCamera).toBe(true);
  viewer.dispose();
});
