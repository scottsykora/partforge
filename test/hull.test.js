import { describe, it, expect } from "vitest";
import { convexHull, hullPoints } from "../src/framework/geometry/hull.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

describe("convexHull", () => {
  it("wraps a square and drops interior + edge points", () => {
    const pts = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 0]]; // interior + on-edge
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);                              // 4 corners only
    // CCW, positive area = 100
    const area = hull.reduce((a, p, i) => { const q = hull[(i + 1) % hull.length]; return a + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
    expect(area).toBeCloseTo(100, 6);
  });

  it("wraps a concave 'L' point set to its convex outline", () => {
    const L = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    const hull = convexHull(L);
    // convex hull of the L is the triangle-ish wrap: corners [0,0],[20,0],[20,5],[5,20],[0,20]
    expect(hull.length).toBe(5);
  });

  it("throws on fewer than 3 points", () => {
    expect(() => convexHull([[0, 0], [1, 1]])).toThrow(/hull/);
  });

  it("throws on collinear points (no 2-D region)", () => {
    expect(() => convexHull([[0, 0], [1, 1], [2, 2], [3, 3]])).toThrow(/collinear|hull/);
  });
});

describe("hullPoints", () => {
  it("passes a point list through unchanged", () => {
    const pts = [[0, 0], [1, 0], [1, 1]];
    expect(hullPoints(pts)).toEqual(pts);
  });

  it("tessellates a curve contour to points", () => {
    const arc = pathProfile([0, 0]).cubicTo([10, 0], [3, 5], [7, 5]).close();
    const pts = hullPoints(arc);
    expect(pts.length).toBeGreaterThan(2);
    expect(pts.every((p) => Array.isArray(p) && p.length === 2)).toBe(true);
  });

  it("samples a Shape2D by its region rings", () => {
    const fakeShape = { _shape2d: true, toRegions: () => [{ outer: [[0, 0], [10, 0], [10, 10]], holes: [] }] };
    expect(hullPoints(fakeShape)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("throws on an unsupported input", () => {
    expect(() => hullPoints(42)).toThrow(/hull/);
    expect(() => hullPoints({ nope: true })).toThrow(/hull/);
  });
});
