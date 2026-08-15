// Winding resolver — pure unit tests, no WASM.
import { describe, expect, test } from "vitest";
import { ringCrossings } from "../src/framework/geometry/paper-bridge.js";
import { trimSegment, profileArea } from "../src/framework/geometry/contour-ops.js";
import { _mergeCrossings, _splitRings, _windingAt, _classify, _chain, _coincidence, resolveOffsetWinding, CLUSTER_TOL, PROBE_EPS } from "../src/framework/geometry/contour-winding.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";
import { _offsetContour } from "../src/framework/geometry/contour-offset.js";

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
// 3t^2-2t^3 = the linear fraction). Task 1 pinned segMap's curve -> segment mapping; this pins
// the parameter alongside it.
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
    // measured on HEAD: 0.5 — the time within the SECOND cubic, reported as if it were the
    // time along the whole arc
    expect(arcHit(180, 135).t).toBeCloseTo(135 / 180, 9);
  });
  test("300 degree arc (four cubics, k=4)", () => {
    expect(arcHit(300, 250).t).toBeCloseTo(250 / 300, 9);
  });
  test("90 degree arc (k=1): still wrong on HEAD, because a Bezier time is not an angle", () => {
    // k=1 is exactly where a piece-index correction would have no effect at all; the error is
    // small (~4.5e-3) but it is the commonest arc this engine emits — a round join of 90 or less
    expect(arcHit(90, 67.5).t).toBeCloseTo(67.5 / 90, 9);
  });
  test("a line reports the linear fraction, not the zero-handle cubic's time", () => {
    // HEAD reported 0.560292 for the point 59% along; harmless downstream only because
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

  test("downstream: a piece trimmed out of a 180 degree arc keeps the original circle", () => {
    // Two crossings 0.1mm apart near 127 degrees. On HEAD the short piece between them came back
    // 62.63mm long instead of 0.10mm — the wrong t put the trimmed arc's `via` outside the span,
    // so arcCenterAndSweep recovered the COMPLEMENTARY sweep — and its points wandered 3.4e-2
    // off the circle (0.73 for the long piece).
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
  test("the ±1 invariant holds for every probed piece", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const merged = _mergeCrossings(ringCrossings([a, b]));
    for (const c of _classify(_splitRings([a, b], merged), tess([a, b]), { debug: true })) {
      if (c.wLeft === null) continue;    // dropped-without-probing records — see _classify's doc comment
      expect(c.wLeft - c.wRight).toBe(1);                 // structural, never probed twice
    }
  });
  test("PROBE_EPS is derived from CLUSTER_TOL as a ceiling, with no floor relationship", () => {
    expect(PROBE_EPS).toBe(CLUSTER_TOL * 2);
  });
});

describe("probe anchoring against the QUERIED polyline, not the true curve (fix round 1)", () => {
  // A plain CCW circle as two semicircular arcs. seg 0 sweeps angle 0 -> pi (via pi/2),
  // seg 1 sweeps pi -> 2pi (via 3pi/2); t is linear in angle (contour-ops.js trimSegment),
  // matching sampleArc's own linear-in-angle sweep, so this is an exact point on the arc —
  // not an approximation — and merging it back in doesn't introduce its own snap error.
  const circleRing = (r) => ({ start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] });
  const onCircle = (r, seg, t) => {
    const angle = seg === 0 ? t * Math.PI : Math.PI + t * Math.PI;
    return [r * Math.cos(angle), r * Math.sin(angle)];
  };
  // Split near the seam of seg1->seg0 (t=0.97 on seg1, t=0.02 on seg0): one long piece
  // covering most of the circle, one short piece straddling the wrap point (r, 0). Neither
  // is a real feature — every piece of a plain convex ring must be kept, unreversed.
  const splitCircle = (r) => {
    const c = circleRing(r);
    const merged = _mergeCrossings([
      { ring: 0, seg: 0, t: 0.02, point: onCircle(r, 0, 0.02) },
      { ring: 0, seg: 1, t: 0.97, point: onCircle(r, 1, 0.97) },
    ]);
    return { pieces: _splitRings([c], merged), tessRings: tess([c]) };
  };
  test("r=25: every piece of a plain circle is kept, unreversed (was reversed by the sagitta gap on HEAD)", () => {
    const { pieces, tessRings } = splitCircle(25);
    const cls = _classify(pieces, tessRings);
    expect(cls.length).toBeGreaterThan(0);
    for (const c of cls) { expect(c.keep).toBe(true); expect(c.reverse).toBe(false); }
  });
  test("r=50: same — this is the case with the ~1.6% misclassification rate on HEAD", () => {
    const { pieces, tessRings } = splitCircle(50);
    const cls = _classify(pieces, tessRings);
    expect(cls.length).toBeGreaterThan(0);
    for (const c of cls) { expect(c.keep).toBe(true); expect(c.reverse).toBe(false); }
  });
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

describe("chaining", () => {
  test("an uncrossed ring passes through as one closed contour", () => {
    const sq = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const merged = _mergeCrossings([]);
    const out = _chain(_classify(_splitRings([sq], merged), tess([sq])), merged.pool);
    expect(out.length).toBe(1);
    expect(out[0].segments.length).toBe(4);
  });
  test("two overlapping squares chain into one closed ring of the union boundary", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const merged = _mergeCrossings(ringCrossings([a, b]));
    const out = _chain(_classify(_splitRings([a, b], merged), tess([a, b])), merged.pool);
    expect(out.length).toBe(1);
    // union of two 10x10 squares overlapping in a 5x5 corner = 175
    const areaOf = (c) => { const p = tessellateContour(c, 64); let s = 0;
      for (let i = 0; i < p.length; i++) { const [x1,y1]=p[i],[x2,y2]=p[(i+1)%p.length]; s += x1*y2-x2*y1; }
      return s/2; };
    expect(Math.abs(areaOf(out[0]))).toBeCloseTo(175, 4);
  });
  test("every emitted ring is explicitly closed", () => {
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[5, 5], [15, 5], [15, 15], [5, 15]]);
    const merged = _mergeCrossings(ringCrossings([a, b]));
    for (const c of _chain(_classify(_splitRings([a, b], merged), tess([a, b])), merged.pool)) {
      const last = c.segments[c.segments.length - 1].to;
      expect(Math.hypot(last[0] - c.start[0], last[1] - c.start[1])).toBeLessThan(1e-9);
    }
  });
  test("an unchainable piece set throws rather than emitting a broken ring", () => {
    // a kept piece whose end vertex has no outgoing piece — the shape of paper's
    // truncated-recursion failure
    const orphan = [{ keep: true, reverse: false,
      piece: { ring: 0, from: [0, 0], segs: [{ to: [1, 0] }], vStart: 0, vEnd: 1 } }];
    expect(() => _chain(orphan, [[0, 0], [1, 0]]))
      .toThrow("contour-winding: could not chain offset boundary (incomplete intersection set)");
  });
  test("a CW ring under the DEFAULT (nonzero) rule is kept reversed — exercises reversePieceSegs", () => {
    // resolveOffsetWinding always passes the POSITIVE rule (inside: w >= 1), under which
    // `reverse` can never be true (see _classify's own comment) — so reversePieceSegs is
    // unreachable from production and untested by every other fixture in this file, all of
    // which go through resolveOffsetWinding. _classify's DEFAULT rule (nonzero) is the one
    // path that can still produce reverse:true, exercised directly here. A lone CW ring (no
    // crossings) has its interior on the RIGHT of travel, so the probe's LEFT side reads
    // w=0 (outside) and the right w=-1 (inside) — nonzero keeps it, reversed, so the emitted
    // piece is canonically interior-on-left.
    const cw = ring([[0, 0], [0, 10], [10, 10], [10, 0]]);   // CW: shoelace area -100
    const merged = _mergeCrossings([]);
    const pieces = _splitRings([cw], merged);
    const classified = _classify(pieces, tess([cw]));        // default rule: nonzero
    expect(classified[0].keep).toBe(true);
    expect(classified[0].reverse).toBe(true);
    const out = _chain(classified, merged.pool);
    expect(out.length).toBe(1);
    // reversePieceSegs flips the ring's traversal to CCW: the chained result's area is now
    // POSITIVE with the same magnitude — if its per-segment reversal were wrong the ring
    // would either fail to close or come back with the wrong area.
    expect(ringArea(tessellateContour(out[0], 64))).toBeCloseTo(100, 6);
  });
});

