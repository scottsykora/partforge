import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

// Matches POINT_EPSILON in cutaway-math.js: a vertex this close to the plane
// counts as lying on it, so a grazing plane produces neither duplicate nor
// zero-length segments.
const ON_PLANE_EPSILON = 1e-6;

const _vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _distances = [0, 0, 0];
const _signs = [0, 0, 0];
const _crossing = new THREE.Vector3();

// Plane/triangle intersection over a BufferGeometry, in the geometry's own
// frame. Emits one segment per crossing triangle. Handles indexed (OCCT) and
// non-indexed (Manifold) geometry alike.
//
// Degenerate contact is resolved so each boundary edge is emitted exactly once:
//   - a triangle lying in the plane emits nothing; its neighbours bound it;
//   - a triangle touching the plane at one vertex only emits nothing;
//   - a triangle with an edge in the plane emits that edge only when its third
//     vertex is on the clipped side, so the two triangles sharing that edge do
//     not both emit it.
//
// Known limitation: that last rule reads only its own triangle, so it cannot
// tell "the neighbour is on the other side" (a real crossing, one emission)
// from "the neighbour is also clipped" (a ridge merely tangent to the plane,
// two emissions of the same edge). Telling them apart needs per-slice edge
// bookkeeping on a path that runs every frame of a gizmo drag, and the payoff
// is small: the duplicates are coincident, so they are invisible on opaque
// parts and only slightly darken a translucent one, in the measure-zero case
// where a plane lands exactly on a crease.
export function sectionSegments(geometry, plane) {
  const position = geometry?.getAttribute?.("position");
  if (!position) return new Float32Array(0);

  const index = geometry.getIndex?.() ?? null;
  const count = index ? index.count : position.count;
  const out = [];

  for (let i = 0; i + 2 < count; i += 3) {
    for (let k = 0; k < 3; k++) {
      _vertices[k].fromBufferAttribute(position, index ? index.getX(i + k) : i + k);
      const distance = plane.distanceToPoint(_vertices[k]);
      _distances[k] = distance;
      _signs[k] = distance > ON_PLANE_EPSILON
        ? 1
        : distance < -ON_PLANE_EPSILON ? -1 : 0;
    }

    const onPlane = (_signs[0] === 0 ? 1 : 0)
      + (_signs[1] === 0 ? 1 : 0)
      + (_signs[2] === 0 ? 1 : 0);

    if (onPlane === 3) continue;

    if (onPlane === 2) {
      const solo = _signs[0] !== 0 ? 0 : _signs[1] !== 0 ? 1 : 2;
      if (_signs[solo] !== -1) continue;
      pushPoint(out, _vertices[(solo + 1) % 3]);
      pushPoint(out, _vertices[(solo + 2) % 3]);
      continue;
    }

    if (onPlane === 1) {
      const zero = _signs[0] === 0 ? 0 : _signs[1] === 0 ? 1 : 2;
      const a = (zero + 1) % 3;
      const b = (zero + 2) % 3;
      if (_signs[a] === _signs[b]) continue;
      pushPoint(out, _vertices[zero]);
      pushPoint(out, crossingPoint(a, b));
      continue;
    }

    if (_signs[0] === _signs[1] && _signs[1] === _signs[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = k;
      const b = (k + 1) % 3;
      if (_signs[a] === _signs[b]) continue;
      pushPoint(out, crossingPoint(a, b));
    }
  }

  return new Float32Array(out);
}

function crossingPoint(a, b) {
  const t = _distances[a] / (_distances[a] - _distances[b]);
  return _crossing.copy(_vertices[a]).lerp(_vertices[b], t);
}

function pushPoint(out, point) {
  out.push(point.x, point.y, point.z);
}

const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : 0);

