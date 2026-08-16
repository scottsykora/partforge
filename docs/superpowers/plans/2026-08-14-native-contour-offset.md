# Native Contour Offset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both geometry backends' `offsetRegions` hooks with one pure-JS, curve-native offset engine on the Shape2D contour IR.

**Architecture:** A new pure leaf `src/framework/geometry/contour-offset.js` offsets each IR segment exactly (lines, arcs) or by adaptive Tiller–Hanson approximation (cubics), inserts round/chamfer/miter joins, then either returns the raw result (fast path, validated by sampled checks) or routes it through a new paper.js self-resolve in `paper-bridge.js` (cleanup path). `shape2d.js` imports it directly; the Manifold/OCCT offset code is deleted and survives only as test-local oracles.

**Tech Stack:** Plain ESM JavaScript, vitest, paper.js (existing dep, via paper-bridge only), Manifold + replicad WASM in oracle tests only.

**Spec:** `docs/superpowers/specs/2026-08-14-native-contour-offset-design.md`

## Global Constraints

- **Node 24 required** — run `nvm use` before any `npm`/`npx` command, or tests fail confusingly.
- `contour-offset.js` must stay DOM-free, `three`-free, `node:`-free (`test/worker-layering.test.js` enforces the worker graph).
- OCCT and Manifold must NEVER boot in the same test process — keep oracle tests in separate files.
- Pinned error messages (must stay byte-identical):
  - `'Shape2D.offset: corners must be "round" | "chamfer" | "sharp"'`
  - `"Shape2D.offset: delta must be a finite number"`
  - `"Shape2D.offset: offset collapses the shape (reduce |delta|)"`
- Units are millimetres. Internal constants: `OFFSET_TOL = 1e-3` (cubic max deviation, mm), `MAX_DEPTH = 12`, `JOIN_EPS = 1e-6`, `VALIDATE_SEGS = 32`, `MITER_LIMIT = 2`.
- Contour IR: `{ start: [x,y], segments: [{to}|{to,via}|{to,c1,c2}] }`, rings explicitly closed (last `to` === `start`), outers CCW, holes CW. A segment's start point is the previous segment's `to` (or `start` for the first) — there is no stored "from".
- On any confusing build/test failure, grep `docs/ERROR-PATTERNS.md` first (repo rule).
- Commit after every green test cycle. All work on branch `claude/contour-offset-shape2d-2f9870`.

---

### Task 1: Segment offset primitives

**Files:**
- Modify: `src/framework/geometry/contour-ops.js` (export three existing internals)
- Create: `src/framework/geometry/contour-offset.js`
- Create: `test/contour-offset.test.js`

**Interfaces:**
- Consumes: `arcCenterAndSweep(p0, via, to) -> {center:[x,y], r, dA} | null` from `paper-bridge.js`; `cubicAt`, `cubicDeriv`, `splitCubic` from `contour-ops.js` (exported in this task).
- Produces: `offsetSegment(from, seg, delta) -> { start:[x,y], segments:[segIR...], dirty:boolean }` (internal, exported for tests as `_offsetSegment`). `start` is the offset of the segment's start point; `segments` end at the offset of `seg.to`.

- [ ] **Step 1: Export the cubic helpers from contour-ops.js**

In `src/framework/geometry/contour-ops.js`, add `export` to the three existing functions (they are at ~lines 242, 246, 251; do not change their bodies):

```js
export function cubicAt(p0, c1, c2, p1, t) { ... }
export function cubicDeriv(p0, c1, c2, p1, t) { ... }
export function splitCubic(p0, c1, c2, p1, t) { ... }
```

Note `splitCubic` returns `[{p0,c1,c2,p1}, {p0,c1,c2,p1}]` (two exact cubic pieces).

- [ ] **Step 2: Write failing tests for the three primitives**

Create `test/contour-offset.test.js`:

```js
// Pure unit tests for the native contour offset engine — no WASM, no kernel boot.
import { describe, expect, test } from "vitest";
import { _offsetSegment } from "../src/framework/geometry/contour-offset.js";

const close = (a, b, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(tol);

describe("line offset", () => {
  test("offsets right of travel", () => {
    // travel +x, right of travel is -y; delta +1 → shifted down
    const r = _offsetSegment([0, 0], { to: [10, 0] }, 1);
    close(r.start, [0, -1]); close(r.segments[0].to, [10, -1]);
    expect(r.dirty).toBe(false);
  });
});

describe("arc offset", () => {
  test("CCW arc grows concentrically with positive delta", () => {
    // quarter circle r=5 about origin, CCW from (5,0) to (0,5): right of travel is outward
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, 1);
    close(r.start, [6, 0]); close(r.segments[0].to, [0, 6]);
    close(r.segments[0].via, [6 / Math.SQRT2, 6 / Math.SQRT2]);
    expect(r.dirty).toBe(false);
  });
  test("CW arc shrinks with positive delta", () => {
    // same quarter circle traversed CW from (0,5) to (5,0): right of travel is inward
    const r = _offsetSegment([0, 5], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [5, 0] }, 1);
    close(r.start, [0, 4]); close(r.segments[0].to, [4, 0]);
    expect(r.dirty).toBe(false);
  });
  test("radius inversion flags dirty", () => {
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, -6);
    expect(r.dirty).toBe(true);
  });
  test("collinear via degrades to a line", () => {
    const r = _offsetSegment([0, 0], { via: [5, 0], to: [10, 0] }, 1);
    expect(r.segments[0].via).toBeUndefined();
    close(r.start, [0, -1]);
  });
});

describe("cubic offset", () => {
  test("offset endpoints displaced along endpoint normals; deviation within tolerance", () => {
    // quarter-circle cubic r=5 (k = 0.5523·r), CCW from (5,0) to (0,5)
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 1);
    close(r.start, [6, 0], 1e-6); close(r.segments.at(-1).to, [0, 6], 1e-6);
    expect(r.dirty).toBe(false);
    // every emitted piece is a cubic
    for (const s of r.segments) expect(s.c1).toBeDefined();
  });
  test("subdivided pieces connect exactly", () => {
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 4); // large delta forces subdivision
    expect(r.segments.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/contour-offset.test.js`
Expected: FAIL — `contour-offset.js` does not exist.

- [ ] **Step 4: Implement contour-offset.js with the primitives**

Create `src/framework/geometry/contour-offset.js`:

