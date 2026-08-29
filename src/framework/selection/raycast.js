// Shared raycast for the selection modules: pointer position → the sub-part mesh,
// triangle, CAD-local point/normal, and (when the mesh carries attribution) the
// feature under the pointer. Used by both the click-picker and the hover-labeler.
import * as THREE from "three";

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// Invert the mesh's world transform (pivot rotation + per-view recentring) to recover
// shared-frame CAD coords — the same frame build() models in. `worldToLocal` also
// undoes the mesh's own local matrix, which carries the viewer's fast-path pose
// (setSubPose), so re-apply that matrix to land in the CURRENT shared frame rather
// than the frame the delivered mesh was baked in.
export function worldToSubPartLocal(mesh, world) {
  const v = Array.isArray(world) ? new THREE.Vector3(world[0], world[1], world[2]) : world.clone();
  mesh.worldToLocal(v);
  v.applyMatrix4(mesh.matrix);
  return [v.x, v.y, v.z];
}

const _normal = new THREE.Vector3();

// A geometry-frame direction in shared-frame CAD coords (see pointLocal above).
function normalInSubPartFrame(mesh, normal) {
  _normal.copy(normal).transformDirection(mesh.matrix);
  return [_normal.x, _normal.y, _normal.z];
}

const _inverseWorld = new THREE.Matrix4();

// The same trip for a WORLD direction: back through the mesh's world transform
// into the geometry frame, then forward by its local matrix like any other
// geometry-frame direction. The cut plane's normal is the only one that arrives
// this way — it belongs to the scene, not to a triangle.
function worldNormalInSubPartFrame(mesh, worldNormal) {
  _inverseWorld.copy(mesh.matrixWorld).invert();
  _normal.copy(worldNormal).transformDirection(_inverseWorld).transformDirection(mesh.matrix);
  return [_normal.x, _normal.y, _normal.z];
}

// The feature carried by a mesh triangle, or null (unlabeled / no attribution data).
export function featureAt(mesh, triIndex) {
  const { featureIds, features } = mesh.geometry.userData;
  const id = featureIds?.[triIndex] ?? 0;
  return id > 0 ? { id, label: features[id - 1] } : null;
}

const SECTION_EPSILON = 1e-6;
const _sectionPoint = new THREE.Vector3();
const _sectionNormal = new THREE.Vector3();
const _reverseDirection = new THREE.Vector3();
const _cutPlane = new THREE.Plane();

// The cut FACE under the pointer, when a cutaway is showing one.
//
// Nothing real is there to hit: a section view removes the near half by
// clipping, which the raycaster knows nothing about, so every triangle along
// that ray is either on the discarded side (rejected by isWorldPointVisible) or
// a back face three does not report at all. Clicking the largest surface in the
// view therefore selected nothing.
//
// What IS there is solid material, sliced open at the plane. So: find where the
// ray crosses into the retained half, and ask whether the sub-part is solid at
// that crossing. It is solid when the ray has entered it more often than it has
// left it — and the exits of a ray are the entries of the same ray reversed,
// which is how this stays inside three's front-face raycasting rather than
// flipping every material to DoubleSide behind the renderer's back.
function sectionHit(viewer, meshes, forwardHits, surfaceHit) {
  const plane = viewer.getCutawayPlane?.(_cutPlane);
  if (!plane) return null;
  const ray = raycaster.ray;
  // Only a ray crossing INTO the retained half can reveal a cut face; if the
  // camera is already on that side, nothing in front of it was removed.
  if (plane.normal.dot(ray.direction) <= SECTION_EPSILON) return null;
  const distance = ray.distanceToPlane(plane);
  if (distance == null || distance <= 0) return null;
  // A retained surface nearer than the crossing is simply in front of the cut.
  if (surfaceHit && surfaceHit.distance <= distance) return null;
  // Nothing entered before the plane can be solid at it, so the reverse
  // raycast below is pure cost on the common miss — a click on the backdrop.
  if (!forwardHits.some((hit) => hit.distance < distance)) return null;
  ray.at(distance, _sectionPoint);

  raycaster.set(_sectionPoint, _reverseDirection.copy(ray.direction).negate());
  const exitHits = raycaster.intersectObjects(meshes, false);

  let best = null;
  for (const mesh of meshes) {
    let net = 0;
    let entry = null;
    for (const hit of forwardHits) {
      if (hit.object !== mesh || hit.distance >= distance) continue;
      net += 1;
      entry ??= hit; // hits arrive sorted, so this is the nearest entry
    }
    for (const hit of exitHits) {
      if (hit.object === mesh && hit.distance < distance) net -= 1;
    }
    if (net > 0 && (best == null || entry.distance < best.entry.distance)) best = { mesh, entry };
  }
  if (!best) return null;

  const { mesh, entry } = best;
  return {
    mesh,
    subPart: mesh.name,
    // The triangle the ray entered through. It is not the one under the
    // pointer — a cut face has no triangles — but it is the material the cut
    // opened, and callers that index by triangle need something real.
    triIndex: entry.faceIndex,
    pointWorld: _sectionPoint.clone(),
    pointLocal: worldToSubPartLocal(mesh, _sectionPoint),
    // The cut face looks back at the discarded half, opposite the plane normal.
    normalLocal: worldNormalInSubPartFrame(mesh, _sectionNormal.copy(plane.normal).negate()),
    // Deliberately unattributed: a cut face is an artefact of the section, not
    // a surface the part's build ever labelled.
    feature: null,
    onCutPlane: true,
  };
}

// `includeSection` opts into the cut-face pick above. It is off by default so
// hover labels and measurement mode keep hitting real geometry only — a
// dimension pinned to a plane the user can move is not a dimension.
export function raycastViewer(viewer, clientX, clientY, { includeSection = false } = {}) {
  const rect = viewer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, viewer.camera);
  const meshes = Object.values(viewer._subMeshes).filter((m) => m.visible);
  const hits = raycaster.intersectObjects(meshes, false);
  const hit = hits.find((candidate) =>
    viewer.isWorldPointVisible?.(candidate.point) ?? true
  );
  // Ordered before the surface answer, not after: the crossing into the
  // retained half is nearer than anything retained, so when a cut face is
  // there it is what the pointer is over.
  if (includeSection) {
    const section = sectionHit(viewer, meshes, hits, hit);
    if (section) return section;
  }
  if (!hit) return null;
  return {
    mesh: hit.object,
    subPart: hit.object.name,
    triIndex: hit.faceIndex,
    pointWorld: hit.point,
    pointLocal: worldToSubPartLocal(hit.object, hit.point),
    // face.normal is in the geometry's own frame; the mesh's local matrix (identity,
    // or a rigid fast-path pose) carries it into the shared CAD frame. The pose is
    // rigid, so rotating the direction by that matrix is exact.
    normalLocal: hit.face ? normalInSubPartFrame(hit.object, hit.face.normal) : [0, 0, 0],
    feature: featureAt(hit.object, hit.faceIndex),
  };
}
