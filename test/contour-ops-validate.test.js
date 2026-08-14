import { test, expect } from "vitest";
import { validateProfile } from "../src/framework/geometry/contour-ops.js";

test("a clean region validates ok", () => {
  const region = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  expect(validateProfile(region)).toEqual({ ok: true, issues: [] });
});

test("a bowtie self-intersects", () => {
  const bow = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const r = validateProfile(bow);
  expect(r.ok).toBe(false);
  expect(r.issues[0].type).toBe("self-intersection");
  expect(r.issues[0].point[0]).toBeCloseTo(5, 6);
});

test("a CW outer is a winding issue (when passed as an explicit region)", () => {
  const r = validateProfile({ outer: [[0, 0], [0, 10], [10, 10], [10, 0]], holes: [] });
  expect(r.issues.some((i) => i.type === "winding")).toBe(true);
});

test("a hole outside its outer is a nesting issue", () => {
  const r = validateProfile({ outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[20, 20], [22, 20], [22, 22], [20, 22]]] });
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});

test("zero-length segments are degenerate", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  const r = validateProfile(ct);
  expect(r.issues.some((i) => i.type === "degenerate" && i.segmentIndex === 1)).toBe(true);
});

test("two overlapping outers across regions are a nesting issue", () => {
  const r = validateProfile([
    { outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] },
    { outer: [[5, 5], [15, 5], [15, 15], [5, 15]], holes: [] },
  ]);
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});
