import * as THREE from "three";

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
