import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test("union area of two overlapping unit-spaced squares", () => {
  const s = k.shape2d(SQ(0, 0, 10)).union(SQ(5, 5, 10));   // 100 + 100 − 25 overlap
  expect(s.area()).toBeCloseTo(175, 4);
});

test("cut subtracts overlap area", () => {
  const s = k.shape2d(SQ(0, 0, 10)).cut(SQ(5, 5, 10));      // 100 − 25
  expect(s.area()).toBeCloseTo(75, 4);
});

test("intersect keeps the overlap", () => {
  const s = k.shape2d(SQ(0, 0, 10)).intersect(SQ(5, 5, 10));// 25
  expect(s.area()).toBeCloseTo(25, 4);
});

test("subtract that punches a hole extrudes to genus 1", () => {
  const plate = k.shape2d(SQ(0, 0, 20)).cut(SQ(7, 7, 6));   // hole strictly inside
  expect(k.extrude({ profile: plate, h: 3 }).genus()).toBe(1);
});

test("toRegions materializes; simple unwraps the single region", () => {
  const s = k.shape2d(SQ(0, 0, 20)).cut(SQ(7, 7, 6));       // hole strictly inside → ring with a hole, 1 region
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  expect(s.simple().holes).toHaveLength(1);
});

test("boolean is content-hash cached (hit on repeat)", () => {
  k.beginSubPart("t");
  k.resetCacheStats();
  const one = () => k.shape2d(SQ(0, 0, 10)).cut(SQ(5, 5, 10)).area();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});

test("curve operand: cut a circleProfile hole from a square", () => {
  const s = k.shape2d(SQ(-10, -10, 20)).cut(circleProfile(5));
  expect(s.area()).toBeCloseTo(400 - Math.PI * 25, 0);   // faceted → loose tol
});

test("cutAll subtracts several tools; empty list is a safe identity (no double-free)", () => {
  const s = k.shape2d(SQ(0, 0, 20)).cutAll([SQ(2, 2, 4), SQ(12, 12, 4)]);
  expect(s.area()).toBeCloseTo(400 - 16 - 16, 3);
  const id = k.shape2d(SQ(0, 0, 10)).cutAll([]);   // must survive cleanup()/eviction unscathed
  expect(id.area()).toBeCloseTo(100, 4);
  k.cleanup();                                       // would throw "already deleted" on the aliasing bug
});

test("revolve of a Shape2D lathe profile builds a sane solid", () => {
  const prof = k.shape2d([[2, 0], [6, 0], [6, 8], [2, 8]]);   // rectangle in +X (r,z)
  const v = k.revolve({ profile: prof, degrees: 360 }).volume();
  expect(v).toBeCloseTo(Math.PI * (6 * 6 - 2 * 2) * 8, -1);   // annular ring volume
});
