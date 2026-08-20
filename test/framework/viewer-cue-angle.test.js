// @vitest-environment happy-dom
// Where a camera cue actually LANDS. This is deliberately a live-viewer test
// rather than a camera-tween.js one: the settled pose is the composition of
// cameraPoseForView → the tween → OrbitControls.update(), and the two bugs this
// file pins were both invisible in the pieces taken separately.
//
//   1. The tween used to clamp its destination 0.01 rad off the poles, so a
//      "top" or "bottom" cue settled 0.573° off axis — enough that a spacer kept
//      a visible sliver of side wall instead of reading as a flat outline.
//   2. OrbitControls' damping residual outlives the tween. A cue clicked right
//      after a flick used to settle wherever the leftover fling dragged it
//      (measured on the demo part: 3.8° off a top cue).
//
// Same faked-WebGLRenderer harness as viewer-projection/viewer-pose, plus the
// render loop driven by hand — the tween only advances inside it.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as THREE from "three";

const state = vi.hoisted(() => ({ renderer: null, cutaway: null, controls: null }));

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
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

// The cutaway needs a GL context for its gizmo. Faking it also hands this suite
// the live OrbitControls instance, which the viewer otherwise keeps private —
// createCutaway is the one call it is passed to.
vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn((options) => {
    state.controls = options.orbitControls;
    return state.cutaway;
  }),
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

function createContainer(width = 400, height = 300) {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  document.body.appendChild(container);
  return container;
}

// A 10mm triangle in the XY plane: a real bounding box for frameTo to frame.
const triangle = (mm = 10) => ({
  positions: new Float32Array([0, 0, 0, mm, 0, 0, 0, mm, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
});

function makeViewer() {
  const viewer = createViewer(createContainer(), { meta: {}, parts: { body: {} } });
  viewer.setSubGeometry("body", triangle());
  viewer.showAssembly(["body"], { frame: true });
  return viewer;
}

// Drive the real render loop. The tween advances only from inside it, and the
// camera's own basis (quaternion) is only refreshed by the controls.update()
// of the frame AFTER the tween writes its last position — so "settle" means a
// few frames past the end, exactly as a real settle does.
let clock = 0;
function runFrames(count = 80, step = 16) {
  for (let i = 0; i < count; i++) {
    clock += step;
    state.renderer.animationLoop(clock);
  }
}

// Angle, in degrees, between the direction the camera looks FROM and an axis.
function offAxisDeg(viewer, axis) {
  const { pos, target } = viewer.getCameraState();
  const dir = new THREE.Vector3().fromArray(pos).sub(new THREE.Vector3().fromArray(target)).normalize();
  const want = new THREE.Vector3().fromArray(axis).normalize();
  return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(dir.dot(want), -1, 1)));
}

// The acceptance bar: a landing this close is well past anything a frustum or an
// eye can resolve. OrbitControls' own Spherical.makeSafe() holds phi 1e-6 rad
// (5.7e-5°) off the pole, so an exact-axis cue settles at that floor, not at 0.
const TOLERANCE_DEG = 0.01;