```js
// Native curve-aware contour offset — the engine behind Shape2D.offset. Pure leaf in
// the worker graph (DOM-free, three-free, node:-free). Offsets every ring by one signed
// rule: each point displaced `delta` along the normal to the RIGHT of the direction of
// travel — under the storage winding invariant (outer CCW, holes CW) that always points
// away from the filled interior, so positive delta grows outers and shrinks holes with
// no per-ring casing. Lines and arcs offset EXACTLY; cubics use adaptive Tiller–Hanson.
//
// The cubic subdivision approach is ported from glenzli/paperjs-offset
// (https://github.com/glenzli/paperjs-offset, MIT License, Copyright (c) glenzli),
// adapted from paper.js Segments to the partforge contour IR.
import { arcCenterAndSweep } from "./paper-bridge.js";
import { cubicAt, splitCubic } from "./contour-ops.js";

export const OFFSET_TOL = 1e-3;   // mm — max deviation of a cubic offset approximation
const MAX_DEPTH = 12;             // cubic subdivision recursion cap
const JOIN_EPS = 1e-6;            // endpoints closer than this are coincident

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const L = len(v) || 1; return [v[0] / L, v[1] / L]; };
const rightOf = ([tx, ty]) => [ty, -tx];   // unit right-of-travel normal
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function offsetLine(from, to, delta) {
  const n = scl(rightOf(norm(sub(to, from))), delta);
  return { start: add(from, n), segments: [{ to: add(to, n) }], dirty: false };
}

function offsetArc(from, seg, delta) {
  const c = arcCenterAndSweep(from, seg.via, seg.to);
  if (!c) return offsetLine(from, seg.to, delta);          // collinear via → straight
  const { center, r, dA } = c;
  // CCW sweep (dA>0): right-of-travel is the outward radial → r+delta; CW: inward → r-delta
  const rNew = r + (dA >= 0 ? delta : -delta);
  if (Math.abs(rNew) <= JOIN_EPS) {
    // fully collapsed arc: bridge the offset endpoints with a line, let cleanup cope
    const tanAt = (p) => { const rad = sub(p, center); return norm(dA >= 0 ? [-rad[1], rad[0]] : [rad[1], -rad[0]]); };
    const q = (p) => add(p, scl(rightOf(tanAt(p)), delta));
    return { start: q(from), segments: [{ to: q(seg.to) }], dirty: true };
  }
  // rNew < 0 lands every point on the opposite side of center — the inverted loop
  // that stage-3 cleanup removes. Same projection formula either way.
  const proj = (p) => add(center, scl(norm(sub(p, center)), rNew));
  return { start: proj(from), segments: [{ via: proj(seg.via), to: proj(seg.to) }], dirty: rNew < 0 };
}

// Tiller–Hanson single-piece offset of cubic (p0,c1,c2,p1): displace endpoints along
// their endpoint normals and the handle line by the normal of the c1→c2 chord, then
// accept only if sampled deviation stays within OFFSET_TOL; otherwise split at t=0.5.
// (Ported from paperjs-offset's offsetSegment/adaptiveOffsetCurve.)
function offsetCubic(p0, c1, c2, p1, delta, depth) {
  const nz = (v) => (len(v) > 1e-9 ? v : null);
  const t0 = norm(nz(sub(c1, p0)) ?? nz(sub(c2, p0)) ?? sub(p1, p0));
  const t1 = norm(nz(sub(p1, c2)) ?? nz(sub(p1, c1)) ?? sub(p1, p0));
  const off0 = scl(rightOf(t0), delta), off1 = scl(rightOf(t1), delta);
  const hChord = nz(sub(c2, c1)) ?? sub(p1, p0);
  const hN = scl(rightOf(norm(hChord)), delta);
  const q0 = add(p0, off0), q1 = add(p1, off1);
  const qc1 = add(c1, scl(add(hN, off0), 0.5)), qc2 = add(c2, scl(add(hN, off1), 0.5));
  let ok = true;
  for (const t of [0.25, 0.5, 0.75]) {
    const d = dist(cubicAt(q0, qc1, qc2, q1, t), cubicAt(p0, c1, c2, p1, t));
    if (Math.abs(d - Math.abs(delta)) > OFFSET_TOL) { ok = false; break; }
  }
  if (ok || depth >= MAX_DEPTH) return { start: q0, segments: [{ to: q1, c1: qc1, c2: qc2 }], dirty: !ok };
  const [L, R] = splitCubic(p0, c1, c2, p1, 0.5);
  const a = offsetCubic(L.p0, L.c1, L.c2, L.p1, delta, depth + 1);
  const b = offsetCubic(R.p0, R.c1, R.c2, R.p1, delta, depth + 1);
  return { start: a.start, segments: [...a.segments, ...b.segments], dirty: a.dirty || b.dirty };
}

// One IR segment (running from `from` to seg.to) → its raw offset piece.
export function _offsetSegment(from, seg, delta) {
  if (seg.c1) return offsetCubic(from, seg.c1, seg.c2, seg.to, delta, 0);
  if (seg.via) return offsetArc(from, seg, delta);
  return offsetLine(from, seg.to, delta);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/contour-offset.test.js`
Expected: PASS (all).

- [ ] **Step 6: Run the worker-layering test**

Run: `npx vitest run test/worker-layering.test.js`
Expected: PASS (new module is a legal worker-graph leaf).

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/contour-ops.js src/framework/geometry/contour-offset.js test/contour-offset.test.js
git commit -m "feat: segment offset primitives for native contour offset"
```

---

### Task 2: Joins and the ring walk (`offsetContour`)

**Files:**
- Modify: `src/framework/geometry/contour-offset.js`
- Modify: `test/contour-offset.test.js`

**Interfaces:**
- Consumes: `_offsetSegment` (Task 1); `jointTangents(contour)` from `contour-ops.js` (returns per-vertex `{point, inTan, outTan}`, vertex `i` = point `pts[i]` where `pts = [start, ...segments.map(s=>s.to)]`; the join at vertex `i` connects segment `i-1` (wrapping) to segment `i`); `SMOOTH_JOINT_DEG` from `contour-ops.js`.
- Produces: `offsetContour(contour, delta, corners) -> { contour, dirty }` (exported as `_offsetContour` for tests). Input ring must be explicitly closed; output ring is explicitly closed.

**Join rules** (gap exists on the offset side when `cross(inTan,outTan) * delta > 0`):
- `round`: one arc segment `{via, to}` centered on the original corner, radius `|delta|`, via at the bisector of the two displacement vectors.
- `chamfer`: one line `{to}` — the true bevel, at every angle.
- `sharp`: miter point at the intersection of the endpoint tangent lines; falls back to the chamfer chord when the miter distance exceeds `MITER_LIMIT * |delta|` or tangents are near-parallel.
- Overlap side (`cross * delta < 0`): if BOTH adjacent raw segments are lines, trim them to their intersection (exact — keeps plain polygon insets on the fast path); otherwise insert the chord and mark the ring dirty.
- Smooth vertices (turn < `SMOOTH_JOINT_DEG` degrees or offset endpoints within `JOIN_EPS`): no join inserted.

- [ ] **Step 1: Write failing tests**

Append to `test/contour-offset.test.js`:

```js
import { _offsetContour } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = (s) => ({ start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] });
const area = (c) => ringArea(tessellateContour(c, 256));
const kinds = (c) => c.segments.map((s) => (s.c1 ? "cubic" : s.via ? "arc" : "line"));

