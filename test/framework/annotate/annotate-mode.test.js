// @vitest-environment happy-dom
// Orchestrator: pointer -> tool state machine -> elements, enter/exit
// lifecycle, payload v3 assembly, and the send-abort-on-null-capture contract.
import { afterEach, describe, expect, it, test, vi } from "vitest";
import * as THREE from "three";
import { createAnnotateMode, ANNOTATION_VERSION } from "../../../src/framework/annotate/annotate-mode.js";

afterEach(() => { document.body.innerHTML = ""; });

const RECT = { left: 10, top: 20, width: 200, height: 100 }; // aspect = 2

function fakeCanvas() {
  const element = document.createElement("canvas");
  element.getBoundingClientRect = () => RECT;
  document.body.appendChild(element);
  return {
    element,
    show: vi.fn(),
    hide: vi.fn(),
    setScene: vi.fn(),
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

function pointer(type, clientX, clientY, opts = {}) {
  return new MouseEvent(type, { clientX, clientY, bubbles: true, ...opts });
}

// stage-space conversion: RECT height 100 -> stage x = (clientX-10)/100, y = (clientY-20)/100
const drag = (canvas, from, to) => {
  canvas.element.dispatchEvent(pointer("pointerdown", from[0], from[1]));
  canvas.element.dispatchEvent(pointer("pointermove", to[0], to[1]));
  canvas.element.dispatchEvent(pointer("pointerup", to[0], to[1]));
};

const lastScene = (canvas) => canvas.setScene.mock.calls.at(-1)[0];

// Real THREE camera instances, not object literals — the anchors pass in
// send() raycasts through every element regardless of whether any mesh is
// present to hit, and THREE.Raycaster#setFromCamera unprojects through
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

// Draws one freehand element (default pen tool) under either projection and
// returns the payload the onSend spy received.
function sendOneStroke({ ortho }) {
  const camera = ortho ? orthographicCamera() : perspectiveCamera();
  const { canvas, onSend, mode } = fixture({ viewer: { camera } });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  return { payload: onSend.mock.calls[0][0] };
}

// Same as sendOneStroke, but with a sub-mesh parented under a group, so
// cameraBlock()'s `parts` frame actually populates instead of returning null.
function sendOneStrokeWithParts({ ortho }) {
  const camera = ortho ? orthographicCamera() : perspectiveCamera();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo);
  new THREE.Group().add(mesh); // mesh.parent now has an (identity) matrixWorld to invert
  const { canvas, onSend, mode } = fixture({ viewer: { camera, _subMeshes: { body: mesh } } });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  return { payload: onSend.mock.calls[0][0] };
}

test("pen is the default tool; a drag commits a freehand element", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  expect(canvas.show).toHaveBeenCalled();
  expect(mode.tool()).toBe("pen");
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.strokeCount()).toBe(1);
});

test("rect tool commits center-based params in stage space", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]); // stage (0.2,0.2) -> (1.0,0.7)
  const scene = lastScene(canvas);
  expect(scene.elements[0].type).toBe("rect");
  expect(scene.elements[0].params.cx).toBeCloseTo(0.6);
  expect(scene.elements[0].params.cy).toBeCloseTo(0.45);
  expect(scene.elements[0].params.w).toBeCloseTo(0.8);
  expect(scene.elements[0].params.h).toBeCloseTo(0.5);
});

test("sub-MIN_DRAG_PX shape drags commit nothing", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [60, 45], [62, 46]); // ~2.2px — under the 6px floor
  expect(mode.strokeCount()).toBe(0);
});

test("color selection applies to subsequent elements", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setColor("green");
  drag(canvas, [60, 45], [110, 70]);
  expect(lastScene(canvas).elements[0].color).toBe("green");
});

test("eraser drag adds gaps; undo restores them away", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]); // full-width line at y=0.5
  mode.setTool("eraser");
  drag(canvas, [110, 60], [110, 80]); // brush through the middle
  const gapped = lastScene(canvas).elements[0];
  expect(gapped.gaps.length).toBe(1);
  mode.undo();
  expect(lastScene(canvas).elements[0].gaps).toEqual([]);
});

test("hand tool moves an element by its outline", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]);
  mode.setTool("hand");
  drag(canvas, [110, 70], [110, 90]); // grab the middle, pull down 0.2 stage
  const moved = lastScene(canvas).elements[0];
  expect(moved.params.y1).toBeCloseTo(0.7);
  expect(moved.params.y2).toBeCloseTo(0.7);
});

test("hand tool resizes a rect from a corner handle", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]); // cx 0.6 cy 0.45 w 0.8 h 0.5
  mode.setTool("hand");
  // bottom-right corner is at cx+w/2, cy+h/2 = (1.0, 0.7) stage -> client (110,90)
  drag(canvas, [110, 90], [130, 90]); // drag the corner right by 0.2 stage
  const resized = lastScene(canvas).elements[0];
  expect(resized.params.w).toBeCloseTo(1.0);
});

