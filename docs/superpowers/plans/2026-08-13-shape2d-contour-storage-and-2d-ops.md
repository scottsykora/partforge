# Shape2D Contour Storage + 2D Editing Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `Shape2D` to curve-native contour storage with lazy backend materialization, and add the 2D editing surface (transforms, fillet/chamfer, curve-native readback, queries, corner-preserving simplify, validation).

**Architecture:** `Shape2D` becomes a shared, backend-agnostic value holding regions in the contour IR (`{start, segments:[{to}|{to,via}|{to,c1,c2}]}`); booleans run curve-native in paper.js (shared by both backends), offset stays backend-delegated, and Manifold `CrossSection` / replicad `Drawing` are built lazily at the kernel boundary. The editing ops are pure functions in a new `contour-ops.js` leaf, re-exported through `partforge/geometry`, with `Shape2D` methods delegating to them.

**Tech Stack:** Plain ESM, paper.js (`paper/dist/paper-core.js`, already a dependency), vitest, Manifold + OCCT/replicad WASM kernels.

**Spec:** `docs/superpowers/specs/2026-08-13-shape2d-contour-storage-and-2d-ops-design.md`

## Global Constraints

- **Node 24** — run `nvm use` before anything (`.nvmrc` pins it; the default shell Node is too old and fails confusingly).
- All new geometry modules are **worker-graph leaves**: DOM-free, `three`-free, `node:`-free (`test/worker-layering.test.js` enforces this automatically).
- **Units are millimetres** throughout.
- **OCCT and Manifold must never boot in the same process** — OCCT tests go in their own test files; boot via `bootOcctKernel()` from `src/testing.js`.
- Preserve existing pinned error message wording exactly (e.g. `"Shape2D.offset: offset collapses the shape (reduce |delta|)"`, `"Shape2D.simple: result has N regions, not 1 (use toRegions())"`).
- Never run `npm publish` or tag by hand; the **minor version bump goes in this PR** (Task 17).
- On any confusing build/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.
- Run the suite with `npx vitest run <file>` per task and `npm test` at flip points (Tasks 14, 17).
- Commit after every task; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (end state)

| File | Responsibility |
|---|---|
| `src/framework/geometry/paper-bridge.js` | **New.** paper.js scope + contour ↔ paper Path conversion (with arc→cubic), region boolean engine, grouping. The only module importing paper. |
| `src/framework/geometry/contour-ops.js` | **New.** All pure 2D editing ops (transforms, fillet/chamfer, corners, queries, simplify, validate) + input lifting. Uses paper-bridge for curve math. |
| `src/framework/geometry/shape2d.js` | **New.** Shared `Shape2D` factory: contour-region storage, method delegation, backend hooks (`segs`, `offsetRegions`). |
| `src/framework/geometry/curve-fill.js` | Modified: imports scope/conversion/grouping from paper-bridge; behavior unchanged. |
| `src/framework/geometry/shape2d-regions.js` | Modified: adds `svgPathToContours` (curve-native OCCT readback). |
| `src/framework/geometry/manifold-backend.js` | Modified: `shape2d` uses the shared factory; lazy `csFor` materialization; offset via CrossSection. |
| `src/framework/geometry/occt-backend.js` | Modified: `shape2d` uses the shared factory; lazy `drawingFor`; offset via Drawing with curve-native readback. |
| `src/framework/geometry/kernel.js` | Modified: `SHAPE2D_OPS` + typedef grow. |
| `src/framework/geometry/polygon.js` | Modified: re-exports contour-ops (the `partforge/geometry` surface). |
| `types/geometry.d.ts` | Modified: types for the new surface. |
| `src/parts/gasket.js` + glue | **New.** Reference part. |
| `docs/KERNEL-CONTRACT.md`, `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md` | Modified per spec. |

---

### Task 1: Extract paper-bridge.js from curve-fill.js

**Files:**
- Create: `src/framework/geometry/paper-bridge.js`
- Modify: `src/framework/geometry/curve-fill.js`
- Test: existing `test/curve-fill.test.js` (must stay green), new `test/paper-bridge.test.js`

**Interfaces:**
- Produces: `paperScope()`, `toPaperPath(scope, contour, segMap?)`, `toContour(path)`, `groupPaperPaths(paths)` — exact current semantics from `curve-fill.js:16-68`, now exported from `paper-bridge.js`. `toPaperPath` gains an optional `segMap` array out-param: after the call, `segMap[paperCurveIndex] === ourSegmentIndex` (identity mapping in this task; arcs come in Task 2).

- [ ] **Step 1: Write the new test**

```js
// test/paper-bridge.test.js
import { expect, test } from "vitest";
import { paperScope, toPaperPath, toContour } from "../src/framework/geometry/paper-bridge.js";

test("contour → paper path → contour round-trips lines and cubics", () => {
  const scope = paperScope();
  const ct = { start: [0, 0], segments: [
    { to: [10, 0] },
    { to: [10, 10], c1: [12, 2], c2: [12, 8] },
    { to: [0, 10] },
    { to: [0, 0] },
  ] };
  const back = toContour(toPaperPath(scope, ct));
  expect(back.start).toEqual([0, 0]);
  // implicit straight close: the trailing straight segment back to start is dropped
  expect(back.segments.length).toBe(3);
  expect(back.segments[1].c1[0]).toBeCloseTo(12, 9);
  scope.project.clear();
});

test("segMap is identity for line/cubic contours", () => {
  const scope = paperScope();
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10], c1: [12, 2], c2: [12, 8] }, { to: [0, 0] }] };
  const segMap = [];
  toPaperPath(scope, ct, segMap);
  expect(segMap).toEqual([0, 1, 2]);
  scope.project.clear();
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run test/paper-bridge.test.js`; module doesn't exist)

- [ ] **Step 3: Create `paper-bridge.js` by moving code**

Move, verbatim, from `curve-fill.js`: the `paper` import, `_scope`/`paperScope` (lines 10-19), `toPaperPath` (21-33), `toContour` (35-49), `groupPaperPaths` (53-68). Export all of `paperScope`, `toPaperPath`, `toContour`, `groupPaperPaths`. Add the `segMap` out-param to `toPaperPath`:

```js
export function toPaperPath(scope, contour, segMap = null) {
  const path = new scope.Path({ insert: false });
  path.moveTo(new scope.Point(contour.start[0], contour.start[1]));
  contour.segments.forEach((s, i) => {
    if (s.c1) path.cubicCurveTo(
      new scope.Point(s.c1[0], s.c1[1]),
      new scope.Point(s.c2[0], s.c2[1]),
      new scope.Point(s.to[0], s.to[1]));
    else path.lineTo(new scope.Point(s.to[0], s.to[1]));
    if (segMap) segMap.push(i);
  });
  path.closePath();
  return path;
}
```

(`{to,via}` arc handling lands in Task 2 — this task is a pure move.) Keep the module header comment explaining the lazy private PaperScope rationale (from `curve-fill.js:12-14`).

- [ ] **Step 4: Rewire curve-fill.js**

Delete the moved code from `curve-fill.js`; replace with `import { paperScope, toPaperPath, groupPaperPaths } from "./paper-bridge.js";` (`toContour` is only used by `groupPaperPaths`, which moved). `resolveCurveFill` body is otherwise unchanged.

- [ ] **Step 5: Run both test files — expect PASS**

Run: `npx vitest run test/paper-bridge.test.js test/curve-fill.test.js`

- [ ] **Step 6: Commit** (`git add -A && git commit -m "refactor: extract paper-bridge from curve-fill"`)

---

### Task 2: Arc → cubic conversion in paper-bridge

**Files:**
- Modify: `src/framework/geometry/paper-bridge.js`
- Test: `test/paper-bridge.test.js`

**Interfaces:**
- Produces: `arcToCubicSegments(p0, via, to)` → `[{to, c1, c2}, ...]` (≤90° pieces, exact endpoints); `toPaperPath` now accepts `{to, via}` segments (expanding them via `arcToCubicSegments`, all pieces sharing one `segMap` entry).
- Consumes: circumcircle math pattern from `sampleArc` (`src/framework/geometry/profile.js:65-88`) — same center/sweep-direction recovery, but emitting cubics instead of samples.

- [ ] **Step 1: Write failing tests**

```js
import { arcToCubicSegments } from "../src/framework/geometry/paper-bridge.js";
import { sampleArc } from "../src/framework/geometry/profile.js";

test("quarter-circle arc → single cubic within 1e-4 of the true circle", () => {
  const p0 = [10, 0], via = [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], to = [0, 10];
  const cubics = arcToCubicSegments(p0, via, to);
  expect(cubics.length).toBe(1);
  expect(cubics[0].to).toEqual([0, 10]);
  // max radial deviation from r=10 over sampled t
  let prev = p0;
  for (const seg of cubics) {
    for (let t = 0.1; t < 1; t += 0.1) {
      const p = cubicAt(prev, seg.c1, seg.c2, seg.to, t);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 4);
    }
    prev = seg.to;
  }
});

test("270° arc splits into 3 pieces, endpoint pinned exactly", () => {
  const p0 = [10, 0], via = [-10, 0], to = [0, -10]; // sweep through via
  const cubics = arcToCubicSegments(p0, via, to);
  expect(cubics.length).toBe(3);
  expect(cubics[cubics.length - 1].to).toEqual([0, -10]);
});

test("collinear (degenerate) arc → single straight segment", () => {
  expect(arcToCubicSegments([0, 0], [5, 0], [10, 0])).toEqual([{ to: [10, 0] }]);
});

function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((i) =>
    u*u*u*p0[i] + 3*u*u*t*c1[i] + 3*u*t*t*c2[i] + t*t*t*p1[i]);
}
```

- [ ] **Step 2: Run — expect FAIL** (`arcToCubicSegments` not exported)

- [ ] **Step 3: Implement**

