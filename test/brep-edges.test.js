import { expect, test } from "vitest";
import { filterBrepEdges } from "../src/framework/geometry/brep-edges.js";

// Minimal replicad-shaped fixtures. `faces` is a list of { id, verts, normals }
// — one entry per adjacent face, its OWN vertex copies and their normals (as
// replicad emits: vertices duplicated once per adjacent face). Builds
// `triangles` as an identity map (vertex index → itself) and `faceGroups`
// spanning each face's own index range — the filter only needs faceGroups'
// {start,count,faceId} to look up which face owns which vertex index, so no
// real triangulation is required for these unit fixtures.
function mesh(faces) {
  const vertices = [], normals = [], triangles = [], faceGroups = [];
  for (const f of faces) {
    const start = triangles.length;
    for (let i = 0; i < f.verts.length; i++) {
      vertices.push(...f.verts[i]);
      normals.push(...f.normals[i]);
      triangles.push(start + i);
    }
    faceGroups.push({ start, count: f.verts.length, faceId: f.id });
  }
  return { vertices, normals, triangles, faceGroups };
}
const seg = (a, b) => [...a, ...b];

const A = [0, 0, 0], B = [10, 0, 0]; // the shared edge under test

test("edge between faces at 90° is kept as one segment", () => {
  const m = mesh([
    { id: 1, verts: [A, B], normals: [[0, 0, 1], [0, 0, 1]] },
    { id: 2, verts: [A, B], normals: [[0, -1, 0], [0, -1, 0]] },
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(Array.from(filterBrepEdges(m, e))).toEqual([...A, ...B]);
});

test("edge between coplanar/tangent faces is dropped", () => {
  const m = mesh([
    { id: 1, verts: [A, B], normals: [[0, 0, 1], [0, 0, 1]] },
    { id: 2, verts: [A, B], normals: [[0, 0, 1], [0, 0, 1]] },
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("multi-segment edge: sharp corner endpoints do not overrule tangent interior points", () => {
  const P1 = [3, 0, 0], P2 = [6, 0, 0];
  // interior junctions P1,P2 see only agreeing +Z normals (tangent); endpoints A,B
  // also touch a perpendicular face — which must be ignored for count>2 groups
  const m = mesh([
    { id: 1, verts: [A, P1, P2, B], normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]] },
    { id: 2, verts: [A, P1, P2, B], normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]] },
    { id: 3, verts: [A, B], normals: [[1, 0, 0], [1, 0, 0]] },
  ]);
  const e = { lines: [...seg(A, P1), ...seg(P1, P2), ...seg(P2, B)], edgeGroups: [{ start: 0, count: 6, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("edge with no normal evidence at either corner is kept (fail visible, not invisible)", () => {
  const m = mesh([]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(6);
});

test("edge with evidence at only ONE corner is kept (fail-open: no persisting pair can be confirmed)", () => {
  // B has zero face copies at all — commonIds can't be computed, so this stays
  // inconclusive regardless of how unambiguous A's own two faces look.
  const m = mesh([
    { id: 1, verts: [A], normals: [[0, 0, 1]] },
    { id: 2, verts: [A], normals: [[0, -1, 0]] },
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(6);
});

test("2-point tangent seam is dropped even though each corner also touches a different third face", () => {
  // Reproduces the OCCT fillet-seam bug: a straight tangent seam (constant
  // normal, e.g. a cylinder's ruling line meeting a flat wall) has no interior
  // tessellation point, so both samples are corners — and here each corner
  // additionally touches its OWN unrelated face (bottom cap vs top cap). Face
  // identity confirms the true pair (ids 1 and 2) persists at both corners
  // despite the one-off third face at each end.
  const n = [-1, 0, 0]; // the seam's two true adjacent faces share this normal
  const m = mesh([
    { id: 1, verts: [A, B], normals: [n, n] },        // wall
    { id: 2, verts: [A, B], normals: [n, n] },         // fillet cylinder, tangent to the wall along this seam
    { id: 3, verts: [A], normals: [[0, 0, -1]] },       // bottom cap — touches only corner A
    { id: 4, verts: [B], normals: [[0, 0, 1]] },        // top cap — touches only corner B
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("2-point sharp edge is kept even when a non-developable face's normal swings between corners and a coplanar fragment could spoof a direction match", () => {
  // The failure mode direction-based matching had: face id 2's normal swings
  // 30° along the edge (a legitimately curved/non-developable adjacent face),
  // so it would NOT "match itself" between corners by near-parallelism — while
  // an unrelated coplanar fragment (id 3 at A, id 4 at B, both normal [0,0,1],
  // same as face 1) WOULD spuriously match across corners. A direction-based
  // filter concludes the edge is tangent (matching pair = {face1, fragment},
  // which agree) and silently drops a genuinely sharp edge. Face IDENTITY
  // instead correctly finds {face 1, face 2} as the persisting pair (present
  // at both corners regardless of face 2's normal drifting) and detects their
  // ~90° disagreement — kept.
  const swung = [Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)]; // 30° off [1,0,0]
  const m = mesh([
    { id: 1, verts: [A, B], normals: [[0, 0, 1], [0, 0, 1]] },  // the flat cap — one true adjacent face
    { id: 2, verts: [A, B], normals: [[1, 0, 0], swung] },       // non-developable adjacent face — normal swings along the edge
    { id: 3, verts: [A], normals: [[0, 0, 1]] },                 // unrelated coplanar fragment touching ONLY corner A
    { id: 4, verts: [B], normals: [[0, 0, 1]] },                 // unrelated coplanar fragment touching ONLY corner B
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(6);
});

test("self-adjacent seam is dropped: same faceId twice at both corners with agreeing normals", () => {
  // Reproduces the phantom cylinder-seam line: a closed surface's ruling seam
  // has the SAME face on both sides, so each corner carries TWO copies of one
  // faceId (plus a cap face unique to that corner) rather than two distinct
  // ids. A Set-based intersection of faceIds tops out at size 1 here (only id
  // 5 is shared) and never reaches the "conclusive" threshold, leaving the
  // seam KEPT forever. The multiset count must see two persisting copies of
  // id 5 (min(2,2) = 2) and correctly drop this tangent seam.
  const n = [1, 0, 0];
  const m = mesh([
    { id: 5, verts: [A, B], normals: [n, n] },          // cylinder face, seam side 1
    { id: 5, verts: [A, B], normals: [n, n] },          // cylinder face, seam side 2 (same faceId)
    { id: 3, verts: [A], normals: [[0, 0, -1]] },        // bottom cap — touches only corner A
    { id: 4, verts: [B], normals: [[0, 0, 1]] },         // top cap — touches only corner B
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("2-point edge with evidence at both corners but no persisting faceId pair is kept (inconclusive)", () => {
  // Each corner has two distinct faceIds, but all four ids across both
  // corners are different — nothing persists between the corners at all, so
  // persisting stays 0 and the edge must be treated as inconclusive (kept).
  const m = mesh([
    { id: 1, verts: [A], normals: [[0, 0, 1]] },
    { id: 2, verts: [A], normals: [[0, -1, 0]] },
    { id: 3, verts: [B], normals: [[1, 0, 0]] },
    { id: 4, verts: [B], normals: [[0, 1, 0]] },
  ]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(6);
});

test("sub-MIN_EDGE segments are dropped even on kept edges (degenerate pole edges)", () => {
  const C = [0.005, 0, 0]; // 0.005mm from A — below the 0.01mm floor
  const m = mesh([
    { id: 1, verts: [A, C], normals: [[0, 0, 1], [0, 0, 1]] },
    { id: 2, verts: [A, C], normals: [[0, -1, 0], [0, -1, 0]] },
  ]);
  const e = { lines: seg(A, C), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});
