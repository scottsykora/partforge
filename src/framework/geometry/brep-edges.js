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
// - meshEdges().lines is already flat segment PAIRS ((p0,p1),(p1,p2),…);
//   edgeGroups {start,count} span one B-rep edge, in points (count = 2·segs).
import { TANGENT_ANGLE, MIN_EDGE, cosDeg } from "./shading-policy.js";

const TANGENT_COS = cosDeg(TANGENT_ANGLE);
const MIN_EDGE2 = MIN_EDGE * MIN_EDGE;

export function filterBrepEdges(mesh, meshEdges) {
  const { vertices, normals } = mesh;
  const { lines, edgeGroups } = meshEdges;

  // exact-position key → the normals of every face copy of that vertex
  const byPos = new Map();
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const key = `${vertices[i]},${vertices[i + 1]},${vertices[i + 2]}`;
    let arr = byPos.get(key);
    if (!arr) byPos.set(key, arr = []);
    arr.push([normals[i], normals[i + 1], normals[i + 2]]);
  }

  // Any pair of normals in `ns` disagreeing past TANGENT_COS makes the sample sharp.
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
  // Normals from `n0` that reappear (near-parallel) in `n1` — the faces that
  // persist across BOTH samples, as opposed to a one-off face touching only one.
  const common = (n0, n1) => n0.filter((a) => n1.some((b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > TANGENT_COS));

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
      // touches the top cap, its bottom rim touches the bottom cap). The
      // edge's true two adjacent faces run its full straight length, so their
      // normals persist at BOTH corners; a one-off corner face does not.
      // Comparing only the normals common to both ends filters that noise —
      // this is the fix for the phantom-sphere/fillet-seam bug: previously
      // any pairing (including the unrelated third face) could flag "sharp".
      const n0 = normalsAt(g, 0), n1 = normalsAt(g, 1);
      if (n0 && n1) {
        const both = common(n0, n1);
        if (both.length >= 2) { conclusive = true; sharp = disagrees(both); }
        else if (n0.length >= 2 || n1.length >= 2) { conclusive = true; sharp = true; } // no persistent pair found — ambiguous, kept
      } else {
        const ns = n0 || n1; // one side has no evidence — fall back to the other alone
        if (ns && ns.length >= 2) { conclusive = true; sharp = disagrees(ns); }
      }
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
