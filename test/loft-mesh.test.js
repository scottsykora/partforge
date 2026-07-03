import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { loftMesh } from "../src/framework/geometry/loft.js";
import { regularPolygon } from "../src/framework/geometry/polygon.js";

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

test("closed:true builds a capless loop (topological loop: genus 1 vs the open loft's genus 0)", () => {
  const rings = [];
  for (let i = 0; i < 6; i++) rings.push({ polygon: regularPolygon(6, 8 + i), z: i * 3 });
  expect(() => loftMesh(wasm, rings, { closed: true })).not.toThrow();
  expect(loftMesh(wasm, rings, { closed: false }).genus()).toBe(0); // capped ends → solid ball topology
  expect(loftMesh(wasm, rings, { closed: true }).genus()).toBe(1);  // last ring stitched to first → loop
});