// One cut-face outline for one subpart. The object is parented to the mesh, the
// same trick the stencil helpers use, so it inherits every present and future
// transform including the pose fast path — and it always slices whatever
// `mesh.geometry` currently draws, so the outline cannot disagree with the
// surface it bounds.
//
// The section moves for four unrelated reasons (plane pose, geometry swap,
// frameTo recentring the assembly under a world-fixed plane, and setSubPose),
// and only the first two notify the cutaway. Rather than thread invalidation
// through all four, refresh() compares a signature and re-slices when it
// differs — roughly 21 float compares per frame.
export function createSectionOutline({ mesh, plane, inkColor, now = defaultNow }) {
  const material = new LineMaterial({
    color: inkColor,
    linewidth: 1,
    // The outline lies exactly in the cap plane; pull it toward the viewer so
    // the coincident-depth line wins against the cap it sits in.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.resolution.set(1, 1);
  // Deliberately no clippingPlanes: the outline sits at distance ~0 from its
  // own plane, and clipping it would speckle.

  const object = new LineSegments2(new LineSegmentsGeometry(), material);
  object.frustumCulled = false;
  object.visible = false;
  mesh.add(object);

  const localPlane = new THREE.Plane();
  const inverse = new THREE.Matrix4();
  const lastNormal = new THREE.Vector3(NaN, NaN, NaN);
  const lastMatrix = new THREE.Matrix4();
  let lastConstant = NaN;
  let lastGeometry = null;
  let lastCost = 0;
  let hasSegments = false;
  let visible = false;
  let suppressed = false;
  let disposed = false;
  // A show transition (setVisible(true) / setSuppressed(false)) must not put
  // the last slice on screen if the plane or mesh moved while hidden - that
  // slice belongs to a pose nobody asked to see. Cleared once slice() has
  // caught up; markShown() below leaves it alone when nothing moved, so an
  // ordinary show doesn't wait on a needless re-slice.
  let needsSlice = true;

  function applyVisibility() {
    object.visible = visible && hasSegments && !suppressed && !disposed && !needsSlice;
  }

  // Same signature the plane/mesh state is judged by in refresh(), reused so
  // a show transition can tell "still matches the last slice" from "moved
  // while hidden" without duplicating that comparison.
  function signatureMatches(geometry, matrixWorld) {
    return geometry === lastGeometry
      && plane.constant === lastConstant
      && plane.normal.equals(lastNormal)
      && matrixWorld.equals(lastMatrix);
  }

  function markShown() {
    mesh.updateWorldMatrix(true, false);
    if (!signatureMatches(mesh.geometry, mesh.matrixWorld)) needsSlice = true;
  }

  function slice(geometry, matrixWorld) {
    const start = now();
    localPlane.copy(plane).applyMatrix4(inverse.copy(matrixWorld).invert());
    const segments = geometry
      ? sectionSegments(geometry, localPlane)
      : new Float32Array(0);
    hasSegments = segments.length > 0;
    const previous = object.geometry;
    const next = new LineSegmentsGeometry();
    if (hasSegments) next.setPositions(segments);
    object.geometry = next;
    previous?.dispose();
    lastCost = now() - start;
    needsSlice = false;
    applyVisibility();
  }

  function refresh() {
    if (disposed || !visible || suppressed) return false;
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    if (signatureMatches(geometry, mesh.matrixWorld)) return false;
    lastGeometry = geometry;
    lastConstant = plane.constant;
    lastNormal.copy(plane.normal);
    lastMatrix.copy(mesh.matrixWorld);
    slice(geometry, mesh.matrixWorld);
    return true;
  }

  return {
    object,
    refresh,
    sliceCost: () => lastCost,
    setVisible(on) {
      if (disposed) return;
      visible = Boolean(on);
      if (visible) markShown();
      applyVisibility();
    },
    setSuppressed(on) {
      if (disposed) return;
      suppressed = Boolean(on);
      if (!suppressed) markShown();
      applyVisibility();
    },
    setInk(color) {
      if (!disposed) material.color.set(color);
    },
    setTransparent(on) {
      if (disposed || material.transparent === Boolean(on)) return;
      material.transparent = Boolean(on);
      material.needsUpdate = true;
    },
    setViewportSize(width, height) {
      if (!disposed) material.resolution.set(width, height);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.visible = false;
      mesh.remove(object);
      object.geometry?.dispose();
      material.dispose();
    },
  };
}
