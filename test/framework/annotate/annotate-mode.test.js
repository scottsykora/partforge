// @vitest-environment happy-dom
// Orchestrator: pointer → ink, enter/exit lifecycle, payload assembly, and the
// send-abort-on-null-capture contract.
import { afterEach, describe, expect, it, test, vi } from "vitest";
import * as THREE from "three";
import { createAnnotateMode, ANNOTATION_VERSION } from "../../../src/framework/annotate/annotate-mode.js";

afterEach(() => { document.body.innerHTML = ""; });

const RECT = { left: 10, top: 20, width: 200, height: 100 };

function fakeCanvas() {
  const element = document.createElement("canvas");
  element.getBoundingClientRect = () => RECT;
  document.body.appendChild(element);
  return {
    element,
    show: vi.fn(),
    hide: vi.fn(),
    setStrokes: vi.fn(),
    toDataUrl: vi.fn(() => "data:image/png;base64,INK"),
    size: () => ({ width: 400, height: 200, dpr: 2 }),
    dispose: vi.fn(),
  };
}

function fakeViewer(over = {}) {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  return {
    camera,
    domElement: document.createElement("canvas"),
    _subMeshes: {},
    getCameraState: () => ({ pos: [0, 0, 10], target: [0, 0, 0] }),
    captureCurrent: vi.fn(() => "data:image/jpeg;base64,MODEL"),
    ...over,
  };
}

function fixture(over = {}) {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  const canvas = fakeCanvas();
  const viewer = fakeViewer(over.viewer);
  const onSend = vi.fn();
  const mode = createAnnotateMode(viewer, {
    stage,
    getContext: () => ({ view: "main", params: { size: 42 } }),
    onSend,
    createCanvas: () => canvas,
    ...over.opts,
  });
  return { stage, canvas, viewer, onSend, mode };
}

function pointer(type, clientX, clientY) {
  const e = new MouseEvent(type, { clientX, clientY, bubbles: true });
  return e;
}

function drawStroke(canvas, from = [60, 45], to = [110, 70]) {
  canvas.element.dispatchEvent(pointer("pointerdown", from[0], from[1]));
  canvas.element.dispatchEvent(pointer("pointermove", to[0], to[1]));
  canvas.element.dispatchEvent(pointer("pointerup", to[0], to[1]));
}

// Real THREE camera instances, not object literals — the anchors pass in
// send() raycasts through every stroke point regardless of whether any mesh
// is present to hit, and THREE.Raycaster#setFromCamera unprojects through
// camera.matrixWorld / camera.projectionMatrixInverse, which only a real
// camera instance carries (both are populated by the constructor).
function perspectiveCamera() {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  return camera;
}

function orthographicCamera() {
  // top/bottom span 40mm of world height at zoom 1, so orthoHeight must read
  // back exactly 40.
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 1000);
  camera.position.set(0, 0, 10);
  return camera;
}

// Draws one stroke under either projection and returns the payload the onSend
// spy received. Reuses fixture()/fakeViewer() above (which already knows how
// to override viewer.camera) rather than a second, parallel stub viewer.
function sendOneStroke({ ortho }) {
  const camera = ortho ? orthographicCamera() : perspectiveCamera();
  const { canvas, onSend, mode } = fixture({ viewer: { camera } });
  mode.setEnabled(true);
  drawStroke(canvas);
  mode.send();
  return { payload: onSend.mock.calls[0][0] };
}

// Same as sendOneStroke, but with a sub-mesh parented under a group, so
// cameraBlock()'s `parts` frame (near annotate-mode.js:103-104) actually
// populates instead of returning null — the stub viewer's default
// `_subMeshes: {}` has no parent to invert, which is the "no meshes" path the
// other tests exercise. This is the frame that survives a model rebuild, so
// its projection/fov/orthoHeight must agree with `world`, not just `world`'s.
function sendOneStrokeWithParts({ ortho }) {
  const camera = ortho ? orthographicCamera() : perspectiveCamera();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo);
  new THREE.Group().add(mesh); // mesh.parent now has an (identity) matrixWorld to invert
  const { canvas, onSend, mode } = fixture({ viewer: { camera, _subMeshes: { body: mesh } } });
  mode.setEnabled(true);
  drawStroke(canvas);
  mode.send();
  return { payload: onSend.mock.calls[0][0] };
}

test("enable shows the canvas; drawing normalizes against the canvas rect", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  expect(canvas.show).toHaveBeenCalled();
  drawStroke(canvas, [60, 45], [110, 70]); // rect left=10 top=20 w=200 h=100
  expect(mode.strokeCount()).toBe(1);
  const strokes = canvas.setStrokes.mock.calls.at(-1)[0];
  expect(strokes[0].points[0]).toEqual([0.25, 0.25]);
  expect(strokes[0].points.at(-1)).toEqual([0.5, 0.5]);
});

test("exit discards ink and hides the canvas", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  drawStroke(canvas);
  mode.setEnabled(false);
  expect(mode.strokeCount()).toBe(0);
  expect(canvas.hide).toHaveBeenCalled();
});

