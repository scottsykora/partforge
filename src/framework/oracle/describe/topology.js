// Mesh → welded topology: the shared substrate every describe stage reads. Two
// jobs nothing downstream should have to repeat. (1) NORMALIZE: Manifold hands us
// a non-indexed soup and OCCT an indexed mesh, and no detector should branch on
// which. (2) SIGN THE DIHEDRALS: the signed angle across each shared edge is what
// separates a boss from a pocket and a fillet from a chamfer, and it is the one
// quantity the whole feature vocabulary rests on. Getting its sign convention
// wrong inverts every feature rule at once, so it is asserted directly in tests
// rather than only through the rules that consume it.
//
// Pure leaf: no kernel, no BVH, no DOM. See docs/superpowers/specs/
// 2026-08-21-semantic-mesh-oracle-design.md §2.1.
import { meshTriangles } from "../bvh.js";
import { intrinsicScale } from "./fit.js";

// Coplanarity band for calling an edge "flat" rather than convex/concave. A
// tessellated cylinder's wall edges are genuinely convex at a small angle and must
// NOT be swallowed by this, so the band is much tighter than any facet step a
// reasonable chord tolerance produces: 1e-4 rad is ~0.006°.
export const FLAT_EPS = 1e-4;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// Weld tolerance defaults to a fraction of the bbox diagonal rather than an
// absolute number: a 2mm part and a 2m part both need welding, and an absolute
// epsilon is wrong for one of them. Callers with a known chord tolerance override.
// intrinsicScale() (fit.js), not a plain world-axis min/max, for the same reason
// segment.js's fit tolerance switched: a naive AABB diagonal is not the same number
// under rotation, so this weld epsilon would silently drift with orientation too —
// the effect is negligible at this fraction's scale (nanometres either way), but the
// convention should not have a second, differently-computed copy for the next reader
// to (wrongly) treat as a template.
function weldTolerance(triples) {
  return intrinsicScale(triples.flat(2)) * 1e-7;
}

export function buildTopology(mesh, opts = {}) {
  const triples = meshTriangles(mesh);
  const tol = opts.weld ?? weldTolerance(triples);
  // Quantized grid hash. Snapping to a grid of `tol` merges coordinates that agree
  // to that scale; probing the 26 neighbouring cells too would be more correct at
  // cell boundaries, but a CAD tessellation emits bit-identical shared vertices, so
  // the exact-cell hit is the normal case and the neighbour probe is not worth its
  // cost here. Real scans get the same treatment via a caller-supplied `weld`.
  const key = (v) => `${Math.round(v[0] / tol)},${Math.round(v[1] / tol)},${Math.round(v[2] / tol)}`;
  const index = new Map();
  const verts = [];
  const vid = (v) => {
    const k = key(v);
    let i = index.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(v[0], v[1], v[2]); index.set(k, i); }
    return i;
  };

  const tris = new Uint32Array(triples.length * 3);
  const faceNormal = new Float64Array(triples.length * 3);
  const faceArea = new Float64Array(triples.length);
  for (let t = 0; t < triples.length; t++) {
    const [a, b, c] = triples[t];
    tris[3*t] = vid(a); tris[3*t+1] = vid(b); tris[3*t+2] = vid(c);
    const n = cross(sub(b, a), sub(c, a));
    const len = norm(n);
    faceArea[t] = len / 2;
    // A degenerate triangle has no normal. Store zeros rather than NaN: downstream
    // code filters on zero area, and NaN would silently poison every dot product.
    for (let k = 0; k < 3; k++) faceNormal[3*t+k] = len > 0 ? n[k] / len : 0;
  }

  // Edge table keyed by the UNORDERED vertex pair, but each half-edge remembers the
  // ORDER it was traversed in. That order is the winding, and the winding is what
  // gives the dihedral its sign.
  const half = new Map();
  const edges = [];
  const faceEdges = Array.from({ length: triples.length }, () => []);
  for (let t = 0; t < triples.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v0 = tris[3*t + k], v1 = tris[3*t + (k + 1) % 3];
      const ek = v0 < v1 ? `${v0}:${v1}` : `${v1}:${v0}`;
      const prev = half.get(ek);
      if (prev === undefined) {
        half.set(ek, { v0, v1, triA: t, triB: -1, index: edges.length });
        edges.push(half.get(ek));
      } else {
        prev.triB = t;
      }
      faceEdges[t].push(half.get(ek).index);
    }
  }

  for (const e of edges) {
    if (e.triB < 0) { e.dihedral = 0; e.convexity = "boundary"; continue; }
    const nA = [faceNormal[3*e.triA], faceNormal[3*e.triA+1], faceNormal[3*e.triA+2]];
    const nB = [faceNormal[3*e.triB], faceNormal[3*e.triB+1], faceNormal[3*e.triB+2]];
    const p0 = [verts[3*e.v0], verts[3*e.v0+1], verts[3*e.v0+2]];
    const p1 = [verts[3*e.v1], verts[3*e.v1+1], verts[3*e.v1+2]];
    const dir = sub(p1, p0);
    const len = norm(dir);
    if (len === 0) { e.dihedral = 0; e.convexity = "flat"; continue; }
    const u = [dir[0]/len, dir[1]/len, dir[2]/len];
    // Signed angle between the two outward normals about the shared edge. With CCW
    // winding and outward normals, a positive angle means the surface turns away
    // from the material — convex. Negative means it folds into it — concave.
    const s = dot(cross(nA, nB), u);
    const c = dot(nA, nB);
    e.dihedral = Math.atan2(s, c);
    e.convexity = Math.abs(e.dihedral) < FLAT_EPS ? "flat" : e.dihedral > 0 ? "convex" : "concave";
  }

  return { verts: Float64Array.from(verts), tris, faceNormal, faceArea, edges, faceEdges };
}
