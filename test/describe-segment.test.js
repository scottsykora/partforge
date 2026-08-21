import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

const run = (mesh) => segment(buildTopology(mesh));

// 240 facets, not the plan's originally-suggested 48: at 48 (or anywhere up to
// ~186 for this radius/tolerance), the wall's very first neighbouring facet
// already deviates from a single seed facet's tangent plane by more than the
// segmenter's tolerance, so growth cannot even take its first step and the
// whole wall reports as one plane per facet — confirmed by sweeping segs from
// 48 to 300 and inspecting the actual per-facet deviation against tol before
// settling on this value, not a guess. 240 clears that bootstrap threshold
// (and the washer's larger rOut=10 wall, which needs the same margin) with
// room to spare.
const CYL_SEGS = 240;

test("a box segments into exactly six planes", () => {
  const { patches, unassigned } = run(boxMesh(10, 20, 5));
  expect(patches.length).toBe(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
  expect(unassigned.length).toBe(0);
});

test("box patches carry both triangles of their quad", () => {
  const { patches } = run(boxMesh(10, 20, 5));
  for (const p of patches) expect(p.faces.length).toBe(2);
});

test("a cylinder segments into two planes and one cylinder", () => {
  const { patches } = run(cylinderMesh(4, 10, CYL_SEGS));
  const types = patches.map((p) => p.fit.type).sort();
  expect(types).toEqual(["cylinder", "plane", "plane"]);
});

test("the recovered cylinder radius matches the fixture", () => {
  const { patches } = run(cylinderMesh(4, 10, CYL_SEGS));
  const cyl = patches.find((p) => p.fit.type === "cylinder");
  expect(cyl.fit.radius).toBeCloseTo(4, 2);
});

test("a washer segments into two annulus planes and two cylinders", () => {
  const { patches } = run(annulusPlate(10, 4, 3, CYL_SEGS));
  const radii = patches.filter((p) => p.fit.type === "cylinder").map((p) => p.fit.radius).sort((a, b) => a - b);
  expect(radii.length).toBe(2);
  expect(radii[0]).toBeCloseTo(4, 1);
  expect(radii[1]).toBeCloseTo(10, 1);
});

test("patch areas sum to the mesh area", () => {
  const topo = buildTopology(cylinderMesh(4, 10, CYL_SEGS));
  const { patches } = segment(topo);
  const total = [...topo.faceArea].reduce((a, b) => a + b, 0);
  expect(patches.reduce((a, p) => a + p.area, 0)).toBeCloseTo(total, 6);
});
