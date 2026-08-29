import { expect, test } from "vitest";
import { svgPathToContours, svgArcToCubics } from "../src/framework/geometry/svg-path.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const area = (c) => Math.abs(ringArea(tessellateContour(c, 64)));

test("absolute M/L/Z gives one closed square", () => {
  const subs = svgPathToContours("M0,0 L10,0 L10,10 L0,10 Z");
  expect(subs).toHaveLength(1);
  expect(subs[0].closed).toBe(true);
  expect(area(subs[0].contour)).toBeCloseTo(100, 6);
});

test("relative m/l/z gives the same square", () => {
  const subs = svgPathToContours("m0,0 l10,0 l0,10 l-10,0 z");
  expect(subs[0].closed).toBe(true);
  expect(area(subs[0].contour)).toBeCloseTo(100, 6);
});

test("H and V shorthands, absolute and relative", () => {
  expect(area(svgPathToContours("M0,0 H10 V10 H0 Z")[0].contour)).toBeCloseTo(100, 6);
  expect(area(svgPathToContours("M0,0 h10 v10 h-10 z")[0].contour)).toBeCloseTo(100, 6);
});

test("an implicit repeated command reuses the previous one (M then L, l then l)", () => {
  // "M0,0 10,0 10,10 0,10 Z" — the pairs after M are implicit L
  expect(area(svgPathToContours("M0,0 10,0 10,10 0,10 Z")[0].contour)).toBeCloseTo(100, 6);
});

test("C stays cubic — one segment with two handles", () => {
  const [{ contour }] = svgPathToContours("M0,0 C0,5 5,10 10,10");
  expect(contour.segments).toHaveLength(1);
  expect(contour.segments[0].c1).toEqual([0, 5]);
  expect(contour.segments[0].c2).toEqual([5, 10]);
  expect(contour.segments[0].to).toEqual([10, 10]);
});

test("S reflects the previous cubic's second handle", () => {
  const [{ contour }] = svgPathToContours("M0,0 C0,5 5,10 10,10 S20,5 20,0");
  const second = contour.segments[1];
  // reflection of c2 (5,10) about the join (10,10) is (15,10)
  expect(second.c1).toEqual([15, 10]);
  expect(second.c2).toEqual([20, 5]);
});

test("S with no preceding cubic uses the current point as its first handle", () => {
  const [{ contour }] = svgPathToContours("M0,0 S5,5 10,0");
  expect(contour.segments[0].c1).toEqual([0, 0]);
});

test("Q degree-elevates to a cubic", () => {
  const [{ contour }] = svgPathToContours("M0,0 Q5,10 10,0");
  const s = contour.segments[0];
  // elevation: c1 = p0 + 2/3(q - p0), c2 = p1 + 2/3(q - p1)
  expect(s.c1[0]).toBeCloseTo(10 / 3, 9);
  expect(s.c1[1]).toBeCloseTo(20 / 3, 9);
  expect(s.c2[0]).toBeCloseTo(10 - 10 / 3, 9);
  expect(s.c2[1]).toBeCloseTo(20 / 3, 9);
});

test("T reflects the previous quadratic's control point", () => {
  const [{ contour }] = svgPathToContours("M0,0 Q5,10 10,0 T20,0");
  expect(contour.segments).toHaveLength(2);
  // implied control is the reflection of (5,10) about (10,0) = (15,-10)
  const s = contour.segments[1];
  expect(s.c1[0]).toBeCloseTo(10 + (2 / 3) * 5, 9);
  expect(s.c1[1]).toBeCloseTo((2 / 3) * -10, 9);
});

test("A semicircle traces the true circle, not a chord", () => {
  // r=2 semicircle from (2,0) to (-2,0): area of the closed half-disc is 2π
  const [{ contour }] = svgPathToContours("M2,0 A2,2 0 0 1 -2,0 Z");
  expect(area(contour)).toBeCloseTo(2 * Math.PI, 1);
});

test("two A commands reconstruct a full circle", () => {
  const [{ contour }] = svgPathToContours("M2,0 A2,2 0 0 1 -2,0 A2,2 0 0 1 2,0 Z");
  expect(area(contour)).toBeCloseTo(Math.PI * 4, 1);
});

test("svgArcToCubics emits <=90 degree pieces with exact endpoints", () => {
  const pieces = svgArcToCubics([2, 0], 2, 2, 0, false, true, [-2, 0]);
  expect(pieces.length).toBeGreaterThanOrEqual(2);
  expect(pieces.at(-1).to[0]).toBeCloseTo(-2, 12);
  expect(pieces.at(-1).to[1]).toBeCloseTo(0, 12);
});

test("a zero radius on A degrades to a straight line", () => {
  const [{ contour }] = svgPathToContours("M0,0 A0,0 0 0 1 10,0");
  expect(contour.segments).toHaveLength(1);
  expect(contour.segments[0].c1).toBeUndefined();
});

test("multiple subpaths come back separately, each with its own closed flag", () => {
  const subs = svgPathToContours("M0,0 L10,0 L10,10 Z M20,0 L30,0 L30,10");
  expect(subs).toHaveLength(2);
  expect(subs[0].closed).toBe(true);
  expect(subs[1].closed).toBe(false);
});

test("a subpath after Z starts at the closed subpath's start point", () => {
  // m relative after z is relative to the START of the closed subpath, not its last point
  const subs = svgPathToContours("M5,5 l10,0 l0,10 z m0,0 l1,0");
  expect(subs[1].contour.start).toEqual([5, 5]);
});

test("minified arc flags parse without separators (SVGO output)", () => {
  // `a2,2 0 01-4,0` is the same semicircle as `A2,2 0 0 1 -2,0`: rot 0, then
  // the two single-character flags 0 and 1, then dx=-4 dy=0.
  const compact = svgPathToContours("M2,0 a2,2 0 01-4,0 z")[0].contour;
  const spaced = svgPathToContours("M2,0 A2,2 0 0 1 -2,0 Z")[0].contour;
  expect(area(compact)).toBeCloseTo(area(spaced), 6);
  expect(area(compact)).toBeCloseTo(2 * Math.PI, 1);
});

test("throws on an arc flag that is not 0 or 1", () => {
  expect(() => svgPathToContours("M0,0 A2,2 0 5 1 4,0")).toThrow(/arc flag/);
});

test("throws on an unknown command letter", () => {
  expect(() => svgPathToContours("M0,0 X10,10")).toThrow(/svg: /);
});

test("throws when a command is short of coordinates", () => {
  expect(() => svgPathToContours("M0,0 L10")).toThrow(/svg: /);
});

test("an empty or whitespace-only d yields no subpaths", () => {
  expect(svgPathToContours("   ")).toEqual([]);
});
