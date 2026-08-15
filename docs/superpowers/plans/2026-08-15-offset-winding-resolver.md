# Offset Winding Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the offset engine's paper.js-boolean cleanup path with non-zero winding resolution over the raw offset outline, fixing the text-offset regression and both remaining documented limitations.

**Architecture:** Find crossings with paper's fat-line Bézier clipper (exact `(curve, t)`), merge near-coincident crossings into shared pool vertices, split each raw ring into pieces, keep a piece iff its two sides straddle the non-zero winding boundary (one probe plus a ±1 derivation), chain kept pieces by vertex identity, and emit the original arcs/cubics trimmed via `trimSegment`.

**Tech Stack:** Plain ESM JavaScript, vitest, paper.js (already a dependency — used for intersection finding only), Manifold WASM in oracle tests.

**Spec:** `docs/superpowers/specs/2026-08-15-offset-winding-resolver-design.md`

## Global Constraints

- **Node 24 required** — run `source ~/.nvm/nvm.sh && nvm use` before any npm/npx command.
- New module `src/framework/geometry/contour-winding.js` must stay DOM-free, `three`-free, `node:`-free (`test/worker-layering.test.js` enforces the worker graph).
- Units are millimetres. Existing constants in `contour-offset.js`: `OFFSET_TOL = 1e-3`, `JOIN_EPS = 1e-6`, `VALIDATE_SEGS = 32`, `MITER_LIMIT = 2`.
- Contour IR: `{ start: [x,y], segments: [{to}|{to,via}|{to,c1,c2}] }`, rings explicitly closed, outers CCW, holes CW. A segment's start point is the previous segment's `to`.
- Pinned error messages must stay byte-identical:
  - `'Shape2D.offset: corners must be "round" | "chamfer" | "sharp"'`
  - `"Shape2D.offset: delta must be a finite number"`
  - `"Shape2D.offset: offset collapses the shape (reduce |delta|)"`
- **Never weaken an assertion or loosen a tolerance to make a test pass.** If an existing expectation moves in a way you cannot justify geometrically, STOP and report.
- The full suite (`npm test`) must be green before every commit.
- Grep `docs/ERROR-PATTERNS.md` on any confusing failure (repo rule).
- Commit with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `claude/offset-winding-resolver` (off main at 0.59.0).

## Reference: verified API facts

These were confirmed empirically against this repo; rely on them.

- `toPaperPath(scope, contour, segMap)` from `paper-bridge.js` fills `segMap` so `segMap[paperCurveIndex] === irSegmentIndex`. Verified 137 curves → 137 IR segments on a glyph offset.
- `path.getIntersections()` returns self-intersections; `pathA.getIntersections(pathB)` returns locations on A, each with `.intersection` giving the matching location on B.
- Each location has `.curve.index`, `.time` (t in [0,1] on that curve), and `.point`.
- `trimSegment(from, seg, tStart, tEnd)` in `contour-ops.js` returns `{ from, seg }` and **preserves segment kind** — an arc comes back as `{to, via}`, a cubic as `{to, c1, c2}`, a line as `{to}`. It is currently NOT exported.
- Paper's `addCurveIntersections` bails at 40 recursion levels / 4096 calls and returns a partial set.

---

### Task 1: Foundations — export `trimSegment`, add the intersection helper

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Modify: `src/framework/geometry/paper-bridge.js`
- Create: `test/contour-winding.test.js`

**Interfaces:**
- Produces: `trimSegment(from, seg, tStart, tEnd) -> { from, seg }` exported from `contour-ops.js`.
- Produces: `ringCrossings(rings) -> [{ ring, seg, t, point }]` from `paper-bridge.js` — every self-intersection of each ring plus every pairwise intersection, expressed in IR terms. `rings` is an array of contours.

- [ ] **Step 1: Write the failing test**

Create `test/contour-winding.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/contour-winding.test.js`
Expected: FAIL — `trimSegment` and `ringCrossings` are not exported.

- [ ] **Step 3: Export `trimSegment`**

In `src/framework/geometry/contour-ops.js`, add `export` to the existing declaration at ~line 284. Do not change its body:

```js
export function trimSegment(from, seg, tStart, tEnd) { ... }
```

