// Winding resolver — pure unit tests, no WASM.
import { describe, expect, test } from "vitest";
import { ringCrossings } from "../src/framework/geometry/paper-bridge.js";
import { trimSegment } from "../src/framework/geometry/contour-ops.js";
import { _mergeCrossings, CLUSTER_TOL } from "../src/framework/geometry/contour-winding.js";

const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
const close = (a, b, tol = 1e-6) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(tol);

describe("trimSegment is exported and preserves segment kind", () => {
  test("an arc trimmed stays an arc", () => {
    // quarter circle r=5 CCW from (5,0) to (0,5)
    const r = trimSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, 0, 0.5);
    expect(r.seg.via).toBeDefined();
    expect(r.seg.c1).toBeUndefined();
    close(r.from, [5, 0]);
    close(r.seg.to, [5 / Math.SQRT2, 5 / Math.SQRT2], 1e-9);   // halfway round the sweep
  });
  test("a cubic trimmed stays a cubic, a line stays a line", () => {
    expect(trimSegment([0, 0], { c1: [1, 2], c2: [3, 2], to: [4, 0] }, 0.25, 0.75).seg.c1).toBeDefined();
    const L = trimSegment([0, 0], { to: [10, 0] }, 0.2, 0.8);
    expect(L.seg.c1).toBeUndefined(); expect(L.seg.via).toBeUndefined();
    close(L.from, [2, 0]); close(L.seg.to, [8, 0]);
  });
});

describe("ringCrossings", () => {
  test("two overlapping squares cross at two points, reported on both rings", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const xs = ringCrossings([a, b]);
    // each crossing is reported once per ring involved → 2 crossings × 2 rings
    expect(xs.length).toBe(4);
    expect(new Set(xs.map((x) => x.ring))).toEqual(new Set([0, 1]));
    const pts = xs.map((x) => x.point);
    expect(pts.some((p) => Math.hypot(p[0] - 10, p[1] - 5) < 1e-6)).toBe(true);
    expect(pts.some((p) => Math.hypot(p[0] - 5, p[1] - 10) < 1e-6)).toBe(true);
  });
  test("a bowtie reports its self-intersection", () => {
    const xs = ringCrossings([ring([[0, 0], [10, 10], [10, 0], [0, 10]])]);
    expect(xs.length).toBeGreaterThanOrEqual(2);   // once per participating segment
    for (const x of xs) close(x.point, [5, 5], 1e-6);
  });
  test("disjoint rings report nothing", () => {
    expect(ringCrossings([ring([[0, 0], [1, 0], [1, 1], [0, 1]]),
                          ring([[5, 5], [6, 5], [6, 6], [5, 6]])])).toEqual([]);
  });
  test("every crossing carries a valid IR segment index and t in [0,1]", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    for (const x of ringCrossings([a, b])) {
      expect(Number.isInteger(x.seg)).toBe(true);
      expect(x.seg).toBeGreaterThanOrEqual(0);
      expect(x.t).toBeGreaterThanOrEqual(0);
      expect(x.t).toBeLessThanOrEqual(1);
    }
  });
});

describe("crossing cluster merge", () => {
  test("near-coincident crossings collapse to one shared vertex", () => {
    // the real measured cluster from a glyph offset: three crossings within ~2e-3
    const xs = [
      { ring: 0, seg: 6, t: 0.15, point: [0.9223, -0.9347] },
      { ring: 0, seg: 6, t: 0.27, point: [0.9224, -0.9337] },
      { ring: 0, seg: 6, t: 0.45, point: [0.9222, -0.9343] },
      { ring: 0, seg: 20, t: 0.5, point: [5.0, 5.0] },
    ];
    const { crossings, pool } = _mergeCrossings(xs, 5e-3);
    expect(pool.length).toBe(2);                                  // cluster + the far one
    expect(crossings[0].vertex).toBe(crossings[1].vertex);
    expect(crossings[1].vertex).toBe(crossings[2].vertex);
    expect(crossings[3].vertex).not.toBe(crossings[0].vertex);
  });
  test("distinct crossings keep distinct vertices", () => {
    const xs = [{ ring: 0, seg: 0, t: 0.5, point: [0, 0] }, { ring: 0, seg: 2, t: 0.5, point: [10, 10] }];
    const { pool } = _mergeCrossings(xs, 5e-3);
    expect(pool.length).toBe(2);
  });
  test("the pooled vertex position is the cluster centroid", () => {
    const xs = [{ ring: 0, seg: 0, t: 0.1, point: [0, 0] }, { ring: 0, seg: 1, t: 0.1, point: [0.002, 0] }];
    const { pool } = _mergeCrossings(xs, 5e-3);
    expect(pool.length).toBe(1);
    expect(pool[0][0]).toBeCloseTo(0.001, 9);
  });
  test("CLUSTER_TOL is derived, not a bare magic number, and sits above OFFSET_TOL", () => {
    expect(CLUSTER_TOL).toBeGreaterThan(1e-3);   // must exceed the cubic-offset tolerance
    expect(CLUSTER_TOL).toBeLessThan(0.05);      // must stay well under any real feature
  });
});
