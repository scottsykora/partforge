// Winding resolver — pure unit tests, no WASM.
import { describe, expect, test } from "vitest";
import { ringCrossings } from "../src/framework/geometry/paper-bridge.js";
import { trimSegment } from "../src/framework/geometry/contour-ops.js";
import { _mergeCrossings, _splitRings, _windingAt, _classify, CLUSTER_TOL, PROBE_EPS } from "../src/framework/geometry/contour-winding.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";

const tess = (rings) => rings.map((r) => tessellateContour(r, 64));

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

describe("splitting rings at crossings", () => {
  const sq = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
  test("a ring with no crossings yields one closed piece", () => {
    const pieces = _splitRings([sq], { crossings: [], pool: [] });
    expect(pieces.length).toBe(1);
    expect(pieces[0].vStart).toBeNull();
    expect(pieces[0].segs.length).toBe(4);
  });
  test("two crossings split a ring into two pieces that together cover it", () => {
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.5, point: [5, 0] },
      { ring: 0, seg: 2, t: 0.5, point: [5, 10] },
    ]);
    const pieces = _splitRings([sq], merged);
    expect(pieces.length).toBe(2);
    // endpoints chain: piece0 ends where piece1 starts and vice versa
    expect(pieces[0].vEnd).toBe(pieces[1].vStart);
    expect(pieces[1].vEnd).toBe(pieces[0].vStart);
    // total emitted length equals the ring perimeter (40)
    const len = (p) => { let L = 0, cur = p.from;
      for (const s of p.segs) { L += Math.hypot(s.to[0] - cur[0], s.to[1] - cur[1]); cur = s.to; } return L; };
    expect(len(pieces[0]) + len(pieces[1])).toBeCloseTo(40, 6);
  });
  test("a piece starting mid-segment is trimmed, not snapped to the vertex", () => {
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.5, point: [5, 0] },
      { ring: 0, seg: 0, t: 0.8, point: [8, 0] },
    ]);
    const pieces = _splitRings([sq], merged);
    const short = pieces.find((p) => p.segs.length === 1 && Math.abs(p.from[0] - 5) < 1e-9);
    expect(short).toBeDefined();
    expect(short.segs[0].to[0]).toBeCloseTo(8, 9);
  });
  test("provenance round-trip: an arc ring splits into arc pieces", () => {
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.5, point: [0, 5] },
      { ring: 0, seg: 1, t: 0.5, point: [0, -5] },
    ]);
    for (const p of _splitRings([circ], merged)) for (const s of p.segs) expect(s.via).toBeDefined();
  });
});

describe("integer winding", () => {
  const ccw = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
  const cw = ring([[0, 0], [0, 10], [10, 10], [10, 0]]);
  test("inside a CCW ring is +1, outside is 0", () => {
    expect(_windingAt([5, 5], tess([ccw]))).toBe(1);
    expect(_windingAt([50, 5], tess([ccw]))).toBe(0);
  });
  test("inside a CW ring is -1", () => {
    expect(_windingAt([5, 5], tess([cw]))).toBe(-1);
  });
  test("two stacked CCW rings give +2 where they overlap", () => {
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    expect(_windingAt([7, 7], tess([ccw, b]))).toBe(2);
    expect(_windingAt([2, 2], tess([ccw, b]))).toBe(1);
  });
  test("a CCW outer with a CW hole is 0 inside the hole", () => {
    const hole = ring([[4, 4], [4, 6], [6, 6], [6, 4]]);
    expect(_windingAt([5, 5], tess([ccw, hole]))).toBe(0);
    expect(_windingAt([1, 1], tess([ccw, hole]))).toBe(1);
  });
});

describe("piece classification", () => {
  test("every piece of a simple CCW square is kept, unreversed", () => {
    const sq = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.5, point: [5, 0] }, { ring: 0, seg: 2, t: 0.5, point: [5, 10] }]);
    const pieces = _splitRings([sq], merged);
    const cls = _classify(pieces, tess([sq]));
    expect(cls.every((c) => c.keep)).toBe(true);
    expect(cls.every((c) => !c.reverse)).toBe(true);
  });
  test("the interior overlap of two stacked squares is dropped", () => {
    // where two CCW squares overlap, winding is 2 on the inner side → not a boundary
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const merged = _mergeCrossings(ringCrossings([a, b]));
    const cls = _classify(_splitRings([a, b], merged), tess([a, b]));
    expect(cls.some((c) => !c.keep)).toBe(true);          // the buried arms are dropped
    expect(cls.some((c) => c.keep)).toBe(true);
  });
  test("the ±1 invariant holds for every piece", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const merged = _mergeCrossings(ringCrossings([a, b]));
    for (const c of _classify(_splitRings([a, b], merged), tess([a, b]), { debug: true })) {
      expect(c.wLeft - c.wRight).toBe(1);                 // structural, never probed twice
    }
  });
  test("PROBE_EPS clears the clustering tolerance", () => {
    expect(PROBE_EPS).toBeGreaterThan(CLUSTER_TOL);
  });
});
