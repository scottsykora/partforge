import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment, facePoints } from "../src/framework/oracle/describe/segment.js";
import { fitPlane, fitCylinder, fitTorus } from "../src/framework/oracle/describe/fit.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectHoles } from "../src/framework/oracle/describe/features/holes.js";
import { detectDressups } from "../src/framework/oracle/describe/features/dressups.js";
import {
  annulusPlate, cylinderMesh, rotateMesh,
  chamferedBox, countersunkPlate, filletedCylinderTop, filletFaceRange, cupMesh,
} from "./helpers/mesh-fixtures.js";

// `rotateMesh(mesh, [rx, ry, rz])` takes radians packed in one array (see
// mesh-fixtures.js) — same arbitrary, unremarkable tilt describe-surface-graph.test.js,
// describe-segment.test.js and describe-ransac.test.js already use.
const TILT = [(17 * Math.PI) / 180, (29 * Math.PI) / 180, (53 * Math.PI) / 180];
const ORIENTATIONS = [["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]];

const graphOf = (mesh) => { const t = buildTopology(mesh); return surfaceGraph(t, segment(t).patches); };

// `filletedCylinderTop`'s own comment explains why: a torus fillet is NOT expected to
// segment cleanly via `segment()`'s region growing (the same structural limitation
// `torusMesh`'s comment documents — growth's witness-corroboration bootstrap doesn't
// handle double curvature), so this hand-builds each of the fixture's four patches
// directly with the same fit functions `segment()`'s own `bestFit` would have used,
// had growth converged — the exact pattern describe-surface-graph.test.js's own
// `torusPatch` helper already uses for the plain `torusMesh` fixture. Section-ordered
// construction (`filletFaceRange`) is what makes slicing the faces out this cleanly
// possible without re-deriving the mesh's own triangle layout here.
function filletGraph(R, H, r, segs, tubeSegs, orient) {
  const mesh = orient(filletedCylinderTop(R, H, r, segs, tubeSegs));
  const topo = buildTopology(mesh);
  const [fs, fe] = filletFaceRange(segs, tubeSegs);
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const mk = (id, faces, fitFn) => {
    const { pts, normals } = facePoints(topo, faces);
    return { id, faces, fit: fitFn(pts, normals), area: faces.reduce((a, t) => a + topo.faceArea[t], 0) };
  };
  const patches = [
    mk("bottom", range(0, segs), (pts) => fitPlane(pts)),
    mk("wall", range(segs, fs), (pts, n) => fitCylinder(pts, n)),
    mk("fillet", range(fs, fe), (pts, n) => fitTorus(pts, n)),
    mk("top", range(fe, fe + segs), (pts) => fitPlane(pts)),
  ];
  return surfaceGraph(topo, patches);
}

test("the washer bore is detected as one through hole", () => {
  const holes = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(holes.length).toBe(1);
  expect(holes[0].type).toBe("throughHole");
});

test("the through hole reports the fixture diameter and depth", () => {
  const [hole] = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(hole.diameter).toBeCloseTo(8, 1);
  expect(hole.depth).toBeCloseTo(3, 2);
});

test("the outer wall of a washer is NOT a hole", () => {
  // The outer wall's rims are convex circular arcs to both caps — IDENTICAL in convexity
  // to the bore's rims (ruling R10). Only its curvature differs, so this test is the one
  // that fails if a rule ever regresses to keying on arc convexity.
  const holes = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(holes.length).toBe(1);
  expect(holes[0].diameter).toBeLessThan(12);
});

test("a through hole reports an exit face and no floor face", () => {
  const [hole] = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(hole.exitFace).not.toBeNull();
  expect(hole.floorFace).toBeNull();
});

test("a bare cylinder has no holes at all", () => {
  expect(detectHoles(graphOf(cylinderMesh(4, 10, 48)))).toEqual([]);
});

test("a sharp-edged fixture reports no fillets or chamfers", () => {
  expect(detectDressups(graphOf(annulusPlate(10, 4, 3, 48)))).toEqual([]);
});

// Arbitrary orientation, per the Global Constraints. Hole rules read cylinder curvature
// and arc convexity, both of which come from normals and cross products — exactly the
// arithmetic that broke on rotation in Task 3.
test.each(ORIENTATIONS)(
  "%s: the washer bore is one through hole of the same diameter", (_n, orient) => {
    const holes = detectHoles(graphOf(orient(annulusPlate(10, 4, 3, 48))));
    expect(holes.length).toBe(1);
    expect(holes[0].type).toBe("throughHole");
    expect(holes[0].diameter).toBeCloseTo(8, 1);
  });

test("holes carry a stable key derived from geometry, not from iteration order", () => {
  const a = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)))[0];
  const b = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)))[0];
  expect(a.key).toBe(b.key);
  expect(a.id).toBeNull();
});

