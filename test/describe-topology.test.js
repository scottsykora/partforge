import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { boxMesh, cylinderMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

// Area-weighted face-normal sum is the divergence theorem's ∮ n dA = 0: for ANY
// closed (watertight) mesh, regardless of shape or tessellation, the outward
// normals weighted by triangle area must cancel exactly. It is a cheap,
// shape-agnostic tripwire for winding bugs — including the annulusPlate
// top-cap winding bug this file's own tests once missed entirely.
function normalSum(t) {
  const sum = [0, 0, 0];
  for (let i = 0; i < t.faceArea.length; i++) {
    for (let k = 0; k < 3; k++) sum[k] += t.faceNormal[3 * i + k] * t.faceArea[i];
  }
  return sum;
}

test("a box welds to 8 vertices and 12 triangles", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  expect(t.verts.length / 3).toBe(8);
  expect(t.tris.length / 3).toBe(12);
});

test("every box edge shared by two coplanar triangles is flat", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  const flat = t.edges.filter((e) => e.convexity === "flat");
  expect(flat.length).toBe(6);              // one diagonal per quad face
});

test("every box corner edge is convex at +90 degrees", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  const convex = t.edges.filter((e) => e.convexity === "convex");
  expect(convex.length).toBe(12);
  for (const e of convex) expect(e.dihedral).toBeCloseTo(Math.PI / 2, 6);
});

// "some edge is concave / some edge is convex" is satisfied by a single
// correctly-signed edge anywhere in the mesh, so it cannot tell a fully-correct
// annulus from one where an entire ring has the wrong sign — exactly the bug
// this test caught in review (see the annulusPlate top-cap fix in
// mesh-fixtures.js). The replacement below asserts on the wall's own
// circumferential curvature rather than the wall-to-cap ring: a straight
// vertical wall meeting a flat cap is a plain 90-degree convex corner
// regardless of which side of the wall the material is on (a picture frame's
// inner lip is exactly as convex as its outer edge — verified directly by
// hand-computing both cross products against the fixture's actual vertex
// coordinates), so that junction cannot distinguish a hole from a boss. What
// DOES distinguish them is whether the wall bulges away from the material
// (convex, a boss) or into it (concave, a bore) as you walk around it — the
// edges where adjacent wall facets meet at fixed radius, differing only in z.
// Identify those by edge direction (parallel to the axis, i.e. same x,y at
// both ends) rather than by radius alone, since the per-facet diagonal also
// sits at a single radius but runs radius-and-z-mixed and is flat, not curved.
test("the outer wall's facet joints are convex and the bore's are concave", () => {
  const rOut = 10, rIn = 4;
  const t = buildTopology(annulusPlate(rOut, rIn, 3, 24));
  const vx = (i) => t.verts[3 * i], vy = (i) => t.verts[3 * i + 1], vz = (i) => t.verts[3 * i + 2];
  const closeTo = (a, b) => Math.abs(a - b) < 1e-6;

  let outerCount = 0, boreCount = 0;
  for (const e of t.edges) {
    // A facet joint runs straight along the axis: same (x, y) at both ends,
    // different z. (The per-facet diagonal shares a radius too, but changes
    // both angle and z, so it fails this check and is correctly skipped.)
    if (!closeTo(vx(e.v0), vx(e.v1)) || !closeTo(vy(e.v0), vy(e.v1))) continue;
    if (closeTo(vz(e.v0), vz(e.v1))) continue;
    const r = Math.hypot(vx(e.v0), vy(e.v0));
    if (closeTo(r, rOut)) {
      expect(e.convexity).toBe("convex");
      outerCount++;
    } else if (closeTo(r, rIn)) {
      expect(e.convexity).toBe("concave");
      boreCount++;
    }
  }
  // Guard the guard: if the direction/radius filter matched nothing, the
  // assertions above never ran and the test would pass vacuously.
  expect(outerCount).toBeGreaterThan(0);
  expect(boreCount).toBeGreaterThan(0);
});

test("a watertight mesh has no boundary edges", () => {
  const t = buildTopology(annulusPlate(10, 4, 3, 24));
  expect(t.edges.filter((e) => e.convexity === "boundary").length).toBe(0);
});

test("closed meshes satisfy the divergence identity (area-weighted normals cancel)", () => {
  for (const mesh of [boxMesh(10, 20, 5), cylinderMesh(6, 8, 32), annulusPlate(10, 4, 3, 24)]) {
    const [sx, sy, sz] = normalSum(buildTopology(mesh));
    expect(Math.hypot(sx, sy, sz)).toBeLessThan(1e-6);
  }
});
