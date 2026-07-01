// Viewer adapter for click-to-select: arms a click listener, raycasts via the shared
// selection raycast, and hands a resolved Selection to onPick.
import { raycastViewer, worldToSubPartLocal } from "./raycast.js";
import { resolveSelection } from "./resolve.js";

export { worldToSubPartLocal };

export function attachPicker(viewer, { part, getContext, onPick }) {
  let active = false;

  function onClick(ev) {
    if (!active) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const selection = resolveSelection(part, getContext(), hit);
    viewer.flashPoint([hit.pointWorld.x, hit.pointWorld.y, hit.pointWorld.z]);
    onPick(selection);
  }

  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => viewer.domElement.removeEventListener("click", onClick),
  };
}