```js
// Circular arc through (p0, via, to) → cubic Bézier segments, ≤90° each, endpoints
// exact. Same circumcircle + sweep-direction recovery as profile.js's sampleArc
// (the sweep is the one passing through `via`); each piece uses the standard
// k = (4/3)·tan(θ/4) control-point offset. Collinear triple → straight segment.
export function arcToCubicSegments(p0, via, to) {
  const [ax, ay] = p0, [bx, by] = via, [cx, cy] = to;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [{ to: [cx, cy] }];
  const sa = ax*ax + ay*ay, sb = bx*bx + by*by, sc = cx*cx + cy*cy;
  const ux = (sa * (by - cy) + sb * (cy - ay) + sc * (ay - by)) / d;
  const uy = (sa * (cx - bx) + sb * (ax - cx) + sc * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const av = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const twoPi = 2 * Math.PI;
  const ccw = (x) => { let v = x % twoPi; if (v < 0) v += twoPi; return v; };
  const dCCW = ccw(a1 - a0), vCCW = ccw(av - a0);
  const dA = vCCW <= dCCW ? dCCW : dCCW - twoPi;
  const pieces = Math.max(1, Math.ceil(Math.abs(dA) / (Math.PI / 2)));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = a0 + dA * (i / pieces), t1 = a0 + dA * ((i + 1) / pieces);
    const dt = t1 - t0, k = (4 / 3) * Math.tan(dt / 4);
    const P = (t) => [ux + r * Math.cos(t), uy + r * Math.sin(t)];
    const s = P(t0), e = P(t1);
    out.push({
      to: e,
      c1: [s[0] - k * r * Math.sin(t0), s[1] + k * r * Math.cos(t0)],
      c2: [e[0] + k * r * Math.sin(t1), e[1] - k * r * Math.cos(t1)],
    });
  }
  out[out.length - 1].to = [cx, cy];   // pin the exact endpoint
  return out;
}
```

Extend `toPaperPath`: in the segment loop, `else if (s.via)` expands `arcToCubicSegments(prev, s.via, s.to)` into consecutive `cubicCurveTo` calls, pushing the SAME index `i` onto `segMap` once per piece, tracking `prev` (start point, then each segment's `to`).

- [ ] **Step 4: Run — expect PASS.** Also add and pass a segMap test: a contour with one `{to,via}` 270° arc between two lines yields `segMap = [0, 1, 1, 1, 2]`.

- [ ] **Step 5: Commit**

---

### Task 3: contour-ops input lifting + winding primitives

**Files:**
- Create: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-lift.test.js`

**Interfaces:**
- Produces (module-internal but exported for tests and later tasks):
  - `liftProfile(input)` → `{ kind: "points"|"contour"|"region"|"regions", regions: [{outer, holes}] }` — every ring normalized to a `{start, segments}` contour (`pointsToContour` for arrays).
  - `restoreProfile(kind, regions)` — inverse container mapping. `"points"` restores to a point array ONLY if every segment is a line; otherwise returns a contour (documented: ops that introduce curves upgrade point-list inputs to contours).
  - `pointsToContour(points)`, `contourIsCCW(contour)`, `reverseContour(contour)`, `ensureRegionWinding(region)` (outer CCW, holes CW).
- Consumes: `isPathContour`, `tessellateContour` from `./profile.js`; `ringArea` from `./shape2d-regions.js`.

- [ ] **Step 1: Write failing tests**

```js
import { liftProfile, restoreProfile, reverseContour, contourIsCCW, ensureRegionWinding }
  from "../src/framework/geometry/contour-ops.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("lifts a point list to one region and restores it", () => {
  const { kind, regions } = liftProfile(sq);
  expect(kind).toBe("points");
  expect(regions.length).toBe(1);
  expect(regions[0].outer.segments.every((s) => !s.c1 && !s.via)).toBe(true);
  expect(restoreProfile(kind, regions)).toEqual(sq);
});

test("lifts contour / region / region-array, preserving container kind", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [5, 8], c1: [10, 4], c2: [8, 8] }, { to: [0, 0] }] };
  expect(liftProfile(ct).kind).toBe("contour");
  expect(liftProfile({ outer: sq, holes: [] }).kind).toBe("region");
  expect(liftProfile([{ outer: sq, holes: [] }]).kind).toBe("regions");
});

test("reverseContour reverses traversal, swaps c1/c2, keeps via; double-reverse is identity", () => {
  const ct = { start: [0, 0], segments: [
    { to: [10, 0] },
    { to: [10, 10], via: [12, 5] },
    { to: [0, 10], c1: [8, 12], c2: [2, 12] },
    { to: [0, 0] },
  ] };
  const rev = reverseContour(ct);
  expect(rev.start).toEqual([0, 0]);              // closed contour: same start point set, walked backwards
  expect(contourIsCCW(rev)).toBe(!contourIsCCW(ct));
  expect(reverseContour(rev)).toEqual(ct);
});

test("ensureRegionWinding forces outer CCW and holes CW", () => {
  const cwSq = { start: [0, 0], segments: [{ to: [0, 10] }, { to: [10, 10] }, { to: [10, 0] }, { to: [0, 0] }] };
  const ccwHole = { start: [2, 2], segments: [{ to: [8, 2] }, { to: [8, 8] }, { to: [2, 8] }, { to: [2, 2] }] };
  const fixed = ensureRegionWinding({ outer: cwSq, holes: [ccwHole] });
  expect(contourIsCCW(fixed.outer)).toBe(true);
  expect(contourIsCCW(fixed.holes[0])).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```js
import { isPathContour, tessellateContour } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";

const WINDING_SEGS = 64;   // tessellation LOD for orientation/containment sampling

export function pointsToContour(points) {
  return { start: [points[0][0], points[0][1]],
    segments: [...points.slice(1).map((p) => ({ to: [p[0], p[1]] })), { to: [points[0][0], points[0][1]] }] };
}

const isPointList = (x) => Array.isArray(x) && x.length > 0 && Array.isArray(x[0]);
const liftContour = (c) => (isPointList(c) ? pointsToContour(c) : c);

export function liftProfile(input) {
  if (input && input._shape2d) return { kind: "regions", regions: input.toContours() };
  if (isPointList(input)) return { kind: "points", regions: [{ outer: pointsToContour(input), holes: [] }] };
  if (isPathContour(input)) return { kind: "contour", regions: [{ outer: input, holes: [] }] };
  if (Array.isArray(input) && input.every((r) => r && r.outer))
    return { kind: "regions", regions: input.map((r) => ({ outer: liftContour(r.outer), holes: (r.holes ?? []).map(liftContour) })) };
  if (input && input.outer)
    return { kind: "region", regions: [{ outer: liftContour(input.outer), holes: (input.holes ?? []).map(liftContour) }] };
  throw new Error("contour-ops: input must be [[x,y],…], a {start,segments} contour, {outer,holes}, or a region array");
}

export function restoreProfile(kind, regions) {
  if (kind === "regions") return regions;
  if (kind === "region") return regions[0];
  const outer = regions[0].outer;
  if (kind === "contour") return outer;
  // "points": only restorable if every segment stayed a straight line
  if (outer.segments.every((s) => !s.c1 && !s.via)) {
    const pts = [outer.start, ...outer.segments.map((s) => s.to)];
    const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(lx - fx, ly - fy) < 1e-9) pts.pop();   // drop the closing duplicate
    return pts;
  }
  return outer;   // curves were introduced — upgrade to a contour
}

export const contourIsCCW = (c) => ringArea(tessellateContour(c, WINDING_SEGS)) >= 0;

export function reverseContour(contour) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  const segments = [];
  for (let i = contour.segments.length - 1; i >= 0; i--) {
    const s = contour.segments[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segments.push(m);
  }
  return { start: [pts[pts.length - 1][0], pts[pts.length - 1][1]], segments };
}

export function ensureRegionWinding(region) {
  return {
    outer: contourIsCCW(region.outer) ? region.outer : reverseContour(region.outer),
    holes: region.holes.map((h) => (contourIsCCW(h) ? reverseContour(h) : h)),
  };
}
```

Note: `liftProfile` on a `Shape2D` calls `toContours()`, which exists from Task 12 onward; until then only raw inputs are exercised — fine, tests don't pass Shape2D yet.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 4: Transforms

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-transform.test.js`

**Interfaces:**
- Produces: `translateProfile(input, [dx,dy])`, `rotateProfile(input, deg, center = [0,0])`, `scaleProfile(input, s, center = [0,0])` (`s`: number or `[sx,sy]`), `mirrorProfile(input, axis)` (`axis: "x" | "y" | {point:[x,y], dir:[dx,dy]}` — `"x"` mirrors across the X axis, i.e. y → −y). All shape-preserving polymorphic (Task 3 lift/restore). Uniform-similarity maps keep `{to,via}` arcs; non-uniform scale converts arcs → cubics via `arcToCubicSegments` before mapping. Mirror/negative-scale re-normalize winding: regions via `ensureRegionWinding`; bare point-list/contour inputs keep their original orientation sense (re-reversed after mapping).

- [ ] **Step 1: Write failing tests**

```js
import { translateProfile, rotateProfile, scaleProfile, mirrorProfile, contourIsCCW }
  from "../src/framework/geometry/contour-ops.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("translate is exact on every segment type and preserves container kind", () => {
  const moved = translateProfile(sq, [5, -2]);
  expect(moved).toEqual([[5, -2], [15, -2], [15, 8], [5, 8]]);
  const ct = { start: [0, 0], segments: [{ to: [10, 0], via: [5, 3] }, { to: [0, 0], c1: [8, -4], c2: [2, -4] }] };
  const m = translateProfile(ct, [1, 1]);
  expect(m.segments[0].via).toEqual([6, 4]);
  expect(m.segments[1].c1).toEqual([9, -3]);
});

test("rotate 90° about a center", () => {
  const r = rotateProfile([[10, 0]], [0, 0]) /* invalid: needs ≥1 point — see below */;
});
// replace the placeholder above with:
test("rotate 90° about the origin maps (10,0) → (0,10)", () => {
  const r = rotateProfile({ start: [10, 0], segments: [{ to: [20, 0] }, { to: [10, 0] }] }, 90);
  expect(r.start[0]).toBeCloseTo(0, 9);
  expect(r.start[1]).toBeCloseTo(10, 9);
});

test("uniform scale keeps arcs as arcs; non-uniform converts them to cubics", () => {
  const ct = { start: [10, 0], segments: [{ to: [-10, 0], via: [0, 10] }, { to: [10, 0] }] };
  expect(scaleProfile(ct, 2).segments[0].via).toBeDefined();
  const stretched = scaleProfile(ct, [2, 1]);
  expect(stretched.segments.some((s) => s.c1)).toBe(true);
  expect(stretched.segments.every((s) => !s.via)).toBe(true);
});

test("mirror re-normalizes region winding (outer stays CCW)", () => {
  const region = { outer: sq, holes: [[[2, 2], [2, 8], [8, 8], [8, 2]]] };
  const m = mirrorProfile(region, "y");
  expect(contourIsCCW(m.outer)).toBe(true);
  expect(contourIsCCW(m.holes[0])).toBe(false);
});

