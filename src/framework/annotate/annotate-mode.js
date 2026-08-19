// Annotation-mode orchestrator — the one annotate module touching both the DOM
// and the viewer (the measure-mode.js stance). Owns pointer→ink, the mode
// lifecycle, and payload assembly. The overlay canvas is lazy-created on first
// enable and kept across toggles; INK is not — exiting the mode discards it,
// because screen-space ink is only meaningful against the camera pose it was
// drawn over (deliberately unlike measure pins).
import * as THREE from "three";
import { createInkStore, anchorSpecs, DEFAULT_STROKE_WIDTH } from "./ink.js";
import { createInkCanvas } from "./ink-canvas.js";
import { raycastViewer } from "../selection/raycast.js";

export const ANNOTATION_VERSION = 1;
// Long-edge bound on BOTH pictures in the payload. The ink canvas is stage
// sized × devicePixelRatio, so an unbounded send on a large hi-DPI display
// hands the host a multi-megabyte pair of base64 strings — slow to encode,
// and past the ceiling a host that ships them anywhere has to enforce. 2048
// is captureCurrent's own default and comfortably above what any reviewer
// (human or model) reads a sketch at; a smaller stage exports at its own size
// and pays nothing.
const SEND_MAX_EDGE = 2048;

export function createAnnotateMode(viewer, { stage, getContext, onSend, createCanvas = createInkCanvas } = {}) {
  const ink = createInkStore();
  let canvas = null; // lazy; created on first enable
  let enabled = false;
  let drawing = false;
  const modeListeners = new Set();
  const notifyMode = () => { for (const cb of [...modeListeners]) cb(); };
  const offInk = ink.onChange(() => canvas?.setStrokes(ink.strokes()));

  const rectOf = () => canvas.element.getBoundingClientRect();
  const normalized = (event, rect) => [
    Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  ];

  // isPrimary === false (a second simultaneous touch) is ignored; undefined
  // (plain MouseEvent, some test environments) draws normally.
  const onPointerDown = (event) => {
    if (event.isPrimary === false || drawing) return;
    const rect = rectOf();
    if (!rect.width || !rect.height) return;
    drawing = true;
    canvas.element.setPointerCapture?.(event.pointerId);
    const [nx, ny] = normalized(event, rect);
    ink.begin(nx, ny, { width: DEFAULT_STROKE_WIDTH, aspect: rect.width / rect.height });
  };
  const onPointerMove = (event) => {
    if (!drawing || event.isPrimary === false) return;
    const [nx, ny] = normalized(event, rectOf());
    ink.extend(nx, ny);
  };
  const onPointerEnd = (event) => {
    if (!drawing || event.isPrimary === false) return;
    drawing = false;
    ink.end();
  };

  function ensureCanvas() {
    if (canvas) return;
    canvas = createCanvas(stage);
    canvas.element.addEventListener("pointerdown", onPointerDown);
    canvas.element.addEventListener("pointermove", onPointerMove);
    canvas.element.addEventListener("pointerup", onPointerEnd);
    canvas.element.addEventListener("pointercancel", onPointerEnd);
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      ensureCanvas();
      canvas.show();
    } else {
      drawing = false;
      ink.clear(); // spec: ink never survives an exit
      canvas?.hide();
    }
    notifyMode();
  }

  // The camera pose in two frames. World replays exactly against THIS build;
  // the parts frame (through the inverse of the shared parts parent's
  // matrixWorld — the measure-mode idiom) stays pinned to the CAD geometry, so
  // it survives the per-view bbox recentring when the model is rebuilt later.
  function cameraBlock() {
    const { pos, target } = viewer.getCameraState();
    const world = { pos, target, up: viewer.camera.up.toArray(), fov: viewer.camera.fov };
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent ?? null;
    if (!parent) return { world, parts: null };
    parent.updateWorldMatrix(true, false);
    const inv = parent.matrixWorld.clone().invert();
    const map = (v) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(inv).toArray();
    const up = new THREE.Vector3(world.up[0], world.up[1], world.up[2]).transformDirection(inv).toArray();
    return { world, parts: { pos: map(world.pos), target: map(world.target), up, fov: world.fov } };
  }

  function send() {
    if (!enabled || ink.isEmpty()) return false;
    const rect = rectOf();
    if (!rect.width || !rect.height) return false;
    const { width, height, dpr } = canvas.size();
    // Model render FIRST: on a lost WebGL context captureCurrent returns null
    // and we abort with the ink intact — nothing is silently dropped.
    const model = viewer.captureCurrent({ size: Math.min(Math.max(width, height), SEND_MAX_EDGE) });
    if (!model) return false;
    const strokes = ink.strokes();
    const aspect = rect.width / rect.height;
    const anchors = strokes.flatMap((stroke, index) =>
      anchorSpecs(stroke.points, aspect).map((spec) => {
        const hit = raycastViewer(
          viewer,
          rect.left + spec.screen[0] * rect.width,
          rect.top + spec.screen[1] * rect.height,
        );
        return {
          stroke: index,
          ...(spec.kind ? { kind: spec.kind } : { t: spec.t }),
          screen: spec.screen,
          // a miss is kept as null — "circled empty space" is signal
          hit: hit ? { subPart: hit.subPart, pointLocal: hit.pointLocal } : null,
        };
      }));
    const { view, params } = getContext();
    onSend?.({
      version: ANNOTATION_VERSION,
      strokes,
      anchors,
      images: { drawing: canvas.toDataUrl({ maxEdge: SEND_MAX_EDGE }), model },
      camera: cameraBlock(),
      viewport: { width: rect.width, height: rect.height, dpr },
      context: { view, params: { ...params } },
    });
    setEnabled(false); // sent: exit and discard
    return true;
  }

  let detached = false;
  return {
    setEnabled,
    isEnabled: () => enabled,
    undo: () => ink.undo(),
    clear: () => ink.clear(),
    strokeCount: () => ink.strokeCount(),
    send,
    onInkChange: (cb) => ink.onChange(cb),
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    detach() {
      if (detached) return;
      detached = true;
      // Leave the state machine honest: a detach while enabled must not
      // strand isEnabled() at true forever. Runs before listeners/canvas
      // teardown below — setEnabled(false) notifies mode listeners and hides
      // the canvas, both of which still need to be live for this call.
      setEnabled(false);
      offInk();
      if (!canvas) return;
      canvas.element.removeEventListener("pointerdown", onPointerDown);
      canvas.element.removeEventListener("pointermove", onPointerMove);
      canvas.element.removeEventListener("pointerup", onPointerEnd);
      canvas.element.removeEventListener("pointercancel", onPointerEnd);
      canvas.dispose();
    },
  };
}
