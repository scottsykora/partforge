import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectPrismatic } from "../src/framework/oracle/describe/features/prismatic.js";
import { detectDressups } from "../src/framework/oracle/describe/features/dressups.js";
import { boxWithPad, chamferedBox } from "./helpers/mesh-fixtures.js";

// Round 2 review's IMPORTANT finding: prismatic.js's and dressups.js's own `key`
// fields embedded a segmentation surface id (`s0`, `s1`, …), which surface-graph.js
// assigns in triangle-DISCOVERY order — so the SAME geometry, fed in with its
// triangles in a different order, renumbered its surfaces and produced a DIFFERENT
// key for the same physical feature (observed: a boss's key moved from `boss:15:s1`
// to `boss:15:s0`). describe.js's own f0..fN numbering sorts on exactly these keys,
// so an unstable key means unstable numbering for a mesh whose GEOMETRY never
// changed — contradicting both files' own "geometry-derived" comments and the global
// stability requirement (spec §, and describe.js's "f-numbering depends on the MESH,
// never on iteration order" comment). Fixed by building each key from the feature's
// own FITTED quantities (a cap's plane offset/normal/area; a dress-up's neighbours'
// own fitted geometry) instead of any surface id.

// Reorders WHOLE triangles (each kept intact — same 3 vertices, same winding) in a
// non-indexed soup mesh ({positions}, 9 floats per triangle — every fixture in
// mesh-fixtures.js is this shape), so buildTopology sees the IDENTICAL geometry
// with a different triangle-discovery order. Deterministic Fisher-Yates over a tiny
// LCG, not Math.random, so a failure is reproducible.
function permuteTriangles(mesh, seed) {
  const src = mesh.positions;
  const n = src.length / 9;
  const order = Array.from({ length: n }, (_, i) => i);
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out = new Array(src.length);
  order.forEach((srcT, dstT) => { for (let k = 0; k < 9; k++) out[dstT * 9 + k] = src[srcT * 9 + k]; });
  return { positions: out };
}

const graphOf = (mesh) => { const t = buildTopology(mesh); return surfaceGraph(t, segment(t).patches); };

// Replicates describe.js's own numbering rule (sort the concatenated feature list by
// its own `key`, then assign f0..fN by that order) so this test proves the thing the
// finding is actually about — stable NUMBERING — not just stable key strings.
const numbered = (feats) => [...feats].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  .map((f, i) => ({ id: `f${i}`, key: f.key }));

test("a boss's prismatic key (and its f-number) survives a triangle-order permutation", () => {
  const mesh = boxWithPad(60, 40, 10, 15, 10, 20, 15, 8);
  const permuted = permuteTriangles(mesh, 12345);

  const a = detectPrismatic(graphOf(mesh));
  const b = detectPrismatic(graphOf(permuted));

  expect(a.length).toBe(2); // the base extrusion plus the pad, both must survive
  expect(numbered(a)).toEqual(numbered(b));
});

test("a chamfer's key (and its f-number) survives a triangle-order permutation", () => {
  const mesh = chamferedBox(20, 20, 20, 4);
  const permuted = permuteTriangles(mesh, 54321);

  const a = detectDressups(graphOf(mesh));
  const b = detectDressups(graphOf(permuted));

  expect(a.length).toBe(1);
  expect(numbered(a)).toEqual(numbered(b));
});