test("send assembles the payload, calls onSend, exits, and clears", () => {
  const { canvas, viewer, onSend, mode } = fixture();
  mode.setEnabled(true);
  drawStroke(canvas);
  expect(mode.send()).toBe(true);
  expect(onSend).toHaveBeenCalledTimes(1);
  const payload = onSend.mock.calls[0][0];
  expect(payload.version).toBe(ANNOTATION_VERSION);
  expect(payload.strokes).toHaveLength(1);
  expect(payload.images).toEqual({ drawing: "data:image/png;base64,INK", model: "data:image/jpeg;base64,MODEL" });
  // v2: the world frame also names its projection and carries orthoHeight
  // (null under perspective) alongside fov.
  expect(payload.camera.world).toEqual({
    pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0],
    projection: "perspective", fov: 45, orthoHeight: null,
  });
  expect(payload.camera.parts).toBe(null); // no meshes in the stub viewer
  expect(payload.viewport).toEqual({ width: 200, height: 100, dpr: 2 });
  expect(payload.context).toEqual({ view: "main", params: { size: 42 } });
  // anchors: one open stroke → t = 0 / 0.5 / 1, all misses (empty scene)
  expect(payload.anchors.map((a) => a.t)).toEqual([0, 0.5, 1]);
  expect(payload.anchors.every((a) => a.hit === null)).toBe(true);
  expect(payload.anchors[0].stroke).toBe(0);
  // capture size follows the ink bitmap's long edge, under the 2048 bound
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 400 });
  // sent → mode exits and ink clears
  expect(mode.isEnabled()).toBe(false);
  expect(mode.strokeCount()).toBe(0);
});

test("both pictures are bounded to the same long edge", () => {
  // A large hi-DPI stage: unbounded, the ink layer would export at 5120px and
  // the model render would follow it, handing the host two multi-megabyte data
  // URLs to carry somewhere.
  const big = fakeCanvas();
  big.size = () => ({ width: 5120, height: 2560, dpr: 2 });
  const { viewer, onSend, mode } = fixture({ opts: { createCanvas: () => big } });
  mode.setEnabled(true);
  drawStroke(big);
  expect(mode.send()).toBe(true);
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 2048 });
  expect(big.toDataUrl).toHaveBeenCalledWith({ maxEdge: 2048 });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test("send aborts (ink intact, still enabled) when captureCurrent returns null", () => {
  const { canvas, onSend, mode } = fixture({
    viewer: { captureCurrent: vi.fn(() => null) },
  });
  mode.setEnabled(true);
  drawStroke(canvas);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(mode.isEnabled()).toBe(true);
  expect(mode.strokeCount()).toBe(1);
});

test("send with no ink is a no-op", () => {
  const { onSend, mode } = fixture();
  mode.setEnabled(true);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
});

test("payload params are a snapshot, not the live object", () => {
  const params = { size: 1 };
  const { canvas, onSend, mode } = fixture({
    opts: { getContext: () => ({ view: "main", params }) },
  });
  mode.setEnabled(true);
  drawStroke(canvas);
  mode.send();
  params.size = 2;
  expect(onSend.mock.calls[0][0].context.params.size).toBe(1);
});

test("detach disposes the canvas and is idempotent", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  mode.detach();
  mode.detach();
  expect(canvas.dispose).toHaveBeenCalledTimes(1);
});

test("detach while enabled leaves the state machine honest", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  mode.detach();
  expect(mode.isEnabled()).toBe(false);
  expect(canvas.hide).toHaveBeenCalled();
  expect(canvas.dispose).toHaveBeenCalledTimes(1);
});

describe("camera block under each projection", () => {
  it("is version 2 and reports a perspective camera by name", () => {
    // A consumer reconstructing the camera must be told which projection it is
    // looking at — an fov-shaped hole is how that fails silently.
    const { payload } = sendOneStroke({ ortho: false });
    expect(payload.version).toBe(2);
    expect(payload.camera.world.projection).toBe("perspective");
    expect(payload.camera.world.fov).toBe(45);
    expect(payload.camera.world.orthoHeight).toBeNull();
  });

  it("reports an orthographic camera with its frustum height and no fov", () => {
    const { payload } = sendOneStroke({ ortho: true });
    expect(payload.camera.world.projection).toBe("orthographic");
    expect(payload.camera.world.fov).toBeNull();
    expect(payload.camera.world.orthoHeight).toBeCloseTo(40, 6);
  });

  // `parts` is the durable frame — pinned to the CAD geometry so it survives
  // a later rebuild's per-view recentring. A consumer re-referencing a sketch
  // against an updated model reads THIS frame, so it needs the same
  // projection/orthoHeight/fov as `world`, not just a copy of `fov` (which
  // would leave an ortho payload's parts frame with a null and no explanation).
  it("parts frame agrees with world on projection/fov/orthoHeight under perspective", () => {
    const { payload } = sendOneStrokeWithParts({ ortho: false });
    expect(payload.camera.parts).not.toBeNull(); // guards the assertions below against a no-op
    expect(payload.camera.parts.projection).toBe("perspective");
    expect(payload.camera.parts.fov).toBe(45);
    expect(payload.camera.parts.orthoHeight).toBeNull();
  });

  it("parts frame agrees with world on projection/fov/orthoHeight under orthographic", () => {
    const { payload } = sendOneStrokeWithParts({ ortho: true });
    expect(payload.camera.parts).not.toBeNull();
    expect(payload.camera.parts.projection).toBe("orthographic");
    expect(payload.camera.parts.fov).toBeNull();
    expect(payload.camera.parts.orthoHeight).toBeCloseTo(40, 6);
  });
});
