# loftSmooth v2 (curve-native emission) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `k.loftSmooth` emits cubic-Bézier curve rings on both backends (STEP-exact around each ring), accepts curve contours and `sharp` corner tags on control sections, and supports `closed:true` loops on Manifold.

**Architecture:** All new math lives in the pure leaf `src/framework/geometry/loft-smooth.js`: sections resolve to *points + corner indices*, arcs between corresponding corners are resampled with clamped open Catmull-Rom, the v1 cross-station CR interpolates the vertices (gaining a periodic mode for `closed`), and every emitted station is fitted back to an all-cubic contour by exact 4-point Bézier inversion. Both backends then just call `k.loft` in its existing curve mode (`kernel-front.js` composition).

**Tech Stack:** Plain ESM, vitest, Manifold + OCCT/replicad WASM kernels (Node 24).

**Spec:** `docs/superpowers/specs/2026-08-25-loft-smooth-v2-design.md` — the binding authority; read it before any task.

## Global Constraints

- **Node 24**: the sandbox blocks `source nvm.sh` — prefix every shell with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- `loft-smooth.js` stays a **pure, DOM-free, `three`-free, `node:`-free leaf** (worker graph; `test/worker-layering.test.js` enforces).
- **Frozen error strings** are exact — copy them verbatim from the spec §5 / this plan; tests pin them.
- **CONTRACT_VERSION stays 4**; version bump to **0.85.0** happens in Task 7 only.
- OCCT and Manifold must never boot in the same test file.
- Commit convention: `git -c core.hooksPath=/dev/null commit`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- On any confusing failure, grep `docs/ERROR-PATTERNS.md` first.
- Run the full suite (`npx vitest run`) before each task's final commit; a handful of heavy files (offset-fuzz, contour-cleanup, mesh-roundall) are known load-sensitive flakes — rerun them in isolation before treating a timeout as real.

---

### Task 1: Around-ring model — corners, curve sections, per-arc reconciliation

Emission stays v1 point rings in this task; only resolution and around-ring resampling change.

**Files:**
- Modify: `src/framework/geometry/loft-smooth.js`
- Test: `test/loft-smooth.test.js`

**Interfaces:**
- Consumes: `isArcContour`, `sampleArc`, `sampleBezier`, `closeContourGap` from `./profile.js`; `profileCorners` from `./contour-ops.js`; `LOFT_SEGS` from `./loft-rings.js` (all existing exports; all pure).
- Produces (later tasks rely on these exact names):
  - `resolveSections(sections)` (internal) → `[{ pts2d: number[][], corners: number[], z: number }]` — corners sorted ascending, corner 0 rotated to vertex index 0.
  - `reconcile(resolved, V)` (internal) → `{ rings: number[][][], corners: number[] }` — every ring has the same length (`V` raised to the corner count), `corners[j]` is the shared output vertex index of corner `j` (corner 0 at 0).
  - `export function resampleOpenArc(pts, spans)` → `spans + 1` points, endpoints exact.
  - `smoothLoftRings(sections, { stations, samples })` — signature unchanged, still returns `[{ polygon: number[][], z }]` for now.

- [ ] **Step 1: Write the failing tests** — append to `test/loft-smooth.test.js`:

```js
import { smoothLoftRings, resampleClosedSpline, resampleOpenArc } from "../src/framework/geometry/loft-smooth.js";
import { pathProfile } from "../src/framework/geometry/profile-lib.js"; // if absent, build the contour literal below instead

test("resampleOpenArc interpolates its endpoints exactly and is monotone in count", () => {
  const arc = [[0, 0], [4, 3], [8, 3], [12, 0]];
  const out = resampleOpenArc(arc, 6);
  expect(out.length).toBe(7);
  expect(out[0]).toEqual([0, 0]);
  expect(out[6]).toEqual([12, 0]);
});

test("sharp tags survive reconciliation: tagged vertices appear at the same index in every ring", () => {
  // Two squares with all four corners tagged — corners must sit at identical shared indices.
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const rings = smoothLoftRings(
    [{ polygon: sq(10), sharp: [0, 1, 2, 3], z: 0 }, { polygon: sq(6), sharp: [0, 1, 2, 3], z: 10 }],
    { stations: 5, samples: 32 });
  for (const r of rings) {
    expect(r.polygon.length).toBe(32);
    // 4 equal arcs of a square → corners at 0, 8, 16, 24; corner positions lie on the square's diagonals
    for (const idx of [0, 8, 16, 24]) {
      const [x, y] = r.polygon[idx];
      expect(Math.abs(Math.abs(x) - Math.abs(y))).toBeLessThan(1e-6);
    }
  }
});

test("sharp corners are interpolated exactly at control stations", () => {
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const rings = smoothLoftRings(
    [{ polygon: sq(10), sharp: [0, 1, 2, 3], z: 0 }, { polygon: sq(10), sharp: [0, 1, 2, 3], z: 10 }],
    { stations: 2, samples: 16 });
  expect(rings[0].polygon[0][0]).toBeCloseTo(10, 9);
  expect(rings[0].polygon[0][1]).toBeCloseTo(10, 9);
});

test("corner 0 anchors the seam: a rotated sharp list still puts corner 0 at vertex 0", () => {
  const sq = [[10, 10], [-10, 10], [-10, -10], [10, -10]];
  const rings = smoothLoftRings(
    [{ polygon: sq, sharp: [2, 3], z: 0 }, { polygon: sq, sharp: [2, 3], z: 10 }],
    { stations: 2, samples: 16 });
  expect(rings[0].polygon[0]).toEqual([-10, -10]); // vertex at sharp index 2 leads the ring
});

test("curve contour sections are accepted; their corners are implicit", () => {
  // A half-round "D": one line segment (2 implicit corners) + one arc.
  const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
  const rings = smoothLoftRings([{ polygon: D, z: 0 }, { polygon: D, z: 10 }], { stations: 2, samples: 24 });
  expect(rings.length).toBe(2);
  expect(rings[0].polygon.length).toBe(24);
});

test("point and curve sections mix when their corner counts match", () => {
  // The D-contour has 2 implicit corners (line↔arc joints); the point section
  // tags 2 of its own — correspondence works across forms.
  const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
  const lens = [[0, -8], [0, 8], [4, 6], [7, 0], [4, -6]];
  const rings = smoothLoftRings(
    [{ polygon: D, z: 0 }, { polygon: lens, sharp: [0, 1], z: 10 }],
    { stations: 4, samples: 24 });
  expect(rings.length).toBe(4);
  expect(rings.every((r) => r.polygon.length === 24)).toBe(true);
});

test("corner-count mismatch and sharp-validation errors are exact (frozen by the spec)", () => {
  const sq = [[10, 10], [-10, 10], [-10, -10], [10, -10]];
  const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
  expect(() => smoothLoftRings([{ polygon: sq, sharp: [0], z: 0 }, { polygon: sq, z: 10 }], {}))
    .toThrow("loftSmooth: every section must have the same corner count — section 1 has 0, section 0 has 1");
  expect(() => smoothLoftRings([{ polygon: D, sharp: [0], z: 0 }, { polygon: D, z: 10 }], {}))
    .toThrow("loftSmooth: section 0 is a curve contour — its corners are implicit; sharp is only for point sections");
  expect(() => smoothLoftRings([{ polygon: sq, sharp: [4], z: 0 }, { polygon: sq, sharp: [0], z: 10 }], {}))
    .toThrow("loftSmooth: section 0 sharp indices must be integers in 0…3");
  expect(() => smoothLoftRings([{ polygon: sq, sharp: [1.5], z: 0 }, { polygon: sq, sharp: [0], z: 10 }], {}))
    .toThrow("loftSmooth: section 0 sharp indices must be integers in 0…3");
});

test("samples below the corner count is raised to it", () => {
  const oct = [[10, 0], [7, 7], [0, 10], [-7, 7], [-10, 0], [-7, -7], [0, -10], [7, -7]];
  // 8 corners, samples clamped-in at 8 → raised to 8 (1 span per arc)
  const rings = smoothLoftRings(
    [{ polygon: oct, sharp: [0, 1, 2, 3, 4, 5, 6, 7], z: 0 }, { polygon: oct, sharp: [0, 1, 2, 3, 4, 5, 6, 7], z: 5 }],
    { stations: 2, samples: 8 });
  expect(rings[0].polygon.length).toBe(8);
});
```

