import { test, expect } from "vitest";
import { translateProfile, rotateProfile, scaleProfile, mirrorProfile, contourIsCCW }
  from "../src/framework/geometry/contour-ops.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("translate is exact on every segment type and preserves container kind", () => {
  const moved = translateProfile(sq, [5, -2]);
  expect(moved).toEqual([[5, -2], [15, -2], [15, 8], [5, 8]]);
  const ct = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 3] }, { to: [0, 0], c1: [8, -4], c2: [2, -4] }] };
  const m = translateProfile(ct, [1, 1]);
  expect(m.segments[0].via).toEqual([6, 4]);
  expect(m.segments[1].c1).toEqual([9, -3]);
});

test("rotate 90° about the origin maps (10,0) → (0,10)", () => {
  const r = rotateProfile({ start: [10, 0], segments: [{ to: [20, 0] }, { to: [10, 0] }] }, 90);
  expect(r.start[0]).toBeCloseTo(0, 9);
  expect(r.start[1]).toBeCloseTo(10, 9);
});

test("uniform scale keeps arcs as arcs; non-uniform converts them to cubics", () => {
  const ct = { start: [10, 0], segments: [{ to: [-10, 0], via: [0, 10] }, { to: [10, 0] }] };
  expect(scaleProfile(ct, 2).segments[0].via).toBeDefined();
  const stretched = scaleProfile(ct, [2, 1]);
  expect(stretched.segments.some((s) => s.c1)).toBe(true);
  expect(stretched.segments.every((s) => !s.via)).toBe(true);
});

test("mirror re-normalizes region winding (outer stays CCW)", () => {
  const region = { outer: sq, holes: [[[2, 2], [2, 8], [8, 8], [8, 2]]] };
  const m = mirrorProfile(region, "y");
  expect(contourIsCCW(m.outer)).toBe(true);
  expect(contourIsCCW(m.holes[0])).toBe(false);
});

test("mirror on a bare point list preserves its orientation sense and container kind", () => {
  const m = mirrorProfile(sq, "y");
  expect(Array.isArray(m) && Array.isArray(m[0])).toBe(true);
  // sq is CCW; the mirrored result must still traverse CCW
  const ct = { start: m[0], segments: [...m.slice(1).map((p) => ({ to: p })), { to: m[0] }] };
  expect(contourIsCCW(ct)).toBe(true);
});