describe("offsetContour", () => {
  test("sharp outset of a square is the exact bigger square", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "sharp");
    expect(dirty).toBe(false);
    expect(area(contour)).toBeCloseTo(144, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("round outset adds exact quarter-circle arcs", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour).filter((k) => k === "arc").length).toBe(4);
    expect(area(contour)).toBeCloseTo(140 + Math.PI, 2);  // exact πd² corners (tessellation-limited)
  });
  test("chamfer outset cuts 2d² off the sharp area", () => {
    const { contour } = _offsetContour(sq(10), 1, "chamfer");
    expect(area(contour)).toBeCloseTo(142, 9);
  });
  test("inset square trims line-line corners exactly on the fast path", () => {
    const { contour, dirty } = _offsetContour(sq(10), -1, "round");
    expect(dirty).toBe(false);                             // trimmed, not chord+dirty
    expect(area(contour)).toBeCloseTo(64, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("circle offset is exact concentric arcs, no joins", () => {
    // a circle is two half-arcs (the storage convention — one full-circle arc is ambiguous)
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const { contour, dirty } = _offsetContour(circ, 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour)).toEqual(["arc", "arc"]);
    for (const p of tessellateContour(contour, 64)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(6, 6);
  });
  test("acute triangle chamfer is a single chord per corner (true bevel)", () => {
    const tri = { start: [0, 0], segments: [{ to: [20, 0] }, { to: [10, 3] }, { to: [0, 0] }] };
    const { contour } = _offsetContour(tri, 1, "chamfer");
    // every corner contributes exactly one extra line: 3 edges + 3 chamfer chords
    expect(contour.segments.filter((s) => !s.via && !s.c1).length).toBe(6);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/contour-offset.test.js`
Expected: FAIL — `_offsetContour` not exported.

- [ ] **Step 3: Implement joins + ring walk**

Append to `contour-offset.js` (add `jointTangents`, `SMOOTH_JOINT_DEG` to the contour-ops import):

```js
const MITER_LIMIT = 2;

// Intersection of the line through P (direction u) with the line through Q (direction v).
function lineIntersect(P, u, Q, v) {
  const d = cross(u, v);
  if (Math.abs(d) < 1e-12) return null;
  const w = sub(Q, P);
  return add(P, scl(u, cross(w, v) / d));
}

// Segments bridging aEnd → bStart around `corner` on the gap side.
function joinSegs(corner, aEnd, bStart, inTan, outTan, delta, corners) {
  if (corners === "chamfer") return [{ to: bStart }];
  if (corners === "sharp") {
    const X = lineIntersect(aEnd, inTan, bStart, outTan);
    if (X && dist(X, corner) <= MITER_LIMIT * Math.abs(delta)) return [{ to: X }, { to: bStart }];
    return [{ to: bStart }];                               // miter-limit fallback = bevel
  }
  // round: exact arc about the corner, via on the displacement bisector
  const d1 = sub(aEnd, corner), d2 = sub(bStart, corner);
  let m = add(d1, d2);
  if (len(m) < 1e-9) m = delta > 0 ? rightOf(norm(d1)) : scl(rightOf(norm(d1)), -1); // 180° turn
  return [{ via: add(corner, scl(norm(m), Math.abs(delta))), to: bStart }];
}

// Offset one explicitly-closed ring. Returns { contour, dirty }.
export function _offsetContour(contour, delta, corners) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  // drop zero-length line segments (they carry no direction)
  const keep = contour.segments.map((s, i) => s.c1 || s.via || dist(pts[i], s.to) > 1e-9);
  const segs = contour.segments.filter((_, i) => keep[i]);
  const froms = [];
  { let p = contour.start; for (const s of contour.segments) { froms.push(p); p = s.to; } }
  const fromsKept = froms.filter((_, i) => keep[i]);
  // NB: feed jointTangents the KEPT chain's start — if the first segment was dropped
  // as zero-length, contour.start no longer heads the filtered ring.
  const joints = jointTangents({ start: fromsKept[0] ?? contour.start, segments: segs });
  const pieces = segs.map((s, i) => _offsetSegment(fromsKept[i], s, delta));
  let dirty = pieces.some((p) => p.dirty);
  const n = segs.length;
  const joins = new Array(n).fill(null);   // joins[i] bridges piece[i-1] → piece[i] at vertex i

  for (let i = 0; i < n; i++) {
    const prev = pieces[(i - 1 + n) % n], next = pieces[i];
    const aEnd = prev.segments.at(-1).to, bStart = next.start;
    const { point, inTan, outTan } = joints[i];
    const turn = cross(inTan, outTan);
    const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, inTan[0] * outTan[0] + inTan[1] * outTan[1]))) * 180) / Math.PI;
    if (dist(aEnd, bStart) <= JOIN_EPS || turnDeg < SMOOTH_JOINT_DEG) continue;   // smooth
    if (turn * delta > 0) { joins[i] = joinSegs(point, aEnd, bStart, inTan, outTan, delta, corners); continue; }
    // overlap side: trim when both neighbors are plain lines, else chord + dirty
    const aSeg = prev.segments.at(-1), bSeg = next.segments[0];
    if (!aSeg.via && !aSeg.c1 && !bSeg.via && !bSeg.c1) {
      const X = lineIntersect(aEnd, inTan, bStart, outTan);
      if (X) { aSeg.to = X; next.start = X; continue; }    // exact trim, stays clean
    }
    joins[i] = [{ to: bStart }]; dirty = true;
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(...pieces[i].segments);
    const j = joins[(i + 1) % n];
    if (j) out.push(...j);
  }
  const start = pieces[0].start;
  const last = out.at(-1);
  if (dist(last.to, start) <= JOIN_EPS) last.to = [start[0], start[1]];  // snap the closure exactly
  else out.push({ to: [start[0], start[1]] });
  return { contour: { start, segments: out }, dirty };
}
```

Note the vertex-0 trim case works without special-casing: trimming at vertex 0 rewrites `pieces[0].start` BEFORE assembly reads it, and the closing snap targets the updated start.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/contour-offset.test.js`
Expected: PASS. If the round-join via lands on the wrong side (area shrinks instead of growing), the 180°-fallback sign or the bisector direction is flipped — fix the sign, don't loosen the test.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/contour-offset.js test/contour-offset.test.js
git commit -m "feat: joins and ring walk for native contour offset"
```

---

### Task 3: Raw-result validation (fast-path gate)

**Files:**
- Modify: `src/framework/geometry/contour-offset.js`
- Modify: `test/contour-offset.test.js`

**Interfaces:**
- Consumes: `tessellateContour` (profile.js), `ringArea`, `pointInRing` (shape2d-regions.js).
- Produces: `validateRawOffset(regions) -> boolean` — true when the raw offset result is already valid: every outer still CCW with area > 1e-9, every hole still CW, every hole's sample point inside its outer, no sampled self-intersections within a ring, no crossings between rings.

- [ ] **Step 1: Write failing tests**

```js
import { validateRawOffset } from "../src/framework/geometry/contour-offset.js";