test("send payload is v3: elements with params, erased, description, anchors", () => {
  const { mode, canvas, onSend } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]);
  expect(mode.send()).toBe(true);
  const payload = onSend.mock.calls[0][0];
  expect(payload.version).toBe(3);
  expect(payload.strokes).toBeUndefined();
  const [rect] = payload.elements;
  expect(rect.type).toBe("rect");
  expect(rect.color).toEqual({ name: "red", hex: "#d92d20" });
  expect(rect.erased).toEqual([]);
  expect(rect.visibleFraction).toBe(1);
  expect(rect.description).toContain("rect · c");
  const center = rect.anchors.find((a) => a.at === "center");
  // anchors are normalized per axis 0..1 (screen frame, as v2)
  expect(center.screen[0]).toBeCloseTo(0.3); // stage 0.6 / aspect 2
  expect(center.screen[1]).toBeCloseTo(0.45);
  expect(center).toHaveProperty("hit");
  expect(payload.images).toEqual({ drawing: expect.any(String), model: "data:image/jpeg;base64,MODEL" });
  // sent -> mode exits and elements clear
  expect(mode.isEnabled()).toBe(false);
  expect(mode.strokeCount()).toBe(0);
});

test("a circle-shaped ellipse is flagged and collapses to a single radius", () => {
  const { mode, canvas, onSend } = fixture();
  mode.setEnabled(true);
  mode.setTool("ellipse");
  drag(canvas, [30, 30], [50, 50]); // stage (0.2,0.1) -> (0.4,0.3): near-square drag snaps to a circle
  mode.send();
  const [el] = onSend.mock.calls[0][0].elements;
  expect(el.params.circle).toBe(true);
  expect(el.params).toHaveProperty("r");
  expect(el.params).not.toHaveProperty("rx");
});

test("capture size follows the ink bitmap's long edge, under the 2048 bound", () => {
  const { canvas, viewer, mode } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 400 });
});

test("both pictures are bounded to the same long edge", () => {
  // A large hi-DPI stage: unbounded, the ink layer would export at 5120px and
  // the model render would follow it, handing the host two multi-megabyte data
  // URLs to carry somewhere.
  const big = fakeCanvas();
  big.size = () => ({ width: 5120, height: 2560, dpr: 2 });
  const { viewer, onSend, mode } = fixture({ opts: { createCanvas: () => big } });
  mode.setEnabled(true);
  drag(big, [60, 45], [110, 70]);
  expect(mode.send()).toBe(true);
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 2048 });
  expect(big.toDataUrl).toHaveBeenCalledWith({ maxEdge: 2048 });
  expect(onSend).toHaveBeenCalledTimes(1);
});

test("send aborts (elements intact, still enabled) when captureCurrent returns null", () => {
  const { canvas, onSend, mode } = fixture({
    viewer: { captureCurrent: vi.fn(() => null) },
  });
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(mode.isEnabled()).toBe(true);
  expect(mode.strokeCount()).toBe(1);
});

test("send with no elements is a no-op", () => {
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
  drag(canvas, [60, 45], [110, 70]);
  mode.send();
  params.size = 2;
  expect(onSend.mock.calls[0][0].context.params.size).toBe(1);
});

test("setEnabled(false) discards elements and hides the canvas", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  mode.setEnabled(false);
  expect(mode.strokeCount()).toBe(0);
  expect(canvas.hide).toHaveBeenCalled();
});

test("escape-like cancel: setEnabled(false) mid-gesture discards everything", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  canvas.element.dispatchEvent(pointer("pointerdown", 60, 45));
  mode.setEnabled(false);
  mode.setEnabled(true);
  expect(mode.strokeCount()).toBe(0);
});

test("tool and color persist across an enable/disable cycle", () => {
  const { mode } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  mode.setColor("blue");
  mode.setEnabled(false);
  mode.setEnabled(true);
  expect(mode.tool()).toBe("rect");
  expect(mode.color()).toBe("blue");
});

test("onToolChange fires for tool and color changes", () => {
  const { mode } = fixture();
  let calls = 0;
  mode.onToolChange(() => { calls += 1; });
  mode.setTool("rect");
  mode.setColor("blue");
  mode.setTool("rect"); // no-op: unchanged
  expect(calls).toBe(2);
});

test("canUndo tracks the store's history", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  expect(mode.canUndo()).toBe(false);
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.canUndo()).toBe(true);
});

test("Escape cancels a hand-tool drag by undoing it", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]); // y = 0.5 both ends
  mode.setTool("hand");
  canvas.element.dispatchEvent(pointer("pointerdown", 110, 70));
  canvas.element.dispatchEvent(pointer("pointermove", 110, 90));
  canvas.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const el = lastScene(canvas).elements[0];
  expect(el.params.y1).toBeCloseTo(0.5);
  expect(el.params.y2).toBeCloseTo(0.5);
});

test("Escape during a shape drag drops the preview without committing", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  canvas.element.dispatchEvent(pointer("pointerdown", 30, 40));
  canvas.element.dispatchEvent(pointer("pointermove", 110, 90));
  canvas.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(mode.strokeCount()).toBe(0);
  canvas.element.dispatchEvent(pointer("pointerup", 110, 90));
  expect(mode.strokeCount()).toBe(0); // gesture already cancelled: pointerup is a no-op
});

test("Escape with no in-flight gesture is a no-op (mode exit stays the chrome's job)", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  drag(canvas, [60, 45], [110, 70]);
  canvas.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(mode.isEnabled()).toBe(true);
  expect(mode.strokeCount()).toBe(1);
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

test("onModeChange fires on enable and disable", () => {
  const { mode } = fixture();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
});

describe("camera block under each projection", () => {
  it("is version 3 and reports a perspective camera by name", () => {
    // A consumer reconstructing the camera must be told which projection it is
    // looking at — an fov-shaped hole is how that fails silently.
    const { payload } = sendOneStroke({ ortho: false });
    expect(payload.version).toBe(ANNOTATION_VERSION);
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
