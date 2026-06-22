import { expect, test } from "vitest";
import { piePolygon, hexPolygon } from "../src/framework/geometry/polygon.js";

test("hexPolygon returns 6 points on radius r", () => {
  const pts = hexPolygon(3);
  expect(pts).toHaveLength(6);
  for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(3, 6);
});

test("piePolygon starts at origin and spans the arc", () => {
  const pts = piePolygon(10, 90);
  expect(pts[0]).toEqual([0, 0]);
  const last = pts[pts.length - 1];
  expect(Math.hypot(last[0], last[1])).toBeCloseTo(10, 6);
});
