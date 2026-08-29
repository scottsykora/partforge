import { expect, test } from "vitest";
import { outlineStroke } from "../src/framework/geometry/stroke-outline.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const style = (o) => ({ strokeWidth: 2, linecap: "butt", linejoin: "miter", ...o });
const netArea = (regions) => regions.reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);

const openLine = pathProfile([0, 0]).lineTo([10, 0]).close();
const square = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 10]).lineTo([0, 10]).lineTo([0, 0]).close();

test("round caps: a length-10 stroke of width 2 has area 20 + pi", () => {
  expect(netArea(outlineStroke(openLine, false, style({ linecap: "round" })))).toBeCloseTo(20 + Math.PI, 1);
});

test("butt caps: the same stroke is a plain 10 x 2 rectangle", () => {
  expect(netArea(outlineStroke(openLine, false, style()))).toBeCloseTo(20, 1);
});

test("square caps add a half-width block at each end", () => {
  expect(netArea(outlineStroke(openLine, false, style({ linecap: "square" })))).toBeCloseTo(24, 1);
});

test("stroke width scales the outline linearly", () => {
  const a = netArea(outlineStroke(openLine, false, style({ strokeWidth: 1 })));
  const b = netArea(outlineStroke(openLine, false, style({ strokeWidth: 4 })));
  expect(b / a).toBeCloseTo(4, 4);
});

test("a closed square stroked width 2 with miter joins is a 144 - 64 annulus", () => {
  const regions = outlineStroke(square, true, style());
  expect(netArea(regions)).toBeCloseTo(80, 1);
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
});

test("a closed square with round joins loses the mitre corners", () => {
  const regions = outlineStroke(square, true, style({ linejoin: "round" }));
  expect(netArea(regions)).toBeCloseTo(144 - (4 - Math.PI) - 64, 1);
});

test("an L-shaped open stroke is a single region", () => {
  const L = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 10]).close();
  const regions = outlineStroke(L, false, style());
  expect(regions).toHaveLength(1);
  // Two 10x2 butt-capped arm rectangles (20 each) overlap in a 1x1 square at the
  // joint (the horizontal arm stops at x=10, so the overlap strip is 1 wide, not
  // 2) — but the miter join at this 90 degree corner extends the outline by
  // exactly one hw x hw = 1x1 square beyond the plain rectangle corner, which
  // cancels the overlap: 20 + 20 - 1 + 1 = 40. Confirmed independently by
  // shoelace on the exact mitered hexagon (0,-1),(11,-1),(11,10),(9,10),(9,1),(0,1).
  expect(netArea(regions)).toBeCloseTo(40, 1);
});

test("an open arc stroke keeps positive area and one region", () => {
  const arc = pathProfile([2, 0]).arcTo([-2, 0], [0, 2]).close();
  const regions = outlineStroke(arc, false, style({ strokeWidth: 1 }));
  expect(regions).toHaveLength(1);
  expect(netArea(regions)).toBeCloseTo(2 * Math.PI, 1);   // pi/2*(2.5^2 - 1.5^2)
});

test("a self-crossing open stroke normalizes rather than double-counting", () => {
  const cross = pathProfile([0, 0]).lineTo([10, 10]).lineTo([10, 0]).lineTo([0, 10]).close();
  const regions = outlineStroke(cross, false, style({ strokeWidth: 1 }));
  expect(regions.length).toBeGreaterThanOrEqual(1);
  expect(netArea(regions)).toBeGreaterThan(0);
  expect(netArea(regions)).toBeLessThan(4 * Math.hypot(10, 10) * 1);
});

test("a zero-width stroke throws rather than returning nothing", () => {
  expect(() => outlineStroke(openLine, false, style({ strokeWidth: 0 }))).toThrow(/svg: /);
});