- [ ] **Step 4: Add `ringCrossings` to paper-bridge.js**

Append to `src/framework/geometry/paper-bridge.js`:

```js
// Every crossing among a set of contour-IR rings — self-intersections of each ring plus
// pairwise intersections — expressed back in IR terms as { ring, seg, t, point }.
//
// This deliberately borrows the half of paper.js that works. Paper implements fat-line
// Bézier clipping (Sederberg–Nishita) with convex-hull rejection: recursive subdivision
// that returns exact (curve, t) on the original curves. Paper's weakness in this engine
// was never finding intersections — it is the tracing and branch selection afterwards,
// which contour-winding.js replaces. segMap (filled by toPaperPath) maps paper's curve
// index back to our IR segment index.
//
// NB paper's addCurveIntersections bails at 40 recursion levels / 4096 calls and returns
// a PARTIAL set on pathological input. Callers must detect that downstream (an unconsumed
// piece during chaining) rather than trusting completeness here.
export function ringCrossings(rings) {
  if (rings.length === 0) return [];
  const scope = paperScope();
  try {
    const maps = rings.map(() => []);
    const paths = rings.map((c, i) => toPaperPath(scope, c, maps[i]));
    const out = [];
    const push = (ringIdx, loc) => {
      const seg = maps[ringIdx][loc.curve.index];
      if (!Number.isInteger(seg)) return;               // defensive: unmapped curve
      out.push({ ring: ringIdx, seg, t: loc.time, point: [loc.point.x, loc.point.y] });
    };
    for (let i = 0; i < paths.length; i++) {
      for (const loc of paths[i].getIntersections()) push(i, loc);      // self
      for (let j = i + 1; j < paths.length; j++) {
        for (const loc of paths[i].getIntersections(paths[j])) {        // pairwise
          push(i, loc);
          push(j, loc.intersection);
        }
      }
    }
    return out;
  } finally {
    scope.project.clear();
  }
}
```

- [ ] **Step 5: Run tests, expect PASS; run worker-layering**

Run: `npx vitest run test/contour-winding.test.js test/worker-layering.test.js`
Note on the bowtie test: paper reports a self-intersection once per participating curve, so the count is ≥2, not exactly 1 — the assertion is written accordingly.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/contour-ops.js src/framework/geometry/paper-bridge.js test/contour-winding.test.js
git commit -m "feat: export trimSegment and add ringCrossings intersection helper"
```

---

### Task 2: Point pool and crossing-cluster merge

**Files:**
- Create: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Consumes: `ringCrossings` (Task 1).
- Produces: `mergeCrossings(crossings, tol) -> { crossings, pool }` where each returned crossing gains a `vertex` field (an index into `pool`, an array of `[x,y]`), and crossings whose points are within `tol` share one vertex. Exported as `_mergeCrossings` for tests.
- Produces: `CLUSTER_TOL` — the derived clustering tolerance.

- [ ] **Step 1: Write the failing test**

Append to `test/contour-winding.test.js`:

```js
import { _mergeCrossings, CLUSTER_TOL } from "../src/framework/geometry/contour-winding.js";

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
```

- [ ] **Step 2: Run to verify failure, then implement**

Create `src/framework/geometry/contour-winding.js`:

```js
// Non-zero winding resolution for offset outlines — the cleanup path of contour-offset.js.
//
// The correct result of an offset is the NON-ZERO WINDING REGION of the raw offset
// outline. Self-overlap loops, collapsed holes, unmerged seams and pinched necks are all
// the same failure: approximating that rule with booleans instead of computing it. This
// module computes it: find crossings (paper's curve clipper), split each ring there, keep
// a piece iff its two sides straddle the winding boundary, chain the survivors, and emit
// the ORIGINAL curves trimmed at the crossing parameters.
//
// Pure leaf in the worker graph: DOM-free, three-free, node:-free.
import { ringCrossings } from "./paper-bridge.js";
import { trimSegment } from "./contour-ops.js";
import { tessellateContour } from "./profile.js";