test("mirror on a bare point list preserves its orientation sense and container kind", () => {
  const m = mirrorProfile(sq, "y");
  expect(Array.isArray(m) && Array.isArray(m[0])).toBe(true);
  // sq is CCW; the mirrored result must still traverse CCW
  const ct = { start: m[0], segments: [...m.slice(1).map((p) => ({ to: p })), { to: m[0] }] };
  expect(contourIsCCW(ct)).toBe(true);
});
```

(Delete the intentionally-invalid placeholder test before running; it documents the API only takes contours/regions/point lists.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

One affine core; `M = [a, b, c, d, tx, ty]`, `p' = [a·x + c·y + tx, b·x + d·y + ty]`:

```js
import { arcToCubicSegments } from "./paper-bridge.js";

const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const isSimilarity = (M) => {
  const [a, b, c, d] = M;
  return Math.abs(a * a + b * b - (c * c + d * d)) < 1e-9 && Math.abs(a * c + b * d) < 1e-9;
};

function transformContour(contour, M) {
  const similar = isSimilarity(M);
  const segments = [];
  let prev = contour.start;
  for (const s of contour.segments) {
    if (s.via && !similar) {           // arc under a non-similarity map → cubics first
      for (const piece of arcToCubicSegments(prev, s.via, s.to)) segments.push(piece);
    } else segments.push(s);
    prev = s.to;
  }
  return { start: apply(M, contour.start), segments: segments.map((s) => {
    const m = { to: apply(M, s.to) };
    if (s.via) m.via = apply(M, s.via);
    if (s.c1) { m.c1 = apply(M, s.c1); m.c2 = apply(M, s.c2); }
    return m;
  }) };
}

function transformProfile(input, M) {
  const { kind, regions } = liftProfile(input);
  const flips = M[0] * M[3] - M[1] * M[2] < 0;
  let out = regions.map((rg) => ({ outer: transformContour(rg.outer, M), holes: rg.holes.map((h) => transformContour(h, M)) }));
  if (flips) {
    out = (kind === "region" || kind === "regions")
      ? out.map(ensureRegionWinding)
      // bare inputs: restore the ORIGINAL orientation sense of each ring
      : out.map((rg, i) => ({
          outer: contourIsCCW(rg.outer) === contourIsCCW(regions[i].outer) ? rg.outer : reverseContour(rg.outer),
          holes: rg.holes,
        }));
  }
  return restoreProfile(kind, out);
}

export const translateProfile = (input, [dx, dy]) => transformProfile(input, [1, 0, 0, 1, dx, dy]);
export function rotateProfile(input, deg, center = [0, 0]) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), [cx, cy] = center;
  return transformProfile(input, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
}
export function scaleProfile(input, s, center = [0, 0]) {
  const [sx, sy] = Array.isArray(s) ? s : [s, s];
  if (!(sx !== 0 && sy !== 0) || !Number.isFinite(sx) || !Number.isFinite(sy))
    throw new Error("scaleProfile: scale factors must be finite and non-zero");
  const [cx, cy] = center;
  return transformProfile(input, [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]);
}
export function mirrorProfile(input, axis) {
  if (axis === "x") return transformProfile(input, [1, 0, 0, -1, 0, 0]);
  if (axis === "y") return transformProfile(input, [-1, 0, 0, 1, 0, 0]);
  const { point: [px, py], dir: [ux0, uy0] } = axis;
  const L = Math.hypot(ux0, uy0);
  if (!(L > 0)) throw new Error('mirrorProfile: axis must be "x", "y", or {point, dir} with a non-zero dir');
  const ux = ux0 / L, uy = uy0 / L;
  const a = ux * ux - uy * uy, b = 2 * ux * uy;        // reflection across line through point along dir
  return transformProfile(input, [a, b, b, -a, px - a * px - b * py, py - b * px + a * py]);
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 5: profileCorners + the corner model

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-corners.test.js`

**Interfaces:**
- Produces: `profileCorners(input)`. For a bare contour/point-list: `[{index, point, interiorAngleDeg, convex, segTypes}]` where corner `index` i is the joint entering segment i (corner 0 at `start`), `segTypes` is `["line"|"arc"|"cubic", "line"|"arc"|"cubic"]` (incoming, outgoing). For a region/regions input: entries additionally carry `{regionIndex, ring}` with `ring: "outer" | {hole: n}`. `SMOOTH_JOINT_DEG = 1` exported; joints with tangent deviation below it are omitted. `convex` is material-relative: `convex === (leftTurn === ringIsCCW)`.
- Produces (internal, reused by Task 6): `jointTangents(contour)` → per-vertex `{inTan, outTan, point}` unit vectors.

- [ ] **Step 1: Write failing tests**

```js
import { profileCorners, SMOOTH_JOINT_DEG } from "../src/framework/geometry/contour-ops.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

test("a CCW square has 4 convex 90° corners", () => {
  const corners = profileCorners([[0, 0], [10, 0], [10, 10], [0, 10]]);
  expect(corners.length).toBe(4);
  for (const c of corners) {
    expect(c.interiorAngleDeg).toBeCloseTo(90, 6);
    expect(c.convex).toBe(true);
  }
  expect(corners[0].point).toEqual([0, 0]);
});

test("an L-shape has 5 convex + 1 concave corner", () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const corners = profileCorners(L);
  expect(corners.filter((c) => c.convex).length).toBe(5);
  const cc = corners.find((c) => !c.convex);
  expect(cc.point).toEqual([4, 4]);
  expect(cc.interiorAngleDeg).toBeCloseTo(270, 6);
});

test("a G1 cubic-cubic joint is not a corner (SMOOTH_JOINT_DEG)", () => {
  // Two cubics meeting at (10,0) with a shared tangent direction (0,1):
  const ct = pathProfile([0, 0])
    .cubicTo([10, 0], [4, 0], [10, -6])     // ends heading +Y? — no: choose handles so out-tangent at (10,0) is (10,0)-(10,-6) → +Y
    .cubicTo([0, 10], [10, 6], [6, 10])     // starts heading +Y ((10,6)-(10,0) → +Y)
    .close();
  const corners = profileCorners(ct);
  // the (10,0) joint is smooth; the (0,10)→close→(0,0) joints are corners
  expect(corners.some((c) => c.point[0] === 10 && c.point[1] === 0)).toBe(false);
  expect(SMOOTH_JOINT_DEG).toBe(1);
});

test("hole corners report material-relative convexity", () => {
  const region = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  const holeCorners = profileCorners(region).filter((c) => typeof c.ring === "object");
  expect(holeCorners.length).toBe(4);
  for (const c of holeCorners) expect(c.convex).toBe(true);   // square hole corners are convex into the material? NO —
});
```

Correction for the last test (think it through before coding): for a square hole in a plate, the material around the hole turns the *same* way a convex boss does from the hole's own CW perspective — define and pin it concretely: a square hole's corners are `convex: true` under the material-relative rule (`leftTurn === ringIsCCW`; CW ring, right turns → `false === false` → `true`). Keep the assertion `toBe(true)` and this comment in the test.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```js
export const SMOOTH_JOINT_DEG = 1;

// Unit tangent of segment `s` (from `from`) at its start (dir=+1) or end (dir=-1 → arrival direction).
function segTangent(from, s, atStart) {
  const norm = ([x, y]) => { const L = Math.hypot(x, y) || 1; return [x / L, y / L]; };
  if (s.c1) {
    if (atStart) {
      const d = [s.c1[0] - from[0], s.c1[1] - from[1]];
      return norm(Math.hypot(d[0], d[1]) > 1e-9 ? d : [s.c2[0] - from[0], s.c2[1] - from[1]]);
    }
    const d = [s.to[0] - s.c2[0], s.to[1] - s.c2[1]];
    return norm(Math.hypot(d[0], d[1]) > 1e-9 ? d : [s.to[0] - s.c1[0], s.to[1] - s.c1[1]]);
  }
  if (s.via) {
    // tangent ⊥ radius, oriented along the sweep (recover center like arcToCubicSegments)
    const c = arcCenterAndSweep(from, s.via, s.to);          // {center:[x,y], dA} or null
    if (!c) return norm([s.to[0] - from[0], s.to[1] - from[1]]);
    const p = atStart ? from : s.to;
    const r = [p[0] - c.center[0], p[1] - c.center[1]];
    const t = c.dA >= 0 ? [-r[1], r[0]] : [r[1], -r[0]];
    return norm(t);
  }
  return norm([s.to[0] - from[0], s.to[1] - from[1]]);
}
```

`arcCenterAndSweep(p0, via, to)` extracts the circumcenter + signed sweep from `arcToCubicSegments`' first half — factor that math into a shared exported helper in `paper-bridge.js` (`arcCenterAndSweep`) and have `arcToCubicSegments` use it, rather than duplicating.

```js
export function jointTangents(contour) {  // per vertex i: tangent arriving at and leaving vertex i
  const n = contour.segments.length;
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  return contour.segments.map((_, i) => {
    const prevSeg = contour.segments[(i - 1 + n) % n];
    const prevFrom = pts[(i - 1 + n) % n];
    return {
      point: pts[i],
      inTan: segTangent(prevFrom, prevSeg, false),
      outTan: segTangent(pts[i], contour.segments[i], true),
    };
  });
}

const segType = (s) => (s.c1 ? "cubic" : s.via ? "arc" : "line");

function contourCorners(contour) {
  const ccw = contourIsCCW(contour);
  const n = contour.segments.length;
  const out = [];
  jointTangents(contour).forEach(({ point, inTan, outTan }, i) => {
    const cross = inTan[0] * outTan[1] - inTan[1] * outTan[0];
    const dot = Math.min(1, Math.max(-1, inTan[0] * outTan[0] + inTan[1] * outTan[1]));
    const turnDeg = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
    if (turnDeg < SMOOTH_JOINT_DEG) return;
    const leftTurn = cross > 0;
    out.push({
      index: i, point: [point[0], point[1]],
      interiorAngleDeg: ccw === leftTurn ? 180 - turnDeg : 180 + turnDeg,
      convex: leftTurn === ccw,
      segTypes: [segType(contour.segments[(i - 1 + n) % n]), segType(contour.segments[i])],
    });
  });
  return out;
}

export function profileCorners(input) {
  const { kind, regions } = liftProfile(input);
  if (kind === "points" || kind === "contour") return contourCorners(regions[0].outer);
  const out = [];
  regions.forEach((rg, regionIndex) => {
    for (const c of contourCorners(rg.outer)) out.push({ regionIndex, ring: "outer", ...c });
    rg.holes.forEach((h, hi) => { for (const c of contourCorners(h)) out.push({ regionIndex, ring: { hole: hi }, ...c }); });
  });
  return out;
}
```