describe("validateRawOffset", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
  test("accepts a clean square with a hole", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]),
      holes: [ring([[4, 4], [4, 6], [6, 6], [6, 4]])] }])).toBe(true);
  });
  test("rejects a self-intersecting (butterfly) ring", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }])).toBe(false);
  });
  test("rejects a flipped (CW) outer", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [0, 10], [10, 10], [10, 0]]), holes: [] }])).toBe(false);
  });
  test("rejects crossing rings", () => {
    expect(validateRawOffset([
      { outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] },
      { outer: ring([[5, 5], [15, 5], [15, 15], [5, 15]]), holes: [] },
    ])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/contour-offset.test.js`
Expected: FAIL — `validateRawOffset` not exported.

- [ ] **Step 3: Implement**

Append to `contour-offset.js` (import `tessellateContour` from `./profile.js`, `ringArea`, `pointInRing` from `./shape2d-regions.js`):

```js
const VALIDATE_SEGS = 32;
const AREA_EPS = 1e-9;

function segsCross(a1, a2, b1, b2) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a1, a2, b1), o2 = o(a1, a2, b2), o3 = o(b1, b2, a1), o4 = o(b1, b2, a2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0; // strict crossings only
}

function ringSelfIntersects(ring) {
  const m = ring.length;
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) {
    if (i === 0 && j === m - 1) continue;                  // adjacent via wraparound
    if (segsCross(ring[i], ring[(i + 1) % m], ring[j], ring[(j + 1) % m])) return true;
  }
  return false;
}

function ringsCross(a, b) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++)
    if (segsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}

// True when a raw offset result is already valid (fast path). Sampled at VALIDATE_SEGS.
export function validateRawOffset(regions) {
  const sampled = regions.map((rg) => ({
    outer: tessellateContour(rg.outer, VALIDATE_SEGS),
    holes: rg.holes.map((h) => tessellateContour(h, VALIDATE_SEGS)),
  }));
  const allRings = [];
  for (const rg of sampled) {
    if (ringArea(rg.outer) <= AREA_EPS) return false;                  // flipped or collapsed outer
    for (const h of rg.holes) {
      if (ringArea(h) >= -AREA_EPS) return false;                      // flipped or collapsed hole
      if (!pointInRing(h[0], rg.outer)) return false;                  // hole escaped its outer
    }
    allRings.push(rg.outer, ...rg.holes);
  }
  for (const r of allRings) if (ringSelfIntersects(r)) return false;
  for (let i = 0; i < allRings.length; i++) for (let j = i + 1; j < allRings.length; j++)
    if (ringsCross(allRings[i], allRings[j])) return false;
  return true;
}
```

- [ ] **Step 4: Run tests, expect PASS; then commit**

```bash
npx vitest run test/contour-offset.test.js
git add src/framework/geometry/contour-offset.js test/contour-offset.test.js
git commit -m "feat: fast-path validation for raw offset results"
```

---

### Task 4: paper-bridge self-resolve (cleanup path)

**Files:**
- Modify: `src/framework/geometry/paper-bridge.js`
- Create: `test/paper-bridge-resolve.test.js`

**Interfaces:**
- Consumes: existing internals `paperScope`, `regionsToCompound`, `groupPaperPathsOriented` (all already in paper-bridge.js).
- Produces: `resolveSelfRegions(regions) -> regions` — self-unites one region list to remove self-intersections, inverted loops, and overlaps; result re-nested and winding-normalized; `[]` when everything cancels. Arcs come back as cubic approximations (paper.js has no arc primitive) — same degradation booleans already apply.

- [ ] **Step 1: Write failing tests**

Create `test/paper-bridge-resolve.test.js`:

```js
// resolveSelfRegions: the offset cleanup stage — paper.js self-union, no WASM.
import { expect, test } from "vitest";
import { resolveSelfRegions } from "../src/framework/geometry/paper-bridge.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea, regionsArea } from "../src/framework/geometry/shape2d-regions.js";

const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });

test("a clean square passes through unchanged", () => {
  const out = resolveSelfRegions([{ outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] }]);
  expect(out.length).toBe(1);
  expect(Math.abs(regionsAreaOf(out))).toBeCloseTo(100, 6);
});

test("a butterfly ring resolves to simple positive lobes", () => {
  // bowtie: edges cross at (5,5); self-union must return simple geometry with the
  // positive lobe area (two triangles of 25 each)
  const out = resolveSelfRegions([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }]);
  expect(out.length).toBeGreaterThanOrEqual(1);
  expect(Math.abs(regionsAreaOf(out))).toBeCloseTo(50, 4);
});