// Crossings closer than this are one vertex. Derived: it must exceed OFFSET_TOL (1e-3 mm,
// the cubic-offset approximation error) or two crossings that are genuinely the same point
// on an approximated curve stay split; and it must stay far below the thinnest feature the
// engine is expected to keep. 5x OFFSET_TOL sits an order below a 0.05 mm feature.
export const CLUSTER_TOL = 5e-3;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Assign every crossing a pool vertex, merging any within `tol`. Greedy against the pool:
// crossings are few (tens per ring) so the O(n·pool) scan is not worth indexing.
export function _mergeCrossings(crossings, tol = CLUSTER_TOL) {
  const pool = [];
  const members = [];
  const out = crossings.map((x) => {
    let v = pool.findIndex((p) => dist(p, x.point) <= tol);
    if (v === -1) { v = pool.length; pool.push([x.point[0], x.point[1]]); members.push([]); }
    members[v].push(x.point);
    return { ...x, vertex: v };
  });
  // settle each pooled vertex on its cluster centroid so the shared position is unbiased
  for (let v = 0; v < pool.length; v++) {
    const m = members[v];
    pool[v] = [m.reduce((s, p) => s + p[0], 0) / m.length, m.reduce((s, p) => s + p[1], 0) / m.length];
  }
  return { crossings: out, pool };
}
```

- [ ] **Step 3: Run tests, expect PASS. Commit**

```bash
git add src/framework/geometry/contour-winding.js test/contour-winding.test.js
git commit -m "feat: crossing cluster merge with a shared vertex pool"
```

---

### Task 3: Split rings into pieces with provenance

**Files:**
- Modify: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Consumes: `_mergeCrossings` (Task 2), `trimSegment` (Task 1).
- Produces: `_splitRings(rings, merged) -> pieces[]`, each piece `{ ring, from: [x,y], segs: [segIR...], vStart, vEnd }` — a run of the ring between two consecutive pooled vertices, materialized as trimmed IR segments. A ring with no crossings yields one closed piece with `vStart === vEnd === null`.

- [ ] **Step 1: Write the failing test**

```js
import { _splitRings } from "../src/framework/geometry/contour-winding.js";

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
```

- [ ] **Step 2: Implement**

Append to `contour-winding.js`:

```js
// Point on a ring at (segment, t) — the ring's own parameterization.
const ringPoints = (contour) => [contour.start, ...contour.segments.map((s) => s.to)];

// Split each ring at its merged crossings into pieces. Crossings are sorted along the
// ring by (seg, t); consecutive pairs bound a piece, wrapping at the end. Each piece is
// materialized immediately as trimmed IR segments via trimSegment, so provenance never
// has to be carried further — a trimmed arc is still an arc.
export function _splitRings(rings, merged) {
  const byRing = rings.map(() => []);
  for (const x of merged.crossings) byRing[x.ring].push(x);
  const pieces = [];

  rings.forEach((contour, r) => {
    const pts = ringPoints(contour);
    const xs = byRing[r].slice().sort((a, b) => (a.seg - b.seg) || (a.t - b.t));
    if (xs.length === 0) {
      pieces.push({ ring: r, from: [contour.start[0], contour.start[1]],
                    segs: contour.segments.map((s) => ({ ...s })), vStart: null, vEnd: null });
      return;
    }
    // emit the run from crossing a to crossing b (b may wrap past the ring end)
    const emit = (a, b) => {
      const segs = [];
      let from = merged.pool[a.vertex];
      const spanEnd = b.seg + (b.seg < a.seg || (b.seg === a.seg && b.t <= a.t)
        ? contour.segments.length : 0);
      for (let k = a.seg; k <= spanEnd; k++) {
        const i = k % contour.segments.length;
        const seg = contour.segments[i];
        const tS = k === a.seg ? a.t : 0;
        const tE = k === spanEnd ? b.t : 1;
        if (tE - tS <= 1e-12) continue;
        segs.push(trimSegment(pts[i], seg, tS, tE).seg);
      }
      if (segs.length === 0) return;                      // degenerate zero-length run
      segs[segs.length - 1].to = [merged.pool[b.vertex][0], merged.pool[b.vertex][1]];  // snap to the shared vertex
      pieces.push({ ring: r, from: [from[0], from[1]], segs, vStart: a.vertex, vEnd: b.vertex });
    };
    for (let i = 0; i < xs.length; i++) emit(xs[i], xs[(i + 1) % xs.length]);
  });
  return pieces;
}
```

Note the deliberate endpoint snap: the piece's first point comes from the pool and its last `to` is overwritten with the pool position. That is what makes chaining exact — pieces meeting at a vertex share coordinates bit-for-bit, not approximately.

- [ ] **Step 3: Run tests, expect PASS. Commit**

```bash
git add src/framework/geometry/contour-winding.js test/contour-winding.test.js
git commit -m "feat: split raw offset rings into pieces at merged crossings"
```

---

### Task 4: Integer winding query and piece classification

**Files:**
- Modify: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Produces: `_windingAt(p, tessRings) -> integer` — signed crossing count of a +x ray.
- Produces: `_classify(pieces, tessRings) -> [{ piece, keep, reverse }]`.

**The rule** (derive it in a comment; the tests pin it): for a piece walked in its own direction, the interior of a CCW ring lies to its **left**, so `wLeft = wRight + 1` exactly. Probe once on the left. Keep the piece iff exactly one side is non-zero, which reduces to **`keep iff wLeft === 0 || wLeft === 1`**. When `wLeft === 1` the piece is already correctly oriented; when `wLeft === 0` the interior is on its right, so the piece must be **reversed** in the output.

- [ ] **Step 1: Write the failing test**

```js
import { _windingAt, _classify, PROBE_EPS } from "../src/framework/geometry/contour-winding.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";

