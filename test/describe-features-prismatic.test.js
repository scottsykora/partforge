import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectPrismatic } from "../src/framework/oracle/describe/features/prismatic.js";
import { detectSweeps } from "../src/framework/oracle/describe/features/sweeps.js";
import { boxMesh, cylinderMesh, annulusPlate, cupMesh, rotateMesh } from "./helpers/mesh-fixtures.js";

// Same arbitrary, unremarkable tilt describe-surface-graph.test.js, describe-segment.test.js
// and describe-ransac.test.js already use. `rotateMesh(mesh, [rx, ry, rz])` takes radians
// packed in one array (see mesh-fixtures.js).
const TILT = [(17 * Math.PI) / 180, (29 * Math.PI) / 180, (53 * Math.PI) / 180];

const ctx = (mesh) => { const t = buildTopology(mesh); return { t, g: surfaceGraph(t, segment(t).patches) }; };

test("a plain box is one extrusion, not a pocket or a boss", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const f = detectPrismatic(g);
  expect(f.map((x) => x.type)).toEqual(["extrusion"]);
});

// Guards ruling R10 from the prismatic side: a washer's cap arcs are a MIX of convex
// (both rims) and concave (nothing) — a rule that counted them to decide pocket-vs-boss
// would classify by noise. The base extrusion must win regardless.
test("a washer's base extrusion is not misread as a pocket or a boss", () => {
  const { g } = ctx(annulusPlate(10, 4, 3, 48));
  expect(detectPrismatic(g).map((x) => x.type)).toEqual(["extrusion"]);
});

test("the box extrusion recovers a rectangular profile and its depth", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const [ex] = detectPrismatic(g);
  expect(ex.profile.kind).toBe("polygon");
  expect(ex.depth).toBeCloseTo(5, 2);
});

test("a cylinder is an extrusion with a circular profile", () => {
  const { g } = ctx(cylinderMesh(4, 10, 48));
  const [ex] = detectPrismatic(g);
  expect(ex.profile.kind).toBe("circle");
  // `profile.radius` comes from the cap's boundary ARC (surface-graph.js's `arcKind`),
  // which measures the mean distance of EDGE MIDPOINTS to their own centroid, not the
  // wall's own least-squares vertex fit — deliberately (`profile` is a proposal for a
  // sketch, not a measurement; see this file's header). On a 48-gon inscribed in a
  // true radius-4 circle, that midpoint radius is 4*cos(pi/48) = 3.99144, an 0.0086mm
  // undershoot that exceeds `toBeCloseTo(4, 2)`'s 0.005 tolerance by design of the
  // tessellation, not a bug. `describe-features-holes.test.js` already uses precision 1
  // for the identical facet-radius measurement on the same 48-segment fixtures; matched
  // here rather than tightened, since the fixture's own geometry sets that bound.
  expect(ex.profile.radius).toBeCloseTo(4, 1);
  expect(ex.depth).toBeCloseTo(10, 2);
});

test("a washer is recognised as axisymmetric (a revolve candidate)", () => {
  const { g } = ctx(annulusPlate(10, 4, 3, 48));
  const rev = detectSweeps(g).find((f) => f.type === "revolve");
  expect(rev).toBeDefined();
  expect(Math.abs(rev.axis.direction[2])).toBeCloseTo(1, 3);
});

test("a solid box is not reported as a shell", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  expect(detectSweeps(g).some((f) => f.type === "shell")).toBe(false);
});

// Arbitrary orientation, per the Global Constraints. `sweepDirection` and the revolve
// axis vote both come out of eigen-decompositions of normal fields, which have no reason
// to prefer world axes — but the depth fallback compares plane OFFSETS, which do.
test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
  "%s: a box is one extrusion of the same depth", (_n, orient) => {
    const { g } = ctx(orient(boxMesh(10, 20, 5)));
    const f = detectPrismatic(g);
    expect(f.map((x) => x.type)).toEqual(["extrusion"]);
    expect(f[0].depth).toBeCloseTo(5, 2);
  });

test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
  "%s: the washer is still recognised as axisymmetric", (_n, orient) => {
    const { g } = ctx(orient(annulusPlate(10, 4, 3, 48)));
    expect(detectSweeps(g).some((f) => f.type === "revolve")).toBe(true);
  });

// The mouth-vs-floor ambiguity: `cupMesh`'s blind bore has a wide mouth ANNULUS (the
// rim around the hole) and a narrow floor DISK, and both border the same bore wall.
// Processing pockets/bosses largest-area-first (the same order used to find the base)
// would let the bigger annulus claim that wall before the genuine floor gets a turn,
// misreporting the feature backwards or dropping it. Smallest-first is what fixes that
// (see this file's header) — this is the regression test for it, using the same
// fixture describe-features-holes.test.js already uses for the equivalent blind-hole
// case.
test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
  "%s: a blind-hole cup is a base extrusion plus one pocket, not a boss or a mouth-first misread",
  (_n, orient) => {
    const { g } = ctx(orient(cupMesh(10, 4, 8, 3, 48)));
    const f = detectPrismatic(g);
    expect(f.map((x) => x.type)).toEqual(["extrusion", "pocket"]);
    const pocket = f.find((x) => x.type === "pocket");
    expect(pocket.depth).toBeCloseTo(5, 1);
  });

test("prismatic features carry stable keys and null ids", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const a = detectPrismatic(g)[0], b = detectPrismatic(g)[0];
  expect(a.key).toBe(b.key);
  expect(a.id).toBeNull();
});
