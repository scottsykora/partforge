import { expect, test } from "vitest";
import {
  roundedRectPolygon, regularPolygon, ellipsePolygon,
  slotPolygon, starPolygon, ringSectorPolygon,
} from "../src/framework/geometry/polygon.js";

const signedArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const bbox = (p) => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [x, y] of p) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); }
  return { w: hi[0] - lo[0], h: hi[1] - lo[1] };
};

test("every profile is CCW (positive signed area)", () => {
  expect(signedArea(roundedRectPolygon(40, 20, 4))).toBeGreaterThan(0);
  expect(signedArea(regularPolygon(6, 10))).toBeGreaterThan(0);
  expect(signedArea(ellipsePolygon(10, 5))).toBeGreaterThan(0);
  expect(signedArea(slotPolygon(20, 4))).toBeGreaterThan(0);
  expect(signedArea(starPolygon(5, 10, 4))).toBeGreaterThan(0);
  expect(signedArea(ringSectorPolygon(5, 10, 90))).toBeGreaterThan(0);
});

test("roundedRectPolygon spans w x h and clamps the corner radius", () => {
  const b = bbox(roundedRectPolygon(40, 20, 4));
  expect(b.w).toBeCloseTo(40, 6);
  expect(b.h).toBeCloseTo(20, 6);
  // r clamped to min(w,h)/2 = 10 → a 20x20 with r=10 is a circle-ish, still 20 wide
  expect(bbox(roundedRectPolygon(20, 20, 999)).w).toBeCloseTo(20, 6);
});

test("regularPolygon returns n vertices on the circumradius", () => {
  const p = regularPolygon(6, 10);
  expect(p.length).toBe(6);
  for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
});

test("ellipsePolygon spans 2*rx by 2*ry", () => {
  const b = bbox(ellipsePolygon(10, 5));
  expect(b.w).toBeCloseTo(20, 6);
  expect(b.h).toBeCloseTo(10, 6);
});

test("slotPolygon overall length is length + 2r", () => {
  expect(bbox(slotPolygon(20, 4)).w).toBeCloseTo(28, 6);
  expect(bbox(slotPolygon(20, 4)).h).toBeCloseTo(8, 6);
});

test("starPolygon alternates outer and inner radius over 2*points vertices", () => {
  const p = starPolygon(5, 10, 4);
  expect(p.length).toBe(10);
  expect(Math.hypot(...p[0])).toBeCloseTo(10, 6);
  expect(Math.hypot(...p[1])).toBeCloseTo(4, 6);
});

test("ringSectorPolygon rejects a full 360 ring", () => {
  expect(() => ringSectorPolygon(5, 10, 360)).toThrow(/< 360/);
});