Also UPDATE two existing assertions in this file (v1 strings the spec retires/extends):
- The frozen-errors test pins `"loftSmooth: section 0 needs polygon:[[x,y],…] (≥3 points) or sides+radius shorthand"` → change the expected string to `"loftSmooth: section 0 needs polygon:[[x,y],…] (≥3 points), a curve contour, a Shape2D, or sides+radius shorthand"`.
- If any test pins the retired `"…is an arc profile — control sections must be point arrays (for now)"` string, delete that assertion.

Note on `pathProfile`: the D-contour tests above use a literal contour IR, so no import is needed — drop the `pathProfile` import line entirely.

- [ ] **Step 2: Run to verify failures**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth.test.js
```

Expected: new tests FAIL (`resampleOpenArc` not exported; sharp/curve sections rejected).

- [ ] **Step 3: Implement in `loft-smooth.js`**

Imports become:

```js
import { isArcContour, sampleArc, sampleBezier, closeContourGap } from "./profile.js";
import { profileCorners } from "./contour-ops.js";
import { LOFT_SEGS } from "./loft-rings.js";
```

Add the joint-tracking tessellator (a mirror of `profile.js` `tessellateContour`, minus its dedupe pass — dedupe would shift joint indices, and the arc-length resampler tolerates zero-length steps):

```js
// Tessellate a path contour tracking each segment joint's output index
// (vertex i = start of segment i; jointIdx[i] is its position in pts).
function tessellateWithJoints(contour, segs) {
  const pts = [[contour.start[0], contour.start[1]]];
  const jointIdx = [0];
  let prev = contour.start;
  for (const seg of contour.segments) {
    if (seg.c1) for (const p of sampleBezier(prev, seg.c1, seg.c2, seg.to, segs)) pts.push(p);
    else if (seg.via) for (const p of sampleArc(prev, seg.via, seg.to, segs)) pts.push(p);
    else pts.push([seg.to[0], seg.to[1]]);
    jointIdx.push(pts.length - 1);
    prev = seg.to;
  }
  pts.pop();      // explicit closure lands on start — drop the duplicate for a closed ring
  jointIdx.pop(); // and the wrap entry with it
  return { pts, jointIdx };
}
```

Rewrite `resolveSections` to return `{ pts2d, corners, z }` (corners sorted, seam-anchored):

```js
function resolveSections(sections) {
  if (!Array.isArray(sections) || sections.length < 2)
    throw new Error("loftSmooth: sections must be an array of at least 2 control sections");
  return sections.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`loftSmooth: section ${i} must be an object { polygon|sides+radius, z }`);
    if (!Number.isFinite(s.z)) throw new Error(`loftSmooth: section ${i} needs a finite z`);
    let pts = s.polygon;
    let corners;
    if (pts && pts._shape2d) {
      const regions = pts._regions;
      if (regions.length === 0) throw new Error(`loftSmooth: section ${i} is an empty Shape2D — nothing to loft`);
      if (regions.length > 1) throw new Error(
        `loftSmooth: section ${i} is a Shape2D with ${regions.length} regions — a loft section must be a single closed outline (union the regions into one, or loft each separately)`);
      if (regions[0].holes.length > 0) throw new Error(
        `loftSmooth: section ${i} has holes — loft sections must be hole-free outlines (cut the holes from the lofted solid instead)`);
      pts = JSON.parse(JSON.stringify(regions[0].outer));
    }
    if (isArcContour(pts)) {
      if (s.sharp != null)
        throw new Error(`loftSmooth: section ${i} is a curve contour — its corners are implicit; sharp is only for point sections`);
      const contour = closeContourGap(pts);
      const t = tessellateWithJoints(contour, LOFT_SEGS);
      corners = profileCorners(contour).map((c) => t.jointIdx[c.index]).sort((a, b) => a - b);
      pts = t.pts;
    } else {
      if (!pts && Number.isFinite(s.sides) && Number.isFinite(s.radius)) {
        pts = [];
        for (let j = 0; j < s.sides; j++) {
          const a = (j / s.sides) * 2 * Math.PI;
          pts.push([Math.cos(a) * s.radius, Math.sin(a) * s.radius]);
        }
      }
      if (!Array.isArray(pts) || pts.length < 3)
        throw new Error(`loftSmooth: section ${i} needs polygon:[[x,y],…] (≥3 points), a curve contour, a Shape2D, or sides+radius shorthand`);
      if (s.sharp != null) {
        if (!Array.isArray(s.sharp) || s.sharp.some((x) => !Number.isInteger(x) || x < 0 || x >= pts.length))
          throw new Error(`loftSmooth: section ${i} sharp indices must be integers in 0…${pts.length - 1}`);
        corners = [...new Set(s.sharp)].sort((a, b) => a - b);
      } else corners = [];
    }
    const sc = s.scale ?? 1;
    const [sx, sy] = Array.isArray(sc) ? sc : [sc, sc];
    const rot = ((s.rotate ?? 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot);
    let pts2d = pts.map(([x, y]) => {
      const X = x * sx, Y = y * sy;
      return [X * cos - Y * sin, X * sin + Y * cos];
    });
    // Corner 0 anchors the seam (spec §2): rotate the ring so it leads at vertex 0.
    if (corners.length && corners[0] !== 0) {
      const shift = corners[0];
      pts2d = [...pts2d.slice(shift), ...pts2d.slice(0, shift)];
      corners = corners.map((c) => c - shift);
    }
    return { pts2d, corners, z: s.z };
  });
}
```

Add the open-arc machinery (`dist`, `crPoint`, `SUB` already exist):

```js
const reflectPt = (p, q) => [2 * p[0] - q[0], 2 * p[1] - q[1]];