// --- Round 1 fixes: a chamfer that can actually fire, a countersunk hole, a torus
// fillet across a realistic r/R range, and a genuine blind hole. ---

// The chamfer fixture: a 45-degree bevel of size 3 cut along one 30mm-long vertical
// edge of a 20x20x30 box. Its bevel plane has FOUR arcs (two ~30mm to the walls it
// blends, two ~4.2mm to the top/bottom caps it merely runs into) — the shape that
// exposed the original `arcs.length !== 2` premise as impossible for any finite
// straight chamfer to satisfy.
test.each(ORIENTATIONS)("%s: a chamfered box reports exactly one 45-degree chamfer", (_n, orient) => {
  const dressups = detectDressups(graphOf(orient(chamferedBox(20, 20, 30, 3))));
  expect(dressups.length).toBe(1);
  expect(dressups[0].type).toBe("chamfer");
  expect(dressups[0].angle).toBeCloseTo(Math.PI / 4, 1);
  // width = area / longest arc = (c*sqrt(2) wide, 30mm long) / 30 = c*sqrt(2)
  expect(dressups[0].width).toBeCloseTo(3 * Math.SQRT2, 1);
});

test.each(ORIENTATIONS)("%s: a chamfered box reports no holes", (_n, orient) => {
  expect(detectHoles(graphOf(orient(chamferedBox(20, 20, 30, 3))))).toEqual([]);
});

// The countersunk-hole fixture: `annulusPlate`'s bore with a 45-degree countersink
// opening its top mouth from 8mm to 10mm diameter. Exposed two round-1 gaps at once:
// the countersink cone itself (no cone branch in the old chamfer rule) and the bore's
// through-hole status (the old mouth filter required a PLANE neighbour, and this
// bore's top mouth is a cone).
test.each(ORIENTATIONS)("%s: a countersunk plate reports one chamfer (the countersink)", (_n, orient) => {
  const dressups = detectDressups(graphOf(orient(countersunkPlate(10, 4, 5, 3, 96))));
  const chamfers = dressups.filter((d) => d.type === "chamfer");
  expect(chamfers.length).toBe(1);
  expect(chamfers[0].angle).toBeCloseTo(Math.PI / 4, 1);
});

test.each(ORIENTATIONS)("%s: a countersunk plate's bore is still one through hole", (_n, orient) => {
  const holes = detectHoles(graphOf(orient(countersunkPlate(10, 4, 5, 3, 96))));
  expect(holes.length).toBe(1);
  expect(holes[0].type).toBe("throughHole");
  expect(holes[0].diameter).toBeCloseTo(8, 1);
  expect(holes[0].entryFace).not.toBeNull();
  expect(holes[0].exitFace).not.toBeNull();
  // The countersink cone is recorded as part of the hole, not silently dropped.
  expect(holes[0].evidence.countersunk).toBe(true);
  expect(holes[0].surfaces.length).toBe(2);
});

// The blind-hole fixture: a flat-bottomed cylindrical bore that stops partway through
// a solid cylinder. The through-hole invariant test above only proves a through hole
// reports no floor; this proves the floor branch itself actually fires.
test.each(ORIENTATIONS)("%s: a blind-hole cup is detected as one blind hole with a floor", (_n, orient) => {
  const holes = detectHoles(graphOf(orient(cupMesh(10, 4, 8, 3, 48))));
  expect(holes.length).toBe(1);
  expect(holes[0].type).toBe("blindHole");
  expect(holes[0].diameter).toBeCloseTo(8, 1);
  expect(holes[0].depth).toBeCloseTo(5, 1);   // bore runs from z=3 (floor) to z=8 (mouth)
  expect(holes[0].entryFace).not.toBeNull();
  expect(holes[0].floorFace).not.toBeNull();
  expect(holes[0].exitFace).toBeNull();
});

// The torus-fillet fixture: a cylinder (shaft radius R=8) with its top rim rounded by
// a tangent torus fillet of radius r. Swept from r/R=0.0625 up to 0.25 — the old
// area-ratio test missed the two larger ratios entirely (a torus fillet's end cap
// shrinks by 2r, eroding the AREA ratio far faster than the geometry warrants), while
// the new length-based width test (radius against the larger neighbour's own arc
// radius) clears all three with margin.
test.each(ORIENTATIONS)(
  "%s: a torus fillet is detected with the right radius across r/R = 0.0625 to 0.25", (_n, orient) => {
    const R = 8;
    for (const ratio of [0.0625, 0.125, 0.25]) {
      const r = R * ratio;
      const g = filletGraph(R, 12, r, 96, 48, orient);
      const fillets = detectDressups(g).filter((d) => d.type === "fillet");
      expect(fillets.length).toBe(1);
      expect(fillets[0].radius).toBeCloseTo(r, 1);
    }
  });
