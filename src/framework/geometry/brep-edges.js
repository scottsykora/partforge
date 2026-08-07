// Filter replicad meshEdges() down to genuinely sharp feature edges using the
// analytic per-vertex normals from mesh(). A B-rep edge whose adjacent faces
// meet tangentially (fillet blend boundaries, closed-surface seam lines) is
// not a visual feature — drop it, so a sphere or fillet never draws phantom
// lines. Plain arrays in, plain arrays out; no OCCT required (unit-testable).
//
// Format facts this relies on (replicad):
// - mesh() vertices are concatenated per face: boundary points are duplicated,
//   one copy per adjacent face, each carrying that face's analytic normal, and
//   edge polyline nodes reuse the exact face-triangulation coordinates — so an
//   exact-position key connects an edge point to every adjacent face normal.
// - mesh() also returns `triangles` (flat vertex-index list) and `faceGroups`
//   ({start,count,faceId} spans into `triangles`, in index units) — every
//   vertex index belongs to exactly one face, so this gives a vertex→faceId map.
// - meshEdges().lines is already flat segment PAIRS ((p0,p1),(p1,p2),…);
//   edgeGroups {start,count} span one B-rep edge, in points (count = 2·segs).
import { TANGENT_ANGLE, MIN_EDGE, cosDeg } from "./shading-policy.js";

const TANGENT_COS = cosDeg(TANGENT_ANGLE);
const MIN_EDGE2 = MIN_EDGE * MIN_EDGE;

export function filterBrepEdges(mesh, meshEdges) {
  const { vertices, normals, triangles = [], faceGroups = [] } = mesh;
  const { lines, edgeGroups } = meshEdges;

  // vertex index → owning face's id (-1 if unknown/not supplied).
  const vface = new Int32Array(vertices.length / 3).fill(-1);
  for (const fg of faceGroups)
    for (let i = fg.start; i < fg.start + fg.count; i++) vface[triangles[i]] = fg.faceId;

  // exact-position key → [nx, ny, nz, faceId] for every face copy of that vertex
  const byPos = new Map();
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const key = `${vertices[i]},${vertices[i + 1]},${vertices[i + 2]}`;
    let arr = byPos.get(key);
    if (!arr) byPos.set(key, arr = []);
    arr.push([normals[i], normals[i + 1], normals[i + 2], vface[i / 3]]);
  }

  // Any pair of entries in `ns` whose normals disagree past TANGENT_COS makes the sample sharp.
  const disagrees = (ns) => {
    for (let a = 0; a < ns.length; a++)
      for (let b = a + 1; b < ns.length; b++) {
        const dot = ns[a][0] * ns[b][0] + ns[a][1] * ns[b][1] + ns[a][2] * ns[b][2];
        if (dot < TANGENT_COS) return true;
      }
    return false;
  };
  const normalsAt = (g, p) => {
    const o = (g.start + p) * 3;
    return byPos.get(`${lines[o]},${lines[o + 1]},${lines[o + 2]}`);
  };

  const out = [];
  for (const g of edgeGroups) {
    if (g.count < 2) continue;
    // Sharp iff a sample sees two adjacent-face normals disagreeing past
    // TANGENT_COS. A point with fewer than two known normals is inconclusive;
    // an edge with no conclusive point is KEPT: a spurious line is visible and
    // debuggable, a missing feature edge is not.
    let sharp = false, conclusive = false;
    if (g.count > 2) {
      // Interior points are free of corner contamination — group ENDPOINTS are
      // corners that also touch a third face, so skip them here.
      for (let p = 1; p <= g.count - 2 && !sharp; p++) {
        const ns = normalsAt(g, p);
        if (!ns || ns.length < 2) continue;
        conclusive = true;
        if (disagrees(ns)) sharp = true;
      }
    } else {
      // No interior points exist — BOTH samples are corners, each possibly
      // touching its OWN unrelated third face (e.g. a fillet seam's top rim
      // touches the top cap, its bottom rim touches the bottom cap). Matching
      // normals BY DIRECTION across the two corners (near-parallel) is unsound:
      // a non-developable adjacent face's normal can legitimately swing along
      // the edge, so it fails to "match itself" between corners, while an
      // unrelated coplanar fragment touching only one corner can spuriously
      // match — silently reading a genuinely sharp edge as tangent (fail-
      // invisible, which this module must never do). Key persistence on FACE
      // IDENTITY instead: the edge's two true adjacent faces are whichever
      // faceIds are actually present at BOTH corners, independent of how much
      // their normal varies between the two samples.
      //
      // A closed surface's seam ruling (cylinder/cone/bore) has the SAME
      // faceId on both sides of the seam, so a corner can carry two copies of
      // one persisting id rather than two distinct ids. Count persistence as a
      // MULTISET intersection (tally occurrences per corner, sum the min per
      // shared id) so that case still reaches persisting >= 2, instead of a
      // Set intersection whose size tops out at 1 for a single repeated id.
      // This assumes every adjacent face contributes a vertex copy at each
      // corner it touches (replicad guarantees this); if that ever didn't
      // hold, a corner could show persistence only against itself and this
      // could drop a genuinely sharp edge.
      const n0 = normalsAt(g, 0), n1 = normalsAt(g, 1);
      if (n0 && n1) {
        const count0 = new Map();
        for (const e of n0) if (e[3] !== -1) count0.set(e[3], (count0.get(e[3]) || 0) + 1);
        const count1 = new Map();
        for (const e of n1) if (e[3] !== -1) count1.set(e[3], (count1.get(e[3]) || 0) + 1);
        const sharedIds = new Set();
        let persisting = 0;
        for (const [id, c0] of count0) {
          const c1 = count1.get(id);
          if (c1) { persisting += Math.min(c0, c1); sharedIds.add(id); }
        }
        if (persisting >= 2) {
          conclusive = true;
          const atSharedFaces = (ns) => ns.filter((e) => sharedIds.has(e[3]));
          sharp = disagrees(atSharedFaces(n0)) || disagrees(atSharedFaces(n1));
        } // else: fewer than 2 confirmed persisting face copies — inconclusive, KEPT
      } // else: one or both corners have no evidence at all — inconclusive, KEPT (fail-open)
    }
    if (conclusive && !sharp) continue; // tangent edge — not a visual feature

    for (let p = 0; p + 1 < g.count; p += 2) { // lines is segment pairs — step 2 points
      const a = (g.start + p) * 3, b = (g.start + p + 1) * 3;
      const dx = lines[a] - lines[b], dy = lines[a + 1] - lines[b + 1], dz = lines[a + 2] - lines[b + 2];
      if (dx * dx + dy * dy + dz * dz < MIN_EDGE2) continue; // degenerate sliver / pole edge
      out.push(lines[a], lines[a + 1], lines[a + 2], lines[b], lines[b + 1], lines[b + 2]);
    }
  }
  return Float32Array.from(out);
}
