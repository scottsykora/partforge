// Viewer adapter for click-to-select: arms a click listener, raycasts via the shared
// selection raycast, and hands a resolved Selection to onPick.
import { raycastViewer, worldToSubPartLocal } from "./raycast.js";
import { resolveSelection } from "./resolve.js";

export { worldToSubPartLocal };

const DRAG_THRESHOLD_SQUARED = 4 ** 2;

export function attachPicker(viewer, { part, getContext, onPick }) {
  let active = false;
  const pointerStarts = new Map();
  let dragged = false;

  function onPointerDown(ev) {
    if (pointerStarts.size === 0) dragged = false;
    pointerStarts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  }

  function onPointerMove(ev) {
    const pointerStart = pointerStarts.get(ev.pointerId);
    if (!pointerStart || dragged) return;
    const dx = ev.clientX - pointerStart.x;
    const dy = ev.clientY - pointerStart.y;
    dragged = dx * dx + dy * dy > DRAG_THRESHOLD_SQUARED;
  }

  function onPointerUp(ev) {
    pointerStarts.delete(ev.pointerId);
  }

  function onPointerCancel(ev) {
    pointerStarts.delete(ev.pointerId);
    if (pointerStarts.size === 0) dragged = false;
  }

  function onClick(ev) {
    const wasDragged = dragged;
    pointerStarts.clear();
    dragged = false;
    if (!active || wasDragged) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const selection = resolveSelection(part, getContext(), hit);
    viewer.flashPoint([hit.pointWorld.x, hit.pointWorld.y, hit.pointWorld.z]);
    onPick(selection);
  }

  viewer.domElement.addEventListener("pointerdown", onPointerDown);
  viewer.domElement.addEventListener("pointermove", onPointerMove);
  viewer.domElement.addEventListener("pointerup", onPointerUp);
  viewer.domElement.addEventListener("pointercancel", onPointerCancel);
  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => {
      viewer.domElement.removeEventListener("pointerdown", onPointerDown);
      viewer.domElement.removeEventListener("pointermove", onPointerMove);
      viewer.domElement.removeEventListener("pointerup", onPointerUp);
      viewer.domElement.removeEventListener("pointercancel", onPointerCancel);
      viewer.domElement.removeEventListener("click", onClick);
    },
  };
}
