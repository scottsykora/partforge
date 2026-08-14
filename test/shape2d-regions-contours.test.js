import { expect, test } from "vitest";
import { svgPathToContours } from "../src/framework/geometry/shape2d-regions.js";

test("M/L/C parse to line + cubic segments, Z closes the ring", () => {
  const cts = svgPathToContours("M 0 0 L 10 0 C 12 2 12 8 10 10 L 0 10 Z");
  expect(cts.length).toBe(1);
  expect(cts[0].start).toEqual([0, 0]);
  expect(cts[0].segments[1]).toEqual({ to: [10, 10], c1: [12, 2], c2: [12, 8] });
});

test("A becomes cubics that stay on the circle", () => {
  const cts = svgPathToContours("M 10 0 A 10 10 0 0 1 -10 0 L 10 0 Z"); // half circle r=10
  const arcSegs = cts[0].segments.filter((s) => s.c1);
  expect(arcSegs.length).toBe(2);                         // 180° → two ≤90° pieces
  // The standard tangent-matching cubic k=(4/3)tan(dθ/4) for an exact 90° piece
  // (this codebase's own KAPPA=0.5522847498307936, e.g. test/shape2d-occt.test.js)
  // puts each control point at R*sqrt(1+k²) ≈ 1.14237*R from center — 11.4237 for
  // R=10, not the mathematically-unreachable 11.2 a tighter bound would imply.
  for (const s of arcSegs) for (const p of [s.c1, s.c2]) expect(Math.hypot(p[0], p[1])).toBeLessThan(11.5); // control net near circle
});
