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

test("intersect of disjoint shapes is empty; simple() throws", () => {
  const s = k.shape2d([[0,0],[1,0],[1,1],[0,1]]).intersect([[10,10],[11,10],[11,11],[10,11]]);
  expect(s.area()).toBeCloseTo(0, 6);
  expect(() => s.simple()).toThrow("Shape2D.simple");
});

test("shape2d rejects an invalid profile", () => {
  expect(() => k.shape2d([[0, 0], [1, 0]])).toThrow(/≥3 points|profile/);
});

test("offset grows a square by delta on every side (round corners add quarter-circles)", () => {
  const s = k.shape2d(SQ(0, 0, 10)).offset(1);           // 10x10 + perimeter*1 + 4 quarter-circles
  expect(s.area()).toBeCloseTo(100 + 40 + Math.PI, 1);   // 100 + 4*10*1 + π*1²
});

test("negative offset insets a square to 8x8", () => {
  expect(k.shape2d(SQ(0, 0, 10)).offset(-1).area()).toBeCloseTo(64, 1); // inset convex corners stay sharp → 8x8
});

test("corner styles differ at convex right angles (sharp > round > chamfer)", () => {
  // chamfer is a true 45° bevel (a single-chord round join): at a right-angle
  // corner it cuts a triangle of area d²/2 per corner, so total = 100 + 40 + 4·0.5
  // = 142 — smaller than round, and identical to OCCT's `bevel` (verified 142.0000
  // on both backends).
  const sharp = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "sharp" }).area();
  const round = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "round" }).area();
  const cham  = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "chamfer" }).area();
  expect(sharp).toBeGreaterThan(round);
  expect(round).toBeGreaterThan(cham);
  expect(cham).toBeCloseTo(142, 4);       // exact 45° bevel — matches OCCT
});

test("acute (<90°) corners: chamfer stays a valid bevel (2-facet approximation)", () => {
  // At a 60° interior corner Clipper2 emits 2 chords (ceil(120°turn/90°)), so Manifold's
  // chamfer bulges ~0.4% beyond OCCT's single-chord bevel (Manifold ≈235.46 vs OCCT ≈234.50).
  // It's still a bevel — smaller than round, larger than nothing — just not float-exact to OCCT.
  const tri = [[-10, -5.7735], [10, -5.7735], [0, 11.547]];   // ~equilateral, side 20
  const cham = k.shape2d(tri).offset(1, { corners: "chamfer" }).area();
  const round = k.shape2d(tri).offset(1, { corners: "round" }).area();
  const sharp = k.shape2d(tri).offset(1, { corners: "sharp" }).area();
  expect(cham).toBeLessThan(round);
  expect(round).toBeLessThan(sharp);
});

test("offset of a circle scales the radius", () => {
  const a = k.shape2d(circleProfile(5)).offset(1).area();
  expect(a).toBeCloseTo(Math.PI * 36, 0);                // π(5+1)²  (faceted → loose)
});

test("collapse throws immediately", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(-6)).toThrow("Shape2D.offset: offset collapses the shape");
});

test("offset validates delta and corners", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "bevel" }))
    .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
});

test("offset is content-hash cached (hit on repeat)", () => {
  k.beginSubPart("off"); k.resetCacheStats();
  const one = () => k.shape2d(SQ(0, 0, 10)).offset(1).area();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});