// Dense polyline of the clamped open centripetal CR through `pts` (reflection
// phantoms at both ends), endpoints exact. Shared by resampleOpenArc and the
// arc-length weights in reconcile().
function openArcDense(pts) {
  const A = pts.length;
  const ctrl = [reflectPt(pts[0], pts[1]), ...pts, reflectPt(pts[A - 1], pts[A - 2])];
  const dense = [];
  for (let i = 1; i < A; i++) {
    const p0 = ctrl[i - 1], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[i + 2];
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), 1e-6);
    const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), 1e-6);
    const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), 1e-6);
    for (let s = 0; s < SUB; s++)
      dense.push(crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t1 + ((t2 - t1) * s) / SUB));
  }
  dense.push([pts[A - 1][0], pts[A - 1][1]]);
  return dense;
}

const polyLen = (poly) => {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += dist(poly[i - 1], poly[i]);
  return L;
};

// Clamped open CR through `pts`, resampled uniformly by arc length to spans+1
// points; both endpoints are interpolated exactly.
export function resampleOpenArc(pts, spans) {
  const dense = openArcDense(pts);
  const M = dense.length - 1;
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i]));
  const total = cum[M];
  if (!(total > 0)) throw new Error("loftSmooth: a control section has zero perimeter");
  const out = [];
  let seg = 0;
  for (let j = 0; j <= spans; j++) {
    const target = (j / spans) * total;
    while (seg < M - 1 && cum[seg + 1] < target) seg++;
    const a = dense[seg], b = dense[seg + 1];
    const w = (target - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    out.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
  }
  out[0] = [pts[0][0], pts[0][1]];
  out[spans] = [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  return out;
}

// Cyclic slice of a ring from corner j to corner j+1, both endpoints included.
function arcPoints(pts, corners, j) {
  const N = pts.length, m = corners.length;
  const a = corners[j], b = corners[(j + 1) % m];
  const out = [];
  for (let k = a; ; k = (k + 1) % N) {
    out.push(pts[k]);
    if (k === b && out.length > 1) break;
  }
  return out;
}

// Reconcile all sections to a shared vertex count: samples spans apportioned
// among the m corner-delimited arcs by mean arc-length fraction (largest
// remainder, ties to the lower arc index, minimum 1 span per arc — spec §2).
function reconcile(resolved, V) {
  const m = resolved[0].corners.length;
  for (let i = 1; i < resolved.length; i++)
    if (resolved[i].corners.length !== m)
      throw new Error(
        `loftSmooth: every section must have the same corner count — section ${i} has ${resolved[i].corners.length}, section 0 has ${m}`);
  if (m === 0)
    return { rings: resolved.map((r) => resampleClosedSpline(r.pts2d, V)), corners: [] };
  const V2 = Math.max(V, m);
  const arcs = resolved.map((r) => Array.from({ length: m }, (_, j) => arcPoints(r.pts2d, r.corners, j)));
  const fracs = Array.from({ length: m }, () => 0);
  for (const sectionArcs of arcs) {
    const lens = sectionArcs.map((a) => polyLen(openArcDense(a)));
    const perim = lens.reduce((a, b) => a + b, 0);
    for (let j = 0; j < m; j++) fracs[j] += lens[j] / perim;
  }
  for (let j = 0; j < m; j++) fracs[j] /= resolved.length;
  const extra = V2 - m;
  const exact = fracs.map((f) => extra * f);
  const alloc = exact.map(Math.floor);
  let left = extra - alloc.reduce((a, b) => a + b, 0);
  const order = exact.map((e, j) => [e - alloc[j], j]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let j = 0; j < left; j++) alloc[order[j][1]]++;
  const spans = alloc.map((a) => a + 1);
  const rings = arcs.map((sectionArcs) =>
    sectionArcs.flatMap((arcPts2, j) => resampleOpenArc(arcPts2, spans[j]).slice(0, -1)));
  const corners = [];
  let acc = 0;
  for (let j = 0; j < m; j++) { corners.push(acc); acc += spans[j]; }
  return { rings, corners };
}
```

In `smoothLoftRings`, replace step 1 (`const rings = resolved.map((r) => resampleClosedSpline(r.pts2d, V));`) with:

```js
  const { rings } = reconcile(resolved, V);
  const VOut = rings[0].length; // V raised to the corner count when larger
```

and use `VOut` everywhere `V` was used *downstream* of reconciliation (centroid divide, the per-vertex station loop). The docstring's `@param sections` line gains: `point arrays may carry sharp:[indices]; curve contours/Shape2D sections carry corners implicitly`.

- [ ] **Step 4: Run the file, then the full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth.test.js && npx vitest run
```

Expected: all pass (the m = 0 path is v1-identical, so nothing else moves).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/loft-smooth.js test/loft-smooth.test.js
git -c core.hooksPath=/dev/null commit -m "feat(loft-smooth): corner tags, curve sections, per-arc reconciliation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Cubic-Bézier emission on both backends

**Files:**
- Modify: `src/framework/geometry/loft-smooth.js`
- Modify: `src/framework/geometry/kernel-front.js` (the `k.loftSmooth ??=` block and its comment, ~lines 59–74)
- Test: `test/loft-smooth.test.js`

**Interfaces:**
- Consumes: Task 1's `reconcile` output (`rings`, `corners`), `crPoint`, `reflectPt`.
- Produces: `export function fitBezierRing(pts, corners = [])` → contour IR `{ start:[x,y], segments:[{to,c1,c2}…] }`, all-cubic, explicitly closed (last `to` === `start` coordinates), one segment per input vertex. `smoothLoftRings` now returns `[{ polygon: <contour IR>, z }]`.

- [ ] **Step 1: Migrate existing point-ring assertions, then add the new tests**

`smoothLoftRings`' return type changes, so first add this helper at the top of `test/loft-smooth.test.js` and rewrite every existing `r.polygon`/`ring.polygon` point access through it (including Task 1's new tests):

