// Shared raycast for the selection modules: pointer position → the sub-part mesh,
// triangle, CAD-local point/normal, and (when the mesh carries attribution) the
// feature under the pointer. Used by both the click-picker and the hover-labeler.
import * as THREE from "three";

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// Invert the mesh's world transform (pivot rotation + per-view recentring) to recover
// shared-frame CAD coords — the same frame build() models in.
export function worldToSubPartLocal(mesh, world) {
  const v = Array.isArray(world) ? new THREE.Vector3(world[0], world[1], world[2]) : world.clone();
  mesh.worldToLocal(v);
  return [v.x, v.y, v.z];
}

// The feature carried by a mesh triangle, or null (unlabeled / no attribution data).
export function featureAt(mesh, triIndex) {
  const { featureIds, features } = mesh.geometry.userData;
  const id = featureIds?.[triIndex] ?? 0;
  return id > 0 ? { id, label: features[id - 1] } : null;
}

export function raycastViewer(viewer, clientX, clientY) {
  const rect = viewer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, viewer.camera);
  const meshes = Object.values(viewer._subMeshes).filter((m) => m.visible);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  return {
    mesh: hit.object,
    subPart: hit.object.name,
    triIndex: hit.faceIndex,
    pointWorld: hit.point,
    pointLocal: worldToSubPartLocal(hit.object, hit.point),
    // face.normal is in the geometry's local frame, which equals the CAD frame here
    // (the mesh carries no local transform; only its parents rotate/recentre).
    normalLocal: hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 0, 0],
    feature: featureAt(hit.object, hit.faceIndex),
  };
}
