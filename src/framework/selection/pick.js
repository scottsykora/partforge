// Viewer adapter — the ONLY three.js/DOM-aware file in the selection module.
// Raycasts a click against the visible sub-meshes, converts the hit to the
// sub-part's local CAD frame, and hands a resolved Selection to onPick.
import * as THREE from "three";
import { resolveSelection } from "./resolve.js";

// Invert the mesh's world transform (pivot rotation + per-view recentring) to recover
// shared-frame CAD coords — the same frame build() models in.
export function worldToSubPartLocal(mesh, world) {
  const v = Array.isArray(world) ? new THREE.Vector3(world[0], world[1], world[2]) : world.clone();
  mesh.worldToLocal(v);
  return [v.x, v.y, v.z];
}

export function attachPicker(viewer, { part, getContext, onPick }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let active = false;

  function onClick(ev) {
    if (!active) return;
    const rect = viewer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, viewer.camera);

    const meshes = Object.values(viewer._subMeshes).filter((m) => m.visible);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return;

    const selection = resolveSelection(part, getContext(), {
      subPart: hit.object.name,
      pointLocal: worldToSubPartLocal(hit.object, hit.point),
      // face.normal is in the geometry's local frame, which equals the CAD frame here
      // (the mesh carries no local transform; only its parents rotate/recentre).
      normalLocal: hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 0, 0],
      // hit.face metadata (kind/axis/radius) is the L1 increment — not populated yet.
    });
    viewer.flashPoint([hit.point.x, hit.point.y, hit.point.z]);
    onPick(selection);
  }

  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => viewer.domElement.removeEventListener("click", onClick),
  };
}
