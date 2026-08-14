import { test, expect } from "vitest";
import { profileLength, profilePointAt, profileTangentAt, profileNearestPoint,
  profileBounds, profileArea, profileContains } from "../src/framework/geometry/contour-ops.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("length / pointAt / tangentAt on a square perimeter", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  expect(profileLength(ct)).toBeCloseTo(40, 9);
  const p = profilePointAt(ct, { t: 0.375 });          // 15mm along → (10, 5)
  expect(p[0]).toBeCloseTo(10, 9); expect(p[1]).toBeCloseTo(5, 9);
  const tan = profileTangentAt(ct, { length: 15 });
  expect(tan[0]).toBeCloseTo(0, 9); expect(tan[1]).toBeCloseTo(1, 9);
});

test("region input to arc-length queries throws", () => {
  expect(() => profilePointAt({ outer: sq, holes: [] }, { t: 0.5 })).toThrow(/single contour/);
});

test("nearestPoint maps back to our segment index through arc expansion", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [0, 4], via: [5, 6] }, { to: [0, 0] }] };
  const near = profileNearestPoint(ct, [5, 8]);
  expect(near.segmentIndex).toBe(1);                    // the arc, despite cubic expansion
  expect(near.distance).toBeGreaterThan(0);
});

test("bounds and area are curve-exact for a cubic circle", () => {
  const KAPPA = 0.5522847498307936, R = 10, k4 = R * KAPPA;
  const circle = { start: [R, 0], segments: [
    { to: [0, R], c1: [R, k4], c2: [k4, R] }, { to: [-R, 0], c1: [-k4, R], c2: [-R, k4] },
    { to: [0, -R], c1: [-R, -k4], c2: [-k4, -R] }, { to: [R, 0], c1: [k4, -R], c2: [R, -k4] },
  ] };
  const b = profileBounds(circle);
  expect(b.max[0]).toBeCloseTo(R, 3);                  // cubic-circle max deviation ~2.7e-4·R
  expect(profileArea(circle)).toBeCloseTo(Math.PI * R * R, 0);
});

test("contains respects holes", () => {
  const region = { outer: sq, holes: [[[3, 3], [7, 3], [7, 7], [3, 7]]] };
  expect(profileContains(region, [1, 1])).toBe(true);
  expect(profileContains(region, [5, 5])).toBe(false);
  expect(profileContains(region, [20, 20])).toBe(false);
});
