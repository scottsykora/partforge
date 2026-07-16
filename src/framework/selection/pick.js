// Viewer adapter for click-to-select: arms a click listener, raycasts via the shared
// selection raycast, and hands a resolved Selection to onPick.
import { raycastViewer, worldToSubPartLocal } from "./raycast.js";
import { resolveSelection } from "./resolve.js";

export { worldToSubPartLocal };

const DRAG_THRESHOLD_SQUARED = 4 ** 2;

export function attachPicker(viewer, { part, getContext, onPick }) {
  let active = false;
  let pointerStart = null;
  let dragged = false;

  function onPointerDown(ev) {
    pointerStart = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
    dragged = false;
  }

  function onPointerMove(ev) {
    if (!pointerStart || ev.pointerId !== pointerStart.id || dragged) return;
    const dx = ev.clientX - pointerStart.x;
    const dy = ev.clientY - pointerStart.y;
    dragged = dx * dx + dy * dy > DRAG_THRESHOLD_SQUARED;
  }

  function onClick(ev) {
    const wasDragged = dragged;
    pointerStart = null;
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
  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => {
      viewer.domElement.removeEventListener("pointerdown", onPointerDown);
      viewer.domElement.removeEventListener("pointermove", onPointerMove);
      viewer.domElement.removeEventListener("click", onClick);
    },
  };
}
