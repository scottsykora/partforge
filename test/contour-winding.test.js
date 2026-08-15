// Winding resolver — pure unit tests, no WASM.
import { describe, expect, test } from "vitest";
import { ringCrossings } from "../src/framework/geometry/paper-bridge.js";
import { trimSegment } from "../src/framework/geometry/contour-ops.js";

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

// A crossing's `t` must be the IR segment's own parameter — the one trimSegment inverts —
// not paper's time on whichever paper curve was hit. They differ for two of the three segment
// kinds: an arc over 90 degrees is several cubics sharing one segMap entry (so paper's time is
// the time within ONE of them), and a line is a zero-handle cubic (so paper's time solves
// 3t^2-2t^3 = the linear fraction). The segMap pins curve -> segment; this pins the parameter
// alongside it.
describe("ringCrossings reports the IR parameter, not paper's curve time", () => {
  const P = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];
  // one arc of `sweep` degrees starting at angle 0, closed by a straight chord
  const arcRing = (sweep, r = 10) =>
    ({ start: P(r, 0), segments: [{ via: P(r, sweep / 2), to: P(r, sweep) }, { to: P(r, 0) }] });
  // a cutter whose first edge runs radially out from the origin at `deg`, so it meets the arc
  // at exactly that angle — the crossing's true IR t is then deg/sweep in closed form, because
  // trimSegment parameterizes an arc linearly in ANGLE (aS = a0 + dA*tStart)
  const radialCutter = (deg) => ({ start: [0, 0], segments: [{ to: P(40, deg) }, { to: P(40, deg + 12) }, { to: [0, 0] }] });
  const arcHit = (sweep, deg) => ringCrossings([arcRing(sweep), radialCutter(deg)])
    .find((x) => x.ring === 0 && x.seg === 0);

  test("180 degree arc (two cubics, k=2): the reported t is the analytic angular fraction", () => {
    expect(arcHit(180, 135).t).toBeCloseTo(135 / 180, 9);
  });
  test("300 degree arc (four cubics, k=4)", () => {
    expect(arcHit(300, 250).t).toBeCloseTo(250 / 300, 9);
  });
  test("90 degree arc (k=1): a Bezier time is not an angle even within one piece", () => {
    // k=1 is exactly where a piece-index correction would have no effect at all; the error is
    // small (~4.5e-3) but it is the commonest arc this engine emits — a round join of 90 or less
    expect(arcHit(90, 67.5).t).toBeCloseTo(67.5 / 90, 9);
  });
  test("a line reports the linear fraction, not the zero-handle cubic's time", () => {
    // paper reports 0.560292 for the point 59% along; harmless downstream only because
    // _splitRings overwrites a line piece's endpoints with pooled vertices
    const box = ring([[0, 0], [10, 0], [10, 5], [0, 5]]);
    const bar = ring([[5.9, -1], [6.1, -1], [6.1, 1], [5.9, 1]]);
    const ts = ringCrossings([box, bar]).filter((x) => x.ring === 0 && x.seg === 0).map((x) => x.t).sort();
    expect(ts[0]).toBeCloseTo(0.59, 9);
    expect(ts[1]).toBeCloseTo(0.61, 9);
  });

  test("round trip: trimSegment at the reported t lands on the reported point, every kind", () => {
    // the contract _splitRings actually depends on, stated directly. Lines and cubics are exact;
    // an arc is good to the cubic approximation's own radial error (~2.7e-4*r), since the point
    // paper reports lies on that approximation rather than on the true circle.
    const check = (contour, cutter, tol) => {
      const xs = ringCrossings([contour, cutter]).filter((x) => x.ring === 0);
      expect(xs.length).toBeGreaterThan(0);
      for (const x of xs) {
        const pts = [contour.start, ...contour.segments.map((s) => s.to)];
        const landed = trimSegment(pts[x.seg], contour.segments[x.seg], 0, x.t).seg.to;
        close(landed, x.point, tol);
      }
    };
    for (const sweep of [60, 90, 180, 300]) check(arcRing(sweep), radialCutter(sweep / 2), 3e-3);
    check(ring([[0, 0], [10, 0], [10, 5], [0, 5]]), ring([[5.9, -1], [6.1, -1], [6.1, 1], [5.9, 1]]), 1e-9);
    // a cubic segment: one paper curve, so its time IS the IR parameter and must pass through
    const cubic = { start: [0, 0], segments: [{ c1: [3, 8], c2: [7, 8], to: [10, 0] }, { to: [0, 0] }] };
    check(cubic, ring([[4.9, 2], [5.1, 2], [5.1, 8], [4.9, 8]]), 1e-9);
  });
});