```js
// v2: rings are all-cubic contours; their vertices are the segment endpoints
// (explicit closure: the last segment lands back on start).
const verts = (r) => [r.polygon.start, ...r.polygon.segments.slice(0, -1).map((s) => s.to)];
```

e.g. `r.polygon.length` → `verts(r).length`, `ring.polygon[idx]` → `verts(ring)[idx]`, `ring.polygon.forEach((p, j) …)` → `verts(ring).forEach((p, j) …)`. Then append:

```js
import { fitBezierRing } from "../src/framework/geometry/loft-smooth.js"; // extend the existing import

const bezAt = (p0, s, u) => { // de Casteljau on one {to,c1,c2} segment from p0
  const l = (a, b) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const a1 = l(p0, s.c1), a2 = l(s.c1, s.c2), a3 = l(s.c2, s.to);
  const b1 = l(a1, a2), b2 = l(a2, a3);
  return l(b1, b2);
};

test("fitBezierRing interpolates every vertex exactly and closes explicitly", () => {
  const pts = resampleClosedSpline([[10, 0], [0, 10], [-10, 0], [0, -12]], 24);
  const c = fitBezierRing(pts);
  expect(c.segments.length).toBe(24);
  expect(c.start).toEqual(pts[0]);
  expect(c.segments[23].to).toEqual(pts[0]);
  c.segments.slice(0, -1).forEach((s, i) => expect(s.to).toEqual(pts[i + 1]));
  expect(c.segments.every((s) => s.c1 && s.c2)).toBe(true);
});

test("fitBezierRing is C1 at smooth joints, tangent-broken at corners", () => {
  const tangentPair = (c, i) => { // out-tangent of segment i-1 and in-tangent of segment i at vertex i
    const n = c.segments.length;
    const prev = c.segments[(i - 1 + n) % n];
    const cur = c.segments[i];
    const from = i === 0 ? c.start : c.segments[i - 1].to;
    return [[from[0] - prev.c2[0], from[1] - prev.c2[1]], [cur.c1[0] - from[0], cur.c1[1] - from[1]]];
  };
  const cross = ([a, b]) => Math.abs(a[0] * b[1] - a[1] * b[0]) / (Math.hypot(...a) * Math.hypot(...b));
  const smoothC = fitBezierRing(resampleClosedSpline([[10, 0], [0, 10], [-10, 0], [0, -10]], 16));
  for (let i = 0; i < 16; i++) expect(cross(tangentPair(smoothC, i))).toBeLessThan(1e-9);
  // Square with 4 corners at indices 0,4,8,12 of a 16-vertex ring: corners break tangency.
  const sq = [[10, 10], [-10, 10], [-10, -10], [10, -10]];
  const ring = [];
  for (let j = 0; j < 4; j++) {
    const a = sq[j], b = sq[(j + 1) % 4];
    for (let s = 0; s < 4; s++) ring.push([a[0] + (b[0] - a[0]) * (s / 4), a[1] + (b[1] - a[1]) * (s / 4)]);
  }
  const cornered = fitBezierRing(ring, [0, 4, 8, 12]);
  for (const i of [0, 4, 8, 12]) expect(cross(tangentPair(cornered, i))).toBeGreaterThan(1e-3);
  for (const i of [2, 6, 10, 14]) expect(cross(tangentPair(cornered, i))).toBeLessThan(1e-9);
});

test("emitted cubics lie on the CR curve (midpoints match a dense resample)", () => {
  const ctrl = [[10, 0], [3, 9], [-8, 5], [-9, -6], [4, -11]];
  const pts = resampleClosedSpline(ctrl, 16);
  const c = fitBezierRing(pts);
  // Each cubic's midpoint must sit between its endpoints at a plausible CR position:
  // compare against a 16x denser resample of the same base ring, nearest-point distance.
  const dense = resampleClosedSpline(ctrl, 256);
  c.segments.forEach((s, i) => {
    const p0 = i === 0 ? c.start : c.segments[i - 1].to;
    const mid = bezAt(p0, s, 0.5);
    const d = Math.min(...dense.map(([x, y]) => Math.hypot(x - mid[0], y - mid[1])));
    expect(d).toBeLessThan(0.15); // on-curve to well under a facet width at r≈10
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth.test.js
```

