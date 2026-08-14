import { expect, test } from "vitest";
import { booleanRegions } from "../src/framework/geometry/paper-bridge.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const R = (pts) => ({ outer: { start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) }, holes: [] });
const sq = (x0, y0, s) => R([[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]);
const ringAreaOf = (contour) => ringArea(tessellateContour(contour, 32));
const area = (regions) => regions.reduce((a, rg) => a + Math.abs(ringAreaOf(rg.outer)) - rg.holes.reduce((h, hl) => h + Math.abs(ringAreaOf(hl)), 0), 0);

test("overlapping union", () => {
  const out = booleanRegions([sq(0, 0, 10)], [sq(5, 0, 10)], "unite");
  expect(out.length).toBe(1);
  expect(area(out)).toBeCloseTo(150, 6);
});

test("COINCIDENT-EDGE union (the bracket.js case): two boxes sharing a full edge", () => {
  const out = booleanRegions([sq(0, 0, 10)], [sq(10, 0, 10)], "unite");
  expect(out.length).toBe(1);
  expect(area(out)).toBeCloseTo(200, 6);
});

test("cut that creates a hole", () => {
  const out = booleanRegions([sq(0, 0, 20)], [sq(5, 5, 10)], "subtract");
  expect(out.length).toBe(1);
  expect(out[0].holes.length).toBe(1);
  expect(area(out)).toBeCloseTo(300, 6);
});

test("cut that removes everything → empty region list", () => {
  expect(booleanRegions([sq(2, 2, 5)], [sq(0, 0, 20)], "subtract")).toEqual([]);
});

test("tangent-touch union (corner contact) stays two regions or one — but never crashes and area is conserved", () => {
  const out = booleanRegions([sq(0, 0, 10)], [sq(10, 10, 10)], "unite");
  expect(area(out)).toBeCloseTo(200, 6);
});

test("curves survive: union of a cubic-circle with a distant square keeps the cubics", () => {
  const KAPPA = 0.5522847498307936, k4 = 10 * KAPPA;
  const circle = { outer: { start: [40, 0], segments: [
    { to: [30, 10], c1: [40, k4], c2: [30 + k4, 10] }, { to: [20, 0], c1: [30 - k4, 10], c2: [20, k4] },
    { to: [30, -10], c1: [20, -k4], c2: [30 - k4, -10] }, { to: [40, 0], c1: [30 + k4, -10], c2: [40, -k4] },
  ] }, holes: [] };
  const out = booleanRegions([sq(0, 0, 10)], [circle], "unite");
  expect(out.length).toBe(2);
  expect(out.flatMap((r) => r.outer.segments).some((s) => s.c1)).toBe(true);
});

test("regions carry storage-winding invariant: outer CCW, holes CW", () => {
  const out = booleanRegions([sq(0, 0, 20)], [sq(5, 5, 10)], "subtract");
  expect(out.length).toBe(1);
  expect(ringAreaOf(out[0].outer)).toBeGreaterThan(0);
  expect(ringAreaOf(out[0].holes[0])).toBeLessThan(0);
});

test("unknown op throws", () => {
  expect(() => booleanRegions([sq(0, 0, 10)], [sq(5, 0, 10)], "xor")).toThrow(/unknown op/);
});

test("empty A, unite → returns B (cloned, not aliased)", () => {
  const b = [sq(0, 0, 10)];
  const out = booleanRegions([], b, "unite");
  expect(out).toEqual(b);
  expect(out).not.toBe(b);
  expect(out[0]).not.toBe(b[0]);
});

test("empty A, subtract/intersect → empty", () => {
  const b = [sq(0, 0, 10)];
  expect(booleanRegions([], b, "subtract")).toEqual([]);
  expect(booleanRegions([], b, "intersect")).toEqual([]);
});

test("empty B, unite/subtract → returns A (cloned)", () => {
  const a = [sq(0, 0, 10)];
  expect(booleanRegions(a, [], "unite")).toEqual(a);
  expect(booleanRegions(a, [], "subtract")).toEqual(a);
});

test("empty B, intersect → empty", () => {
  expect(booleanRegions([sq(0, 0, 10)], [], "intersect")).toEqual([]);
});
