// Viewer adapter for click-to-select: arms a click listener, raycasts via the shared
// selection raycast, and hands a resolved Selection to onPick.
import { raycastViewer, worldToSubPartLocal } from "./raycast.js";
import { resolveSelection } from "./resolve.js";
import { createDragTracker } from "./drag-tracker.js";

export { worldToSubPartLocal };

export function attachPicker(viewer, { part, getContext, onPick }) {
  let active = false;
  const drag = createDragTracker();

  function onClick(ev) {
    const wasDragged = drag.consumeClick();
    if (!active || wasDragged) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const selection = resolveSelection(part, getContext(), hit);
    viewer.flashPoint([hit.pointWorld.x, hit.pointWorld.y, hit.pointWorld.z]);
    onPick(selection);
  }

  viewer.domElement.addEventListener("pointerdown", drag.onDown);
  viewer.domElement.addEventListener("pointermove", drag.onMove);
  viewer.domElement.addEventListener("pointerup", drag.onUp);
  viewer.domElement.addEventListener("pointercancel", drag.onCancel);
  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => {
      viewer.domElement.removeEventListener("pointerdown", drag.onDown);
      viewer.domElement.removeEventListener("pointermove", drag.onMove);
      viewer.domElement.removeEventListener("pointerup", drag.onUp);
      viewer.domElement.removeEventListener("pointercancel", drag.onCancel);
      viewer.domElement.removeEventListener("click", onClick);
    },
  };
}