Expected: FAIL — `fitBezierRing` not exported; migrated `verts()` reads fail against point-array rings.

- [ ] **Step 3: Implement emission**

In `loft-smooth.js` add:

```js
// Exact 4-point inversion: a CR span is a cubic, so sampling it at u = 0, 1/3,
// 2/3, 1 and inverting the Bernstein matrix reproduces it with no approximation
// (spec §3). Endpoints are written from the actual ring vertices so the contour
// interpolates them bit-exactly.
function invertSpan(S0, S1, S2, S3) {
  return {
    to: [S3[0], S3[1]],
    c1: [(-5 * S0[0] + 18 * S1[0] - 9 * S2[0] + 2 * S3[0]) / 6, (-5 * S0[1] + 18 * S1[1] - 9 * S2[1] + 2 * S3[1]) / 6],
    c2: [(2 * S0[0] - 9 * S1[0] + 18 * S2[0] - 5 * S3[0]) / 6, (2 * S0[1] - 9 * S1[1] + 18 * S2[1] - 5 * S3[1]) / 6],
  };
}

// Fit the ring's smooth outline (closed periodic CR, or corner-clamped open CR
// arcs) back to an all-cubic contour IR — one segment per vertex, explicitly
// closed. `corners` are sorted output vertex indices with corner 0 at index 0.
export function fitBezierRing(pts, corners = []) {
  const V = pts.length;
  const segments = [];
  const emitSpan = (p0, p1, p2, p3) => {
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), 1e-6);
    const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), 1e-6);
    const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), 1e-6);
    const at = (u) => crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t1 + (t2 - t1) * u);
    segments.push(invertSpan([p1[0], p1[1]], at(1 / 3), at(2 / 3), [p2[0], p2[1]]));
  };
  if (corners.length === 0) {
    for (let i = 0; i < V; i++)
      emitSpan(pts[(i - 1 + V) % V], pts[i], pts[(i + 1) % V], pts[(i + 2) % V]);
  } else {
    for (let j = 0; j < corners.length; j++) {
      const arc = arcPoints(pts, corners, j);
      const A = arc.length;
      const ctrl = [reflectPt(arc[0], arc[1]), ...arc, reflectPt(arc[A - 1], arc[A - 2])];
      for (let i = 1; i < A; i++) emitSpan(ctrl[i - 1], ctrl[i], ctrl[i + 1], ctrl[i + 2]);
    }
  }
  segments[segments.length - 1].to = [pts[0][0], pts[0][1]]; // exact explicit closure
  return { start: [pts[0][0], pts[0][1]], segments };
}
```

In `smoothLoftRings`, thread `corners` out of `reconcile` and wrap every returned ring:
- `"controls"` mode: `return resolved.map((r, i) => ({ polygon: fitBezierRing(rings[i], corners), z: r.z }));`
- dense mode: `out.push({ polygon, z })` becomes `out.push({ polygon: fitBezierRing(polygon, corners), z })`.
- Update the `@returns` docstring to `{Array<{polygon: {start, segments}, z: number}>}` and the header comment (rings are now all-cubic contour IR; `k.loft` curve mode lofts them as exact wires on OCCT and matched samples on Manifold).

In `kernel-front.js`, the composition drops the `shading:"smooth"` default so loft's curve shading policy decides (corners crease, curves stay smooth); a caller-supplied hint still passes through:

```js
  const brepLoft = typeof k.toSTEP === "function";
  k.loftSmooth ??= ({ sections, stations, samples, shading }) =>
    brepLoft
      ? k.loft({ rings: smoothLoftRings(sections, { stations: "controls", samples }), ruled: false })
      : k.loft({ rings: smoothLoftRings(sections, { stations, samples }), ...(shading ? { shading } : {}) });
```

(The guarded spread keeps an undefined `shading` key out of loft's option validation; behavior matches the spec's normative snippet.) Rewrite the comment block above it: the densifier now emits all-cubic curve rings on both paths; B-rep lofts them as exact Bézier wires (`ruled:false`, probe 74–261 ms at 24–128 spans) — the dense-point-wire abort story stays as the reason `stations:"controls"` exists; parity remains the screwSweep tolerance class.

- [ ] **Step 4: Run the file, then the full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth.test.js && npx vitest run
```

Expected: all pass. `test/loft-smooth-manifold.test.js` / `-occt.test.js` call `k.loftSmooth` end-to-end and must stay within their existing bands — if a band test fails by a hair, STOP and report (that is a parity regression, not a constant to bump).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/loft-smooth.js src/framework/geometry/kernel-front.js test/loft-smooth.test.js
git -c core.hooksPath=/dev/null commit -m "feat(loft-smooth): emit cubic-Bézier curve rings on both backends

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Closed loops

**Files:**
- Modify: `src/framework/geometry/loft-smooth.js`
- Modify: `src/framework/geometry/kernel-front.js` (the same composition block)
- Modify: `src/framework/geometry/op-options.js:283` (the loftSmooth passThrough)
- Modify: `types/kernel.d.ts` (LoftSmoothOptions, ~line 384; new LoftSmoothSection)
- Test: `test/loft-smooth.test.js`, `test/op-options.test.js`

**Interfaces:**
- Consumes: Task 2's contour-emitting `smoothLoftRings`.
- Produces: `smoothLoftRings(sections, { stations, samples, closed })`; `k.loftSmooth({ …, closed })`.

- [ ] **Step 1: Write the failing tests** — append to `test/loft-smooth.test.js`:

```js
test("closed:true emits a periodic station list — every control ring once, no ring-0 repeat", () => {
  const four = [10, 13, 11, 14].map((r, i) => ({ polygon: ngon(8, r), z: i * 5 }));
  const rings = smoothLoftRings(four, { stations: 12, samples: 16, closed: true });
  expect(rings.length).toBe(12);
  const first = verts(rings[0]), last = verts(rings[rings.length - 1]);
  expect(last).not.toEqual(first); // the wrap-back station is interior, not a duplicate of ring 0
  // control station 0 is emitted exactly
  const want = resampleClosedSpline(ngon(8, 10), 16);
  first.forEach((p, j) => {
    expect(p[0]).toBeCloseTo(want[j][0], 9);
    expect(p[1]).toBeCloseTo(want[j][1], 9);
  });
});

