import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { loftMesh } from "../src/framework/geometry/loft.js";
import { regularPolygon, roundedProfile, circleProfile } from "../src/framework/geometry/polygon.js";
import { resolveLoftRings } from "../src/framework/geometry/loft-rings.js";
import { pointsToContour } from "../src/framework/geometry/profile.js";

// Raw-mesh test for the Manifold loft helper, mirroring helix-tube.test.js: boot the raw
// manifold-3d module and assert the hand-built ring mesh is a valid watertight manifold,
// has the analytic volume, and is oriented outward.
let wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const boxRings = [{ polygon: SQ, z: 0 }, { polygon: SQ, z: 10 }];

test("loft of two identical square rings is a valid watertight manifold (ofMesh does not throw)", () => {
  expect(() => loftMesh(wasm, boxRings)).not.toThrow();
});

test("loft of identical square rings has the analytic box volume", () => {
  expect(loftMesh(wasm, boxRings).volume()).toBeCloseTo(10 * 10 * 10, 5); // 10×10 square × height 10
});

test("oriented outward: subtracting the loft from an enclosing blank REMOVES material", () => {
  const blank = wasm.Manifold.cube([40, 40, 40], true).translate([0, 0, 5]); // encloses the loft
  const cut = blank.subtract(loftMesh(wasm, boxRings));
  expect(cut.volume()).toBeLessThan(blank.volume());
});

test("a tapered loft (top ring scaled 0.5) is a frustum — volume between the two prisms", () => {
  const frustum = loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: SQ, z: 10, scale: 0.5 }]);
  // square frustum: base 10×10, top 5×5, h=10 → (h/3)(A1+A2+√(A1A2)) = (10/3)(100+25+50)
  expect(frustum.volume()).toBeCloseTo((10 / 3) * (100 + 25 + 50), 5);
});

// CW winding and descending z both invert the hand-mesh; loft must self-correct so the
// result is a positive-volume, boolean-safe solid regardless of authoring order.
const CW = [[-5, -5], [-5, 5], [5, 5], [5, -5]]; // same square, clockwise

test("CW-wound rings still produce a positive-volume (outward) solid", () => {
  const solid = loftMesh(wasm, [{ polygon: CW, z: 0 }, { polygon: CW, z: 10 }]);
  expect(solid.volume()).toBeCloseTo(1000, 5);
});

test("descending-z rings still produce a positive-volume (outward) solid", () => {
  const solid = loftMesh(wasm, [{ polygon: SQ, z: 10 }, { polygon: SQ, z: 0 }]);
  expect(solid.volume()).toBeCloseTo(1000, 5);
});

test("mixed CW point ring + all-line contour ring lofts to the full box volume, not zero (finding 1 fix)", () => {
  // Pre-fix: the point ring kept its legacy CW winding while the contour ring was
  // CCW-normalized by bakeContour, so the side walls had opposite windings and canceled
  // to an empty solid (volume ≈ 0) instead of erroring or self-correcting.
  const contourSQ = pointsToContour(SQ); // all-line contour, same square — contour-sourced (r.pts === null)
  const v = loftMesh(wasm, [{ polygon: CW, z: 0 }, { polygon: contourSQ, z: 10 }]).volume();
  expect(v).toBeCloseTo(1000, 5); // 10×10 square × height 10
});

test("self-corrected loft is boolean-safe: subtracting from a blank REMOVES material", () => {
  const blank = wasm.Manifold.cube([40, 40, 40], true).translate([0, 0, 5]);
  const cut = blank.subtract(loftMesh(wasm, [{ polygon: CW, z: 0 }, { polygon: CW, z: 10 }]));
  expect(cut.volume()).toBeLessThan(blank.volume());
});

test("closed:true builds a capless loop (topological loop: genus 1 vs the open loft's genus 0)", () => {
  const rings = [];
  for (let i = 0; i < 6; i++) rings.push({ polygon: regularPolygon(6, 8 + i), z: i * 3 });
  expect(() => loftMesh(wasm, rings, { closed: true })).not.toThrow();
  expect(loftMesh(wasm, rings, { closed: false }).genus()).toBe(0); // capped ends → solid ball topology
  expect(loftMesh(wasm, rings, { closed: true }).genus()).toBe(1);  // last ring stitched to first → loop
});

// L-hexagon: non-convex, area 4·1 + 1·2 = 6. Centroid-fan caps would self-overlap here;
// the triangulated caps must produce the exact prism volume.
const L = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];

test("non-convex (L-shaped) rings loft to the exact prism volume (triangulated caps)", () => {
  const v = loftMesh(wasm, [{ polygon: L, z: 0 }, { polygon: L, z: 10 }]).volume();
  expect(v).toBeCloseTo(60, 5);
});

test("CW non-convex rings still self-correct to a positive-volume solid", () => {
  const LCW = [...L].reverse();
  expect(loftMesh(wasm, [{ polygon: LCW, z: 0 }, { polygon: LCW, z: 10 }]).volume()).toBeCloseTo(60, 5);
});

test("an arc-contour ring (roundedProfile) now lofts — volume ≈ rounded-square prism", () => {
  const rsq = roundedProfile(SQ, 2);
  const v = loftMesh(wasm, [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10 }]).volume();
  // exact area 10² − (4−π)·2² = 96.5663…; inscribed-facet deficit at LOFT_SEGS is < 0.03/ring
  expect(v).toBeGreaterThan(963);
  expect(v).toBeLessThan(965.7);
});

test("unequal-N point rings auto-resample instead of throwing (square → octagon)", () => {
  const oct = regularPolygon(8, 5);
  expect(() => loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: oct, z: 10 }])).not.toThrow();
  const v = loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: oct, z: 10 }]).volume();
  expect(v).toBeGreaterThan(0);
  expect(loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: oct, z: 10 }]).genus()).toBe(0);
});

test("square → circle morph is watertight, genus 0, volume between the two prisms", () => {
  const rings = [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }];
  const m = loftMesh(wasm, rings);
  expect(m.genus()).toBe(0);
  const v = m.volume();
  expect(v).toBeGreaterThan(Math.PI * 16 * 10 * 0.9); // > cylinder-ish lower bound
  expect(v).toBeLessThan(100 * 10);                   // < square prism
});

test("resample-mode Manifold volume tracks the shared-ring prismatoid (parity anchor)", () => {
  const rings = [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }];
  const { resolved } = resolveLoftRings(rings);
  const sh = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  const mid = resolved[0].pts2d.map((p, i) => [(p[0] + resolved[1].pts2d[i][0]) / 2, (p[1] + resolved[1].pts2d[i][1]) / 2]);
  const expected = (10 / 6) * (sh(resolved[0].pts2d) + 4 * sh(mid) + sh(resolved[1].pts2d));
  const v = loftMesh(wasm, rings).volume();
  expect(Math.abs(v - expected) / expected).toBeLessThan(0.005);
});