describe("junction ordering uses the curve TANGENT at the vertex, not the chord (fix round 1, I1)", () => {
  test("at a curved pinch point, the tangent-correct successor is chosen over the chord-nearer one", () => {
    // Incoming straight piece arrives at the junction (0,0) heading due +x (inDir = 0 rad).
    // Two outgoing cubics leave the same junction:
    //   A: chord to (2, 1) (~26.6 deg) but TANGENT (from -> c1) at ~80.2 deg
    //   B: chord to (1, 1.4) (~54.5 deg) but TANGENT (from -> c1) at ~11.3 deg
    // Ordered by tangent, A is the leftmost turn (turn ~99.8 deg vs B's ~168.7 deg) — A
    // should be chosen. Ordered by chord (the pre-fix code), B looks leftmost instead
    // (turn ~125.5 deg vs A's ~153.4 deg) and gets chosen wrongly.
    const deg = (d) => (d * Math.PI) / 180;
    const c1A = [Math.cos(deg(80.2)), Math.sin(deg(80.2))];
    const c1B = [Math.cos(deg(11.3)), Math.sin(deg(11.3))];

    const pIn = { ring: 0, from: [-1, 0], segs: [{ to: [0, 0] }], vStart: 0, vEnd: 1 };
    const pA = { ring: 0, from: [0, 0], segs: [{ c1: c1A, c2: [1.5, 1.2], to: [2, 1] }], vStart: 1, vEnd: 2 };
    const pB = { ring: 0, from: [0, 0], segs: [{ c1: c1B, c2: [0.7, 1.3], to: [1, 1.4] }], vStart: 1, vEnd: 3 };
    // A's own closer returns straight to the junction's ring-start vertex (0); B's own
    // closer returns to the junction itself (1) — so a wrong pick at the fork doesn't throw,
    // it silently threads both branches into ONE wrongly-lobed ring instead of two simple
    // ones. That's the failure mode this test is guarding against, not a crash.
    const pACloser = { ring: 0, from: [2, 1], segs: [{ to: [-1, 0] }], vStart: 2, vEnd: 0 };
    const pBCloser = { ring: 0, from: [1, 1.4], segs: [{ to: [0, 0] }], vStart: 3, vEnd: 1 };

    const classified = [pIn, pA, pB, pACloser, pBCloser].map((piece) => ({ piece, keep: true, reverse: false }));
    const pool = [[-1, 0], [0, 0], [2, 1], [1, 1.4]];

    const out = _chain(classified, pool);
    // Correct (tangent-based): pIn -> pA -> pACloser closes a 3-edge ring; pB -> pBCloser
    // closes its own separate 2-edge loop. Wrong (chord-based): everything threads into a
    // single 5-edge ring and no 3-edge ring exists.
    expect(out.length).toBe(2);
    const outerRing = out.find((c) => c.segments.length === 3);
    expect(outerRing).toBeDefined();
    close(outerRing.segments[1].to, [2, 1]);   // second edge is A's endpoint, not B's
  });
});