test("closed default station count is n*8", () => {
  const four = [10, 13, 11, 14].map((r, i) => ({ polygon: ngon(8, r), z: i * 5 }));
  expect(smoothLoftRings(four, { samples: 16, closed: true }).length).toBe(32);
});

test("closed validation errors are exact (frozen by the spec)", () => {
  const two = [{ polygon: ngon(8, 10), z: 0 }, { polygon: ngon(8, 12), z: 5 }];
  expect(() => smoothLoftRings(two, { closed: true }))
    .toThrow("loftSmooth: closed:true needs at least 3 control sections");
  const four = [10, 13, 11, 14].map((r, i) => ({ polygon: ngon(8, r), z: i * 5 }));
  expect(() => smoothLoftRings(four, { stations: "controls", closed: true }))
    .toThrow('loftSmooth: closed:true cannot combine with stations:"controls"');
});
```

And to `test/op-options.test.js`, extend the options-only compound-ops test (the `boredCylinder`/`helixSweptTube`/`screwSweep` block):

```js
  const smooth = { sections: [{ sides: 6, radius: 5, z: 0 }, { sides: 6, radius: 3, z: 8 }], closed: false };
  expect(KERNEL_OP_SPECS.loftSmooth.toArgs(smooth)).toEqual([smooth]);
  expect(() => KERNEL_OP_SPECS.loftSmooth.toArgs({ ...smooth, loop: true }))
    .toThrow('loftSmooth: unknown option "loop"');
```

- [ ] **Step 2: Run to verify failures**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth.test.js test/op-options.test.js
```

Expected: FAIL (`closed` unknown option / ignored).

- [ ] **Step 3: Implement**

`smoothLoftRings(sections, { stations, samples, closed = false })`:

- Validations, right after `resolveSections`:

```js
  if (closed && stations === "controls")
    throw new Error('loftSmooth: closed:true cannot combine with stations:"controls"');
  if (closed && n < 3) throw new Error("loftSmooth: closed:true needs at least 3 control sections");
```

- Default stations: `const S = stations ?? (closed ? n * 8 : (n - 1) * 8 + 1);`
- Knots: after the existing loop, `if (closed) knots.push(knots[n - 1] + Math.max(Math.hypot(spine[0][0] - spine[n - 1][0], spine[0][1] - spine[n - 1][1], spine[0][2] - spine[n - 1][2]), 1e-6));` — `knots` gains index `n` (the wrap chord).
- Accessors go periodic under `closed` (replace the three helpers with mode-aware versions):

```js
  const wrap = (i) => ((i % n) + n) % n;
  const knotAt = (i) => {
    if (closed) {
      if (i < 0) return knots[0] - (knots[n] - knots[n - 1]);
      if (i > n) return knots[n] + (knots[1] - knots[0]);
      return knots[i];
    }
    if (i < 0) return knots[0] - (knots[1] - knots[0]);
    if (i >= n) return knots[n - 1] + (knots[n - 1] - knots[n - 2]);
    return knots[i];
  };
  const ptAt = (j, i) => {
    if (closed) return rings[wrap(i)][j];
    if (i < 0) return reflect(rings[0][j], rings[1][j]);
    if (i >= n) return reflect(rings[n - 1][j], rings[n - 2][j]);
    return rings[i][j];
  };
  const zCtrl = (i) => {
    if (closed) return resolved[wrap(i)].z;
    if (i < 0) return 2 * resolved[0].z - resolved[1].z;
    if (i >= n) return 2 * resolved[n - 1].z - resolved[n - 2].z;
    return resolved[i].z;
  };
```

