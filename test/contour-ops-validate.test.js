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
  // Completeness: the duplicate point must NOT also register as a self-intersection — the
  // real edges on either side of it are still adjacent (they touch at the shared vertex,
  // not a genuine crossing), so exactly the one degenerate issue should come back.
  expect(r.issues).toEqual([
    { type: "degenerate", contourIndex: 0, segmentIndex: 1, message: expect.any(String) },
  ]);
});

test("two overlapping outers across regions are a nesting issue", () => {
  const r = validateProfile([
    { outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] },
    { outer: [[5, 5], [15, 5], [15, 15], [5, 15]], holes: [] },
  ]);
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});

test("a self-intersecting cubic is flagged with the owning segment's index", () => {
  // A single cubic that leaves and returns to the same neighborhood, its control points
  // flared out asymmetrically enough that the curve crosses itself mid-span (not just at
  // an endpoint) — closed off with a line back to the start.
  const ct = { start: [0, 0], segments: [
    { to: [10, 0], c1: [20, 20], c2: [-10, 20] },
    { to: [0, 0] },
  ] };
  const r = validateProfile(ct);
  expect(r.ok).toBe(false);
  const hit = r.issues.find((i) => i.type === "self-intersection");
  expect(hit).toBeTruthy();
  expect(hit.contourIndex).toBe(0);
  expect(hit.segmentIndex).toBe(0);          // the cubic, not the closing line
  expect(hit.point[0]).toBeCloseTo(5, 6);
  expect(hit.point[1]).toBeCloseTo(6.131386861313868, 6);
  expect(hit.message).not.toMatch(/or crosses contour/);   // same-contour crossing: no cross-contour suffix
});

test("a clean cubic loop validates ok", () => {
  // Bulges out from the origin and back to it (large control net, zero chord — real shape,
  // not degenerate) without crossing itself.
  const ct = { start: [0, 0], segments: [{ to: [0, 0], c1: [10, 10], c2: [10, -10] }] };
  expect(validateProfile(ct)).toEqual({ ok: true, issues: [] });
});

test("a clean arc-based contour validates ok", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 5] }, { to: [0, 0] }] };
  expect(validateProfile(ct)).toEqual({ ok: true, issues: [] });
});
