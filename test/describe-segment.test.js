import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

const run = (mesh) => segment(buildTopology(mesh));

// A realistic facet count, not the inflated 240 an earlier pass on this file
// needed. That 240 was working around a real bug (region growth used the same
// ascending-DOF fit as its final classification, so it could never escape
// classifying a growing cylinder patch as a "plane" once one had grown far
// enough to fail — see the growthFit/bestFit split and the dihedral-gated
// adaptive tolerance below). With both of those fixed, growth no longer needs
// an artificially fine mesh to bootstrap past its own first step, and the
// N-sweep test below confirms recovery holds all the way down to N = 16 — so
// 48 here is just an unremarkable, realistic CAD facet count again, not a
// crutch. Leaving it as a value distinct from the sweep's own list keeps this
// test from silently depending on the sweep test asserting the same thing.
const CYL_SEGS = 48;

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

// Regression: the suite above only ever ran at ONE facet count, which is
// exactly why the bug fixed in this revision shipped in the first place — at
// nearly every "reasonable" CAD tessellation density (16 through 128 segments
// per revolve, span-checked against real STL exports), the OLD growth
// predicate shredded a curved wall into one plane per facet and never
// recovered a cylinder at all, while still reporting `unassigned.length === 0`
// (it was over-claiming faces as the wrong type, not failing to claim them —
// so Task 4's RANSAC mop-up, which only ever looks at `unassigned`, could
// never have caught it either). Sweeping density here is what would have
// caught that the first time.
const CYLINDER_SEGS_SWEEP = [16, 24, 32, 48, 64, 96, 240];

test.for(CYLINDER_SEGS_SWEEP)("a cylinder at %i segments still segments into two planes and one cylinder of radius 4", (segs) => {
  const { patches, unassigned } = run(cylinderMesh(4, 10, segs));
  const types = patches.map((p) => p.fit.type).sort();
  expect(types, `segs=${segs}`).toEqual(["cylinder", "plane", "plane"]);
  const cyl = patches.find((p) => p.fit.type === "cylinder");
  expect(cyl.fit.radius, `segs=${segs}`).toBeCloseTo(4, 2);
  expect(unassigned.length, `segs=${segs}`).toBe(0);
});

test.for(CYLINDER_SEGS_SWEEP)("a washer at %i segments still segments into two annulus planes and cylinders at r=4 and r=10", (segs) => {
  const { patches, unassigned } = run(annulusPlate(10, 4, 3, segs));
  expect(patches.length, `segs=${segs}`).toBe(4);
  const radii = patches.filter((p) => p.fit.type === "cylinder").map((p) => p.fit.radius).sort((a, b) => a - b);
  expect(radii.length, `segs=${segs}`).toBe(2);
  expect(radii[0], `segs=${segs}`).toBeCloseTo(4, 1);
  expect(radii[1], `segs=${segs}`).toBeCloseTo(10, 1);
  expect(unassigned.length, `segs=${segs}`).toBe(0);
});

// `unassigned` has an easy-to-miss precondition: a lone triangle's three points
// always define SOME plane exactly (rms 0), so `growthFit`/`bestFit` can only
// ever fail on a single-triangle seed when even a PLANE fit is refused — which
// only happens when fit.js's own rank guard judges the three points too close
// to collinear (a genuine, if extreme, sliver). This hand-built fixture pairs
// one ordinary flat quad with one isolated sliver triangle (no shared vertices
// with anything, so growth cannot rescue it from a neighbour either) placed far
// away, to exercise the one real path into `unassigned` rather than leaving it
// untested, as it was before this revision.
test("a fixture with one legitimate quad and one isolated sliver triangle reports the sliver as unassigned", () => {
  const positions = [
    0, 0, 0, 10, 0, 0, 10, 10, 0,
    0, 0, 0, 10, 10, 0, 0, 10, 0,
    1000, 0, 0, 1010, 0, 0, 1005, 1e-6, 0,
  ];
  const { patches, unassigned } = segment(buildTopology({ positions }));
  expect(patches.length).toBe(1);
  expect(patches[0].fit.type).toBe("plane");
  expect(patches[0].faces.length).toBe(2);
  expect(unassigned).toEqual([2]);
});