- Station list: span count becomes `closed ? n : n - 1` (`spans[i] = knots[i + 1] - knots[i]` now reaches the wrap chord); `tEnd = knots[closed ? n : n - 1]`; the emission loop pushes each control knot `knots[i]` plus its apportioned interior stations for every span, and the final `ts.push(tEnd)` happens **only when open** (closed would duplicate ring 0).
- Station evaluation: the segment search runs over the enlarged span range (`while (seg < (closed ? n - 1 : n - 2) && t > knots[seg + 1]) seg++;`), and `t2 = knotAt(seg + 1)` (was `knots[seg + 1]`, which no longer exists for the wrap segment's far knot in the open case — use `knotAt` uniformly).

`kernel-front.js` composition becomes the spec's final form:

```js
  const brepLoft = typeof k.toSTEP === "function";
  k.loftSmooth ??= ({ sections, stations, samples, shading, closed = false }) => {
    if (brepLoft && closed) throw new Error("loftSmooth: closed:true loops are only supported on the Manifold backend");
    return brepLoft
      ? k.loft({ rings: smoothLoftRings(sections, { stations: "controls", samples }), ruled: false })
      : k.loft({ rings: smoothLoftRings(sections, { stations, samples, closed }), ...(shading ? { shading } : {}), closed });
  };
```

`op-options.js:283`:

```js
  loftSmooth: { toArgs: passThrough("loftSmooth", ["sections", "stations", "samples", "shading", "closed"], ["sections"]) },
```

`types/kernel.d.ts` — replace `LoftSmoothOptions` (keep it right where it is, after the SweepOptions area at ~line 383) with:

```ts
/** One `k.loftSmooth` control section. Point arrays may tag true corners with
 *  `sharp`; curve contours and Shape2D outlines carry corners implicitly. */
export interface LoftSmoothSection {
  polygon?: Contour | Shape2D;
  sides?: number;
  radius?: number;
  z: number;
  /** Degrees about Z. */
  rotate?: number;
  scale?: number | Point2;
  /** Corner indices into a point-array polygon. */
  sharp?: number[];
}

/** k.loftSmooth — spline-interpolated loft of sparse control sections. */
export interface LoftSmoothOptions {
  /** Sparse control sections; vertex counts may differ between sections. */
  sections: LoftSmoothSection[];
  /** Output ring count along the spine (default 8 per span + 1; closed: 8 per section). */
  stations?: number;
  /** Output vertex count around each ring (default max(64, largest section)). */
  samples?: number;
  shading?: "smooth" | "faceted";
  /** Capless loop — Manifold only, ≥3 sections. */
  closed?: boolean;
}
```

If `test/types-surface.test.js` pins option keys or interface names, update its expectations to match (`closed`, `LoftSmoothSection`) — read the failure before editing.

- [ ] **Step 4: Run the touched files, then the full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth.test.js test/op-options.test.js test/types-surface.test.js && npx vitest run
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/loft-smooth.js src/framework/geometry/kernel-front.js src/framework/geometry/op-options.js types/kernel.d.ts test/loft-smooth.test.js test/op-options.test.js test/types-surface.test.js
git -c core.hooksPath=/dev/null commit -m "feat(loft-smooth): closed:true loops — periodic spine, Manifold-only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Drop `test/types-surface.test.js` from the `git add` if it needed no edit.)

---

### Task 4: Manifold kernel tests

**Files:**
- Test: `test/loft-smooth-manifold.test.js`

**Interfaces:** Consumes `k.loftSmooth` with `sharp` and `closed` (Tasks 1–3). The file already boots Manifold in `beforeAll` and holds `PARITY_CM3 = 22.85` — do not change the anchor.

- [ ] **Step 1: Write the failing tests** — append:

```js
test("sharp tags change the surface: tagged square prism differs from the untagged fit, both watertight", () => {
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const sections = (sharp) => [
    { polygon: sq(10), ...(sharp ? { sharp: [0, 1, 2, 3] } : {}), z: 0 },
    { polygon: sq(10), ...(sharp ? { sharp: [0, 1, 2, 3] } : {}), z: 20 },
  ];
  const tagged = k.loftSmooth({ sections: sections(true), stations: 5, samples: 32 });
  const smooth = k.loftSmooth({ sections: sections(false), stations: 5, samples: 32 });
  // Tagged corners keep the true square (400 mm² cross-section); the untagged CR
  // rounds them off. Both must be positive watertight solids.
  expect(tagged.volume()).toBeCloseTo(400 * 20, -2); // within ~50 mm³ of the exact prism
  expect(tagged.volume()).toBeGreaterThan(smooth.volume() * 1.001);
  expect(tagged.genus()).toBe(0);
  expect(smooth.genus()).toBe(0);
});

test("closed:true builds a capless genus-1 loop (the loft-mesh precedent, smoothed)", () => {
  const sections = [];
  for (let i = 0; i < 6; i++) sections.push({ sides: 8, radius: 8 + i, z: i * 3 });
  const s = k.loftSmooth({ sections, closed: true, samples: 24 });
  expect(s.genus()).toBe(1);
  expect(s.volume()).toBeGreaterThan(0);
});
```

(`k` is the file's existing booted kernel binding — match the local name used by the existing tests.)

- [ ] **Step 2: Run to verify current state**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth-manifold.test.js
```

Expected: the two new tests exercise already-implemented behavior — they should PASS. If the tagged-prism volume is not within the band, or genus differs, STOP: that is an implementation bug in Tasks 1–3, not a test to loosen. The pre-existing parity-anchor test must still pass unchanged.

- [ ] **Step 3: Commit**

```bash
git add test/loft-smooth-manifold.test.js
git -c core.hooksPath=/dev/null commit -m "test(loft-smooth): Manifold gates for sharp tags and closed loops

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: OCCT kernel tests

**Files:**
- Test: `test/loft-smooth-occt.test.js` (OCCT-only file — never boot Manifold here)

**Interfaces:** Consumes `k.loftSmooth` (curve-wire B-rep path) and the frozen closed error.

- [ ] **Step 1: Update and extend the tests**

The existing speed test asserts the 48×128 build under 5000 ms and the STEP test asserts `byteLength > 1000`. Update per spec §7 and append the new gates:

- Speed test: keep the `< 5000` hard contract assert and add a `< 1000` tripwire assert on the same measurement, with a comment citing the probe (261 ms at 5 controls × 128 spans).
- STEP test: raise the floor to `expect(step.byteLength).toBeGreaterThan(10000);` (probe: 162 KB at 24 spans).
- Append:

```js
test("closed:true throws the frozen Manifold-only error on the B-rep path", () => {
  const sections = [];
  for (let i = 0; i < 4; i++) sections.push({ sides: 8, radius: 8 + i, z: i * 3 });
  expect(() => k.loftSmooth({ sections, closed: true }))
    .toThrow("loftSmooth: closed:true loops are only supported on the Manifold backend");
});

test("sharp-tagged sections loft as curve wires with a real corner (square prism volume is exact-ish)", () => {
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const s = k.loftSmooth({
    sections: [
      { polygon: sq(10), sharp: [0, 1, 2, 3], z: 0 },
      { polygon: sq(10), sharp: [0, 1, 2, 3], z: 20 },
    ],
    samples: 32,
  });
  expect(s.volume()).toBeCloseTo(400 * 20, -2);
});
```

- [ ] **Step 2: Run the OCCT file**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/loft-smooth-occt.test.js
```

Expected: all pass, including the pre-existing parity anchor. If the 1000 ms tripwire fails but 5000 ms holds, report the timing rather than deleting the assert.

- [ ] **Step 3: Commit**

```bash
git add test/loft-smooth-occt.test.js
git -c core.hooksPath=/dev/null commit -m "test(loft-smooth): OCCT gates — curve-wire speed, STEP floor, closed error, sharp corner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Propeller reference part — sharpTE toggle

**Files:**
- Modify: `src/parts/propeller.js`

**Interfaces:** Consumes `sharp` on point sections (Task 1). The airfoil ring has `2 * p.sectionPts` vertices: index 0 is the upper trailing-edge point, index `2 * p.sectionPts - 1` the lower one (see the `airfoil()` concatenation comment).

- [ ] **Step 1: Add the toggle**

In `bladeSections`, tag both trailing-edge vertices when enabled:

```js
const bladeSections = (p) =>
  SPAN_T.map((t, i) => ({
    polygon: airfoil(
      (p.rootChord + (p.tipChord - p.rootChord) * t) * CHORD_MUL[i],
      p.thickness * (1 - 0.45 * t),
      p.camber,
      p.sectionPts,
    ),
    // The trailing edge is the ring's two near-coincident end vertices (upper TE
    // is vertex 0, lower TE the last) — tagging both keeps the TE crisp instead
    // of CR-smeared, with the blunt TE base as its own tiny arc.
    ...(p.sharpTE && p.smooth ? { sharp: [0, 2 * p.sectionPts - 1] } : {}),
    z: p.span * t,
    rotate: p.twistRoot + (p.twistTip - p.twistRoot) * t,
  }));
```

In the Surface section's controls, after the `smooth` checkbox:

```js
        { key: "sharpTE", type: "checkbox", label: "Sharp trailing edge", when: { smooth: 1 },
          description: "Tags the trailing-edge vertices as true corners — the spline interpolates them with a crease instead of smearing them round." },
```

In `defaults`, add `sharpTE: 1` (keep it beside `smooth: 1`). Update the Surface section `description` to mention the toggle in one clause. Update the file's header comment (line 4-ish) to cite the v2 spec path `docs/superpowers/specs/2026-08-25-loft-smooth-v2-design.md` alongside the v1 one.

- [ ] **Step 2: Verify — CLI measure + full suite + smoke**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx partforge measure src/parts/propeller.js && npx vitest run && node scripts/check-app.mjs propeller.html
```

Expected: measure passes its verify gate; the parity-anchor tests (`PARITY_CM3 = 22.85` ± 2%) still pass with sharpTE defaulting on — the TE crease is a sub-percent volume effect. If parity fails, STOP and report the measured volume; do not bump the literal.

- [ ] **Step 3: Commit**

```bash
git add src/parts/propeller.js
git -c core.hooksPath=/dev/null commit -m "feat(propeller): sharpTE toggle — corner-tagged trailing edges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, contract row, error patterns, version bump

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md` (the loftSmooth compound-op row)
- Modify: `docs/AUTHORING-PARTS.md` (the k.loftSmooth op-table row + the "Smooth organic lofts" recipe)
- Modify: `docs/ERROR-PATTERNS.md` (replace one entry, add one)
- Modify: `package.json` (version)
- Modify: `src/framework/geometry/kernel.js` (the loftSmooth typedef line, if its wording mentions point rings)

**Interfaces:** none — documentation of Tasks 1–6. Grep each file for `loftSmooth` first; `test/kernel-contract.test.js` pins the contract doc's version header and op coverage, so run it after editing.

- [ ] **Step 1: KERNEL-CONTRACT.md**

Update the loftSmooth row (keep the table's pipe-escaping discipline — literal `|` inside a cell is `\|`): sections accept `{polygon\|sides+radius\|curve contour\|Shape2D, z, rotate?, scale?, sharp?}`; both backends receive all-cubic curve rings (around-ring exact Bézier wires in STEP); `sharp`/implicit contour corners crease; `closed` is Manifold-only (frozen error on B-rep); parity class unchanged (within tolerance, ~2% gate on the reference part). CONTRACT_VERSION stays 4 — state the additive-options rationale in the row's notes the way the import-op precedent row does.

- [ ] **Step 2: AUTHORING-PARTS.md**

Update the `k.loftSmooth` op-table row for the new options, and extend the "Smooth organic lofts" recipe with two short examples: a `sharp:`-tagged airfoil trailing edge (point section) and a curve-contour section (reuse the D-contour literal from the tests). Mention `closed:true` (Manifold-only) in one sentence.

- [ ] **Step 3: ERROR-PATTERNS.md**

- Replace the `loftsmooth-sections-point-arrays` entry (its error no longer exists) with `## loftsmooth-corner-count-mismatch`: Symptom leads with an instantiated literal (`loftSmooth: every section must have the same corner count — section 1 has 0, section 0 has 2`), cause (a `sharp` list or a cornered curve contour on some sections but not all — every section needs the same corner count, m ≥ 0), fix (tag the corresponding vertices on every section, or none), linking `docs/AUTHORING-PARTS.md`.
- Add `## loftsmooth-closed-needs-manifold`: Symptom `loftSmooth: closed:true loops are only supported on the Manifold backend`; cause (STEP export or `meta.backend:"occt"` routes the whole part to OCCT, where loft loops are unsupported); fix (drop `closed` for STEP-bound parts, or keep the part mesh-only), linking `docs/KERNEL-CONTRACT.md`.

- [ ] **Step 4: package.json + kernel.js**

Set `"version": "0.85.0"`. In `kernel.js`, check the `loftSmooth` KERNEL_OPS comment/typedef line: keep the additive-op comment, refresh wording only if it claims point-ring emission.

- [ ] **Step 5: Run the doc-pinned tests, then the full suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" && npx vitest run test/kernel-contract.test.js test/error-patterns.test.js && npx vitest run
```

(If `test/error-patterns.test.js` doesn't exist, skip that file.) Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add docs/KERNEL-CONTRACT.md docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md package.json src/framework/geometry/kernel.js
git -c core.hooksPath=/dev/null commit -m "docs: loftSmooth v2 contract row, recipes, error patterns; chore: 0.85.0

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