Note: a point-list contour's closing segment returns to `start`; `pointsToContour` (Task 3) already emits that closing line explicitly, so vertex 0 gets proper in/out tangents.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 6: filletProfile / chamferProfile — line-line corners, selectors, errors

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-fillet.test.js`

**Interfaces:**
- Produces: `filletProfile(input, r, opts?)`, `chamferProfile(input, dist, opts?)`; `opts.corners`: `"all"` (default) | `"convex"` | `"concave"` | `{indices: number[]}` (with per-corner `r` array allowed) | `{near: [x,y], count: 1}`. For region/regions input, `{indices}` indexes into the flattened `profileCorners(input)` order. Throws `Error` with messages of the exact shape:
  - `` `filletProfile: corner ${i} at (${x}, ${y}): r=${r} does not fit; max ≈ ${maxR}` ``
  - `` `filletProfile: corners ${i} and ${j} overlap on segment ${k} (reduce r)` ``
  - `` `filletProfile: no corner matched selector ${JSON.stringify(sel)}` ``
  (Same shapes for `chamferProfile:` with `dist=`.) Curve-adjacent corners (any `segTypes` entry ≠ `"line"`) throw `filletProfile: corner ${i} involves a curved segment — supported in Task 7` until Task 7 replaces that throw.
- Consumes: `cornerArc(p0, p1, p2, r)` from `./polygon.js:107` — read its implementation first; it returns the corner's arc geometry (`null` when the radius doesn't fit within the adjacent edges) and is the exact math `filletPolygon` already trusts.

- [ ] **Step 1: Read `polygon.js:107-160`** (`cornerArc` + `filletPolygon`) to bind to the actual return fields. `roundedProfile` (`polygon.js:192`) shows how a symbolic `{to, via}` fillet arc is emitted from `cornerArc` output — mirror that emission.

- [ ] **Step 2: Write failing tests**

```js
import { filletProfile, chamferProfile, profileCorners } from "../src/framework/geometry/contour-ops.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("fillet all corners of a square: 4 line + 4 arc segments, area shrinks by 4·(r² − πr²/4)", () => {
  const out = filletProfile(sq, 2);
  expect(out.segments.filter((s) => s.via).length).toBe(4);
  expect(out.segments.filter((s) => !s.via && !s.c1).length).toBe(4);
  const area = ringArea(tessellateContour(out, 256));
  expect(area).toBeCloseTo(100 - 4 * (4 - Math.PI), 2);
});

test('corners:"concave" fillets only the L-shape notch', () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const out = filletProfile(L, 1.5, { corners: "concave" });
  expect(out.segments.filter((s) => s.via).length).toBe(1);
});

test("{near} picks the closest corner; {indices} takes per-corner radii", () => {
  const near = filletProfile(sq, 3, { corners: { near: [9, 9] } });
  expect(near.segments.filter((s) => s.via).length).toBe(1);
  const idx = filletProfile(sq, [1, 2], { corners: { indices: [0, 2] } });
  expect(idx.segments.filter((s) => s.via).length).toBe(2);
});

test("radius that does not fit throws with the max that would", () => {
  expect(() => filletProfile(sq, 6)).toThrow(/corner \d+ at \(.*\): r=6 does not fit; max ≈ 5/);
});

test("adjacent fillets consuming one segment throw an overlap error", () => {
  const thin = [[0, 0], [3, 0], [3, 20], [0, 20]];
  expect(() => filletProfile(thin, 2)).toThrow(/overlap on segment/);
});

test("chamfer emits straight cuts and shrinks area by 4·d²/2", () => {
  const out = chamferProfile(sq, 2);
  expect(out.segments.filter((s) => s.via || s.c1).length).toBe(0);
  expect(out.segments.length).toBe(8);
  expect(ringArea(tessellateContour(out, 8))).toBeCloseTo(100 - 4 * 2, 6);
});

