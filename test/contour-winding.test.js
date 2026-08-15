// Winding resolver — pure unit tests, no WASM.
import { describe, expect, test } from "vitest";
import { ringCrossings } from "../src/framework/geometry/paper-bridge.js";
import { trimSegment } from "../src/framework/geometry/contour-ops.js";
import { _mergeCrossings, _splitRings, _windingAt, _coincidence, _classify, CLUSTER_TOL, CHAIN_INCOMPLETE_MESSAGE } from "../src/framework/geometry/contour-winding.js";
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
  test("pieces carry the exact source-curve tangent and curvature at both crossing ends", () => {
    // circle r=5 split at (0,5) and (0,-5): tangents are the circle tangents at those
    // angles (CCW: perpendicular-left of the radius), curvature +1/5 everywhere
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.5, point: [0, 5] },
      { ring: 0, seg: 1, t: 0.5, point: [0, -5] },
    ]);
    for (const p of _splitRings([circ], merged)) {
      expect(Math.hypot(p.tanA[0], p.tanA[1])).toBeCloseTo(1, 12);
      expect(Math.hypot(p.tanB[0], p.tanB[1])).toBeCloseTo(1, 12);
      expect(p.kA).toBeCloseTo(1 / 5, 12);
      expect(p.kB).toBeCloseTo(1 / 5, 12);
    }
    // the piece departing (0,5) travels CCW: tangent there is (-1, 0)
    const top = _splitRings([circ], merged).find((p) => Math.abs(p.from[1] - 5) < 1e-9);
    close(top.tanA, [-1, 0], 1e-9);
    // a line ring's pieces carry zero curvature and the edge direction
    const sqm = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.5, point: [5, 0] },
      { ring: 0, seg: 2, t: 0.5, point: [5, 10] },
    ]);
    for (const p of _splitRings([sq], sqm)) { expect(p.kA).toBe(0); expect(p.kB).toBe(0); }
  });

  test("downstream: a piece trimmed out of a 180 degree arc keeps the original circle", () => {
    // Two crossings 0.1mm apart near 127 degrees. With paper's raw curve time the short
    // piece between them came back 62.63mm long instead of 0.10mm — the wrong t put the
    // trimmed arc's `via` outside the span, so arcCenterAndSweep recovered the
    // COMPLEMENTARY sweep — and its points wandered 3.4e-2 off the circle.
    const P = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];
    const arcRing = (sweep, r = 10) =>
      ({ start: P(r, 0), segments: [{ via: P(r, sweep / 2), to: P(r, sweep) }, { to: P(r, 0) }] });
    const r = 10, hit = 126.85;
    const n = P(1, hit), tg = P(1, hit + 90);
    const at = (rad, off) => [n[0] * rad + tg[0] * off, n[1] * rad + tg[1] * off];
    const bar = ring([at(8, -0.05), at(12, -0.05), at(12, 0.05), at(8, 0.05)]);
    const arc = arcRing(180);
    const merged = _mergeCrossings(ringCrossings([arc, bar]).filter((x) => x.ring === 0));
    const pieces = _splitRings([arc], merged);
    const measure = (p) => {
      const poly = tessellateContour({ start: p.from, segments: p.segs }, 256);
      let len = 0, off = 0;
      for (let i = 0; i < poly.length; i++) {
        off = Math.max(off, Math.abs(Math.hypot(poly[i][0], poly[i][1]) - r));
        if (i) len += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
      }
      return { len, off };
    };
    const short = pieces.map(measure).sort((a, b) => a.len - b.len)[0];
    expect(short.len).toBeCloseTo(0.1, 3);          // the bar is 0.1mm wide
    for (const p of pieces) expect(measure(p).off).toBeLessThan(1e-3);
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
  test("the ±1 invariant holds for every labeled piece", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const merged = _mergeCrossings(ringCrossings([a, b]));
    for (const c of _classify(_splitRings([a, b], merged), tess([a, b]), { debug: true })) {
      if (c.wLeft === null) continue;    // excluded records (duplicates, degenerates) — see _classify's doc comment
      expect(c.wLeft - c.wRight).toBe(1);                 // by construction of the face labels
    }
  });
});

describe("face labels are radius-independent (the probe design misclassified past r≈8.3)", () => {
  // A plain CCW circle as two semicircular arcs, split near the wrap seam: one long piece
  // covering most of the circle, one short piece straddling (r, 0). Neither is a real
  // feature — every piece of a plain convex ring must be kept, unreversed, at ANY radius.
  const circleRing = (r) => ({ start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] });
  const onCircle = (r, seg, t) => {
    const angle = seg === 0 ? t * Math.PI : Math.PI + t * Math.PI;
    return [r * Math.cos(angle), r * Math.sin(angle)];
  };
  const splitCircle = (r) => {
    const c = circleRing(r);
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.02, point: onCircle(r, 0, 0.02) },
      { ring: 0, seg: 1, t: 0.97, point: onCircle(r, 1, 0.97) },
    ]);
    return { pieces: _splitRings([c], merged), tessRings: tess([c]) };
  };
  for (const r of [25, 50, 500]) {
    test(`r=${r}: every piece of a plain circle is kept, unreversed`, () => {
      const { pieces, tessRings } = splitCircle(r);
      const cls = _classify(pieces, tessRings);
      expect(cls.length).toBeGreaterThan(0);
      for (const c of cls) { expect(c.keep).toBe(true); expect(c.reverse).toBe(false); }
    });
  }
  test("a degenerate (zero-length) piece is dropped, not kept with an arbitrary orientation", () => {
    const sq = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const degenerate = { ring: 0, from: [10, 5], segs: [{ to: [10, 5] }], vStart: 0, vEnd: 1 };
    const [c] = _classify([degenerate], tess([sq]));
    expect(c.keep).toBe(false);
  });
  test("a piece with zero segments is dropped, not thrown (hand-built input, unreachable from _splitRings)", () => {
    const sq = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const empty = { ring: 0, from: [0, 0], segs: [], vStart: 0, vEnd: 0 };
    const [c] = _classify([empty], tess([sq]));
    expect(c.keep).toBe(false);
  });
});