test("overlapping regions merge", () => {
  const out = resolveSelfRegions([
    { outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] },
    { outer: ring([[5, 0], [15, 0], [15, 10], [5, 10]]), holes: [] },
  ]);
  expect(out.length).toBe(1);
  expect(Math.abs(regionsAreaOf(out))).toBeCloseTo(150, 6);
});

test("a fully inverted ring cancels to nothing", () => {
  // CW-only ring (a raw inward offset that flipped): nonzero union drops it
  const out = resolveSelfRegions([{ outer: ring([[0, 0], [0, 10], [10, 10], [10, 0]]), holes: [] }]);
  expect(out).toEqual([]);
});

function regionsAreaOf(regions) {
  let a = 0;
  for (const rg of regions) {
    a += ringArea(tessellateContour(rg.outer, 64));
    for (const h of rg.holes) a += ringArea(tessellateContour(h, 64));
  }
  return a;
}
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `npx vitest run test/paper-bridge-resolve.test.js` → FAIL (`resolveSelfRegions` not exported).

Append to `paper-bridge.js` (below `booleanRegions`, reusing its plumbing):

```js
// Self-resolve one region list: unite it with itself through paper's boolean engine,
// which removes self-intersections, drops winding-inverted loops, and merges overlaps —
// the cleanup stage of the native contour offset (contour-offset.js). Same readback and
// winding normalization as booleanRegions. Empty result → []. NB paper has no arc
// primitive, so arcs return as cubic approximations (arcToCubicSegments) — identical to
// what every boolean already does.
export function resolveSelfRegions(regions) {
  if (regions.length === 0) return [];
  const scope = paperScope();
  try {
    const A = regionsToCompound(scope, regions);
    const out = A.unite(A, { insert: false });
    const paths = (out.className === "CompoundPath" ? out.children : [out])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    if (!paths.length) return [];
    return groupPaperPathsOriented(paths);
  } finally {
    scope.project.clear();
  }
}
```

- [ ] **Step 3: Run tests, expect PASS**

Run: `npx vitest run test/paper-bridge-resolve.test.js`
If the inverted-ring test returns the ring instead of `[]`, paper's `unite` treated the evenodd compound's lone CW child as positive area; fix by pre-filtering: in `resolveSelfRegions`, drop input the union proves empty — check `Math.abs(out.area) <= 1e-9` on the united result and return `[]`. Do not weaken the test.

- [ ] **Step 4: Commit**

```bash
git add src/framework/geometry/paper-bridge.js test/paper-bridge-resolve.test.js
git commit -m "feat: resolveSelfRegions cleanup stage in paper-bridge"
```

---

### Task 5: `offsetRegions` orchestrator + unit corpus

**Files:**
- Modify: `src/framework/geometry/contour-offset.js`
- Modify: `test/contour-offset.test.js`

**Interfaces:**
- Consumes: everything above, plus `closeContourGap` (profile.js), `resolveSelfRegions` (paper-bridge.js).
- Produces: **the public engine** `offsetRegions(regions, delta, { corners = "round" } = {}) -> regions`. Throws the three pinned messages. Extra opts (e.g. `segs`) are silently ignored.

- [ ] **Step 1: Write failing tests**

Append to `test/contour-offset.test.js`:

```js
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { profileArea } from "../src/framework/geometry/contour-ops.js";

const region = (outer, holes = []) => ({ outer, holes });
const sqRegion = (s) => region(sq(s));

describe("offsetRegions", () => {
  test("validates corners and delta with the pinned messages", () => {
    expect(() => offsetRegions([sqRegion(10)], 1, { corners: "bevel" }))
      .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
    expect(() => offsetRegions([sqRegion(10)], NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  });
  test("collapse throws the pinned message", () => {
    expect(() => offsetRegions([sqRegion(10)], -6)).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  });
  test("zero delta returns an equal-area copy", () => {
    const out = offsetRegions([sqRegion(10)], 0);
    expect(profileArea(out)).toBeCloseTo(100, 9);
  });
  test("hole shrinks when the region grows", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }; // CW
    const out = offsetRegions([region(sq(10), [hole])], 1, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(144 - 16, 6);     // hole 2×2 grew to 4×4
  });
  test("hole vanishing under positive delta is absorbed", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] };
    const out = offsetRegions([region(sq(10), [hole])], 2, { corners: "sharp" });
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(196, 6);
  });
  test("dumbbell inset splits into two regions via cleanup", () => {
    const db = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 4] }, { to: [20, 4] }, { to: [20, 0] }, { to: [30, 0] },
      { to: [30, 10] }, { to: [20, 10] }, { to: [20, 6] }, { to: [10, 6] }, { to: [10, 10] },
      { to: [0, 10] }, { to: [0, 0] }] };
    const out = offsetRegions([region(db)], -2, { corners: "sharp" });
    expect(out.length).toBe(2);
    expect(profileArea(out)).toBeCloseTo(72, 4);           // two 6×6 squares
  });
  test("L-shape inset stays on the fast path with exact area", () => {
    const L = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] };
    const out = offsetRegions([region(L)], -2, { corners: "sharp" });
    expect(profileArea(out)).toBeCloseTo(11, 9);
    for (const s of out[0].outer.segments) { expect(s.via).toBeUndefined(); expect(s.c1).toBeUndefined(); }
  });
  test("cusp-producing inward cubic offset yields a simple result", () => {
    const arch = { start: [10, 0], segments: [{ c1: [7, 4], c2: [3, 4], to: [0, 0] }, { to: [10, 0] }] };
    const out = offsetRegions([region(arch)], -0.8, { corners: "round" });
    expect(validateRawOffset(out)).toBe(true);             // output must be simple
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail, then implement**

Append to `contour-offset.js` (import `closeContourGap` from `./profile.js`, `resolveSelfRegions` from `./paper-bridge.js`):

```js
// Region-in / region-out offset: the engine behind Shape2D.offset on BOTH backends.
// Fast path: raw per-ring offsets that validate cleanly are returned as-is (lines/arcs
// exact). Cleanup path: anything dirty or invalid is self-united through paper.js.
export function offsetRegions(regions, delta, { corners = "round" } = {}) {
  if (!["round", "chamfer", "sharp"].includes(corners))
    throw new Error('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
  if (!Number.isFinite(delta)) throw new Error("Shape2D.offset: delta must be a finite number");
  if (delta === 0) return JSON.parse(JSON.stringify(regions));

  let dirty = false;
  const raw = regions.map((rg) => {
    const o = _offsetContour(closeContourGap(rg.outer), delta, corners);
    const hs = rg.holes.map((h) => _offsetContour(closeContourGap(h), delta, corners));
    dirty = dirty || o.dirty || hs.some((h) => h.dirty);
    return { outer: o.contour, holes: hs.map((h) => h.contour) };
  });

  const out = (!dirty && validateRawOffset(raw)) ? raw : resolveSelfRegions(raw);
  if (out.length === 0) throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  return out;
}
```

- [ ] **Step 3: Run the whole unit file, expect PASS**

Run: `npx vitest run test/contour-offset.test.js`
Likely trip points: (a) hole-vanishing case — a flipped hole must fail `validateRawOffset` so cleanup absorbs it (that's why flipped holes return `false` there); (b) dumbbell — the neck butterfly must fail per-ring self-intersection. Debug with `console.log(validateRawOffset(raw))` before reaching for fixes; per repo rule check `docs/ERROR-PATTERNS.md` on anything confusing.

- [ ] **Step 4: Commit**

```bash
git add src/framework/geometry/contour-offset.js test/contour-offset.test.js
git commit -m "feat: offsetRegions orchestrator with fast/cleanup paths"
```

---

### Task 6: Wire into shape2d.js and the Manifold backend

**Files:**
- Modify: `src/framework/geometry/shape2d.js`
- Modify: `src/framework/geometry/manifold-backend.js`
- Modify: `test/shape2d-manifold.test.js`, `test/manifold-backend.test.js` (re-baseline only if needed)

**Interfaces:**
- Consumes: `offsetRegions` from `contour-offset.js`.
- Produces: `makeShape2dFactory({ segs, extrude, revolve })` — the `offsetRegions` dep is GONE. `k._offsetRegions` on the Manifold kernel now delegates to the shared engine.

- [ ] **Step 1: Rewire shape2d.js**

In `src/framework/geometry/shape2d.js`:
- Add `import { offsetRegions } from "./contour-offset.js";`
- Change the factory signature to `export function makeShape2dFactory({ segs, extrude, revolve })`.
- The `offset` entry keeps its exact shape (the `closeContourGap` mapping stays):

```js
offset: (delta, opts = {}) => make(offsetRegions(regions, delta, opts)
  .map((rg) => ({ outer: closeContourGap(rg.outer), holes: rg.holes.map(closeContourGap) }))),
```

- Update the stale comment above it: the hook is gone; note offset now runs shared, like booleans.

- [ ] **Step 2: Delete the Manifold offset route**

In `src/framework/geometry/manifold-backend.js`:
- Delete `resolveOffsetJoin`, `offsetCS`, and the local `offsetRegions` (lines ~56–99) and their comment block.
- Keep `regionPolys` (used by `csFor`).
- Change the factory call to `makeShape2dFactory({ segs, extrude: (o) => kernel.extrude(o), revolve: (o) => kernel.revolve(o) })`.
- Add `import { offsetRegions } from "./contour-offset.js";` and keep the kernel surface: `_offsetRegions: offsetRegions,`.

- [ ] **Step 3: Run the Manifold-side suites**

Run: `npx vitest run test/shape2d-manifold.test.js test/manifold-backend.test.js test/shape2d-hash.test.js test/worker-layering.test.js`

Expected: mostly PASS. Legitimate re-baselines (update expectations, nothing else):
- Round-corner areas become exact (`+πd²`) instead of the polygonized fan — `toBeCloseTo` precisions may need the expected value updated to the closed form.
- The acute-triangle chamfer test (~line 119) pinned the 2-chord Clipper2 bulge; the true bevel is now slightly smaller — update to the exact single-chord value.
- Any test asserting offset output is made of line segments only (tessellated) — offset now preserves arcs.

- [ ] **Step 4: Run the full non-OCCT suite**

Run: `npx vitest run` (OCCT files will still pass — their backend still has its own route until Task 7; nothing imports what we deleted).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/shape2d.js src/framework/geometry/manifold-backend.js test/shape2d-manifold.test.js test/manifold-backend.test.js
git commit -m "feat: Shape2D.offset runs the native engine; delete Manifold Clipper2 route"
```

---

### Task 7: Delete the OCCT offset route; re-baseline OCCT tests

**Files:**
- Modify: `src/framework/geometry/occt-backend.js`
- Modify: `test/shape2d-occt.test.js`, `test/shape2d-occt-adapter.test.js`

- [ ] **Step 1: Delete the OCCT offset machinery**

In `src/framework/geometry/occt-backend.js`:
- Delete `offsetDrawing`, the local `offsetRegions`, `groupOffsetContours`, `negateContourY`, `OFFSET_CLASSIFY_SEGS` (lines ~344–426) and their comments.
- Keep `drawingFromRegions` (extrude/revolve use it) and `contourDrawing`/`drawingFromProfile`.
- Drop now-unused imports: check `svgPathToContours` (only the offset readback used it — `grep -n svgPathToContours src/framework/geometry/occt-backend.js`); also check `pointInRing`/`ringArea`/`reverseContour` usage before removing each import — remove only genuinely orphaned ones.
- Factory call → `makeShape2dFactory({ segs: SHAPE2D_SEGS, extrude: ..., revolve: ... })`.
- `import { offsetRegions } from "./contour-offset.js";` and keep `_offsetRegions: offsetRegions,` on the kernel surface.

- [ ] **Step 2: Run the OCCT suites and re-baseline**

Run: `npx vitest run test/shape2d-occt.test.js test/shape2d-occt-adapter.test.js`

Expected re-baselines:
- **"offset of a curved Shape2D stays exact → STEP has a B_SPLINE"** (~line 115): a circle offset is now exact arcs; the extruded STEP contains `CIRCLE` entities instead. Update the assertion to check for `CIRCLE` (and rename the test: "…stays exact → STEP has a CIRCLE"). If the STEP text contains neither, inspect what `drawingFromRegions` emits for `via` arcs before changing anything else — the fix must keep the test proving *curve* output (assert the STEP does NOT merely contain line segments).
- The **"collapse throws immediately (OCCT)"** test guarded replicad's private `innerShape` field; collapse detection is now shared and kernel-free. Keep the test (same pinned message) but update its comment — it no longer guards a replicad internal.
- Volume/area parity tests should pass unchanged (both backends now share one engine — parity is by construction).

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/framework/geometry/occt-backend.js test/shape2d-occt.test.js test/shape2d-occt-adapter.test.js
git commit -m "feat: delete OCCT offset route; both backends share the native engine"
```

---

### Task 8: Kernel oracle tests

**Files:**
- Create: `test/offset-oracle-manifold.test.js`
- Create: `test/offset-oracle-occt.test.js`

**Interfaces:**
- Consumes: `offsetRegions` (native), `tessellateContour`, raw `manifold-3d` WASM (Manifold file), raw replicad boot (OCCT file — copy the boot preamble from `src/testing/occt.js`).
- Produces: nothing downstream — this is where the deleted kernel routes live on as cross-checks.

**Shared helper (duplicate into BOTH files — they must not share a module that boots anything):**

```js
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const SEGS = 64;
const rings = (regions) => regions.flatMap((rg) =>
  [tessellateContour(rg.outer, SEGS), ...rg.holes.map((h) => tessellateContour(h, SEGS))]);
const totalArea = (rs) => rs.reduce((a, r) => a + ringArea(r), 0);
// one-directional sampled boundary distance: max over a's points of min distance to b's segments
function boundaryDist(a, b) {
  const segDist = (p, q1, q2) => {
    const dx = q2[0] - q1[0], dy = q2[1] - q1[1];
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
    return Math.hypot(p[0] - (q1[0] + t * dx), p[1] - (q1[1] + t * dy));
  };
  let worst = 0;
  for (const ring of a) for (const p of ring) {
    let best = Infinity;
    for (const r2 of b) for (let i = 0; i < r2.length; i++)
      best = Math.min(best, segDist(p, r2[i], r2[(i + 1) % r2.length]));
    worst = Math.max(worst, best);
  }
  return worst;
}
const hausdorff = (a, b) => Math.max(boundaryDist(a, b), boundaryDist(b, a));

// Corpus: name, regions (contour IR), deltas to test. Polygonal + curved cases.
const sq = (s) => ({ outer: { start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] }, holes: [] });
const circ = (r) => ({ outer: { start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] }, holes: [] });
const Lsh = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] }, holes: [] };
const CORPUS = [
  { name: "square", regions: [sq(10)], deltas: [1, -1, 2.5], curved: false },
  { name: "circle", regions: [circ(5)], deltas: [1, -2], curved: true },
  { name: "L-shape", regions: [Lsh], deltas: [1, -1.5], curved: false },
  { name: "square+hole", regions: [{ ...sq(10), holes: [{ start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }] }], deltas: [0.5, -0.5], curved: false },
];
const AREA_RTOL = 0.005;                       // 0.5 %
const HAUS_TOL = (curved) => (curved ? 2e-2 : 5e-3);  // curved: absorb the oracle's own faceting
```

- [ ] **Step 1: Write the Manifold oracle test**

`test/offset-oracle-manifold.test.js` (helper block above, then):

```js
// Oracle: the deleted Manifold/Clipper2 offset route, reconstructed test-locally.
// Compares round + sharp only — chamfer semantics intentionally diverge at acute
// corners now (native does a true bevel; Clipper2 approximated with 2 chords).
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";