test("empty selector match throws", () => {
  expect(() => filletProfile(sq, 1, { corners: "concave" })).toThrow(/no corner matched/);
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement**

Structure (per ring, working on the lifted contour):

1. `const corners = contourCorners(contour)`; resolve the selector to a set of corner indices + per-corner radius (`resolveSelector(corners, r, opts)` — shared with chamfer; `{near}` sorts by squared distance and takes `count`; throws the no-match error).
2. For each selected corner `i` at vertex between segments `prev = (i−1+n)%n` and `i`: both must be `"line"` (else the Task-7 placeholder throw). Compute setback: interior half-angle `θ/2` from `interiorAngleDeg`, `setback = r / Math.tan(θ/2)` for fillet (`setback = dist` for chamfer). `maxR` for the error message: `Math.tan(θ/2) * min(lenPrev, lenNext)` where the lengths are each adjacent segment's full chord length (`lenPrev`/`lenNext`).
3. Fit check per corner: `setback > min(lenPrev, lenNext) + 1e-9` → throw the does-not-fit error. Overlap check per segment: sum of setbacks claimed at its two ends `> segment length + 1e-9` → throw the overlap error (report the two corner indices and the segment index).
4. Rebuild the ring: walk vertices; at a selected corner replace the vertex with tangent point A on the incoming line (at `setback` before the vertex), the arc `{to: B, via: M}` (B = tangent point on the outgoing line, M = the arc midpoint from `cornerArc`'s circle: center + r in the direction of the corner bisector), and continue. For chamfer, `{to: B}` straight. Trim the two adjacent line segments to A / from B by adjusting their endpoints.
5. Reassemble contours → `restoreProfile`.

Emit arcs symbolically (never facet) exactly the way `roundedProfile` does from `cornerArc`'s fields. Concave corners work with the same math — `cornerArc` handles the reflex side; verify against the `"concave"` test and adjust the bisector sign if `cornerArc` returns null for reflex corners (in that case compute the arc directly: center at `vertex + (r / sin(θ/2)) · bisector`, tangent points at `setback` along each edge, `via` at `center − r · bisector̂` — with `bisector̂` the unit bisector pointing INTO the material for convex, OUT for concave).

- [ ] **Step 5: Run — expect PASS**
- [ ] **Step 6: Commit**

---

### Task 7: Fillet/chamfer at curve-adjacent corners (numeric tangency)

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-fillet-curves.test.js`

**Interfaces:**
- Produces: replaces Task 6's curved-corner throw. Same public signatures; new failure message `` `filletProfile: corner ${i} at (${x}, ${y}): could not fit r=${r} against the curved segment (max ≈ ${maxR})` `` where `maxR` comes from bisection.
- Consumes: `toPaperPath`/`paperScope` from paper-bridge (per-segment open paper paths for evaluation); `jointTangents` from Task 5.

- [ ] **Step 1: Write failing tests**

```js
import { filletProfile, profileCorners, jointTangents } from "../src/framework/geometry/contour-ops.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

// A "tab" whose top edge is a shallow cubic bulge meeting straight sides at corners.
const tab = () => pathProfile([0, 0])
  .lineTo([20, 0])
  .lineTo([20, 10])
  .cubicTo([0, 10], [14, 14], [6, 14])
  .close();

test("filleting a line-curve corner emits an arc and is G1 at both tangency points", () => {
  const out = filletProfile(tab(), 2, { corners: { near: [20, 10] } });
  const arcIdx = out.segments.findIndex((s) => s.via);
  expect(arcIdx).toBeGreaterThan(-1);
  // G1: tangent leaving the trimmed neighbor ≈ tangent entering the arc, at both ends
  const tans = jointTangents(out);
  const dotIn = tans[arcIdx].inTan[0] * tans[arcIdx].outTan[0] + tans[arcIdx].inTan[1] * tans[arcIdx].outTan[1];
  const next = (arcIdx + 1) % out.segments.length;
  const dotOut = tans[next].inTan[0] * tans[next].outTan[0] + tans[next].inTan[1] * tans[next].outTan[1];
  expect(dotIn).toBeGreaterThan(0.9999);
  expect(dotOut).toBeGreaterThan(0.9999);
});

test("curved neighbor is trimmed, not replaced: remaining cubic still ends where the arc starts", () => {
  const out = filletProfile(tab(), 2, { corners: { near: [20, 10] } });
  expect(out.segments.some((s) => s.c1)).toBe(true);   // the bulge survives as a (trimmed) cubic
});

test("oversized radius on a curve corner throws with a computed max", () => {
  expect(() => filletProfile(tab(), 9, { corners: { near: [20, 10] } }))
    .toThrow(/could not fit r=9 .* max ≈ /);
});
```

- [ ] **Step 2: Run — expect FAIL** (Task 6 placeholder throw fires)

- [ ] **Step 3: Implement the tangency solver**

Represent each adjacent segment as an evaluable curve `E = { at(t) → [x,y], tan(t) → unit [x,y] }`:
- line: linear interpolation; constant tangent.
- cubic: de Casteljau eval + derivative (the `cubicAt` pattern from Task 2's test; derivative `3(1−t)²(c1−p0) + 6(1−t)t(c2−c1) + 3t²(p1−c2)`).
- arc `{via}`: angle interpolation via `arcCenterAndSweep`.

Solver, per corner between incoming curve A (approach the corner as t→1) and outgoing curve B (t→0):

```js
// Find (tA, tB) with |A(tA) − C| = |B(tB) − C| = r and C on both inward normals:
//   C(tA) = A(tA) + r·nA(tA),  C(tB) = B(tB) + r·nB(tB),  F(tA,tB) = C(tA) − C(tB) = 0.
// nX(t) is the segment tangent rotated ±90°; the correct signs are the pair for
// which, at the seed (tA=1−ε, tB=ε), both candidate centers land on the corner's
// bisector side (pick the sign combo minimizing |F| at the seed).
// Damped Newton with numeric Jacobian (h = 1e-6), 40 iterations, step clamp 0.25,
// clamped to t ∈ [1e-6, 1−1e-6]; converged when |F| < 1e-9 · max(1, r).
```

Write it exactly like that comment: numeric Jacobian 2×2, solve the linear system by Cramer's rule, halve the step while `|F|` doesn't decrease (max 8 halvings). On convergence: tangency points `TA = A.at(tA)`, `TB = B.at(tB)`, center `C = A.at(tA) + r·nA(tA)`; emit `{to: TB, via: C + r · normalize(midpointDirection)}` where `midpointDirection` bisects the angular span from `TA−C` to `TB−C` on the short way around that passes between the tangency points. Trim: incoming cubic → de Casteljau split at `tA`, keep the first piece (splitting a cubic yields exact cubics); incoming arc → same `{via}` recomputed as the on-circle point at the angular midpoint of the kept sweep; line → move endpoint. Outgoing mirrored.

Non-convergence or `tA/tB` pinned at the clamp → bisect on `r` (12 iterations, `[0, r]`) to find the largest radius that converges, and throw the could-not-fit message with it.

Line-line corners keep Task 6's exact path (do NOT route them through the solver — exactness and speed).

Chamfer at curve corners: same solver structure but simpler — find `tA`, `tB` such that arc-length setbacks along each curve equal `dist` (use paper's `getPointAt(length)` on a per-segment open path for arc-length parameterization; build with `toPaperPath` on a single-segment open contour, `path.closePath()` skipped — add an `{open: true}` option to `toPaperPath` for this), connect `TA → TB` with a straight segment, trim as above.

- [ ] **Step 4: Run — expect PASS.** Also re-run Task 6's file (line-line unchanged): `npx vitest run test/contour-ops-fillet.test.js test/contour-ops-fillet-curves.test.js`

- [ ] **Step 5: Commit**

---

### Task 8: Queries

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`, `src/framework/geometry/paper-bridge.js` (the `{open}` option if not already added in Task 7)
- Test: `test/contour-ops-queries.test.js`

**Interfaces:**
- Produces: `profileLength(contour)`, `profilePointAt(contour, {t}|{length})`, `profileTangentAt(contour, {t}|{length})` — single-contour only; region input throws `` `profilePointAt: pass a single contour (use region.outer / region.holes[i])` `` (same shape for the other two). `profileNearestPoint(input, [x,y])` → `{point, distance, contourIndex, segmentIndex, t}` (accepts everything; `contourIndex` counts outer=0 then holes in order, per region, flattened). `profileBounds(input)` → `{min:[x,y], max:[x,y]}` curve-exact. `profileArea(input)` → outers − holes, curve-exact. `profileContains(input, [x,y])` → boolean (even-odd over outer+holes).

- [ ] **Step 1: Write failing tests**

```js
import { profileLength, profilePointAt, profileTangentAt, profileNearestPoint,
  profileBounds, profileArea, profileContains } from "../src/framework/geometry/contour-ops.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("length / pointAt / tangentAt on a square perimeter", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  expect(profileLength(ct)).toBeCloseTo(40, 9);
  const p = profilePointAt(ct, { t: 0.375 });          // 15mm along → (10, 5)
  expect(p[0]).toBeCloseTo(10, 9); expect(p[1]).toBeCloseTo(5, 9);
  const tan = profileTangentAt(ct, { length: 15 });
  expect(tan[0]).toBeCloseTo(0, 9); expect(tan[1]).toBeCloseTo(1, 9);
});

test("region input to arc-length queries throws", () => {
  expect(() => profilePointAt({ outer: sq, holes: [] }, { t: 0.5 })).toThrow(/single contour/);
});

test("nearestPoint maps back to our segment index through arc expansion", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [0, 4], via: [5, 6] }, { to: [0, 0] }] };
  const near = profileNearestPoint(ct, [5, 8]);
  expect(near.segmentIndex).toBe(1);                    // the arc, despite cubic expansion
  expect(near.distance).toBeGreaterThan(0);
});

test("bounds and area are curve-exact for a cubic circle", () => {
  const KAPPA = 0.5522847498307936, R = 10, k4 = R * KAPPA;
  const circle = { start: [R, 0], segments: [
    { to: [0, R], c1: [R, k4], c2: [k4, R] }, { to: [-R, 0], c1: [-k4, R], c2: [-R, k4] },
    { to: [0, -R], c1: [-R, -k4], c2: [-k4, -R] }, { to: [R, 0], c1: [k4, -R], c2: [R, -k4] },
  ] };
  const b = profileBounds(circle);
  expect(b.max[0]).toBeCloseTo(R, 3);                  // cubic-circle max deviation ~2.7e-4·R
  expect(profileArea(circle)).toBeCloseTo(Math.PI * R * R, 0);
});

test("contains respects holes", () => {
  const region = { outer: sq, holes: [[[3, 3], [7, 3], [7, 7], [3, 7]]] };
  expect(profileContains(region, [1, 1])).toBe(true);
  expect(profileContains(region, [5, 5])).toBe(false);
  expect(profileContains(region, [20, 20])).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

All via the paper bridge inside `try { … } finally { scope.project.clear(); }` blocks:

- `profileLength/PointAt/TangentAt`: reject non-single-contour input (`liftProfile(...).kind` must be `"points"` or `"contour"`); `toPaperPath(scope, contour)` → `path.length`, `path.getPointAt(len)`, `path.getTangentAt(len)`; `{t}` maps to `t * path.length`; clamp `length` to `[0, path.length]`, throw on non-finite.
- `profileNearestPoint`: for each contour of each region (outer, then holes) build path + `segMap` (Task 2), `path.getNearestLocation(new scope.Point(x, y))` → keep the best `loc.distance`; result `{point: [loc.point.x, loc.point.y], distance, contourIndex, segmentIndex: segMap[loc.index], t: loc.time}`.
- `profileBounds`: union of each path's `path.bounds` (paper bounds are curve-exact).
- `profileArea`: Σ|outer path.area| − Σ|hole path.area|.
- `profileContains`: build one `CompoundPath` per region (outer + holes, `fillRule: "evenodd"`), `compound.contains(point)`, OR across regions.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 9: simplifyProfile (corner-preserving)

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-simplify.test.js`

**Interfaces:**
- Produces: `simplifyProfile(input, tolerance)` — shape-preserving polymorphic. Splits each contour at its corners (`SMOOTH_JOINT_DEG`), then per run: pure-line runs get collinear merging only (cross-product < 1e-9 · chord lengths); runs containing a curve are refit by paper `path.simplify(tolerance)` on an OPEN path. Corner points are bit-exact preserved. Arcs come back as cubics (documented).

- [ ] **Step 1: Write failing tests**

```js
import { simplifyProfile, profileCorners } from "../src/framework/geometry/contour-ops.js";

test("collinear line chains merge; corners survive exactly", () => {
  const stair = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [0, 10]];   // two collinear pairs
  const out = simplifyProfile(stair, 0.1);
  expect(out).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test("an over-segmented smooth curve refits to fewer cubics without moving corners", () => {
  // half-circle sampled as 32 line segments between two straight edges
  const pts = [[10, 0], [10, 10]];
  for (let i = 0; i <= 32; i++) { const a = Math.PI * (0.5 - i / 32) * -1 + Math.PI / 2; /* θ from 90°→270° */ }
  // build explicitly instead: arc from (10,10) to (-10,10)? keep it simple —
  const ring = [[10, -10], [10, 0]];
  for (let i = 0; i <= 32; i++) { const a = (Math.PI * i) / 32; ring.push([10 * Math.cos(a), 10 * Math.sin(a)]); }
  ring.push([-10, -10]);
  const before = ring.length;
  const out = simplifyProfile(ring, 0.05);
  const segCount = out.segments.length;
  expect(segCount).toBeLessThan(before / 3);
  expect(out.segments.some((s) => s.c1)).toBe(true);           // refit as cubics
  const corners = profileCorners(out).map((c) => c.point);
  expect(corners).toContainEqual([10, 0]);                      // the line→curve corner survived
});
```

(First test: the pure-line profile stays a point list — `restoreProfile` keeps kind. Second: line input upgraded to a contour because cubics were introduced. The half-circle of 32 chords reads as "smooth" only if adjacent chord turns are < `SMOOTH_JOINT_DEG` — 180°/32 ≈ 5.6° per joint is NOT smooth. Fix the test data: use 256 chords (0.7°/joint) so the sampled arc is below the smooth threshold, and assert `segCount < before / 10`.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

1. Lift; per contour: `contourCorners` → corner indices. Rotate the segment list so it starts at a corner (if any); split into runs between consecutive corners.
2. Per run: if every segment is a line → merge collinear (walk, drop interior vertex when `|cross(v1, v2)| < 1e-9 · |v1| · |v2|`). Else → build an open paper path through the run (`toPaperPath` with `{open: true}`), `path.simplify(tolerance)`, read back with an open-path variant of `toContour` (no wrap-around; emit every curve). Pin the run's first/last anchor back to the exact corner coordinates after simplify (paper may nudge endpoints; overwrite them).
3. Re-join runs; un-rotate; `restoreProfile`.
4. A cornerless contour (a smooth closed loop) simplifies as one closed path (`path.closed = true` before simplify).

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 10: validateProfile

**Files:**
- Modify: `src/framework/geometry/contour-ops.js`
- Test: `test/contour-ops-validate.test.js`

**Interfaces:**
- Produces: `validateProfile(input)` → `{ok: boolean, issues: [{type: "self-intersection"|"winding"|"nesting"|"degenerate", contourIndex, segmentIndex?, point?, message}]}`. Never throws on geometric badness (only on unliftable input). `contourIndex` uses the same flattened numbering as `profileNearestPoint`.
- Consumes: `pointInRing`, `ringArea` from `./shape2d-regions.js`.

- [ ] **Step 1: Write failing tests**

```js
import { validateProfile } from "../src/framework/geometry/contour-ops.js";

test("a clean region validates ok", () => {
  const region = { outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [5, 15], [15, 15], [15, 5]]] };
  expect(validateProfile(region)).toEqual({ ok: true, issues: [] });
});

test("a bowtie self-intersects", () => {
  const bow = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const r = validateProfile(bow);
  expect(r.ok).toBe(false);
  expect(r.issues[0].type).toBe("self-intersection");
  expect(r.issues[0].point[0]).toBeCloseTo(5, 6);
});

test("a CW outer is a winding issue (when passed as an explicit region)", () => {
  const r = validateProfile({ outer: [[0, 0], [0, 10], [10, 10], [10, 0]], holes: [] });
  expect(r.issues.some((i) => i.type === "winding")).toBe(true);
});

test("a hole outside its outer is a nesting issue", () => {
  const r = validateProfile({ outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[20, 20], [22, 20], [22, 22], [20, 22]]] });
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});

test("zero-length segments are degenerate", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
  const r = validateProfile(ct);
  expect(r.issues.some((i) => i.type === "degenerate" && i.segmentIndex === 1)).toBe(true);
});

test("two overlapping outers across regions are a nesting issue", () => {
  const r = validateProfile([
    { outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] },
    { outer: [[5, 5], [15, 5], [15, 15], [5, 15]], holes: [] },
  ]);
  expect(r.issues.some((i) => i.type === "nesting")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Sampling: `sampleForValidation(contour)` — per segment: line → `[to]`; arc/cubic → 8 uniform-parameter points (cubic: `cubicAt` eval; arc: angle interpolation via `arcCenterAndSweep`). Keep, per sampled point, the source `segmentIndex`.

Checks, in order (collect all issues, don't stop at the first):
1. **degenerate** — per segment: chord + control-net length < 1e-9 → issue with `segmentIndex`. Per contour: sampled `|ringArea| < 1e-9` → degenerate contour.
2. **self-intersection** — all sampled edges of ALL contours in ONE region go into a uniform grid (cell = region bbox max-dimension / 64). For each pair sharing a cell: skip edges adjacent in the same contour (sharing an endpoint index ±1, wrap-aware); segment-segment intersection test; on hit, emit issue with the crossing point and the two contour indices (report the first contour's `contourIndex`, mention both in `message`). Cross-region pairs are handled under nesting (below), not here.
3. **winding** — explicit region/regions input only (a bare contour/point list has no declared role): sampled outer `ringArea < 0` or hole `ringArea > 0` → issue.
4. **nesting** — hole's first sample not `pointInRing` its outer's samples → issue. Region pairs: if any sampled vertex of region B's outer is inside region A's outer (and B is not one of A's holes — they're separate regions by construction) → issue `"regions overlap or nest — merge with union() or make it a hole"`.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 11: booleanRegions (the paper.js boolean engine)

**Files:**
- Modify: `src/framework/geometry/paper-bridge.js`
- Test: `test/paper-bridge-boolean.test.js`

**Interfaces:**
- Produces: `booleanRegions(aRegions, bRegions, op)` with `op: "unite" | "subtract" | "intersect"` → region list in contour IR (outer CCW, holes CW — `groupPaperPaths` + a winding-normalization pass using `contourIsCCW`/`reverseContour`… **no** — paper-bridge must not import contour-ops (contour-ops imports paper-bridge; no cycles). Instead normalize winding here with a local signed-area over the returned paper paths: `path.area > 0` in paper's y-down-agnostic terms — use `toContour` then orient by `path.clockwise` BEFORE conversion: force outer paths `counterClockwise` and holes `clockwise` via `path.reverse()` on the paper object, then `toContour`.) Empty result → `[]`.

- [ ] **Step 1: Write failing tests**

```js
import { booleanRegions } from "../src/framework/geometry/paper-bridge.js";

const R = (pts) => ({ outer: { start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) }, holes: [] });
const sq = (x0, y0, s) => R([[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]);
const area = (regions) => regions.reduce((a, rg) => a + Math.abs(ringAreaOf(rg.outer)) - rg.holes.reduce((h, hl) => h + Math.abs(ringAreaOf(hl)), 0), 0);
// ringAreaOf: import tessellateContour from profile.js and ringArea from shape2d-regions.js

test("overlapping union", () => {
  const out = booleanRegions([sq(0, 0, 10)], [sq(5, 0, 10)], "unite");
  expect(out.length).toBe(1);
  expect(area(out)).toBeCloseTo(150, 6);
});

test("COINCIDENT-EDGE union (the bracket.js case): two boxes sharing a full edge", () => {
  const out = booleanRegions([sq(0, 0, 10)], [sq(10, 0, 10)], "unite");
  expect(out.length).toBe(1);
  expect(area(out)).toBeCloseTo(200, 6);
});

test("cut that creates a hole", () => {
  const out = booleanRegions([sq(0, 0, 20)], [sq(5, 5, 10)], "subtract");
  expect(out.length).toBe(1);
  expect(out[0].holes.length).toBe(1);
  expect(area(out)).toBeCloseTo(300, 6);
});

test("cut that removes everything → empty region list", () => {
  expect(booleanRegions([sq(2, 2, 5)], [sq(0, 0, 20)], "subtract")).toEqual([]);
});

test("tangent-touch union (corner contact) stays two regions or one — but never crashes and area is conserved", () => {
  const out = booleanRegions([sq(0, 0, 10)], [sq(10, 10, 10)], "unite");
  expect(area(out)).toBeCloseTo(200, 6);
});

test("curves survive: union of a cubic-circle with a distant square keeps the cubics", () => {
  const KAPPA = 0.5522847498307936, k4 = 10 * KAPPA;
  const circle = { outer: { start: [40, 0], segments: [
    { to: [30, 10], c1: [40, k4], c2: [30 + k4, 10] }, { to: [20, 0], c1: [30 - k4, 10], c2: [20, k4] },
    { to: [30, -10], c1: [20, -k4], c2: [30 - k4, -10] }, { to: [40, 0], c1: [30 + k4, -10], c2: [40, -k4] },
  ] }, holes: [] };
  const out = booleanRegions([sq(0, 0, 10)], [circle], "unite");
  expect(out.length).toBe(2);
  expect(out.flatMap((r) => r.outer.segments).some((s) => s.c1)).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```js
function regionsToCompound(scope, regions) {
  const children = [];
  for (const rg of regions) {
    children.push(toPaperPath(scope, rg.outer));
    for (const h of rg.holes) children.push(toPaperPath(scope, h));
  }
  return new scope.CompoundPath({ children, fillRule: "evenodd" });
}

export function booleanRegions(aRegions, bRegions, op) {
  if (!["unite", "subtract", "intersect"].includes(op)) throw new Error(`booleanRegions: unknown op "${op}"`);
  if (aRegions.length === 0) return op === "unite" ? bRegions.map(cloneRegion) : [];
  if (bRegions.length === 0) return op === "intersect" ? [] : aRegions.map(cloneRegion);
  const scope = paperScope();
  try {
    const A = regionsToCompound(scope, aRegions), B = regionsToCompound(scope, bRegions);
    const out = A[op](B, { insert: false });
    const paths = (out.className === "CompoundPath" ? out.children : [out])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    if (!paths.length) return [];
    const grouped = groupPaperPathsOriented(paths);
    return grouped;
  } finally { scope.project.clear(); }
}
```

`groupPaperPathsOriented` = `groupPaperPaths` (Task 1) with one addition before `toContour`: force `path.clockwise = false` on outers and `= true` on holes (paper's `clockwise` setter reverses in place), so the emitted contours carry the storage winding invariant (outer CCW in y-up model space — note paper y-down vs model y-up flips the meaning of "clockwise"; **decide by area sign of the emitted contour instead**: after `toContour`, tessellate 8 points/seg with a tiny local sampler and shoelace — if outer area < 0, emit `reverseContour`-equivalent locally. To avoid duplicating `reverseContour` in paper-bridge, export it from a tiny shared leaf: **move `reverseContour` + `pointsToContour` into `profile.js`** (it's the IR home; contour-ops re-exports them). Do that move as part of this step and update Task 3's imports.)

`cloneRegion` = deep copy via the same structured copy `toContours` uses (`JSON.parse(JSON.stringify(rg))` is acceptable here — plain number arrays only).

- [ ] **Step 4: Run — expect PASS.** Also run `npx vitest run test/curve-fill.test.js test/contour-ops-lift.test.js` (the `reverseContour` move touched their imports).
- [ ] **Step 5: Commit**

---

### Task 12: Shared Shape2D factory

**Files:**
- Create: `src/framework/geometry/shape2d.js`
- Test: `test/shape2d-storage.test.js` (no WASM — a fake backend)

**Interfaces:**
- Produces: `makeShape2dFactory({ segs, offsetRegions, extrude, revolve })` → `shape2d(profile)` function. `offsetRegions(regions, delta, {corners})` is the backend hook returning a region list (contour IR). The returned Shape2D exposes EXACTLY: `union, cut, cutAll, intersect, offset, area, boundingBox, toRegions, simple, regions, clone, extrude, revolve, translate, rotate, scale, mirror, toContours, fillet, chamfer, simplify, corners, contains` (public), plus `_shape2d: true`, `_regions`, `_hash` (internals). This is the list `SHAPE2D_OPS` becomes in Task 14.
- Consumes: `booleanRegions` (Task 11), contour-ops functions (Tasks 4-10), `addShape2dSugar` (`shape2d-sugar.js`), `assembleRegions` (`shape2d-regions.js`), `tessellateContour` (`profile.js`), `h` (`solid-hash.js`), `liftProfile`/`ensureRegionWinding` (contour-ops).

- [ ] **Step 1: Write failing tests**

```js
import { makeShape2dFactory } from "../src/framework/geometry/shape2d.js";

const deps = {
  segs: 64,
  offsetRegions: (regions, delta) => { calls.push(["offset", delta]); return regions; },
  extrude: (o) => ({ fake: "solid", ...o }),
  revolve: (o) => ({ fake: "solid", ...o }),
};
let calls; let shape2d;
beforeEach(() => { calls = []; shape2d = makeShape2dFactory(deps); });

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("lifts every profile form, is idempotent, and stores winding-normalized contours", () => {
  const s = shape2d(sq);
  expect(shape2d(s)).toBe(s);
  expect(s._regions[0].outer.segments.length).toBe(4);
  const rings = s.toContours();
  expect(rings).not.toBe(s._regions);                    // deep copy
  rings[0].outer.start[0] = 999;
  expect(s._regions[0].outer.start[0]).toBe(0);          // storage untouched
});

test("union is curve-native and backend-free; area/boundingBox are curve-exact", () => {
  const a = shape2d(sq), b = shape2d([[5, 0], [15, 0], [15, 10], [5, 10]]);
  const u = a.union(b);
  expect(u.area()).toBeCloseTo(150, 6);
  expect(u.boundingBox()).toEqual({ min: [0, 0], max: [15, 10] });
  expect(a.area()).toBeCloseTo(100, 6);                  // value semantics — operand untouched
});

test("toRegions tessellates at deps.segs and groups via assembleRegions", () => {
  const s = shape2d({ outer: sq, holes: [[[3, 3], [7, 3], [7, 7], [3, 7]]] });
  const regions = s.toRegions();
  expect(regions.length).toBe(1);
  expect(regions[0].holes.length).toBe(1);
  expect(Array.isArray(regions[0].outer[0])).toBe(true); // point rings, not contours
});

test("transforms, fillet, simplify, corners, contains delegate and return new Shape2D values", () => {
  const s = shape2d(sq);
  const moved = s.translate([5, 5]);
  expect(moved._shape2d).toBe(true);
  expect(moved.boundingBox().min).toEqual([5, 5]);
  expect(s.corners().length).toBe(4);
  const filleted = s.fillet(2, { corners: "convex" });
  expect(filleted.toContours()[0].outer.segments.some((seg) => seg.via)).toBe(true);
  expect(s.contains([5, 5])).toBe(true);
});

test("offset delegates to the backend hook; extrude/revolve route through sugar deps", () => {
  const s = shape2d(sq);
  s.offset(1, { corners: "round" });
  expect(calls).toContainEqual(["offset", 1]);
  expect(s.extrude({ h: 5 }).fake).toBe("solid");
});

test("simple() error message is preserved verbatim", () => {
  const two = shape2d(sq).union(shape2d([[30, 0], [40, 0], [40, 10], [30, 10]]));
  expect(() => two.simple()).toThrow("Shape2D.simple: result has 2 regions, not 1 (use toRegions())");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```js
import { addShape2dSugar } from "./shape2d-sugar.js";
import { assembleRegions } from "./shape2d-regions.js";
import { tessellateContour } from "./profile.js";
import { booleanRegions } from "./paper-bridge.js";
import { h } from "./solid-hash.js";
import { liftProfile, ensureRegionWinding, translateProfile, rotateProfile, scaleProfile,
  mirrorProfile, filletProfile, chamferProfile, simplifyProfile, profileCorners,
  profileArea, profileBounds, profileContains } from "./contour-ops.js";

const deepCopy = (regions) => JSON.parse(JSON.stringify(regions));

export function makeShape2dFactory({ segs, offsetRegions, extrude, revolve }) {
  const liftRegions = (x) => (x && x._shape2d ? deepCopy(x._regions) : liftProfile(x).regions.map(ensureRegionWinding));
  const make = (regions) => {
    const hash = h("shape2d", regions);
    const viaOps = (fn) => make(fn(regions));            // regions-in → regions-out delegation
    const s = {
      _shape2d: true, _regions: regions, _hash: hash,
      union:     (o) => make(booleanRegions(regions, liftRegions(o), "unite")),
      cut:       (o) => make(booleanRegions(regions, liftRegions(o), "subtract")),
      cutAll:    (os) => make(os.reduce((acc, o) => booleanRegions(acc, liftRegions(o), "subtract"), regions)),
      intersect: (o) => make(booleanRegions(regions, liftRegions(o), "intersect")),
      offset:    (delta, opts = {}) => make(offsetRegions(regions, delta, opts)),
      area:      () => profileArea(regions),
      boundingBox: () => profileBounds(regions),
      toRegions: () => assembleRegions(regions.flatMap((rg) =>
        [tessellateContour(rg.outer, segs), ...rg.holes.map((hl) => tessellateContour(hl, segs))])),
      toContours: () => deepCopy(regions),
      clone:     () => make(deepCopy(regions)),
      translate: (v) => viaOps((r) => translateProfile(r, v)),
      rotate:    (deg, center) => viaOps((r) => rotateProfile(r, deg, center)),
      scale:     (f, center) => viaOps((r) => scaleProfile(r, f, center)),
      mirror:    (axis) => viaOps((r) => mirrorProfile(r, axis)),
      fillet:    (r, opts) => viaOps((rg) => filletProfile(rg, r, opts)),
      chamfer:   (d, opts) => viaOps((rg) => chamferProfile(rg, d, opts)),
      simplify:  (tol) => viaOps((r) => simplifyProfile(r, tol)),
      corners:   () => profileCorners(regions),
      contains:  (p) => profileContains(regions, p),
    };
    return addShape2dSugar(s, { shape2d, extrude, revolve });
  };
  const shape2d = (profile) => (profile && profile._shape2d ? profile : make(liftRegions(profile)));
  return shape2d;
}
```

Notes: `offsetRegions` must validate its own `corners` option and throw the preserved messages (backends do, Task 13). `liftProfile` handles `_shape2d` inputs via `toContours` (Task 3) — with the factory that path now actually runs.

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

### Task 13: Backend adapters (materialization + offset), not yet flipped

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (add `csForRegions`, `manifoldOffsetRegions` — exported for tests via the kernel's internals? No: attach to nothing yet; define and export as named module exports `_csForRegions` is not possible per-kernel-instance… **define them inside `createManifoldKernel` and expose for tests as `k._offsetRegions` — `_`-prefixed = backend-internal, allowed by the contract tests' `publicKeys` filter**)
- Modify: `src/framework/geometry/occt-backend.js` (same pattern: `k._offsetRegions`)
- Modify: `src/framework/geometry/shape2d-regions.js` (add `svgPathToContours`)
- Test: `test/shape2d-regions-contours.test.js`, `test/shape2d-manifold-adapter.test.js`, `test/shape2d-occt-adapter.test.js` (**OCCT: own file**)

**Interfaces:**
- Produces:
  - `svgPathToContours(d)` (shape2d-regions.js) → contour array from an absolute `M L C Q A Z` path string: `C` stays cubic, `Q` degree-elevates (the existing math at `shape2d-regions.js:119-124`), `A` → cubic segments via a new local `svgArcToCubics(from, rx, ry, rotDeg, largeArc, sweep, to)` (center parameterization exactly as `sampleSvgArc`, `shape2d-regions.js:63-98`, but emitting ≤90° cubic pieces with `k = (4/3)tan(dθ/4)` in the ellipse's rotated frame). Throws on other commands (same message pattern as `svgPathToRings`).
  - Manifold `k._offsetRegions(regions, delta, {corners, segs})`: tessellate regions at kernel segs → `CrossSection.ofPolygons` (T-tracked) → the EXACT current offset logic (`manifold-backend.js:79-98`, including the corners validation, join-type table, and collapse throw, wording preserved) → `assembleRegions(out.toPolygons())` → convert each ring to a line contour (`pointsToContour`) → `[{outer, holes}]`.
  - OCCT `k._offsetRegions(regions, delta, {corners})`: per-region `contourDrawing` outer, `.cut` holes, fuse regions → the EXACT current offset logic (`occt-backend.js:390-403`, wording preserved) → `result.toSVGPaths().flat(Infinity)` → `svgPathToContours` per d-string → y-negate every coordinate (start/to/via/c1/c2) → classify by containment depth parity (sample each contour with `tessellateContour(c, 32)`, count containment via `pointInRing` of first sample in other contours' samples, even depth = outer) → orient with `reverseContour` to outer-CCW/hole-CW → group holes into their smallest containing outer → region list.
- Consumes: `pointsToContour`, `reverseContour` (now in `profile.js` per Task 11), `contourDrawing`/`draw` internals already in each backend.

- [ ] **Step 1: Write failing tests**

```js
// test/shape2d-regions-contours.test.js  (pure, no WASM)
import { svgPathToContours } from "../src/framework/geometry/shape2d-regions.js";

test("M/L/C parse to line + cubic segments, Z closes the ring", () => {
  const cts = svgPathToContours("M 0 0 L 10 0 C 12 2 12 8 10 10 L 0 10 Z");
  expect(cts.length).toBe(1);
  expect(cts[0].start).toEqual([0, 0]);
  expect(cts[0].segments[1]).toEqual({ to: [10, 10], c1: [12, 2], c2: [12, 8] });
});

test("A becomes cubics that stay on the circle", () => {
  const cts = svgPathToContours("M 10 0 A 10 10 0 0 1 -10 0 L 10 0 Z"); // half circle r=10
  const arcSegs = cts[0].segments.filter((s) => s.c1);
  expect(arcSegs.length).toBe(2);                         // 180° → two ≤90° pieces
  for (const s of arcSegs) for (const p of [s.c1, s.c2]) expect(Math.hypot(p[0], p[1])).toBeLessThan(11.2); // control net near circle
});
```

```js
// test/shape2d-manifold-adapter.test.js
import { bootManifoldKernel } from "../src/testing.js";
let k; beforeAll(async () => { k = await bootManifoldKernel(); });

test("_offsetRegions grows a square and returns line-contour regions", () => {
  const sq = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, holes: [] };
  const out = k._offsetRegions([sq], 1, { corners: "sharp" });
  expect(out.length).toBe(1);
  expect(out[0].outer.segments.every((s) => !s.c1 && !s.via)).toBe(true);
});

test("_offsetRegions collapse throws the preserved message", () => {
  const sq = { outer: { start: [0, 0], segments: [{ to: [4, 0] }, { to: [4, 4] }, { to: [0, 4] }, { to: [0, 0] }] }, holes: [] };
  expect(() => k._offsetRegions([sq], -3, {})).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
});
```

```js
// test/shape2d-occt-adapter.test.js  (OWN FILE — boots OCCT)
import { bootOcctKernel } from "../src/testing.js";
let k; beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("_offsetRegions on OCCT reads back curve-native contours (round corners are curves, not facet fans)", () => {
  const sq = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, holes: [] };
  const out = k._offsetRegions([sq], 2, { corners: "round" });
  expect(out.length).toBe(1);
  const segs = out[0].outer.segments;
  expect(segs.some((s) => s.c1)).toBe(true);              // rounded corners came back as cubics
  expect(segs.length).toBeLessThan(30);                   // NOT a 64-gon fan
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** as specified in Interfaces. In the Manifold kernel, add `_offsetRegions` to the returned kernel object; in OCCT likewise. Both reuse their existing offset code paths (extract the current `offset` closure bodies into these functions; the OLD `wrapShape2d.offset` now calls the extracted logic too, so behavior is single-sourced ahead of the flip).

- [ ] **Step 4: Run — expect PASS** (`npx vitest run test/shape2d-regions-contours.test.js test/shape2d-manifold-adapter.test.js test/shape2d-occt-adapter.test.js`)
- [ ] **Step 5: Run the full suite** (`npm test`) — old Shape2D behavior must be untouched.
- [ ] **Step 6: Commit**

---

### Task 14: The flip — both backends adopt the shared Shape2D

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js`, `src/framework/geometry/occt-backend.js`, `src/framework/geometry/kernel.js`, `docs/KERNEL-CONTRACT.md`
- Test: whole suite; targeted updates listed below

**Interfaces:**
- Consumes: `makeShape2dFactory` (Task 12), `_offsetRegions` (Task 13).
- Produces: `SHAPE2D_OPS` = `["union","cut","cutAll","intersect","offset","area","boundingBox","toRegions","simple","regions","clone","extrude","revolve","translate","rotate","scale","mirror","toContours","fillet","chamfer","simplify","corners","contains"]`; backends' `shape2d` returns the shared value; Manifold `extrude`/`revolve` and OCCT `extrude`/`revolve` materialize lazily.

- [ ] **Step 1: Manifold flip**

Delete `wrapShape2d`, `cachedCS`, `liftCS` (`manifold-backend.js:56-111`). Replace:

```js
const shape2d = makeShape2dFactory({
  segs,
  offsetRegions: (regions, delta, opts) => offsetRegionsImpl(regions, delta, opts),  // Task 13's function
  extrude: (o) => kernel.extrude(o),
  revolve: (o) => kernel.revolve(o),
});
// Lazy CrossSection materialization, memoized through the solid cache by content hash.
const csFor = (shape) => cache.lookup(h("cs2d", shape._hash, segs), () => {
  const polys = shape._regions.flatMap((rg) =>
    [tessellateContour(rg.outer, segs), ...rg.holes.map((hl) => tessellateContour(hl, segs))]);
  const cs = T(CrossSection.ofPolygons(polys, "EvenOdd"));
  return { value: cs, pin: cs, dispose: () => cs.delete?.() };
});
```

Update consumers: `extrude` (`manifold-backend.js:276-285`) — `const cs = shape ? csFor(shape) : (tessellate as today)`; hash key stays `shape._hash`-based. `revolve` (`:311-312`) — `csFor(pts)` instead of `pts._cs`.

- [ ] **Step 2: OCCT flip**

Delete `wrapShape2d`/`liftDrawing`/`drawingRegionRings`-based Shape2D (`occt-backend.js:330-410`), keeping `contourDrawing`, `drawingFromProfile`, and `svgPathToRings` usage for any remaining internal callers. Replace:

```js
const shape2d = makeShape2dFactory({
  segs: SHAPE2D_SEGS,                                  // 64 — preserves today's toRegions LOD
  offsetRegions: occtOffsetRegionsImpl,                // Task 13's function
  extrude: (o) => kernel.extrude(o),
  revolve: (o) => kernel.revolve(o),
});
const drawingFor = (shape) => shape._regions
  .map((rg) => { let d = contourDrawing(rg.outer); for (const hl of rg.holes) d = d.cut(contourDrawing(hl)); return d; })
  .reduce((a, b) => a.fuse(b));
```

Update consumers: `extrude` (`occt-backend.js:438-447`) — `profile._shape2d ? drawingFor(profile) : drawingFromProfile(profile)` (drop the `.clone()` on the materialized drawing only if `drawingFor` builds fresh each call — it does, so no clone needed; note that in a comment). `revolve` (`:429`) — same substitution.

- [ ] **Step 3: Contract update**

`kernel.js`: new `SHAPE2D_OPS` (list above); extend the Shape2D typedef with the ten new methods (one line each, mirroring the Solid transform wording; `toContours(): () => {outer:contour, holes:contour[]}[]` noted as "curve-native, lossless"). `docs/KERNEL-CONTRACT.md`: bump the minor discussed in its Versioning section is prose — the machine header `**Contract version: 1**` stays (additive change, no breaking bump); add the new ops to the Shape2D table; rewrite the Shape2D section to document contour storage, lazy materialization, paper.js booleans (backend-identical), the offset carve-out, and the fillet-after-boolean STEP note.

- [ ] **Step 4: Consumption-site sweep**

`grep -rn "_cs\b\|_drawing\|_shape2d" src/` — fix every hit outside the two backends: `hull.js:16` (uses public `toRegions()` — fine), `op-options.js:241` (read it; it normalizes a Shape2D `profile` — verify it only touches public methods/`_shape2d`), and any missed site.

- [ ] **Step 5: Full suite + fix fallout**

Run: `npm test`. Expected classes of fallout, fix each: (a) `kernel-contract.test.js` / `occt-backend.test.js` "exactly the documented surface" — green once `SHAPE2D_OPS` matches; (b) area/volume assertions that pinned tessellation-LOD area values (area is now curve-exact) — loosen only with justification in the diff; (c) tests reaching into `_cs`/`_drawing` — rewrite against public surface. The offset-collapse message tests must pass UNCHANGED (wording preserved in Task 13).

- [ ] **Step 6: Run the browser smoke check** (`npm run check`) — boots the demo app end-to-end.
- [ ] **Step 7: Commit**

---

### Task 15: Cross-backend identity + STEP CIRCLE fidelity tests

**Files:**
- Test: `test/shape2d-parity-manifold.test.js`, `test/shape2d-parity-occt.test.js` (own OCCT file), fixture `test/fixtures/shape2d-boolean-golden.json`

**Interfaces:**
- Consumes: public Shape2D surface only.

- [ ] **Step 1: Generate the golden fixture**

A tiny script-in-test: in the MANIFOLD parity file, compute `k.shape2d(A).union(B).cut(C).toContours()` for a fixed input set (two overlapping rounded profiles + a cubic-bulge tab from `pathProfile`), and `JSON.stringify` it into `test/fixtures/shape2d-boolean-golden.json` ONCE (write the file manually from the test's logged output, then commit it — the test asserts against the committed fixture, it does not regenerate).

- [ ] **Step 2: Both parity files assert**

```js
const golden = JSON.parse(readFileSync(new URL("./fixtures/shape2d-boolean-golden.json", import.meta.url), "utf8"));
test("boolean chain matches the shared-engine golden result exactly", () => {
  const out = k.shape2d(A).union(k.shape2d(B)).cut(k.shape2d(C)).toContours();
  expect(out).toEqual(golden);        // backend-identical BY CONSTRUCTION — exact, not toleranced
});
```

(Same fixture, same assertion, in the OCCT file. This is the "parity strengthened from tolerance to identity" requirement.)

- [ ] **Step 3: STEP CIRCLE test (OCCT file)**

```js
test("fillet arcs reach STEP as CIRCLE entities", async () => {
  const plate = k.shape2d([[0, 0], [30, 0], [30, 20], [0, 20]]).fillet(4);
  const solid = k.extrude({ profile: plate, h: 3 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "plate", solid }]));
  expect(step).toMatch(/\bCIRCLE\b/);
});
```

- [ ] **Step 4: Run both files; commit.**

---

### Task 16: partforge/geometry surface, types, contract-doc helpers

**Files:**
- Modify: `src/framework/geometry/polygon.js` (append re-exports), `types/geometry.d.ts`, `docs/KERNEL-CONTRACT.md`
- Test: `test/kernel-contract.test.js` (existing assertions do the enforcement)

- [ ] **Step 1:** Append to `polygon.js`:

```js
export { translateProfile, rotateProfile, scaleProfile, mirrorProfile,
  filletProfile, chamferProfile, profileCorners,
  profileLength, profilePointAt, profileTangentAt, profileNearestPoint,
  profileBounds, profileArea, profileContains,
  simplifyProfile, validateProfile } from "./contour-ops.js";
```

- [ ] **Step 2:** `types/geometry.d.ts` — declare each with the signatures from the spec's API table (`ProfileInput = number[][] | Contour | Region | Region[]`; ops generic over input kind is fine as `ProfileInput → ProfileInput`; queries typed precisely).

- [ ] **Step 3:** `docs/KERNEL-CONTRACT.md` — add every re-exported name in backticks to the 2-D helper section (the `kernel-contract.test.js` "names every partforge/geometry helper" test enforces this; run it to find misses).

- [ ] **Step 4:** Run: `npx vitest run test/kernel-contract.test.js` — PASS. Commit.

---

### Task 17: Docs, error patterns, reference part, version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `package.json`
- Create: `src/parts/gasket.js`, `gasket.html`, `src/app-gasket.js`, `src/gasket-worker.js`
- Test: `test/gasket-part.test.js`

- [ ] **Step 1: `docs/AUTHORING-PARTS.md` — "Editing profiles" section** after the existing "2-D booleans" section: the op tables from the spec, the polymorphic input contract, corner selectors with a `profileCorners` example, the two rules called out in bold (**fillet after booleans if STEP CIRCLE fidelity matters** — booleans are cubic-only; **run `validateProfile` after mutations** — fillet doesn't check global self-intersection), and the Shape2D method list.

- [ ] **Step 2: `docs/ERROR-PATTERNS.md` entries** (one `##` per pattern, literal-symptom → cause → fix):
  - `## filletProfile: … does not fit; max ≈` → radius exceeds corner capacity → use the reported max or select fewer corners.
  - `## filletProfile: corners … overlap on segment` → adjacent fillets consume one edge → reduce r or fillet one of the two.
  - `## profilePointAt: pass a single contour` → region passed to an arc-length query → use `region.outer` / `region.holes[i]`.
  - `## regions overlap or nest — merge with union()` → two regions occupy the same area → union them or restructure as holes.

- [ ] **Step 3: `src/parts/gasket.js`** — a `PartDefinition` (copy the structure from `src/parts/bracket.js`): params `w, h, boltR, cornerR, clearance`; build: `pathProfile` outline with one cubic bulge edge → `k.shape2d` → `.union` two bolt tabs (`circleProfile` centers on the outline edge — the coincident-edge case) → `.fillet(p.cornerR, { corners: "convex" })` → `.cut` bolt holes → `.offset(p.clearance)` when non-zero → `.extrude({ h: p.h })`. `verify` block asserts via `toContours` (segment kinds present) and `profileCorners` count. Wire the three glue files exactly per the demo pattern (worker `new Worker(new URL(...))` inline).

- [ ] **Step 4: `test/gasket-part.test.js`** — build on Manifold, assert `volume() > 0`, `genus()` equals the bolt-hole count, and `validateProfile(part-built profile)` ok via re-running the build's 2D steps as pure functions.

- [ ] **Step 5: Version bump** — `npm version minor --no-git-tag-version` (bump lands in the PR; publish is automatic on merge — never `npm publish`).

- [ ] **Step 6: Full gate** — `npm test`, then `npm run check`, then `node scripts/check-app.mjs gasket.html` if the part page is registered as dev-only (skip if not in `rollupOptions.input` — it isn't; CI smoke list stays at four).

- [ ] **Step 7: Commit.**

---

## Self-Review (performed)

- **Spec coverage:** storage refactor (T12-14), paper booleans + coincident-edge tests (T11), offset carve-out (T13), toContours lossless (T12), transforms + winding (T4), fillet/chamfer + selectors + errors (T6-7), corners (T5), queries (T8), simplify (T9), validate (T10), OCCT curve readback (T13), STEP CIRCLE (T15), identity parity (T15), contract/docs/types (T14, T16), ERROR-PATTERNS + AUTHORING-PARTS (T17), gasket (T17), version bump (T17). No gaps found.
- **Consistency notes for implementers:** `reverseContour`/`pointsToContour` move to `profile.js` in Task 11 (paper-bridge may not import contour-ops); Tasks 3-10 import them from `contour-ops.js` until then — Task 11 updates those imports. `arcCenterAndSweep` is factored into paper-bridge in Task 5. Task 12's Shape2D key list is the Task 14 `SHAPE2D_OPS` verbatim.
- **Known judgment calls pinned:** hole-corner convexity convention (Task 5), `"points"`-kind restoration upgrade rule (Task 3), Manifold `toRegions` LOD stays kernel-segs / OCCT stays 64 (Tasks 12/14).
