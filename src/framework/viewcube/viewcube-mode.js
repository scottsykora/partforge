// The view cube's orchestrator — the only viewcube file that touches both the
// viewer and the DOM (the annotate-mode.js / measure-mode.js stance). Owns the
// frame subscription, the dirty check that keeps idle frames free, pointer
// input, and the drag/click split.
import { projectCube, hitRegion } from "./cube-geom.js";
import { createCubeCanvas } from "./cube-canvas.js";
import { runCleanupSteps } from "../teardown.js";

// Past this many px of travel a press is an orbit, not a click. 4px is the
// usual "did they mean to drag" threshold and comfortably above the jitter a
// trackpad tap produces.
const DRAG_THRESHOLD_PX = 4;

export function createViewcubeMode(viewer, {
  host,
  createCanvas = createCubeCanvas,
  dragThreshold = DRAG_THRESHOLD_PX,
} = {}) {
  const wrap = document.createElement("div");
  wrap.className = "pf-viewcube";
  host.appendChild(wrap);

  const canvas = createCanvas(wrap, {});
  canvas.setTheme?.(viewer.getTheme?.() ?? "dark");

  let hidden = false;
  let hover = null;
  let projected = null;
  // The dirty check. An unchanged camera must cost nothing — no clear, no
  // fills — because this runs inside the viewer's rAF callback alongside the
  // cutaway's outline re-slice and the main render.
  let lastKey = null;

  const cameraKey = () => {
    const cam = viewer.camera;
    const q = cam.quaternion;
    // Zoom is part of the key because an ortho dolly changes camera.zoom
    // without touching the quaternion, and the cube's scale follows neither —
    // but the projection SWAP repaints, and a zoom change is the cheapest
    // signal that one happened.
    return `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)},${q.w.toFixed(6)},${cam.isOrthographicCamera ? cam.zoom : 0}`;
  };

  function redraw() {
    if (hidden) return;
    const cam = viewer.camera;
    const q = cam.quaternion;
    projected = projectCube([q.x, q.y, q.z, q.w], { size: canvas.size });
    canvas.draw(projected, { hover });
  }

  function onFrame() {
    if (hidden) return;
    const key = cameraKey();
    if (key === lastKey) return;
    lastKey = key;
    redraw();
  }

  // --- pointer ---------------------------------------------------------------
  let press = null; // { x, y, dragging, id }

  const localPoint = (event) => {
    const rect = canvas.element.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const onPointerDown = (event) => {
    if (event.isPrimary === false || hidden) return;
    press = { x: event.clientX, y: event.clientY, dragging: false, id: event.pointerId };
    canvas.element.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (event.isPrimary === false || hidden) return;
    if (press) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.dragging && Math.hypot(dx, dy) < dragThreshold) return;
      press.dragging = true;
      press.x = event.clientX;
      press.y = event.clientY;
      // Hover is meaningless mid-drag and would flicker as the cube spins.
      if (hover !== null) hover = null;
      viewer.orbitBy(dx, dy);
      return;
    }
    const next = hitRegion(...localPoint(event), projected);
    if (next === hover) return;
    hover = next;
    redraw();
  };

  const onPointerUp = (event) => {
    if (!press || event.isPrimary === false) return;
    const wasDrag = press.dragging;
    canvas.element.releasePointerCapture?.(press.id);
    press = null;
    if (wasDrag) return;
    const id = hitRegion(...localPoint(event), projected);
    if (id) viewer.tweenCameraTo(id, { duration: 0.6 });
  };

  const onPointerLeave = () => {
    if (press || hover === null) return;
    hover = null;
    redraw();
  };

  canvas.element.addEventListener("pointerdown", onPointerDown);
  canvas.element.addEventListener("pointermove", onPointerMove);
  canvas.element.addEventListener("pointerup", onPointerUp);
  canvas.element.addEventListener("pointercancel", onPointerUp);
  canvas.element.addEventListener("pointerleave", onPointerLeave);

  const offFrame = viewer.onFrame(onFrame);
  const offTheme = viewer.onThemeChange((mode) => {
    canvas.setTheme(mode);
    redraw();
  });

  lastKey = cameraKey();
  redraw(); // never show a blank box before the first camera movement

  function setHidden(flag) {
    const next = !!flag;
    if (next === hidden) return;
    hidden = next;
    wrap.hidden = hidden;
    if (!hidden) {
      // The camera almost certainly moved while we were away, and the dirty
      // check would otherwise hold the stale drawing until it moves again.
      lastKey = cameraKey();
      redraw();
    }
  }

  let detached = false;
  return {
    element: wrap,
    setHidden,
    isHidden: () => hidden,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offFrame,
        offTheme,
        () => canvas.element.removeEventListener("pointerdown", onPointerDown),
        () => canvas.element.removeEventListener("pointermove", onPointerMove),
        () => canvas.element.removeEventListener("pointerup", onPointerUp),
        () => canvas.element.removeEventListener("pointercancel", onPointerUp),
        () => canvas.element.removeEventListener("pointerleave", onPointerLeave),
        () => canvas.dispose(),
        () => wrap.remove(),
      ], "viewcube mode cleanup failed");
    },
  };
}