describe("junction ordering uses the ARC's true tangent, not the through-point chord (fix round 2, I1)", () => {
  const deg = (d) => (d * Math.PI) / 180;
  // A CCW arc from J=[0,0], radius 1, with a given start tangent and sweep (both degrees).
  // `via` is the through point at mid-sweep — exactly what round 1 (from -> via) still read
  // as an approximate direction, biased by sweep/4 off the true tangent.
  const arcFromTangent = (tauDeg, sweepDeg) => {
    const thetaR = deg(tauDeg - 90);                    // radius direction at the start point
    const C = [-Math.cos(thetaR), -Math.sin(thetaR)];   // center, since the start point is [0,0]
    const a0 = thetaR;                                  // angle of the start point around C
    const at = (a) => [C[0] + Math.cos(a), C[1] + Math.sin(a)];
    return { via: at(a0 + deg(sweepDeg) / 2), to: at(a0 + deg(sweepDeg)) };
  };

  test("arc (180 deg sweep) vs cubic: the true-tangent successor is chosen, not the through-point-biased one", () => {
    // Arc A: 180 deg sweep, true start tangent 60 deg — from->via (round 1) reads ~105 deg
    // (60 + sweep/4 = 60 + 45, the systematic through-point bias). Cubic B: tangent 80 deg,
    // exact even pre-fix. True ordering picks B (turn 100 vs A's true 120); the biased
    // reading instead picks A (turn 75 vs B's 100).
    const A = arcFromTangent(60, 180);
    const c1B = [Math.cos(deg(80)), Math.sin(deg(80))];

    const pIn = { ring: 0, from: [-1, 0], segs: [{ to: [0, 0] }], vStart: 0, vEnd: 1 };
    const pB = { ring: 0, from: [0, 0], segs: [{ c1: c1B, c2: [1.5, 2.6], to: [2, 3] }], vStart: 1, vEnd: 2 };
    const pA = { ring: 0, from: [0, 0], segs: [{ via: A.via, to: A.to }], vStart: 1, vEnd: 3 };
    const pBCloser = { ring: 0, from: [2, 3], segs: [{ to: [-1, 0] }], vStart: 2, vEnd: 0 };
    const pACloser = { ring: 0, from: A.to, segs: [{ to: [0, 0] }], vStart: 3, vEnd: 1 };

    const classified = [pIn, pB, pA, pBCloser, pACloser].map((piece) => ({ piece, keep: true, reverse: false }));
    const pool = [[-1, 0], [0, 0], [2, 3], A.to];

    const out = _chain(classified, pool);
    expect(out.length).toBe(2);
    const outerRing = out.find((c) => c.segments.length === 3);
    expect(outerRing).toBeDefined();
    close(outerRing.segments[1].to, [2, 3]);   // second edge is B's endpoint, not A's
  });

  test("arc (170 deg sweep) vs arc (20 deg sweep): same failure mode with both candidates curved", () => {
    // A: 170 deg sweep, true tangent 50 deg (through-point bias reads ~92.5 deg). B: 20 deg
    // sweep, true tangent 70 deg (bias reads ~75 deg). True ordering picks B (turn 110 vs
    // A's true 130); the biased reading instead picks A (87.5 vs B's 105).
    const A = arcFromTangent(50, 170);
    const B = arcFromTangent(70, 20);

    const pIn = { ring: 0, from: [-1, 0], segs: [{ to: [0, 0] }], vStart: 0, vEnd: 1 };
    const pB = { ring: 0, from: [0, 0], segs: [{ via: B.via, to: B.to }], vStart: 1, vEnd: 2 };
    const pA = { ring: 0, from: [0, 0], segs: [{ via: A.via, to: A.to }], vStart: 1, vEnd: 3 };
    const pBCloser = { ring: 0, from: B.to, segs: [{ to: [-1, 0] }], vStart: 2, vEnd: 0 };
    const pACloser = { ring: 0, from: A.to, segs: [{ to: [0, 0] }], vStart: 3, vEnd: 1 };

    const classified = [pIn, pB, pA, pBCloser, pACloser].map((piece) => ({ piece, keep: true, reverse: false }));
    const pool = [[-1, 0], [0, 0], B.to, A.to];

    const out = _chain(classified, pool);
    expect(out.length).toBe(2);
    const outerRing = out.find((c) => c.segments.length === 3);
    expect(outerRing).toBeDefined();
    close(outerRing.segments[1].to, B.to);   // second edge is B's endpoint, not A's
  });
});

