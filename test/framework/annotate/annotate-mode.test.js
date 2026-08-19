// @vitest-environment happy-dom
// Orchestrator: pointer → ink, enter/exit lifecycle, payload assembly, and the
// send-abort-on-null-capture contract.
import { afterEach, expect, test, vi } from "vitest";
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
  expect(payload.camera.world).toEqual({ pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 45 });
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