let CrossSection;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  CrossSection = wasm.CrossSection;
});

const JOIN = { round: "Round", sharp: "Miter" };
for (const { name, regions, deltas, curved } of CORPUS) {
  for (const delta of deltas) for (const corners of ["round", "sharp"]) {
    test(`${name} delta=${delta} ${corners} matches Clipper2 within tolerance`, () => {
      const native = rings(offsetRegions(regions, delta, { corners }));
      const cs = CrossSection.ofPolygons(rings(regions), "EvenOdd");
      const oracle = cs.offset(delta, JOIN[corners], 2, SEGS).toPolygons();
      expect(Math.abs(totalArea(native) - totalArea(oracle)) / Math.abs(totalArea(oracle))).toBeLessThan(AREA_RTOL);
      expect(hausdorff(native, oracle)).toBeLessThan(HAUS_TOL(curved));
    });
  }
}
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/offset-oracle-manifold.test.js`
Expected: PASS. A failure here is a REAL ENGINE BUG until proven otherwise — investigate the native side first (dump both ring sets, eyeball which one is wrong), and check `docs/ERROR-PATTERNS.md`.

- [ ] **Step 3: Write the OCCT oracle test**

`test/offset-oracle-occt.test.js` — same helper block, plus the replicad boot preamble copied from `src/testing/occt.js` (createRequire / wasmBinary / `setOC`), then rebuild the deleted Drawing route test-locally:

```js
// Oracle: the deleted OCCT/BRepOffsetAPI route, reconstructed test-locally
// (Drawing per region via replicad's draw API, offset, SVG-path readback).
import { beforeAll, expect, test } from "vitest";
import { svgPathToRings } from "../src/framework/geometry/shape2d-regions.js";

let replicad;
beforeAll(async () => {
  // ... boot preamble from src/testing/occt.js (createRequire, wasm init, setOC) ...
  replicad = await import("replicad");
}, 60_000);

// contour IR ring → replicad Drawing (lines + threePointsArcTo for via arcs — the same
// mapping occt-backend's contourDrawing uses; cubics via cubicBezierCurveTo)
function contourToDrawing(c) {
  let d = replicad.draw([c.start[0], c.start[1]]);
  let prev = c.start;
  for (const s of c.segments) {
    if (s.via) d = d.threePointsArcTo([s.to[0], s.to[1]], [s.via[0], s.via[1]]);
    else if (s.c1) d = d.cubicBezierCurveTo([s.to[0], s.to[1]], [s.c1[0], s.c1[1]], [s.c2[0], s.c2[1]]);
    else d = d.lineTo([s.to[0], s.to[1]]);
    prev = s.to;
  }
  return d.close();
}
const drawingOf = (regions) => regions.reduce((acc, rg) => {
  let r = contourToDrawing(rg.outer);
  for (const h of rg.holes) r = r.cut(contourToDrawing(h));
  return acc ? acc.fuse(r) : r;
}, null);
const oracleRings = (regions, delta, lineJoinType) => {
  const out = drawingOf(regions).offset(delta, { lineJoinType });
  return out.toSVGPaths().flat(Infinity).flatMap((d) => svgPathToRings(d, SEGS))
    .map((ring) => ring.map(([x, y]) => [x, -y]));   // toSVGPathD is y-down
};

