import { expect, test } from "vitest";
import {
  latheRoundedRect, torusContour, roundedRectRing, roundedBoxRings, EPS_R,
  roundedRectContour,
} from "../src/framework/geometry/rounded-solids.js";

const SQ = Math.SQRT1_2;

test("latheRoundedRect rounds the two outer corners with exact tangents", () => {
  const c = latheRoundedRect(8, 20, 3, 1.5);
  expect(c.start).toEqual([0, 0]);
  expect(c.segments).toEqual([
    { to: [6.5, 0] },
    { to: [8, 1.5], via: [8 - 1.5 * (1 - SQ), 1.5 * (1 - SQ)] },
    { to: [8, 17] },
    { to: [5, 20], via: [8 - 3 * (1 - SQ), 20 - 3 * (1 - SQ)] },
    { to: [0, 20] },
  ]);
});

test("latheRoundedRect capsule: full-radius corners keep their FULL radius (no roundedProfile-style clamp)", () => {
  const c = latheRoundedRect(5, 10, 5, 5);
  // bottom edge is fully consumed: no zero-length lineTo, arc starts at [0,0].
  // Vias written with the implementation's own expression form (r − R(1−cos45))
  // so the comparison is bit-exact.
  expect(c.segments).toEqual([
    { to: [5, 5], via: [5 - 5 * (1 - SQ), 5 * (1 - SQ)] },
    { to: [0, 10], via: [5 - 5 * (1 - SQ), 10 - 5 * (1 - SQ)] },
  ]);
});

test("latheRoundedRect with round 0 is the plain rectangle", () => {
  expect(latheRoundedRect(6, 9, 0, 0).segments).toEqual([
    { to: [6, 0] }, { to: [6, 9] }, { to: [0, 9] },
  ]);
});

test("torusContour is four quarter arcs closing exactly on its start", () => {
  const c = torusContour(10, 3);
  expect(c.start).toEqual([13, 0]);
  expect(c.segments).toHaveLength(4);
  for (const s of c.segments) expect(s.via).toBeDefined();
  expect(c.segments[3].to).toEqual(c.start);
  // each via sits on the tube circle
  for (const s of c.segments)
    expect(Math.hypot(s.via[0] - 10, s.via[1])).toBeCloseTo(3, 12);
});

test("roundedRectRing: 4·(A+1) CCW points, corner centers at ±(hw−rc), ±(hd−rc)", () => {
  const A = 4;
  const ring = roundedRectRing(10, 7, 2, A);
  expect(ring).toHaveLength(4 * (A + 1));
  expect(ring[0]).toEqual([10, 5]);          // corner (+,+) arc starts at angle 0
  expect(ring[A][0]).toBeCloseTo(8, 12);     // ends at angle 90: (hw−rc, hd)
  expect(ring[A][1]).toBeCloseTo(7, 12);
  // CCW: shoelace area positive
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  expect(area).toBeGreaterThan(0);
});

test("roundedRectRing clamps a sharp (rc ≤ 0) corner to EPS_R, never coincident points", () => {
  const ring = roundedRectRing(10, 7, -2, 3);
  const uniq = new Set(ring.map((p) => p.join(",")));
  expect(uniq.size).toBe(ring.length);
  // stays within the rect
  for (const [x, y] of ring) { expect(Math.abs(x)).toBeLessThanOrEqual(10 + EPS_R); expect(Math.abs(y)).toBeLessThanOrEqual(7 + EPS_R); }
});

test("roundedBoxRings: ascending z, constant N, correct zone endpoints", () => {
  const rings = roundedBoxRings([24, 16, 12], { side: 4, top: 2, bottom: 1 }, 32);
  const N = rings[0].polygon.length;
  for (const r of rings) expect(r.polygon.length).toBe(N);
  for (let i = 1; i < rings.length; i++) expect(rings[i].z).toBeGreaterThan(rings[i - 1].z);
  expect(rings[0].z).toBe(0);
  expect(rings[rings.length - 1].z).toBe(12);
  // base ring: δ = bottom = 1 → half-extent 11, corner radius side−δ = 3 → max |x| = 11
  const xs = rings[0].polygon.map((p) => p[0]);
  expect(Math.max(...xs)).toBeCloseTo(11, 9);
  // top ring: δ = top = 2 → half-extent 10
  const xt = rings[rings.length - 1].polygon.map((p) => p[0]);
  expect(Math.max(...xt)).toBeCloseTo(10, 9);
});

// Deliberately exercises the builder directly with top + bottom = h at side > 0 —
// the public roundedBox op's validation now rejects this exact combination
// (round.top + round.bottom must be strictly < h when side > 0); this test
// pins the lower-level builder's own station-dedup behavior, not a reachable op call.
test("roundedBoxRings dedupes the shared station when top + bottom = h", () => {
  const rings = roundedBoxRings([20, 20, 10], { side: 5, top: 5, bottom: 5 }, 32);
  for (let i = 1; i < rings.length; i++) expect(rings[i].z).toBeGreaterThan(rings[i - 1].z);
});

test("roundedBoxRings with round 0 everywhere is just two rect rings", () => {
  const rings = roundedBoxRings([20, 12, 8], { side: 0, top: 0, bottom: 0 }, 32);
  expect(rings).toHaveLength(2);
  expect(rings[0].z).toBe(0);
  expect(rings[1].z).toBe(8);
});

test("roundedRectContour: normal case has 4 lines + 4 arcs, closes on start, vias sit at corner radius r", () => {
  const r = 2;
  const c = roundedRectContour(20, 12, r);
  expect(c.segments).toHaveLength(8);
  const arcs = c.segments.filter((s) => s.via);
  const lines = c.segments.filter((s) => !s.via);
  expect(arcs).toHaveLength(4);
  expect(lines).toHaveLength(4);
  expect(c.segments[c.segments.length - 1].to).toEqual(c.start);
  const hw = 10, hd = 6;
  const centers = [[hw - r, hd - r], [-(hw - r), hd - r], [-(hw - r), -(hd - r)], [hw - r, -(hd - r)]];
  arcs.forEach((s, i) => {
    const [cx, cy] = centers[i];
    expect(Math.hypot(s.via[0] - cx, s.via[1] - cy)).toBeCloseTo(r, 12);
  });
});

test("roundedRectContour: stadium boundary (2·r = min(w, d)) has no zero-length segments", () => {
  const c = roundedRectContour(20, 12, 6);
  let cur = c.start;
  for (const s of c.segments) {
    expect(Math.hypot(s.to[0] - cur[0], s.to[1] - cur[1])).toBeGreaterThan(1e-9);
    cur = s.to;
  }
  expect(c.segments.filter((s) => s.via)).toHaveLength(4);
});

test("roundedRectContour: square-stadium (2·r = w = d) is a circle of 4 arcs only, closing on start", () => {
  const c = roundedRectContour(12, 12, 6);
  expect(c.segments).toHaveLength(4);
  for (const s of c.segments) expect(s.via).toBeDefined();
  expect(c.segments[c.segments.length - 1].to).toEqual(c.start);
});