const tess = (rings) => rings.map((r) => tessellateContour(r, 64));

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
```

- [ ] **Step 2: Implement**

```js
// Probe offset for the winding query. Must clear CLUSTER_TOL — a probe closer to the
// boundary than the distance two merged crossings can sit apart may land on the wrong
// side of a neighbouring piece — while staying far below any feature worth keeping.
export const PROBE_EPS = CLUSTER_TOL * 2;

// Signed crossing count of a +x ray from p against tessellated rings. Standard
// half-open rule (a[1] <= p[1] < b[1]) so a vertex is counted exactly once.
export function _windingAt(p, tessRings) {
  let w = 0;
  for (const ring of tessRings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= p[1]) { if (b[1] > p[1] && side > 0) w++; }
      else if (b[1] <= p[1] && side < 0) w--;
    }
  }
  return w;
}

// A point ON the piece, with the local direction there.
//
// NB the probe point must lie on the actual curve, not on a chord: for an arc or cubic
// the chord midpoint sits off to one side, and probing PROBE_EPS from a point that is
// already displaced from the boundary is how a classification silently flips. So sample
// the piece's own tessellation and take the midpoint of its middle polyline edge — that
// point is within the tessellation chord error of the true curve, orders below PROBE_EPS.
function pieceMid(piece) {
  const poly = tessellateContour({ start: piece.from, segments: piece.segs }, WINDING_SEGS);
  const i = Math.max(0, Math.floor((poly.length - 1) / 2));
  const a = poly[i], b = poly[i + 1] ?? poly[poly.length - 1];
  const d = [b[0] - a[0], b[1] - a[1]];
  const L = Math.hypot(d[0], d[1]) || 1;
  // `len` is the whole piece's length, which is what the short-piece probe scaling needs
  let total = 0;
  for (let k = 0; k < poly.length - 1; k++) total += Math.hypot(poly[k + 1][0] - poly[k][0], poly[k + 1][1] - poly[k][1]);
  return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir: [d[0] / L, d[1] / L], len: total };
}

