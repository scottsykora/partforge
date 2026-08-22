import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectHoles } from "../src/framework/oracle/describe/features/holes.js";
import { detectDressups } from "../src/framework/oracle/describe/features/dressups.js";
import { annulusPlate, cylinderMesh, rotateMesh } from "./helpers/mesh-fixtures.js";

// `rotateMesh(mesh, [rx, ry, rz])` takes radians packed in one array (see
// mesh-fixtures.js) — same arbitrary, unremarkable tilt describe-surface-graph.test.js,
// describe-segment.test.js and describe-ransac.test.js already use.
const TILT = [(17 * Math.PI) / 180, (29 * Math.PI) / 180, (53 * Math.PI) / 180];

const graphOf = (mesh) => { const t = buildTopology(mesh); return surfaceGraph(t, segment(t).patches); };

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

// The blind-hole branch has no hand-buildable fixture here, so assert the invariant from
// the other side: a THROUGH hole must report two mouths and no floor. A rule that started
// mistaking a mouth for a floor would fail this.
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
test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
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
