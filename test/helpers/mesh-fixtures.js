// Hand-built triangle soups for the describe pipeline's kernel-free unit tests.
// Every fixture returns the Manifold convention (`positions` only, 9 floats per
// triangle, no `indices`) because that is what the describe path actually sees —
// mesh imports are Manifold-only. Winding is CCW seen from outside, so face
// normals point outward and dihedral signs come out convex-positive.
const tri = (out, a, b, c) => { out.push(...a, ...b, ...c); };

// Axis-aligned box at the origin, [0,0,0]..[sx,sy,sz]. 12 triangles, and every
// one of its 12 edges is a +90° convex edge — the simplest possible topology
// assertion.
export function boxMesh(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const quads = [[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  const positions = [];
  for (const [a,b,c,d] of quads) { tri(positions, v[a], v[b], v[c]); tri(positions, v[a], v[c], v[d]); }
  return { positions };
}

// Z-axis cylinder from z=0 to z=h, radius r, `segs` facets. Two planar caps and
// one cylindrical wall: the minimum fixture that makes segmentation prove it can
// tell a curved surface from a flat one.
export function cylinderMesh(r, h, segs = 32) {
  const positions = [];
  const p = (i, z) => [r * Math.cos(2 * Math.PI * i / segs), r * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const a = p(i, 0), b = p(i + 1, 0), c = p(i + 1, h), d = p(i, h);
    tri(positions, a, b, c); tri(positions, a, c, d);        // wall
    tri(positions, [0,0,0], b, a);                            // bottom cap (normal -Z)
    tri(positions, [0,0,h], d, c);                            // top cap (normal +Z)
  }
  return { positions };
}

// A washer: outer radius rOut, concentric bore rIn, thickness h. This is THE
// through-hole fixture. The outer wall's edges to the caps are convex; the bore's
// are concave, which is the single distinction every hole rule is built on.
export function annulusPlate(rOut, rIn, h, segs = 32) {
  const positions = [];
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const o0 = p(rOut, i, 0), o1 = p(rOut, i + 1, 0), o2 = p(rOut, i + 1, h), o3 = p(rOut, i, h);
    const n0 = p(rIn, i, 0), n1 = p(rIn, i + 1, 0), n2 = p(rIn, i + 1, h), n3 = p(rIn, i, h);
    tri(positions, o0, o1, o2); tri(positions, o0, o2, o3);   // outer wall, normal outward
    tri(positions, n1, n0, n3); tri(positions, n1, n3, n2);   // bore wall, normal inward-facing
    tri(positions, o1, o0, n0); tri(positions, o1, n0, n1);   // bottom annulus, normal -Z
    tri(positions, o3, o2, n2); tri(positions, o3, n2, n3);   // top annulus, normal +Z
  }
  return { positions };
}

// Applies an arbitrary rotation (Euler angles in radians, X then Y then Z) to
// a mesh's flat `positions` array. Exists because EVERY fixture above is
// axis-aligned and origin-centred, which is not incidental to a real bug this
// module's own tests once missed entirely: a coplanar quad diagonal's
// dihedral computes to bit-exact `0.0` only when the mesh happens to be
// axis-aligned (a lucky cancellation in the underlying cross/dot/atan2
// chain); rotate the identical, still-perfectly-flat geometry and the same
// diagonal comes out as noise like `-9.4e-17` — a real zero with the wrong
// bit pattern. Code in `segment.js` that tested `dihedral === 0` passed every
// axis-aligned fixture in this file while being completely broken for any
// rotated (i.e. almost every REAL) part. `rotateMesh` lets the segmentation
// suite prove recovery does not depend on axis alignment, by running the same
// fixtures through an arbitrary, deliberately unremarkable rotation.
export function rotateMesh({ positions }, [rx, ry, rz]) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i+1], z = positions[i+2];
    const y1 = y*cx - z*sx, z1 = y*sx + z*cx;           // rotate about X
    const x2 = x*cy + z1*sy, z2 = -x*sy + z1*cy;         // rotate about Y
    const x3 = x2*cz - y1*sz, y3 = x2*sz + y1*cz;        // rotate about Z
    out[i] = x3; out[i+1] = y3; out[i+2] = z2;
  }
  return { positions: out };
}