// Keep a piece iff its two sides straddle the non-zero winding boundary.
//
// Crossing a directed edge changes the winding number by exactly ±1, so ONE probe
// suffices: with the interior of a CCW ring on its left, wLeft = wRight + 1 identically.
// A second probe is not merely redundant but harmful — two independent probes can
// disagree (both reading "inside") when either lands badly, and there is no way to tell
// which is wrong. Deriving the far side arithmetically makes the two consistent by
// construction. "Exactly one side non-zero" then reduces to wLeft ∈ {0, 1}; wLeft === 0
// means the interior is on the right, so the piece is emitted reversed.
export function _classify(pieces, tessRings, { debug = false } = {}) {
  return pieces.map((piece) => {
    const { mid, dir, len } = pieceMid(piece);
    // a piece shorter than 2·PROBE_EPS gets a proportionally shorter probe so pinch-point
    // slivers are still classified rather than probed into a neighbouring region
    const eps = Math.min(PROBE_EPS, Math.max(len / 4, 1e-9));
    const left = [mid[0] - dir[1] * eps, mid[1] + dir[0] * eps];
    const wLeft = _windingAt(left, tessRings);
    const wRight = wLeft - 1;
    const keep = wLeft === 0 || wLeft === 1;
    const rec = { piece, keep, reverse: keep && wLeft === 0 };
    return debug ? { ...rec, wLeft, wRight } : rec;
  });
}
```

- [ ] **Step 3: Run tests, expect PASS**

If the winding signs come out inverted (inside a CCW ring reading −1), the ray-cast comparison sign is flipped — fix the sign in `_windingAt`, never the test.

- [ ] **Step 4: Commit**

```bash
git add src/framework/geometry/contour-winding.js test/contour-winding.test.js
git commit -m "feat: integer winding query and one-probe piece classification"
```

---

### Task 5: Chain kept pieces into closed rings

**Files:**
- Modify: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Produces: `_chain(classified, pool) -> contours[]` — closed IR contours built from kept pieces joined by shared pool vertex identity. Throws `"contour-winding: could not chain offset boundary (incomplete intersection set)"` when a kept piece cannot be consumed, which is the detector for paper's truncated-recursion case.

- [ ] **Step 1: Write the failing test**

```js
import { _chain } from "../src/framework/geometry/contour-winding.js";

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
```

- [ ] **Step 2: Implement**

```js
const reversePieceSegs = (piece) => {
  // reverse a piece's segment run, mirroring reverseContour's per-kind handling
  const pts = [piece.from, ...piece.segs.map((s) => s.to)];
  const segs = [];
  for (let i = piece.segs.length - 1; i >= 0; i--) {
    const s = piece.segs[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segs.push(m);
  }
  return { from: pts[pts.length - 1], segs, vStart: piece.vEnd, vEnd: piece.vStart };
};

// Join kept pieces end-to-end by SHARED POOL VERTEX identity — never coordinate
// comparison, which is what makes this exact. A junction with several outgoing pieces
// (a pinch point) takes the most clockwise turn relative to the arriving direction,
// the standard planar-arrangement rule for tracing an outer boundary consistently.
export function _chain(classified, pool) {
  const kept = classified.filter((c) => c.keep)
    .map((c) => (c.reverse ? reversePieceSegs(c.piece) : { from: c.piece.from, segs: c.piece.segs,
                                                           vStart: c.piece.vStart, vEnd: c.piece.vEnd }));
  const closed = kept.filter((p) => p.vStart === null);      // uncrossed whole rings
  const open = kept.filter((p) => p.vStart !== null);
  const out = closed.map((p) => ({ start: [p.from[0], p.from[1]], segs: p.segs }));

  const outgoing = new Map();
  open.forEach((p, i) => { if (!outgoing.has(p.vStart)) outgoing.set(p.vStart, []); outgoing.get(p.vStart).push(i); });
  const used = new Array(open.length).fill(false);

  const dirOut = (p) => { const a = p.from, b = p.segs[0].to; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
  const dirIn = (p) => { const pts = [p.from, ...p.segs.map((s) => s.to)];
    const a = pts[pts.length - 2], b = pts[pts.length - 1]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };

  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    const startV = open[s].vStart;
    let cur = s, guard = 0;
    const chainSegs = [];
    const startPt = [open[s].from[0], open[s].from[1]];
    for (;;) {
      if (guard++ > open.length + 1) throw new Error("contour-winding: could not chain offset boundary (incomplete intersection set)");
      used[cur] = true;
      chainSegs.push(...open[cur].segs);
      const at = open[cur].vEnd;
      if (at === startV) break;
      const cands = (outgoing.get(at) ?? []).filter((i) => !used[i]);
      if (cands.length === 0) throw new Error("contour-winding: could not chain offset boundary (incomplete intersection set)");
      const inDir = dirIn(open[cur]);
      // most clockwise turn: smallest positive rotation from the reversed inbound direction
      cur = cands.reduce((best, i) => {
        const turn = (x) => { let a = inDir + Math.PI - dirOut(open[x]); a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
        return turn(i) < turn(best) ? i : best;
      }, cands[0]);
    }
    out.push({ start: startPt, segs: chainSegs });
  }

  if (used.some((u) => !u)) throw new Error("contour-winding: could not chain offset boundary (incomplete intersection set)");
  return out.map(({ start, segs }) => {
    const last = segs[segs.length - 1].to;
    if (Math.hypot(last[0] - start[0], last[1] - start[1]) <= 1e-9) {
      segs[segs.length - 1].to = [start[0], start[1]];      // snap the closure exact
      return { start, segments: segs };
    }
    return { start, segments: [...segs, { to: [start[0], start[1]] }] };
  });
}
```

- [ ] **Step 3: Run tests, expect PASS. Commit**

```bash
git add src/framework/geometry/contour-winding.js test/contour-winding.test.js
git commit -m "feat: chain kept pieces into closed rings by vertex identity"
```

---

### Task 6: Assemble `resolveOffsetWinding`

**Files:**
- Modify: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Produces: **the public entry** `resolveOffsetWinding(rawRegions) -> regions`. Takes the raw offset region list (`{outer, holes}[]`), flattens it to a ring list, resolves, and re-nests into regions with the storage winding invariant restored.

- [ ] **Step 1: Write the failing test**

```js
import { resolveOffsetWinding } from "../src/framework/geometry/contour-winding.js";
import { profileArea } from "../src/framework/geometry/contour-ops.js";

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
  });
  test("a self-intersecting bowtie resolves to its positive lobes", () => {
    const out = resolveOffsetWinding([R(ring([[0, 0], [10, 10], [10, 0], [0, 10]]))]);
    expect(Math.abs(profileArea(out))).toBeCloseTo(50, 4);
  });
  test("a fully inverted ring resolves to nothing", () => {
    expect(resolveOffsetWinding([R(ring([[0, 0], [0, 10], [10, 10], [10, 0]]))])).toEqual([]);
  });
  test("empty in, empty out", () => {
    expect(resolveOffsetWinding([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Add to the module's existing imports (do not duplicate the `shape2d-regions.js` import
added here — merge it with any existing one):

```js
import { assembleRegions, ringArea } from "./shape2d-regions.js";
import { closeContourGap, reverseContour } from "./profile.js";

// Tessellation density, used ONLY as the ray-cast target for winding queries and for
// locating an on-curve probe point. Nothing topological depends on it — winding is an
// integer and the probe sits PROBE_EPS off the boundary, orders above the chord error.
// Declare this near the top of the file with CLUSTER_TOL, before its first use.
const WINDING_SEGS = 64;

// Resolve a raw offset region list into the non-zero winding region it denotes.
// This is contour-offset.js's cleanup path.
export function resolveOffsetWinding(rawRegions) {
  const rings = [];
  for (const rg of rawRegions) { rings.push(rg.outer); for (const h of rg.holes) rings.push(h); }
  if (rings.length === 0) return [];

  const merged = _mergeCrossings(ringCrossings(rings));
  const pieces = _splitRings(rings, merged);
  const tessRings = rings.map((r) => tessellateContour(r, WINDING_SEGS));
  const contours = _chain(_classify(pieces, tessRings), merged.pool);

  // drop numerically empty loops, then nest by containment and restore the storage
  // winding invariant (outer CCW, holes CW) from each contour's own area sign
  const live = contours.filter((c) => Math.abs(ringArea(tessellateContour(c, WINDING_SEGS))) > 1e-9);
  if (live.length === 0) return [];
  const tessOf = new Map(live.map((c) => [c, tessellateContour(c, WINDING_SEGS)]));
  const regions = assembleRegions(live.map((c) => tessOf.get(c)));
  const byRing = new Map(live.map((c) => [tessOf.get(c), c]));
  return regions.map((rg) => {
    const outer = byRing.get(rg.outer);
    const orient = (c, wantCCW) =>
      closeContourGap(ringArea(tessellateContour(c, WINDING_SEGS)) >= 0 === wantCCW ? c : reverseContour(c));
    return { outer: orient(outer, true), holes: rg.holes.map((h) => orient(byRing.get(h), false)) };
  });
}
```

- [ ] **Step 3: Run tests, expect PASS; run worker-layering. Commit**

```bash
npx vitest run test/contour-winding.test.js test/worker-layering.test.js
git add src/framework/geometry/contour-winding.js test/contour-winding.test.js
git commit -m "feat: resolveOffsetWinding — the winding-based offset cleanup path"
```

---

### Task 7: Wire into `offsetRegions`, delete the old cleanup

**Files:**
- Modify: `src/framework/geometry/contour-offset.js`
- Modify: `src/framework/geometry/paper-bridge.js`
- Modify: `test/contour-offset.test.js`, `test/paper-bridge-resolve.test.js` (delete if its subject is gone)

- [ ] **Step 1: Swap the cleanup path**

In `contour-offset.js`: import `resolveOffsetWinding` from `./contour-winding.js`; replace every `cleanupRegions(...)` call with it. Delete `cleanupRegions`, `splitAtDuplicateEdges`, and `splitPinchedRegions` along with their comments. The fast path, `validateRawOffset`, the collapse throw, and all of `_offsetContour` stay untouched.

The orchestrator reduces to:

```js
  let out = (!dirty && validateRawOffset(raw)) ? raw : resolveOffsetWinding(raw);
  if (out.length === 0) throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  return out;
```

- [ ] **Step 2: Remove the orphaned self-union**

`grep -rn "resolveSelfRegions" src/ test/` — if `contour-offset.js` was its only caller, delete `resolveSelfRegions` from `paper-bridge.js` and delete `test/paper-bridge-resolve.test.js`. Keep `booleanRegions` and `regionsToCompound` (the ordinary Shape2D booleans use them). If anything else still calls it, leave it and say so in the report.

- [ ] **Step 3: Run the offset suites and re-baseline honestly**

Run: `npx vitest run test/contour-offset.test.js test/offset-oracle-manifold.test.js test/offset-oracle-occt.test.js`

Expected improvements — convert these from `test.todo` / parked characterization bands to correctness assertions as they pass:
- wide L-pocket, 5-unit arms, +3 → 0 holes, area `toBeCloseTo(928.274, 1)`
- 9-gon chamfer −2.79 → area `toBeCloseTo(2.76, 1)`
- pinched dumbbell round/chamfer → 72.354 / 74.000

Cases that must NOT move: merge 348, breakthrough 408, and every currently-passing corpus entry. If one moves, investigate and report — do not re-baseline.

- [ ] **Step 4: Full suite, then commit**

```bash
npm test
git add -A && git commit -m "feat: offset cleanup runs winding resolution; delete the boolean cleanup path"
```

---

### Task 8: Oracle corpus — glyphs, topology assertions, fuzz

**Files:**
- Modify: `test/offset-oracle-manifold.test.js`
- Create: `test/offset-fuzz.test.js`

**Why this task exists:** the corpus had no glyph cases, which is the specific reason the reported bug shipped, and it compared area without topology, which is why 0.1 %-accurate garbage passed.

- [ ] **Step 1: Add glyph cases to the Manifold oracle**

Build glyph regions with `textGlyphs(font, ch, { size: 10 })` (see `test/text2d.test.js` for font loading via `DEFAULT_FONT_BYTES`). Add single glyphs `o`, `e`, `a`, `p`, `t` and the string `"Scott"`, at deltas `[0.2, 0.5, 1.0, 2.0, 3.0]` — deliberately bracketing counter collapse. Compare against Clipper2 with the existing helpers.

- [ ] **Step 2: Assert topology everywhere, not just area**

Extend every oracle comparison (existing cases included) to assert region count and total hole count alongside area and Hausdorff distance. Derive the expected counts from the Clipper2 result in-file rather than hardcoding. Verify these targets specifically:

| case | expected |
|---|---|
| `"Scott"` +3 | 1 region, 0 holes, area ≈ 522.349 |
| `"o"` +3 | 1 region, 0 holes, area ≈ 139.537 |
| `"t"` +3 | 1 region, area ≈ 121.842 |
| `"e"`,`"a"`,`"p"` past collapse | counters gone |

- [ ] **Step 3: Add the fuzz test**

Create `test/offset-fuzz.test.js`: a fixed list of seeds driving a small deterministic PRNG (not `Math.random`, which would make any failure irreproducible), generating random polygons, plates with circular/rectangular pockets, and multi-region inputs; offset each at several deltas and all three corner styles; compare region count, hole count, and area against Clipper2. Print the seed in the failure message so every hit is reproducible.

Keep the case count modest enough that the suite stays fast — a few hundred cases, not thousands. The fuzz is a net for classes the fixed corpus misses, not a substitute for it.

- [ ] **Step 4: Run, then commit**

```bash
npx vitest run test/offset-oracle-manifold.test.js test/offset-fuzz.test.js && npm test
git add -A && git commit -m "test: glyph oracle cases, topology assertions, and offset fuzz"
```

---

### Task 9: Performance gate, docs, version bump, end-to-end verification

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md`, `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `package.json`

- [ ] **Step 1: Measure the performance budget**

Time the 24-glyph text case at +0.3 and 200 disjoint squares at +0.5, on this commit and on `origin/main` (use a scratch clone or `git stash`; do not leave the tree dirty). Budget: text cleanup within **~1.5×** of main. Report both numbers. If it exceeds the budget, index the winding ray-cast target by y-bucket and re-measure — the spec calls for measuring before adding the index, not adding it speculatively.

- [ ] **Step 2: Update the contract**

In `docs/KERNEL-CONTRACT.md`, rewrite the "Offset: known limitations" section: delete each limitation whose case now reaches target (both current entries name root causes this resolver removes), and remove the section entirely if none remain. Describe the cleanup path as winding resolution rather than a boolean self-union, and note that cleanup output is now curve-native (an arc stays an arc through cleanup, where it previously became a cubic). Bump the contract version per the file's own convention and keep `test/kernel-contract.test.js`'s pin in sync.

- [ ] **Step 3: Update ERROR-PATTERNS**

Add an entry for the new pinned throw (`"contour-winding: could not chain offset boundary (incomplete intersection set)"`) → cause: paper's intersection recursion cap returned a partial set on pathological input → fix: simplify the profile or reduce |delta|; report it, since it indicates a real gap. Rewrite or delete the two existing offset entries whose root causes this change removes. Register any new ids in `test/error-patterns.test.js`'s `BASELINE_IDS` (ids are permanent — add, never rename).

- [ ] **Step 4: Version bump — RELEASE GATE**

`package.json` → `0.60.0`. Confirm with `npm view partforge version` that it exceeds what is published (0.59.0 at the time of writing; re-check, main may have moved). Forgetting this means the merge ships nothing.

- [ ] **Step 5: End-to-end verification**

```bash
npm test
npx partforge lint src/parts/bracket.js
npx partforge measure src/parts/bracket.js
npx partforge measure src/parts/nameplate.js
npx partforge measure src/parts/planter.js
npm run check
grep -rn "cleanupRegions\|splitAtDuplicateEdges\|splitPinchedRegions" src/
```

The final grep must return nothing. `nameplate.js` is the meaningful one — it is the text-offset part this whole change exists for.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: winding-resolution offset semantics; bump to 0.60.0"
```

---

## Self-review notes (already applied)

- Spec coverage: intersections via paper's clipper (T1), cluster merge (T2), split with provenance (T3), one-probe classification and the ±1 invariant (T4), chaining with the truncated-recursion detector (T5), assembly and nesting (T6), wiring and deletions (T7), glyph corpus + topology assertions + fuzz (T8), perf gate + docs + version + verification (T9).
- The spec's "assert the two sides differ by exactly 1" invariant is realized as an explicit test in T4 via the `debug` flag on `_classify`.
- Type consistency: crossings gain `vertex` in T2 and are consumed by `_splitRings` in T3; pieces `{ring, from, segs, vStart, vEnd}` flow T3 → T4 → T5; `_chain` returns IR contours consumed by `resolveOffsetWinding` in T6; `resolveOffsetWinding(rawRegions)` matches the call site in T7.
- Derived-not-magic constants: `CLUSTER_TOL` from `OFFSET_TOL` (T2), `PROBE_EPS` from `CLUSTER_TOL` (T4), both pinned by tests.
