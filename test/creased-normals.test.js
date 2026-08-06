import { expect, test } from "vitest";
import { creasedNormals } from "../src/framework/geometry/creased-normals.js";
import { FACETED } from "../src/framework/geometry/shading-policy.js";

// Two triangles sharing the edge v0-v1 (the x axis). Tri A lies in the XY
// plane (face normal +Z); tri B is the same quad half rotated `bend` degrees
// up about the x axis. scale shrinks the whole fixture (for MIN_EDGE tests).
function hinge(bendDeg, { oids = [7, 7], scale = 1 } = {}) {
  const t = (bendDeg * Math.PI) / 180;
  const s = scale;
  return {
    numProp: 3,
    vertProperties: Float32Array.from([
      0, 0, 0,                      // v0
      1 * s, 0, 0,                  // v1
      0, 1 * s, 0,                  // v2  (tri A apex)
      0.5 * s, -Math.cos(t) * s, Math.sin(t) * s, // v3 (tri B apex)
    ]),
    triVerts: Uint32Array.from([0, 1, 2, 1, 0, 3]),
    mergeFromVert: new Uint32Array(0),
    mergeToVert: new Uint32Array(0),
    runIndex: Uint32Array.from([0, 3, 6]),
    runOriginalID: Uint32Array.from(oids),
  };
}

const cornerNormal = (r, tri, corner) => [
  r.normals[(tri * 3 + corner) * 3],
  r.normals[(tri * 3 + corner) * 3 + 1],
  r.normals[(tri * 3 + corner) * 3 + 2],
];

test("same surface, 30° bend, default SMOOTH: shared-edge normals are averaged, no edge line", () => {
  const r = creasedNormals(hinge(30));
  const [nx, ny, nz] = cornerNormal(r, 0, 0); // tri A's copy of v0 (shared vertex)
  expect(nz).toBeLessThan(0.9999);            // not the pure +Z face normal — it blends with tri B
  expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
  expect(r.edges.length).toBe(0);             // 30° < 35° — no line
});

test("same surface, 45° bend, default SMOOTH: hard normals and one edge segment", () => {
  const r = creasedNormals(hinge(45));
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5); // tri A shades with its own +Z face normal
  expect(r.edges.length).toBe(6);                     // one segment = 2 points × xyz
});

test("FACETED policy: a 30° same-surface bend shades hard and draws NO line", () => {
  const r = creasedNormals(hinge(30), { policies: new Map([[7, FACETED]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5); // hard: 30° > 10°
  expect(r.edges.length).toBe(0);                     // sameSurfaceLines: false
});

test("FACETED policy: bends under creaseAngle still smooth (ring-to-ring case)", () => {
  const r = creasedNormals(hinge(4), { policies: new Map([[7, FACETED]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeLessThan(0.9999); // 4° < 10° — averaged
});

test("different surfaces: always hard, line only past the 5° coplanar threshold", () => {
  const seam = creasedNormals(hinge(30, { oids: [7, 8] }));
  expect(cornerNormal(seam, 0, 0)[2]).toBeCloseTo(1, 5); // cut seams shade hard at any angle
  expect(seam.edges.length).toBe(6);
  const coplanar = creasedNormals(hinge(2, { oids: [7, 8] }));
  expect(cornerNormal(coplanar, 0, 0)[2]).toBeCloseTo(1, 5);
  expect(coplanar.edges.length).toBe(0);                 // 2° < 5° — coplanar seam, no line
});

test("sub-MIN_EDGE segments are dropped as degenerate slivers", () => {
  const r = creasedNormals(hinge(90, { scale: 0.005 })); // shared edge is 0.005mm long
  expect(r.edges.length).toBe(0);
});

test("feature labels map through runOriginalID unchanged", () => {
  const r = creasedNormals(hinge(45, { oids: [7, 8] }), { featureLabels: new Map([[7, "wall"]]) });
  expect(r.features).toEqual(["wall"]);
  expect(Array.from(r.featureIds)).toEqual([1, 0]); // tri A → feature 1, tri B unlabeled
});
