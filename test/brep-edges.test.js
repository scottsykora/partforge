import { expect, test } from "vitest";
import { filterBrepEdges } from "../src/framework/geometry/brep-edges.js";

// Minimal replicad-shaped fixtures: `mesh` supplies position→normal evidence
// (vertices duplicated per face, as replicad emits them); `meshEdges` supplies
// the candidate segments. Triangles/faceGroups are irrelevant to the filter.
const mesh = (verts, norms) => ({ vertices: verts.flat(), normals: norms.flat(), triangles: [], faceGroups: [] });
const seg = (a, b) => [...a, ...b];

const A = [0, 0, 0], B = [10, 0, 0]; // the shared edge under test

test("edge between faces at 90° is kept as one segment", () => {
  const m = mesh([A, B, A, B], [[0, 0, 1], [0, 0, 1], [0, -1, 0], [0, -1, 0]]); // +Z face copy, −Y face copy
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(Array.from(filterBrepEdges(m, e))).toEqual([...A, ...B]);
});

test("edge between coplanar/tangent faces is dropped", () => {
  const m = mesh([A, B, A, B], [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("multi-segment edge: sharp corner endpoints do not overrule tangent interior points", () => {
  const P1 = [3, 0, 0], P2 = [6, 0, 0];
  // interior junctions P1,P2 see only agreeing +Z normals (tangent); endpoints A,B
  // also touch a perpendicular face — which must be ignored for count>2 groups
  const m = mesh(
    [A, P1, P2, B, A, P1, P2, B, A, B],
    [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [1, 0, 0], [1, 0, 0]],
  );
  const e = { lines: [...seg(A, P1), ...seg(P1, P2), ...seg(P2, B)], edgeGroups: [{ start: 0, count: 6, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("edge with no normal evidence is kept (fail visible, not invisible)", () => {
  const m = mesh([], []);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(6);
});

test("sub-MIN_EDGE segments are dropped even on kept edges (degenerate pole edges)", () => {
  const C = [0.005, 0, 0]; // 0.005mm from A — below the 0.01mm floor
  const m = mesh([A, C, A, C], [[0, 0, 1], [0, 0, 1], [0, -1, 0], [0, -1, 0]]);
  const e = { lines: seg(A, C), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});