describe("resolveOffsetWinding", () => {
  const R = (outer, holes = []) => ({ outer, holes });
  test("a clean region passes through unchanged in area", () => {
    const out = resolveOffsetWinding([R(ring([[0, 0], [10, 0], [10, 10], [0, 10]]))]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(100, 6);
  });
  test("overlapping regions merge into one", () => {
    const out = resolveOffsetWinding([
      R(ring([[0, 0], [10, 0], [10, 10], [0, 10]])),
      R(ring([[5, 5], [15, 5], [15, 15], [5, 15]]))]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(175, 4);
  });
  test("a hole survives as a hole and nests in its outer", () => {
    const hole = ring([[4, 4], [4, 6], [6, 6], [6, 4]]);   // CW
    const out = resolveOffsetWinding([R(ring([[0, 0], [10, 0], [10, 10], [0, 10]]), [hole])]);
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(96, 6);
    // orient() is a named deliverable of this task — profileArea takes Math.abs of every
    // ring, so it can't pin the storage winding invariant on its own; check signs directly.
    expect(ringArea(tessellateContour(out[0].outer, 64))).toBeGreaterThan(0);      // outer CCW
    expect(ringArea(tessellateContour(out[0].holes[0], 64))).toBeLessThan(0);      // hole CW
  });
  test("a self-intersecting bowtie resolves to its positive lobe only (fill rule is POSITIVE winding, not non-zero)", () => {
    // The bowtie's continuous traversal threads through its self-crossing with one lobe
    // locally CCW (w=1, real material under the positive-winding rule) and the other
    // locally CW (w=-1 — a genuine artifact of figure-8 topology, not orientation error,
    // but still a NEGATIVE-winding region, which this module's fill rule treats as
    // collapsed, same as any other w<0 area). Only the w=1 lobe survives: area 10*10/2/2.
    const out = resolveOffsetWinding([R(ring([[0, 0], [10, 10], [10, 0], [0, 10]]))]);
    expect(out.length).toBe(1);
    expect(Math.abs(profileArea(out))).toBeCloseTo(25, 4);
  });
  test("a fully inverted ring resolves to nothing", () => {
    expect(resolveOffsetWinding([R(ring([[0, 0], [0, 10], [10, 10], [10, 0]]))])).toEqual([]);
  });
  test("empty in, empty out", () => {
    expect(resolveOffsetWinding([])).toEqual([]);
  });
});

// Regression coverage for the positive-winding fix: fed REAL _offsetContour output (not
// hand-built rings), the pre-fix predicate (drop-on-reverse only for an uncrossed whole
// ring — see the commit history) reversed negative-winding pieces produced by two holes
// colliding into each other or a hole breaking out past its outer, exactly the artifact
// classes the non-zero rule was wrong about. Both fixtures below are cross-checked against
// offsetRegions' own existing (paper.js-boolean-based) cleanup path in
// test/contour-offset.test.js, which already gets these right via a different mechanism —
// these pin resolveOffsetWinding's OWN winding-based path to the same correct answer,
// directly on _offsetContour's raw output, with no boolean cleanup involved.
describe("resolveOffsetWinding — positive-winding regressions against real offset output", () => {
  const plate = (w, h) => ({ start: [0, 0], segments: [{ to: [w, 0] }, { to: [w, h] }, { to: [0, h] }, { to: [0, 0] }] });

  test("two holes that grow into each other merge into one hole, no filled island", () => {
    // 30x20 plate, two 6x8 holes 3mm apart, delta -2 (holes GROW under a negative delta —
    // see contour-offset.js's header comment): the grown holes overlap by 1mm and must
    // merge into a single hole, not leave a filled island where they doubly overlap.
    const holeA = ring([[5, 6], [5, 14], [11, 14], [11, 6]]);
    const holeB = ring([[14, 6], [14, 14], [20, 14], [20, 6]]);
    const raw = [{
      outer: _offsetContour(plate(30, 20), -2, "round").contour,
      holes: [holeA, holeB].map((h) => _offsetContour(h, -2, "round").contour),
    }];
    const out = resolveOffsetWinding(raw);
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(192.677, 2);
  });

  test("a hole that grows past its outer's edge becomes a notch, not a phantom slab", () => {
    // 30x20 plate, a 10x10 hole 2mm from the bottom edge, delta -2: the grown hole breaks
    // through the eroded bottom edge, so the boundary must gain a notch (0 holes) rather
    // than leaving a separate slab of material sitting outside the outer boundary.
    const hole = ring([[15, 2], [15, 12], [25, 12], [25, 2]]);
    const raw = [{
      outer: _offsetContour(plate(30, 20), -2, "round").contour,
      holes: [_offsetContour(hole, -2, "round").contour],
    }];
    const out = resolveOffsetWinding(raw);
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(249.715, 2);
  });
});

// Collinear / coincident overlaps: two rings running along the SAME curve over a shared
// span. paper DOES report those (Curve.getOverlaps puts an ordinary intersection at each end
// of the overlapped span, on both curves), so the arrangement is complete — what used to
// break is the wRight = wLeft - 1 derivation in _classify, which assumes exactly one directed
// edge at the probed span. Two same-direction copies make the winding jump by 2, so the true
// far side was misread as "material on both sides" and the doubled boundary was dropped,
// leaving the rest unchainable. Every fixture below throws "could not chain offset boundary"
// or comes back with the wrong region count before the fix unless noted otherwise.
describe("coincident (collinear-overlap) pieces", () => {
  const R = (outer, holes = []) => ({ outer, holes });
  const sqAt = (x0, y0, w, h) => ring([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]);
  // two 10x10 squares 20mm apart, each offset independently and resolved together
  const twoSquares = (d, corners) =>
    resolveOffsetWinding([sqAt(0, 0, 10, 10), sqAt(20, 0, 10, 10)]
      .map((s) => R(_offsetContour(s, d, corners).contour)));

  test("delta 8, corners sharp: the doubled top and bottom edges resolve to one 46x26 rectangle", () => {
    // Both offset squares span y in [-8,18], so their top edges are both the line y=18,
    // overlapping over x in [12,18] (likewise the bottom). Same direction on both — the
    // rings are both CCW and both traverse the shared span the same way — so it is a
    // DOUBLED boundary (winding 0 outside, 2 inside), not a cancelling pair.
    const out = twoSquares(8, "sharp");
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(1196, 4);   // 46 x 26
  });

  test("sharp sweep: no throw at any delta, areas match the closed form", () => {
    // Square A offset by d spans x in [-d, 10+d], B spans x in [20-d, 30+d]; they meet at
    // d = 5. Below that: two disjoint squares of side 10+2d. At and above it: one rectangle
    // (30+2d) x (10+2d). d = 5 is the exact-touch case — a full-length coincident edge.
    for (const d of [1, 3, 5, 8, 10]) {
      const out = twoSquares(d, "sharp");
      const merged = d >= 5;
      const area = merged ? (30 + 2 * d) * (10 + 2 * d) : 2 * (10 + 2 * d) ** 2;
      expect(out.length).toBe(merged ? 1 : 2);
      expect(profileArea(out)).toBeCloseTo(area, 4);
    }
  });

  test("round sweep: unchanged (round joins break collinearity, which is why this class hid)", () => {
    // Pinned to 6 decimal places (toBeCloseTo(area, 6)). Deltas 1/3/5 are HEAD's values
    // unchanged — no crossing lands on a join arc there. Deltas 8 and 10 moved by 7.8e-6 and
    // 1.2e-4 mm² when ringCrossings began reporting the IR parameter instead of paper's curve
    // time: the trimmed join arcs' `via` now sits at the correct fraction of the trimmed span.
    // Both moved TOWARDS the truth — the analytic union areas are 1129.928746 and 1405.481561
    // (three independent methods agree to 9 sig figs), and each new value is closer to its own
    // by exactly the shift. The
    // residual ~0.06/0.09 mm² is the cubic approximation of the arcs, which profileArea itself
    // measures through (paper has no arc primitive), not an error in the resolver.
    const want = [[1, 2, 286.284944665], [3, 2, 496.564501988], [5, 1, 757.123616632],
                  [8, 1, 1129.986249849], [10, 1, 1405.575400557]];
    for (const [d, regions, area] of want) {
      const out = twoSquares(d, "round");
      expect(profileArea(out)).toBeCloseTo(area, 6);
      // NB delta 5 is the one region COUNT that moved (2 -> 1) and it moved to the right
      // answer: at exactly-touching the two rounded rects share their whole flank x=15,
      // y in [0,10] — traversed in opposite directions, so that edge cancels and the union
      // is a single region whose interior is connected across the seam. The area is
      // identical to 9 places either way; the pre-fix run emitted the seam twice and
      // reported two rings hemmed together along it.
      expect(out.length).toBe(regions);
    }
  });

  test("partial overlap: two boxes sharing part of two edges union cleanly", () => {
    // [0,10]x[0,5] and [6,16]x[0,5]: the y=0 edges overlap over x in [6,10] (partial at both
    // ends — neither span contains the other), same for y=5. Union = [0,16]x[0,5] = 80.
    const out = resolveOffsetWinding([R(sqAt(0, 0, 10, 5)), R(sqAt(6, 0, 10, 5))]);
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(80, 6);
  });

  test("containment: a short overlapped span wholly inside a longer edge", () => {
    // [0,20]x[0,5] and [5,15]x[-3,0] meet along y=0 over x in [5,15] — entirely inside the
    // first's bottom edge. Opposite directions (each keeps its own interior on the left), so
    // the span cancels. Union area = 100 + 30 = 130.
    const out = resolveOffsetWinding([R(sqAt(0, 0, 20, 5)), R(sqAt(5, -3, 10, 3))]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(130, 6);
  });

  test("opposite direction cancels: a hole grown onto its outer's own edge becomes a notch", () => {
    // 20x10 plate with a 10x5 hole whose bottom edge lies exactly on the plate's bottom edge.
    // The hole ring is CW, so it traverses the shared span against the outer: net 0, the span
    // is interior to the fill, and the result is a U with area 200 - 50 = 150.
    const hole = ring([[5, 0], [5, 5], [15, 5], [15, 0]]);
    const out = resolveOffsetWinding([R(sqAt(0, 0, 20, 10), [hole])]);
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(150, 6);
  });

  test("arcs sharing a span of one circle are handled by the same rule, not just lines", () => {
    // Two r=10 wedges from the origin, 0-90 deg and 45-135 deg: their arcs lie on the same
    // circle and overlap over 45-90 deg, same direction (both CCW) — the arc twin of the
    // sharp-corner case. Union is the 0-135 deg wedge, area = pi*r^2*(135/360) = 117.810.
    const wedge = (a0, a1) => {
      const P = (a) => [10 * Math.cos(a), 10 * Math.sin(a)];
      return { start: [0, 0], segments: [{ to: P(a0) }, { via: P((a0 + a1) / 2), to: P(a1) }, { to: [0, 0] }] };
    };
    const out = resolveOffsetWinding([R(wedge(0, Math.PI / 2)), R(wedge(Math.PI / 4, Math.PI * 0.75))]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo((Math.PI * 100 * 3) / 8, 1);   // tessellated area, 64 segs
  });

  test("a doubled boundary between a w=1 and a w=-1 face is kept: POSITIVE fill, not nonzero", () => {
    // A CCW square above the x axis and an INVERTED (CW) square below it, sharing the edge
    // (0,0)->(10,0) in the SAME direction. Left of that edge w = 1, right w = -1, so it is
    // interior under a nonzero rule but a real edge of the positive region {w >= 1}. This is
    // where "classify nonzero, then drop reversed pieces" and "classify with the positive
    // rule" part company: the former drops this edge and the boundary cannot be chained.
    const up = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);          // CCW
    const down = ring([[0, 0], [10, 0], [10, -10], [0, -10]]);      // CW: a collapsed/inverted offset
    const out = resolveOffsetWinding([R(up), R(down)]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(100, 6);                   // only the positive square
  });

  test("more than two copies: the net count is what the winding jumps by", () => {
    // Three CCW boxes sharing the whole y=0 edge span x in [0,10]: three coincident
    // same-direction copies, so w goes 0 -> 3 across it and the far side is wLeft - 3.
    // Union is the tallest box, area 80. (Pre-fix this could not be chained at all.)
    const out = resolveOffsetWinding([sqAt(0, 0, 10, 5), sqAt(0, 0, 10, 8), sqAt(0, 0, 10, 3)].map((o) => R(o)));
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(80, 6);
  });

  test("two identical rings resolve to one copy, not to nothing", () => {
    // Every edge is doubled, so pre-fix every piece read "material on both sides" and the
    // whole shape silently vanished (area 0) rather than throwing.
    const out = resolveOffsetWinding([R(sqAt(0, 0, 10, 10)), R(sqAt(0, 0, 10, 10))]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(100, 6);
  });

  test("_coincidence: same direction doubles, opposite cancels, a lens is neither", () => {
    const seg = (from, to, vStart, vEnd, extra = {}) => ({ ring: 0, from, segs: [{ to, ...extra }], vStart, vEnd });
    const same = _coincidence([seg([0, 0], [10, 0], 0, 1), seg([0, 0], [10, 0], 0, 1)]);
    expect(same.mult).toEqual([2, 0]);
    expect(same.duplicate).toEqual([false, true]);   // exactly one representative carries the span

    const opp = _coincidence([seg([0, 0], [10, 0], 0, 1), seg([10, 0], [0, 0], 1, 0)]);
    expect(opp.mult).toEqual([0, 0]);                // cancels: no winding jump, no boundary
    expect(opp.duplicate).toEqual([false, false]);   // dropped by the straddle test, not as dupes

    // same endpoints, different curve: a line and an arc bulging away from it
    const lens = _coincidence([seg([0, 0], [10, 0], 0, 1), seg([0, 0], [10, 0], 0, 1, { via: [5, 3] })]);
    expect(lens.mult).toEqual([1, 1]);
    expect(lens.duplicate).toEqual([false, false]);
  });

  test("the probed invariant generalizes to wLeft - wRight === mult", () => {
    const rings = [sqAt(0, 0, 10, 5), sqAt(6, 0, 10, 5)];
    const merged = _mergeCrossings(ringCrossings(rings));
    const pieces = _splitRings(rings, merged);
    const { mult } = _coincidence(pieces);
    const cls = _classify(pieces, tess(rings), { debug: true });
    let doubled = 0;
    cls.forEach((c, i) => {
      if (c.wLeft === null) return;
      expect(c.wLeft - c.wRight).toBe(mult[i]);
      if (mult[i] === 2) doubled++;
    });
    expect(doubled).toBe(2);        // the shared spans of the y=0 and y=5 edges
  });
});

// A crossing is reported once per ring PAIR (see ringCrossings), so a point where three or
// more rings meet arrives two or more times on the SAME ring at the same (seg, t). Before
// _splitRings collapsed those, the run between two such records read as a full wrap and the
// entire ring came back as an extra piece: a 2x2 grid of squares offset until their corners
// met returned 4800 mm² instead of 1600 (delta 5) and could not be chained at all (delta 8).
describe("duplicate crossing records at a multi-ring meeting point", () => {
  const sqAt = (x0, y0, w, h) => ring([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]);
  const grid = (d) => resolveOffsetWinding(
    [sqAt(0, 0, 10, 10), sqAt(20, 0, 10, 10), sqAt(0, 20, 10, 10), sqAt(20, 20, 10, 10)]
      .map((s) => ({ outer: _offsetContour(s, d, "sharp").contour, holes: [] })));

  test("four squares offset to exactly touching give one 40x40 square, not three of them", () => {
    const out = grid(5);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(1600, 4);
  });
  test("four squares offset past touching give one 46x46 square", () => {
    const out = grid(8);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(2116, 4);
  });
  test("a ring that visits one pooled vertex twice still splits there (bowtie, not deduped)", () => {
    // the two visits are the same POINT but genuinely different (seg, t) — collapsing them
    // would leave the figure-8 as a single unsplit loop and lose the positive-lobe answer
    const out = resolveOffsetWinding([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }]);
    expect(out.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(25, 4);
  });
});