const JOIN = { round: "round", sharp: "miter" };
for (const { name, regions, deltas, curved } of CORPUS) {
  for (const delta of deltas) for (const corners of ["round", "sharp"]) {
    test(`${name} delta=${delta} ${corners} matches BRepOffsetAPI within tolerance`, () => {
      const native = rings(offsetRegions(regions, delta, { corners }));
      const oracle = oracleRings(regions, delta, JOIN[corners]);
      expect(Math.abs(Math.abs(totalArea(native)) - Math.abs(totalArea(oracle))) / Math.abs(totalArea(oracle))).toBeLessThan(AREA_RTOL);
      expect(hausdorff(native, oracle)).toBeLessThan(HAUS_TOL(curved));
    });
  }
}
```

Check the exact replicad drawing method names against `occt-backend.js`'s `contourDrawing` before running (it is the authoritative IR→Drawing mapping; mirror it exactly, including any y-handling).

- [ ] **Step 4: Run it**

Run: `npx vitest run test/offset-oracle-occt.test.js`
Expected: PASS. The OCCT boot takes ~10s; the `beforeAll` timeout above covers it.

- [ ] **Step 5: Commit**

```bash
git add test/offset-oracle-manifold.test.js test/offset-oracle-occt.test.js
git commit -m "test: kernel oracle cross-checks for the native offset engine"
```

---

### Task 9: Contract, docs, and version bump

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md`
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/ERROR-PATTERNS.md`
- Modify: `test/kernel-contract.test.js`
- Modify: `package.json`

- [ ] **Step 1: Rewrite the KERNEL-CONTRACT offset section**

Read `docs/KERNEL-CONTRACT.md` and find the offset semantics section (grep `offset`). Replace the two-backend description (and the acute-corner bevel divergence note) with the single native semantics:

> `Shape2D.offset(delta, { corners })` runs backend-independently on the contour
> IR. Lines and arcs offset exactly (arcs stay arcs); cubics are approximated to
> ≤ 1e-3 mm deviation. `corners: "round"` inserts exact arc joins, `"chamfer"` a
> true 45°-bisecting bevel chord at every corner angle, `"sharp"` miters with
> limit 2 (falling back to the bevel chord past the limit). Self-intersecting
> raw results are resolved through the shared planar boolean engine, which may
> return arcs as cubic approximations — identical to boolean-op output. Both
> backends produce identical offset geometry by construction. `segs` is
> accepted and ignored.

Bump the contract version header per the file's own convention (read the header and `test/kernel-contract.test.js`'s version pin — update both together; the test file states how they're held in sync).

- [ ] **Step 2: Update AUTHORING-PARTS.md**

Grep `offset` in `docs/AUTHORING-PARTS.md`. Update the Shape2D op table/prose: signature `offset(delta, { corners: "round" | "chamfer" | "sharp" })`; remove `segs` from the documented options; note arcs/lines stay exact and both backends agree.

- [ ] **Step 3: Update ERROR-PATTERNS.md**

Grep `offset` and `innerShape` in `docs/ERROR-PATTERNS.md`:
- Remove/rewrite any pattern tied to the deleted replicad `innerShape` collapse probe or Clipper2-specific offset behavior.
- Ensure a pattern exists for `Shape2D.offset: offset collapses the shape (reduce |delta|)` → cause: |delta| exceeds the shape's inradius (or a hole grew past its outer) → fix: reduce |delta| or offset in stages. Add it if missing, following the file's `##`-per-pattern format.

- [ ] **Step 4: Re-baseline kernel-contract tests and run everything**

Run: `npx vitest run test/kernel-contract.test.js` — update offset rows to the new single semantics (the chamfer square 142.0000 value now holds on both backends; acute-corner rows lose their divergence carve-out).
Then the full suite: `npm test`
Expected: PASS.

- [ ] **Step 5: Bump the version (release gate — do not skip)**

In `package.json`: `"version": "0.57.0"` → `"version": "0.58.0"`. Per the release process this MUST land in the feature PR — forgetting it means the merge silently never ships.

- [ ] **Step 6: Commit**

```bash
git add docs/KERNEL-CONTRACT.md docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md test/kernel-contract.test.js package.json
git commit -m "docs: single canonical offset semantics; bump to 0.58.0"
```

---

### Task 10: End-to-end verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `nvm use && npm test`
Expected: PASS, zero skips introduced by this work.

- [ ] **Step 2: Part-level smoke via the CLI (no browser)**

The bracket part exercises the Shape2D toolkit. Run:

```bash
npx partforge lint src/parts/bracket.js
npx partforge measure src/parts/bracket.js
npx partforge measure src/parts/planter.js
```

Expected: exit 0. `measure` runs each part's `verify` gate against the new offset.

- [ ] **Step 3: Headless app smoke (needs Playwright Chromium)**

Run: `npm run check` (if Playwright isn't installed: `npm i -D playwright && npx playwright install chromium` first).
Expected: exit 0 for all four apps.

- [ ] **Step 4: Grep for leftovers**

```bash
grep -rn "resolveOffsetJoin\|offsetCS\|offsetDrawing\|groupOffsetContours\|negateContourY\|OFFSET_CLASSIFY_SEGS" src/
```

Expected: no matches. Also confirm `grep -rn "segs" docs/AUTHORING-PARTS.md | grep -i offset` shows nothing.

- [ ] **Step 5: Final commit if verification produced fixes**

```bash
git add -A && git commit -m "chore: post-verification cleanup for native contour offset"
```

---

## Self-review notes (already applied)

- Spec coverage: fast path (T2/T3/T5), cleanup path (T4/T5), joins incl. true bevel (T2), collapse (T5), wiring + deletions (T6/T7), oracles (T8), contract/docs/version (T9), invariants (T5 corpus + `validateRawOffset` reuse), attribution (T1 header comment).
- The spec's "invariant assertions" are realized as `validateRawOffset(out)` checks plus the exact-area/structural assertions in the T5 corpus; the round-mode distance band is enforced by the oracle Hausdorff comparisons in T8 (Minkowski property holds for both engines).
- Type consistency: `{ start, segments, dirty }` pieces (T1) consumed by T2; `{ contour, dirty }` (T2) consumed by T5; `offsetRegions` signature identical across T5/T6/T7 wiring and both oracle files.
