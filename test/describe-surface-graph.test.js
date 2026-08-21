import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph, arcsOf } from "../src/framework/oracle/describe/surface-graph.js";
import { boxMesh, annulusPlate, rotateMesh } from "./helpers/mesh-fixtures.js";

// `rotateMesh(mesh, [rx, ry, rz])` takes radians packed in one array (see
// mesh-fixtures.js) — this tilt matches the one describe-segment.test.js and
// describe-ransac.test.js already use, so all three suites exercise the same
// arbitrary, unremarkable orientation.
const TILT = [(17 * Math.PI) / 180, (29 * Math.PI) / 180, (53 * Math.PI) / 180];

const graphOf = (mesh) => { const t = buildTopology(mesh); return surfaceGraph(t, segment(t).patches); };

test("a box yields six surfaces with stable s-prefixed ids", () => {
  const g = graphOf(boxMesh(10, 20, 5));
  expect(g.surfaces.length).toBe(6);
  expect(g.surfaces.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
});

test("a box yields twelve convex arcs, all straight", () => {
  const g = graphOf(boxMesh(10, 20, 5));
  expect(g.arcs.length).toBe(12);
  expect(g.arcs.every((a) => a.convexity === "convex")).toBe(true);
  expect(g.arcs.every((a) => a.kind === "line")).toBe(true);
});

// The discriminator (ruling R10): the bore is a CONCAVE cylinder, the outer wall a convex
// one. This is the attribute every hole rule keys on.
test("the washer bore is a concave cylinder and its outer wall a convex one", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  const bore = g.surfaces.find((s) => s.type === "cylinder" && s.fit.radius < 6);
  const wall = g.surfaces.find((s) => s.type === "cylinder" && s.fit.radius > 6);
  expect(bore.curvature).toBe("concave");
  expect(wall.curvature).toBe("convex");
});

test("planes carry no curvature at all", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  for (const s of g.surfaces.filter((x) => x.type === "plane")) expect(s.curvature).toBeNull();
});

// And the trap: BOTH rims are convex 90-degree corners. A test that expected the bore's
// rims to be concave would be asserting something geometrically false.
test("both the bore rim and the outer rim are convex circular arcs", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  for (const r of [4, 10]) {
    const cyl = g.surfaces.find((s) => s.type === "cylinder" && Math.abs(s.fit.radius - r) < 2);
    const rims = arcsOf(g, cyl.id).filter((a) => a.kind === "circle");
    expect(rims.length).toBe(2);
    expect(rims.every((a) => a.convexity === "convex")).toBe(true);
  }
});

test("every surface reports at least one closed boundary loop", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  for (const s of g.surfaces) expect(s.loops.length).toBeGreaterThanOrEqual(1);
});

// Arbitrary orientation, per the Global Constraints. Task 3 shipped a defect that
// collapsed segmentation at a 0.01-degree tilt and passed 53/53 because every fixture was
// axis-aligned; curvature and arc classification are just as orientation-sensitive, since
// both read normals and cross products.
test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
  "%s: the washer's curvature and rim classification are identical", (_n, orient) => {
    const g = graphOf(orient(annulusPlate(10, 4, 3, 48)));
    const bore = g.surfaces.find((s) => s.type === "cylinder" && s.fit.radius < 6);
    const wall = g.surfaces.find((s) => s.type === "cylinder" && s.fit.radius > 6);
    expect(bore.curvature).toBe("concave");
    expect(wall.curvature).toBe("convex");
    expect(arcsOf(g, bore.id).filter((a) => a.kind === "circle").every((a) => a.convexity === "convex")).toBe(true);
  });

test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
  "%s: a box is six planes with twelve convex straight arcs", (_n, orient) => {
    const g = graphOf(orient(boxMesh(10, 20, 5)));
    expect(g.surfaces.length).toBe(6);
    expect(g.arcs.length).toBe(12);
    expect(g.arcs.every((a) => a.convexity === "convex" && a.kind === "line")).toBe(true);
  });

// R25/R26: one surface split by segmentation must come back out as ONE surface. A washer
// whose bore is tessellated at mixed density splits into two coaxial equal-radius cylinder
// patches; unmerged, Task 6 detects the same through-hole twice with the same key.
test("co-family patches merge into one surface even when disconnected", () => {
  const topo = buildTopology(annulusPlate(10, 4, 3, 48));
  const { patches } = segment(topo);
  // Split the bore patch in two by hand — this is exactly the shape a variable-density
  // tessellation produces, without needing a mixed-density fixture to reproduce it.
  const bore = patches.find((p) => p.fit.type === "cylinder" && p.fit.radius < 6);
  const half = Math.floor(bore.faces.length / 2);
  const split = patches.filter((p) => p !== bore).concat([
    { ...bore, id: "qA", faces: bore.faces.slice(0, half) },
    { ...bore, id: "qB", faces: bore.faces.slice(half) },
  ]);
  const g = surfaceGraph(topo, split);
  const bores = g.surfaces.filter((s) => s.type === "cylinder" && s.fit.radius < 6);
  expect(bores.length).toBe(1);
  expect(bores[0].faces.length).toBe(bore.faces.length);
});