describe("face labeling", () => {
  const classify = (rings, inside) => {
    const merged = _mergeCrossings(ringCrossings(rings));
    const pieces = _splitRings(rings, merged);
    return _classify(pieces, tess(rings), { debug: true, ...(inside ? { inside } : {}) });
  };
  const positive = (w) => w >= 1;

  test("bowtie: only the positive lobe's boundary survives w>=1, labels differ by exactly 1", () => {
    // one crossing → two self-loop pieces, one per lobe: the CCW lobe (w=+1 inside) is
    // kept as boundary between 1 and 0, the CW lobe (w=−1 inside) is dropped entirely
    const cls = classify([ring([[0, 0], [10, 10], [10, 0], [0, 10]])], positive);
    const kept = cls.filter((c) => c.keep);
    expect(kept.length).toBe(1);
    expect([kept[0].wLeft, kept[0].wRight]).toEqual([1, 0]);
    for (const c of cls) if (c.wLeft !== null) expect(c.wLeft - c.wRight).toBe(1);
  });

  test("nested but disjoint rings: ambient winding crosses components", () => {
    // small CCW square strictly inside a big CCW square — no crossings, two components.
    const big = ring([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const small = ring([[8, 8], [12, 8], [12, 12], [8, 12]]);
    const cls = classify([big, small], positive);
    // big: wLeft 1 / wRight 0 → kept. small: ambient 1 → wLeft 2 / wRight 1 → both
    // filled → dropped (a doubly-covered island contributes no boundary).
    const bigRec = cls.find((c) => c.piece.ring === 0), smallRec = cls.find((c) => c.piece.ring === 1);
    expect(bigRec.keep).toBe(true);
    expect([bigRec.wLeft, bigRec.wRight]).toEqual([1, 0]);
    expect(smallRec.keep).toBe(false);
    expect([smallRec.wLeft, smallRec.wRight]).toEqual([2, 1]);
  });

  test("a CW hole nested in a disjoint CCW outer is kept, unreversed under w>=1", () => {
    const outer = ring([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const hole = ring([[8, 8], [8, 12], [12, 12], [12, 8]]);      // CW
    const cls = classify([outer, hole], positive);
    const h = cls.find((c) => c.piece.ring === 1);
    expect(h.keep).toBe(true);
    expect([h.wLeft, h.wRight]).toEqual([1, 0]);
    expect(h.reverse).toBe(false);
  });

  test("a CW ring alone under the DEFAULT nonzero rule is kept REVERSED (w -1 interior)", () => {
    const cw = ring([[0, 0], [0, 10], [10, 10], [10, 0]]);
    const [c] = classify([cw]);
    expect(c.keep).toBe(true);
    expect(c.reverse).toBe(true);
    expect([c.wLeft, c.wRight]).toEqual([0, -1]);
  });

  test("pinch vertex: squares meeting at one corner classify to even kept-degree everywhere", () => {
    // The dead-end class that sank the probe design: at a pinch every kept edge's head
    // must still have a kept departure. Even kept-degree at every vertex is the
    // structural form of that guarantee.
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[10, 10], [20, 10], [20, 20], [10, 20]]);
    const cls = classify([a, b], positive);
    const deg = new Map();
    for (const c of cls) {
      if (!c.keep || c.piece.vStart === null) continue;
      for (const v of [c.piece.vStart, c.piece.vEnd]) deg.set(v, (deg.get(v) ?? 0) + 1);
    }
    for (const [, d] of deg) expect(d % 2).toBe(0);
    // and everything that IS kept must be boundary between filled and unfilled
    for (const c of cls) if (c.keep) expect(c.wLeft >= 1 !== c.wRight >= 1).toBe(true);
  });

  test("the pinned incomplete-arrangement message is exported byte-exact", () => {
    expect(CHAIN_INCOMPLETE_MESSAGE).toBe("contour-winding: could not chain offset boundary (incomplete intersection set)");
  });
});

describe("coincident piece bookkeeping", () => {
  test("_coincidence: same direction doubles, opposite cancels, a lens is neither", () => {
    const seg = (from, to, vStart, vEnd, extra = {}) => ({ ring: 0, from, segs: [{ to, ...extra }], vStart, vEnd });
    const same = _coincidence([seg([0, 0], [10, 0], 0, 1), seg([0, 0], [10, 0], 0, 1)]);
    expect(same.mult).toEqual([2, 0]);
    expect(same.duplicate).toEqual([false, true]);   // exactly one representative carries the span

    const opp = _coincidence([seg([0, 0], [10, 0], 0, 1), seg([10, 0], [0, 0], 1, 0)]);
    expect(opp.mult).toEqual([0, 0]);                // cancels: no winding jump, no boundary
    expect(opp.duplicate).toEqual([false, true]);    // one weight-0 representative stays in the arrangement

    // same endpoints, different curve: a line and an arc bulging away from it
    const lens = _coincidence([seg([0, 0], [10, 0], 0, 1), seg([0, 0], [10, 0], 0, 1, { via: [5, 3] })]);
    expect(lens.mult).toEqual([1, 1]);
    expect(lens.duplicate).toEqual([false, false]);
  });
});
