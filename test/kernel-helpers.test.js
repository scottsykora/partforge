import { expect, test } from "vitest";
import { piePolygon, hexPolygon, filletPolygon, regularPolygon } from "../src/framework/geometry/polygon.js";

// shoelace area of a 2-D polygon
const area = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
};

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

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("filletPolygon replaces each corner with a segs+1-point arc", () => {
  const out = filletPolygon(SQ, 2, { segs: 8 });
  expect(out).toHaveLength(4 * (8 + 1)); // 4 corners × (segs+1) arc points
});

test("filletPolygon rounds corners so the area shrinks (but stays positive)", () => {
  const out = filletPolygon(SQ, 2);
  expect(area(out)).toBeLessThan(area(SQ)); // corner material removed
  expect(area(out)).toBeGreaterThan(0);
  // every point stays within the original square (corners only get cut IN)
  for (const [x, y] of out) { expect(Math.abs(x)).toBeLessThanOrEqual(5.0001); expect(Math.abs(y)).toBeLessThanOrEqual(5.0001); }
});

test("filletPolygon clamps an over-large radius per corner instead of throwing", () => {
  const out = filletPolygon(SQ, 1000); // r far larger than any edge → clamp to edge midpoints
  expect(area(out)).toBeGreaterThan(0);
  expect(area(out)).toBeLessThan(area(SQ));
  for (const [x, y] of out) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
});

test("filletPolygon throws on a degenerate polygon or non-positive radius", () => {
  expect(() => filletPolygon([[0, 0], [1, 0]], 1)).toThrow(/at least 3/);
  expect(() => filletPolygon(SQ, 0)).toThrow(/r must be/);
  expect(() => filletPolygon(SQ, -1)).toThrow(/r must be/);
});

test("filletPolygon output is a plain [[x,y],…] list (usable by prism/extrude/loft)", () => {
  const out = filletPolygon(regularPolygon(6, 10), 1.5);
  expect(Array.isArray(out)).toBe(true);
  for (const pt of out) { expect(pt).toHaveLength(2); expect(typeof pt[0]).toBe("number"); }
});
