import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { loftMesh } from "../src/framework/geometry/loft.js";
import { regularPolygon, roundedProfile } from "../src/framework/geometry/polygon.js";

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

// The arc-ring guard lives in resolveRings (shared by both backends), so one focused test
// covers loft.js:21 for OCCT and Manifold alike: an arc profile (roundedProfile) is not a
// point array and must be rejected up front — arc rings are extrude/prism-only in v1.
test("an arc profile (roundedProfile) is rejected as a loft ring with a clear error", () => {
  const arcRing = roundedProfile(SQ, 2); // true-arc contour, not a plain point array
  expect(() => loftMesh(wasm, [{ polygon: arcRing, z: 0 }, { polygon: SQ, z: 10 }]))
    .toThrow(/arc profile.*not supported/);
});
