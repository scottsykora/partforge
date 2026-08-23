import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment, facePoints } from "../src/framework/oracle/describe/segment.js";
import { fitTorus } from "../src/framework/oracle/describe/fit.js";
import { surfaceGraph, arcsOf, sameSurface } from "../src/framework/oracle/describe/surface-graph.js";
import { boxMesh, annulusPlate, torusMesh, rotateMesh } from "./helpers/mesh-fixtures.js";

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

// R31: fitPlane's normal sign is an arbitrary eigensolver artifact, unrelated to which
// side the material is on. Before the fix, both of a washer's caps reported an IDENTICAL
// (0,0,1) (translated copies of the same ring shape, hence identical PCA covariance) —
// which is what makes the pocket-vs-boss displacement test in features/prismatic.js
// meaningless without this fix. `surfaceGraph` must orient each plane's normal against
// its own faces' outward mesh normals, so two opposing caps come back genuinely opposite.
test.each([["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]])(
  "%s: a washer's two caps report opposite normals", (_n, orient) => {
    const g = graphOf(orient(annulusPlate(10, 4, 3, 48)));
    const caps = g.surfaces.filter((s) => s.type === "plane");
    expect(caps.length).toBe(2);
    const d = caps[0].fit.normal[0]*caps[1].fit.normal[0]
            + caps[0].fit.normal[1]*caps[1].fit.normal[1]
            + caps[0].fit.normal[2]*caps[1].fit.normal[2];
    expect(d).toBeLessThan(-0.98);
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

// Fix round 1: `sameSurface`'s torus branch checked axis direction and both radii but
// never position — the one branch of the five that didn't gate on it (plane: offset;
// sphere/cone: centre/apex distance; cylinder: perpendicular offset from the axis). Two
// unrelated same-size grooves on the same axis (two O-ring grooves on one shaft, or
// identical grooves at opposite ends of a part) would merge into one impossible surface.
//
// Direct unit tests of `sameSurface` itself, against fabricated fit-parameter objects
// (no mesh, no `mergeCoFamily`): `surfaceGraph`'s post-merge residual guard (also added
// in this fix round) makes a large enough position mismatch ALSO fail on refit residual
// alone, which would otherwise mask a regression here behind that second, coarser net —
// the mesh-driven tori tests further below still pass even with this branch's position
// check deleted entirely (verified directly while writing this fix). Testing the
// function in isolation is what actually pins the fixed behavior down.
const torusFit = (center, axis = [0, 0, 1]) => ({ type: "torus", axis, center, majorRadius: 10, minorRadius: 3 });

test("sameSurface's torus branch rejects two coaxial same-size tori at different axial positions", () => {
  expect(sameSurface(torusFit([0, 0, 0]), torusFit([0, 0, 60]))).toBe(false);
});

test("sameSurface's torus branch rejects two same-size tori on parallel axes offset sideways", () => {
  expect(sameSurface(torusFit([0, 0, 0]), torusFit([50, 0, 0]))).toBe(false);
});

test("sameSurface's torus branch accepts two fits describing the same torus (within noise)", () => {
  expect(sameSurface(torusFit([0, 0, 0]), torusFit([1e-9, -1e-9, 0]))).toBe(true);
});

// `torusMesh` is NOT expected to segment into one patch via `segment()`'s own region
// growing (see its comment in mesh-fixtures.js — a torus's double curvature defeats the
// witness-corroboration mechanism structurally, an orthogonal, pre-existing limitation).
// So these tests build each patch's fit directly with `fitTorus` over the whole mesh —
// the same computation `segment()`'s own `bestFit` would have run, had growth converged —
// to confirm the end-to-end behaviour (`surfaceGraph`, `sameSurface` AND the residual
// guard acting together) on real, non-fabricated geometry.
function torusPatch(topo, faces, id) {
  const { pts, normals } = facePoints(topo, faces);
  return { id, faces, fit: fitTorus(pts, normals), area: faces.reduce((a, t) => a + topo.faceArea[t], 0) };
}

test("two coaxial, same-size tori at different positions along the axis do not merge", () => {
  const meshA = torusMesh(10, 3, 48, 48, [0, 0, 0]);
  const meshB = torusMesh(10, 3, 48, 48, [0, 0, 60]);   // same axis and size, 60mm further along it
  const nA = meshA.positions.length / 9;
  const topo = buildTopology({ positions: [...meshA.positions, ...meshB.positions] });
  const facesA = Array.from({ length: nA }, (_, i) => i);
  const facesB = Array.from({ length: topo.faceArea.length - nA }, (_, i) => nA + i);
  const g = surfaceGraph(topo, [torusPatch(topo, facesA, "tA"), torusPatch(topo, facesB, "tB")]);
  expect(g.surfaces.filter((s) => s.type === "torus").length).toBe(2);
});

test("two coaxial, same-size tori offset sideways from the axis do not merge", () => {
  const meshA = torusMesh(10, 3, 48, 48, [0, 0, 0]);
  const meshB = torusMesh(10, 3, 48, 48, [50, 0, 0]);   // same axis direction, shifted off it
  const nA = meshA.positions.length / 9;
  const topo = buildTopology({ positions: [...meshA.positions, ...meshB.positions] });
  const facesA = Array.from({ length: nA }, (_, i) => i);
  const facesB = Array.from({ length: topo.faceArea.length - nA }, (_, i) => nA + i);
  const g = surfaceGraph(topo, [torusPatch(topo, facesA, "tA"), torusPatch(topo, facesB, "tB")]);
  expect(g.surfaces.filter((s) => s.type === "torus").length).toBe(2);
});

test("one torus split into disconnected fragments merges back into one surface", () => {
  const topo = buildTopology(torusMesh(10, 3, 48, 48));
  const all = Array.from({ length: topo.faceArea.length }, (_, i) => i);
  const full = torusPatch(topo, all, "qT");
  const half = Math.floor(full.faces.length / 2);
  const split = [
    { ...full, id: "qA", faces: full.faces.slice(0, half) },
    { ...full, id: "qB", faces: full.faces.slice(half) },
  ];
  const g = surfaceGraph(topo, split);
  const tori = g.surfaces.filter((s) => s.type === "torus");
  expect(tori.length).toBe(1);
  expect(tori[0].faces.length).toBe(full.faces.length);
});

// Fix round 1: the post-merge residual guard, tested directly and independent of any
// particular `sameSurface` gap. Even when two patches' reported fit parameters agree well
// enough to satisfy `sameSurface`, the merge must still be rejected once the ACTUAL
// combined point cloud is refit and found not to describe one surface — that is what turns
// a `sameSurface` gap into "failed to merge" instead of "invented a surface". Forced here
// directly: two genuinely different, non-coplanar box faces, with one's reported fit
// overwritten to claim the other's plane. `sameSurface` says yes; the real geometry says
// no; the guard must still refuse the merge.
test("a forged sameSurface agreement does not survive the post-merge residual check", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  const { patches } = segment(topo);
  const bottom = patches.find((p) => Math.abs(p.fit.normal[2]) > 0.9 && p.fit.offset < 2.5);
  const side = patches.find((p) => Math.abs(p.fit.normal[0]) > 0.9);
  const forgedSide = { ...side, fit: { ...bottom.fit } };
  const others = patches.filter((p) => p !== bottom && p !== side);
  const g = surfaceGraph(topo, [...others, bottom, forgedSide]);
  // Had the guard not fired, bottom + forgedSide would have merged into one surface and
  // the box would report five surfaces instead of six.
  expect(g.surfaces.length).toBe(6);
});