beforeEach(() => {
  clock = 0;
  state.renderer = null;
  state.controls = null;
  state.cutaway = createFakeCutaway();
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

// --- the poles, both projections -------------------------------------------

test.each([
  ["perspective", "top", [0, 1, 0]],
  ["perspective", "bottom", [0, -1, 0]],
  ["orthographic", "top", [0, 1, 0]],
  ["orthographic", "bottom", [0, -1, 0]],
])("a %s %s cue settles exactly on axis", (projection, view, axis) => {
  const viewer = makeViewer();
  viewer.setProjection(projection);

  // refit: true is what the view cube's clicks pass.
  viewer.tweenCameraTo(view, { duration: 0.6, refit: true });
  runFrames();

  expect(offAxisDeg(viewer, axis)).toBeLessThan(TOLERANCE_DEG);
  viewer.dispose();
});

test("a top cue settles into the roll view-angles names as its up", () => {
  const viewer = makeViewer();
  viewer.tweenCameraTo("top", { duration: 0.6, refit: true });
  runFrames();

  // view-angles.js gives top up: [0, 0, -1] — and that is what the orbit frame
  // derives on its own at azimuth 0, which is why the live camera never has to
  // be handed the pose's `up` (only the offscreen capture path, which has no
  // OrbitControls to derive it, sets one).
  const screenUp = new THREE.Vector3(0, 1, 0).applyQuaternion(viewer.camera.quaternion);
  expect(screenUp.x).toBeCloseTo(0, 4);
  expect(screenUp.y).toBeCloseTo(0, 4);
  expect(screenUp.z).toBeCloseTo(-1, 4);
  viewer.dispose();
});

// --- the damping residual ---------------------------------------------------

// 0.3 rad of unspent fling: what OrbitControls holds after a brisk drag, and
// what it would otherwise keep spending for seconds afterwards.
const FLING = 0.3;

test.each([
  ["perspective", [0, 1, 0]],
  ["orthographic", [0, 1, 0]],
])("a live orbit fling cannot drag a %s top cue off axis", (projection, axis) => {
  const viewer = makeViewer();
  viewer.setProjection(projection);
  // Push the residual AWAY from the pole: the direction that used to leave the
  // settled view several degrees short of the axis.
  state.controls._sphericalDelta.phi = FLING;
  state.controls._sphericalDelta.theta = FLING;

  viewer.tweenCameraTo("top", { duration: 0.6, refit: true });
  runFrames();

  expect(offAxisDeg(viewer, axis)).toBeLessThan(TOLERANCE_DEG);
  // Drained, not merely outrun — otherwise it would still be leaking a frame
  // at a time long after the assertion above.
  expect(state.controls._sphericalDelta.phi).toBe(0);
  expect(state.controls._sphericalDelta.theta).toBe(0);
  viewer.dispose();
});

test("damping is suspended only for the life of the cue, and restored after", () => {
  const viewer = makeViewer();
  expect(state.controls.enableDamping).toBe(true);

  viewer.tweenCameraTo("top", { duration: 0.6 });
  runFrames(10);
  expect(state.controls.enableDamping).toBe(false);

  runFrames(60);
  expect(state.controls.enableDamping).toBe(true);
  viewer.dispose();
});

test("a user grab mid-cue cancels the tween and gives damping straight back", () => {
  const viewer = makeViewer();
  viewer.tweenCameraTo("top", { duration: 0.6 });
  runFrames(10);
  const midFlight = viewer.getCameraState().pos;

  viewer.cancelCameraTween();

  expect(state.controls.enableDamping).toBe(true);
  runFrames(60);
  // Cancelled means cancelled: the camera stays where the grab found it. Compared
  // to a tolerance rather than exactly, because controls.update() re-derives the
  // position from its spherical coordinates every frame and that costs a few ulps.
  viewer.getCameraState().pos.forEach((v, i) => expect(v).toBeCloseTo(midFlight[i], 9));
  viewer.dispose();
});

// --- the other regions, and the animation contract --------------------------

const R3 = 1 / Math.sqrt(3);
test.each([
  ["front", [0, 0, 1]],
  ["right", [1, 0, 0]],
  ["top-front", [0, Math.SQRT1_2, Math.SQRT1_2]],
  ["bottom-left", [-Math.SQRT1_2, -Math.SQRT1_2, 0]],
  ["top-front-right", [R3, R3, R3]],
  ["bottom-back-left", [-R3, -R3, -R3]],
])("a %s cue still lands on its own direction", (view, axis) => {
  const viewer = makeViewer();
  viewer.setProjection("orthographic");
  viewer.tweenCameraTo(view, { duration: 0.6, refit: true });
  runFrames();

  expect(offAxisDeg(viewer, axis)).toBeLessThan(TOLERANCE_DEG);
  viewer.dispose();
});

test("an animation camera cue still only changes the angle, never the framing", () => {
  const viewer = makeViewer();
  viewer.setProjection("orthographic");
  // A cue means "look from here". The user's own dolly (ortho zoom) must survive
  // it — that is the contract `refit` exists to opt OUT of.
  viewer.camera.zoom = 2;
  viewer.camera.updateProjectionMatrix();
  const halfHeight = viewer.camera.top;

  viewer.tweenCameraTo("top", { duration: 0.6 }); // no refit: the animation path
  runFrames();

  expect(viewer.camera.zoom).toBe(2);
  expect(viewer.camera.top).toBe(halfHeight);
  // ...and it still arrives on the axis it was asked for.
  expect(offAxisDeg(viewer, [0, 1, 0])).toBeLessThan(TOLERANCE_DEG);
  viewer.dispose();
});
