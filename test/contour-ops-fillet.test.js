import { describe, test, expect } from "vitest";
import { filletProfile, chamferProfile, profileCorners } from "../src/framework/geometry/contour-ops.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("fillet all corners of a square: 4 line + 4 arc segments, area shrinks by 4·(r² − πr²/4)", () => {
  const out = filletProfile(sq, 2);
  expect(out.segments.filter((s) => s.via).length).toBe(4);
  expect(out.segments.filter((s) => !s.via && !s.c1).length).toBe(4);
  const area = ringArea(tessellateContour(out, 256));
  expect(area).toBeCloseTo(100 - 4 * (4 - Math.PI), 2);
});

test('corners:"concave" fillets only the L-shape notch', () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const out = filletProfile(L, 1.5, { corners: "concave" });
  expect(out.segments.filter((s) => s.via).length).toBe(1);
});

test("{near} picks the closest corner; {indices} takes per-corner radii", () => {
  const near = filletProfile(sq, 3, { corners: { near: [9, 9] } });
  expect(near.segments.filter((s) => s.via).length).toBe(1);
  const idx = filletProfile(sq, [1, 2], { corners: { indices: [0, 2] } });
  expect(idx.segments.filter((s) => s.via).length).toBe(2);
});

test("radius that does not fit throws with the max that would", () => {
  expect(() => filletProfile(sq, 6)).toThrow(/corner \d+ at \(.*\): r=6 does not fit; max ≈ 5/);
});

test("adjacent fillets consuming one segment throw an overlap error", () => {
  const thin = [[0, 0], [3, 0], [3, 20], [0, 20]];
  expect(() => filletProfile(thin, 2)).toThrow(/overlap on segment/);
});

test("chamfer emits straight cuts and shrinks area by 4·d²/2", () => {
  const out = chamferProfile(sq, 2);
  expect(out.segments.filter((s) => s.via || s.c1).length).toBe(0);
  expect(out.segments.length).toBe(8);
  expect(ringArea(tessellateContour(out, 8))).toBeCloseTo(100 - 4 * 2, 6);
});

test("empty selector match throws", () => {
  expect(() => filletProfile(sq, 1, { corners: "concave" })).toThrow(/no corner matched/);
});
