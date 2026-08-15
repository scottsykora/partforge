// Winding resolver — pure unit tests, no WASM.
import { describe, expect, test } from "vitest";
import { ringCrossings } from "../src/framework/geometry/paper-bridge.js";
import { trimSegment } from "../src/framework/geometry/contour-ops.js";
import { _mergeCrossings, _splitRings, _windingAt, _classify, _chain, CLUSTER_TOL, PROBE_EPS } from "../src/framework/geometry/contour-winding.js";
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
