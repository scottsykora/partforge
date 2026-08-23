# Shape2D Loft Rings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `k.loft` accepts Shape2D / curve-contour rings on both backends — Manifold stitches matched, vertex-aligned tessellations; OCCT lofts the original curve wires when rings are structurally the same curve and falls back to the identical shared polygon rings when they differ.

**Architecture:** A new shared pure-JS leaf `src/framework/geometry/loft-rings.js` lifts every ring to the curve-contour IR, bakes per-ring transforms, and classifies the loft into one of three modes (`poly-exact` — today's behavior bit-for-bit; `curve` — identical segment signatures, matched per-segment tessellation for Manifold + original curve wires for OCCT; `resample` — arc-length resample to a shared N with seam alignment and corner snapping, both backends consume the identical rings). `loftMesh` keeps its stitcher but gains triangulated caps for non-convex rings.

**Tech Stack:** plain ESM, vitest, manifold-3d WASM (incl. `wasm.triangulate`), replicad/OCCT WASM (separate test files — never boot both in one process).

**Spec:** `docs/superpowers/plans/2026-08-23-shape2d-loft-design.md`

## Global Constraints

- Node 24 (`nvm use` first — the default shell Node is too old; `source nvm.sh` is blocked in the sandbox, PATH-prefix the pinned Node from `~/.nvm/versions` instead).
- On any build/test/measure failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.
- `src/framework/` stays DOM-free / `three`-free / `node:`-free on the worker graph (`test/worker-layering.test.js` enforces).
- OCCT and Manifold must never boot in the same vitest file.
- Units are millimetres; angles are degrees; 2-D contours CCW = material.
- Contract version stays **4** (loosened validation is additive per `docs/KERNEL-CONTRACT.md` Versioning); npm version bumps `0.80.0 → 0.81.0` in this PR.
- Existing equal-N point-ring lofts must stay **bit-exact** (mesh-fillet tool solids, rim-bevel, roundedBoxRings all feed point rings through `k.loft`).
- Run a task's test file after each step: `npx vitest run test/<file>.test.js`.

---

### Task 1: `loft-rings.js` — ring lifting, signatures, mode classification, cache key

**Files:**
- Create: `src/framework/geometry/loft-rings.js`
- Test: `test/loft-rings.test.js`

**Interfaces:**
- Consumes: `regularPolygon` (`polygon.js`), `tessellateContour`, `pointsToContour`, `reverseContour` (`profile.js`), `rotateProfile`, `scaleProfile`, `contourIsCCW` (`contour-ops.js`), `h` (`solid-hash.js`).
- Produces (used by Tasks 2–6):
  - `LOFT_SEGS` — `64` (fixed pure-JS LOD, hull.js precedent).
  - `liftLoftRings(rings)` → `[{ raw, contour, pts, z }]` — `raw` is the original ring spec; `contour` is the transform-baked, CCW-normalized contour IR (always present); `pts` is the legacy transform-baked point ring (present only when the input was a point list / sides+radius).
  - `classifyLoftRings(lifted)` → `{ mode: "poly-exact"|"curve"|"resample", hasCurve: boolean }`.
  - `loftRingsKey(rings)` → array safe to fold through `h()` (Shape2D → its `_hash`).
  - (Task 4 adds `resolveLoftRings` on top of these.)

- [ ] **Step 1: Write the failing tests**

```js
// test/loft-rings.test.js
import { expect, test } from "vitest";
import { liftLoftRings, classifyLoftRings, loftRingsKey, LOFT_SEGS } from "../src/framework/geometry/loft-rings.js";
import { roundedProfile, regularPolygon } from "../src/framework/geometry/polygon.js";

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const fakeShape = (regions) => ({ _shape2d: true, _regions: regions, _hash: "abc123", toContours: () => JSON.parse(JSON.stringify(regions)) });
const rsq = roundedProfile(SQ, 2); // curve contour: 4 lines + 4 arcs, "LALALALA"

test("point-list rings lift with legacy scale-then-rotate baked into pts (bit-exact math)", () => {
  const [r] = liftLoftRings([{ polygon: SQ, z: 0, scale: 2, rotate: 90 }, { polygon: SQ, z: 1 }]);
  // scale 2 → (−10,−10), rotate 90° CCW → (10,−10)
  expect(r.pts[0][0]).toBeCloseTo(10, 12);
  expect(r.pts[0][1]).toBeCloseTo(-10, 12);
  expect(r.z).toBe(0);
});

test("sides+radius shorthand lifts to regularPolygon points", () => {
  const [r] = liftLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 5 }]);
  expect(r.pts).toEqual(regularPolygon(6, 8));
});

test("a curve contour ring lifts with a contour and no pts", () => {
  const [r] = liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 5 }]);
  expect(r.pts).toBeNull();
  expect(r.contour.segments.filter((s) => s.via).length).toBe(4); // 4 corner arcs survive lifting
});

test("a Shape2D ring lifts its single region's outer contour", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }]);
  const [r] = liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]);
  expect(r.contour.segments.filter((s2) => s2.via).length).toBe(4);
});

test("a multi-region Shape2D ring throws a loud error", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }, { outer: rsq, holes: [] }]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]))
    .toThrow(/ring 0 is a Shape2D with 2 regions/);
});

test("a Shape2D ring with holes throws a loud error", () => {
  const s = fakeShape([{ outer: rsq, holes: [rsq] }]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]))
    .toThrow(/ring 0 has holes/);
});

test("an empty Shape2D ring throws a loud error", () => {
  const s = fakeShape([]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }])).toThrow(/ring 0 is an empty Shape2D/);
});

test("existing validation survives: <2 rings, missing z, short point list all throw", () => {
  expect(() => liftLoftRings([{ polygon: SQ, z: 0 }])).toThrow(/at least 2 rings/);
  expect(() => liftLoftRings([{ polygon: SQ }, { polygon: SQ, z: 1 }])).toThrow(/finite z/);
  expect(() => liftLoftRings([{ polygon: [[0, 0], [1, 0]], z: 0 }, { polygon: SQ, z: 1 }])).toThrow(/≥3 points/);
});

test("classify: equal-N point rings → poly-exact", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: SQ, z: 9 }]));
  expect(c).toEqual({ mode: "poly-exact", hasCurve: false });
});

test("classify: identical curved signatures → curve", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]));
  expect(c).toEqual({ mode: "curve", hasCurve: true });
});

test("classify: rounded square → plain square is resample (signatures differ)", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: SQ, z: 9 }]));
  expect(c.mode).toBe("resample");
  expect(c.hasCurve).toBe(true);
});

test("classify: unequal-N point rings → resample (was an error before this feature)", () => {
  const oct = regularPolygon(8, 5);
  expect(classifyLoftRings(liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: oct, z: 9 }])).mode).toBe("resample");
});

test("classify: NON-uniform scale on a curved ring still classifies deterministically", () => {
  // arcs under non-uniform scale become cubics (transformContour), so the scaled ring's
  // signature differs from the unscaled one → resample, not a crash.
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: [2, 1] }]));
  expect(c.mode).toBe("resample");
});

test("loftRingsKey substitutes a Shape2D with its _hash and is h()-stable", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }]);
  const k1 = JSON.stringify(loftRingsKey([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]));
  expect(k1).toContain("abc123");
  expect(k1).not.toContain("_shape2d"); // no live object leaked into the key
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loft-rings.test.js`
Expected: FAIL — module `loft-rings.js` does not exist.

- [ ] **Step 3: Implement `loft-rings.js` (lifting + classification + key)**

```js
// Shared Shape2D/curve-aware loft ring resolution — the pure-JS leaf both backends
// call before touching a kernel. Lifts every accepted ring form to the curve-contour
// IR, bakes each ring's scale-then-rotate(Z) transform ONCE, and classifies the loft
// into one of three modes (see docs/superpowers/plans/2026-08-23-shape2d-loft-design.md):
//   poly-exact — all-line identical signatures: today's path, bit-for-bit;
//   curve      — identical signatures with arcs/cubics: matched per-segment sampling
//                (Manifold) + original curve wires (OCCT, STEP-exact);
//   resample   — structurally different rings: shared arc-length resample, both
//                backends loft the IDENTICAL rings (parity by construction).
import { regularPolygon } from "./polygon.js";
import { pointsToContour, reverseContour } from "./profile.js";
import { rotateProfile, scaleProfile, contourIsCCW } from "./contour-ops.js";

export const LOFT_SEGS = 64; // fixed pure-JS LOD for curve rings (hull.js precedent)

const isPointList = (x) => Array.isArray(x) && Array.isArray(x[0]);
const isContour = (x) => x && !Array.isArray(x) && Array.isArray(x.segments);

// Legacy transform bake for point rings — EXACTLY resolveRings' math, kept verbatim so
// every existing part's loft stays bit-identical (mesh-fillet tools, rim-bevel, roundedBox).
const bakePts = (pts, r) => {
  const s = r.scale ?? 1;
  const [sx, sy] = Array.isArray(s) ? s : [s, s];
  const rot = ((r.rotate ?? 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot);
  return pts.map(([x, y]) => {
    const X = x * sx, Y = y * sy;
    return [X * cos - Y * sin, X * sin + Y * cos];
  });
};

// Contour bake: scale about origin then rotate about origin — the same composite map,
// applied through contour-ops so arcs survive similarity maps exactly and become
// cubics under non-uniform scale (transformContour's rule).
const bakeContour = (contour, r) => {
  let c = contour;
  const s = r.scale ?? 1;
  if (!(s === 1 || (Array.isArray(s) && s[0] === 1 && s[1] === 1))) c = scaleProfile(c, s, [0, 0]);
  if ((r.rotate ?? 0) !== 0) c = rotateProfile(c, r.rotate, [0, 0]);
  return contourIsCCW(c) ? c : reverseContour(c);
};

export function liftLoftRings(rings) {
  if (!Array.isArray(rings) || rings.length < 2)
    throw new Error("loft: rings must be an array of at least 2 rings");
  return rings.map((r, i) => {
    if (!r || typeof r !== "object") throw new Error(`loft: ring ${i} must be an object { polygon|sides+radius, z }`);
    if (!Number.isFinite(r.z)) throw new Error(`loft: ring ${i} needs a finite z`);
    let poly = r.polygon;
    if (poly && poly._shape2d) {
      const regions = poly._regions;
      if (regions.length === 0) throw new Error(`loft: ring ${i} is an empty Shape2D — nothing to loft`);
      if (regions.length > 1) throw new Error(
        `loft: ring ${i} is a Shape2D with ${regions.length} regions — a loft ring must be a single closed outline (union the regions into one, or loft each separately)`);
      if (regions[0].holes.length > 0) throw new Error(
        `loft: ring ${i} has holes — loft rings must be hole-free outlines (cut the holes from the lofted solid instead)`);
      poly = JSON.parse(JSON.stringify(regions[0].outer));
    }
    if (!poly && Number.isFinite(r.sides) && Number.isFinite(r.radius)) poly = regularPolygon(r.sides, r.radius);
    if (isContour(poly)) return { raw: r, contour: bakeContour(poly, r), pts: null, z: r.z };
    if (!isPointList(poly) || poly.length < 3)
      throw new Error(`loft: ring ${i} needs polygon:[[x,y],…] (≥3 points), a curve contour, a Shape2D, or sides+radius shorthand`);
    const pts = bakePts(poly, r);
    return { raw: r, contour: bakeContour(pointsToContour(poly), r), pts, z: r.z };
  });
}

const signatureOf = (contour) => contour.segments.map((s) => (s.c1 ? "C" : s.via ? "A" : "L")).join("");

export function classifyLoftRings(lifted) {
  const sigs = lifted.map((r) => signatureOf(r.contour));
  const hasCurve = sigs.some((s) => /[AC]/.test(s));
  const identical = sigs.every((s) => s === sigs[0]);
  // Identical all-line signatures imply equal vertex counts (an N-point ring lifts to
  // exactly N line segments), so this IS today's equal-N legacy case, bit-for-bit.
  if (identical && !hasCurve) return { mode: "poly-exact", hasCurve: false };
  if (identical) return { mode: "curve", hasCurve };
  return { mode: "resample", hasCurve };
}

// Cache-key form of a ring list: replace live Shape2D values with their content hash
// so h()'s canonical serializer never walks a shape's methods.
export function loftRingsKey(rings) {
  if (!Array.isArray(rings)) return rings;
  return rings.map((r) => (r && typeof r === "object"
    ? { ...r, polygon: r.polygon && r.polygon._shape2d ? r.polygon._hash : r.polygon }
    : r));
}
```

Note for the `≥3 points` error test: `liftLoftRings` hits the point-list length check for `[[0,0],[1,0]]` — a 2-entry array of arrays passes `isPointList` and fails `poly.length < 3`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loft-rings.test.js`
Expected: PASS. Also run `npx vitest run test/worker-layering.test.js` — the new leaf must not violate the import rules.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/loft-rings.js test/loft-rings.test.js
git commit -m "feat(loft): ring lifting, segment signatures, and mode classification for Shape2D rings"
```

---

### Task 2: matched per-segment tessellation (curve mode)

**Files:**
- Modify: `src/framework/geometry/profile.js` (extract `arcGeometry` from `sampleArc`)
- Modify: `src/framework/geometry/loft-rings.js`
- Test: `test/loft-rings.test.js` (extend)

**Interfaces:**
- Consumes: `cubicAt` (`contour-ops.js`), `sampleBezier` (`profile.js`), Task 1's `liftLoftRings`.
- Produces:
  - `profile.js`: `arcGeometry(p0, via, p1)` → `null | { cx, cy, r, a0, dA }` (null = collinear). `sampleArc` behavior unchanged (existing tests are the guard).
  - `loft-rings.js`: `matchedTessellation(lifted)` → `[[ [x,y], … ], …]` — one CCW ring per lift, all equal length, vertices aligned per segment; corners (segment endpoints) exact.

- [ ] **Step 1: Write the failing tests**

Append to `test/loft-rings.test.js`:

```js
import { matchedTessellation } from "../src/framework/geometry/loft-rings.js";
import { arcGeometry, sampleArc } from "../src/framework/geometry/profile.js";

test("arcGeometry matches sampleArc's implicit circle (90° arc r=2)", () => {
  const g = arcGeometry([2, 0], [Math.SQRT2, Math.SQRT2], [0, 2]);
  expect(g.r).toBeCloseTo(2, 9);
  expect(g.cx).toBeCloseTo(0, 9);
  expect(g.cy).toBeCloseTo(0, 9);
  expect(Math.abs(g.dA)).toBeCloseTo(Math.PI / 2, 9);
});

test("arcGeometry returns null for a collinear triple", () => {
  expect(arcGeometry([0, 0], [1, 0], [2, 0])).toBeNull();
});

test("matched tessellation: one rounded square at two scales → equal N, corners exact", () => {
  const rsq = roundedProfile(SQ, 2);
  const lifted = liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]);
  const [a, b] = matchedTessellation(lifted);
  expect(a.length).toBe(b.length);
  // every segment endpoint of the baked contour appears verbatim in the ring
  for (const seg of lifted[0].contour.segments.slice(0, -1)) {
    expect(a.some(([x, y]) => Math.hypot(x - seg.to[0], y - seg.to[1]) < 1e-12)).toBe(true);
  }
  // ring 1 is exactly ring 0 scaled by 0.5, index-for-index (aligned correspondence)
  for (let i = 0; i < a.length; i++) {
    expect(b[i][0]).toBeCloseTo(a[i][0] * 0.5, 9);
    expect(b[i][1]).toBeCloseTo(a[i][1] * 0.5, 9);
  }
});

test("matched tessellation gives each arc the max natural count across rings", () => {
  // big ring's arcs need more facets than the small ring's; both must get the max
  const big = roundedProfile([[-50, -50], [50, -50], [50, 50], [-50, 50]], 20);
  const lifted = liftLoftRings([{ polygon: big, z: 0 }, { polygon: big, z: 9, scale: 0.1 }]);
  const [a, b] = matchedTessellation(lifted);
  expect(a.length).toBe(b.length);
  expect(a.length).toBeGreaterThan(8); // arcs actually sampled, not collapsed to endpoints
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loft-rings.test.js`
Expected: FAIL — `arcGeometry` / `matchedTessellation` not exported.

- [ ] **Step 3: Extract `arcGeometry` in `profile.js`**

Replace the body of `sampleArc` (profile.js:65) so the circle/sweep solve lives in a new exported helper; `sampleArc` keeps its exact output (steps formula and endpoint pinning included):

```js
// Solve the circle through (p0, via, p1) and the CCW-normalized sweep from p0 to p1
// that passes through `via`. Returns null for a collinear triple (callers emit a
// straight segment). Shared by sampleArc and loft-rings' fixed-count arc sampler.
export function arcGeometry(p0, via, p1) {
  const [ax, ay] = p0, [bx, by] = via, [cx0, cy0] = p1;
  const d = 2 * (ax * (by - cy0) + bx * (cy0 - ay) + cx0 * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const sa = ax * ax + ay * ay, sb = bx * bx + by * by, sc = cx0 * cx0 + cy0 * cy0;
  const cx = (sa * (by - cy0) + sb * (cy0 - ay) + sc * (ay - by)) / d;
  const cy = (sa * (cx0 - bx) + sb * (ax - cx0) + sc * (bx - ax)) / d;
  const r = Math.hypot(ax - cx, ay - cy);
  const a0 = Math.atan2(ay - cy, ax - cx);
  const av = Math.atan2(by - cy, bx - cx);
  const a1 = Math.atan2(cy0 - cy, cx0 - cx);
  const twoPi = 2 * Math.PI;
  const ccw = (x) => { let v = x % twoPi; if (v < 0) v += twoPi; return v; };
  const dCCW = ccw(a1 - a0), vCCW = ccw(av - a0);
  return { cx, cy, r, a0, dA: vCCW <= dCCW ? dCCW : dCCW - twoPi };
}

export function sampleArc(p0, via, p1, segs) {
  const g = arcGeometry(p0, via, p1);
  if (!g) return [[p1[0], p1[1]]];                        // collinear → straight line
  const steps = Math.max(2, Math.ceil((segs * Math.abs(g.dA)) / (2 * Math.PI)));
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const ang = g.a0 + g.dA * (s / steps);
    out.push([g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)]);
  }
  out[out.length - 1] = [p1[0], p1[1]];                   // pin the exact endpoint
  return out;
}
```

Run the full curve/profile suites to prove the refactor is behavior-neutral: `npx vitest run test/curve-profile-manifold.test.js test/contour-ops-fillet-curves.test.js test/contour-cleanup.test.js`.

- [ ] **Step 4: Implement `matchedTessellation` in `loft-rings.js`**

```js
import { arcGeometry, sampleBezier } from "./profile.js";
import { cubicAt } from "./contour-ops.js";

// Natural facet count a segment would get at LOFT_SEGS — the per-segment budget the
// matched sampler levels up to across rings.
const segNaturalCount = (prev, seg) => {
  if (seg.c1) return Math.max(1, sampleBezier(prev, seg.c1, seg.c2, seg.to, LOFT_SEGS).length);
  if (seg.via) {
    const g = arcGeometry(prev, seg.via, seg.to);
    return g ? Math.max(2, Math.ceil((LOFT_SEGS * Math.abs(g.dA)) / (2 * Math.PI))) : 1;
  }
  return 1;
};

// Sample one segment with EXACTLY n points (uniform in angle/parameter), last point
// pinned to seg.to. Fixed counts are what keep corresponding vertices aligned across
// rings — the adaptive samplers must not be used here.
const sampleSegN = (prev, seg, n) => {
  const out = [];
  if (seg.c1) {
    for (let s = 1; s <= n; s++) out.push(cubicAt(prev, seg.c1, seg.c2, seg.to, s / n));
  } else if (seg.via) {
    const g = arcGeometry(prev, seg.via, seg.to);
    if (!g) { for (let s = 1; s <= n; s++) out.push([prev[0] + (seg.to[0] - prev[0]) * (s / n), prev[1] + (seg.to[1] - prev[1]) * (s / n)]); }
    else for (let s = 1; s <= n; s++) {
      const ang = g.a0 + g.dA * (s / n);
      out.push([g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)]);
    }
  } else {
    for (let s = 1; s <= n; s++) out.push([prev[0] + (seg.to[0] - prev[0]) * (s / n), prev[1] + (seg.to[1] - prev[1]) * (s / n)]);
  }
  out[out.length - 1] = [seg.to[0], seg.to[1]];
  return out;
};

// Curve mode: identical signatures guaranteed by classifyLoftRings. Per segment index,
// every ring samples with the same count (the max natural count), so vertex i lies at
// the same curve parameter on every ring; the seam is each contour's start.
export function matchedTessellation(lifted) {
  const segCount = lifted[0].contour.segments.length;
  const counts = [];
  for (let j = 0; j < segCount; j++) {
    let n = 1, prevs = lifted.map((r) => (j === 0 ? r.contour.start : r.contour.segments[j - 1].to));
    lifted.forEach((r, k) => { n = Math.max(n, segNaturalCount(prevs[k], r.contour.segments[j])); });
    counts.push(n);
  }
  return lifted.map((r) => {
    const ring = [[r.contour.start[0], r.contour.start[1]]];
    let prev = r.contour.start;
    r.contour.segments.forEach((seg, j) => { for (const p of sampleSegN(prev, seg, counts[j])) ring.push(p); prev = seg.to; });
    // stored contours close explicitly (last segment lands on start) — drop the closure
    ring.pop();
    return ring;
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/loft-rings.test.js` — PASS.
Then the neutrality guard again: `npx vitest run test/curve-profile-manifold.test.js test/loft-mesh.test.js`.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/profile.js src/framework/geometry/loft-rings.js test/loft-rings.test.js
git commit -m "feat(loft): matched per-segment tessellation for structurally identical curve rings"
```

---

### Task 3: arc-length resample fallback — seam alignment + corner snapping

**Files:**
- Modify: `src/framework/geometry/loft-rings.js`
- Test: `test/loft-rings.test.js` (extend)

**Interfaces:**
- Consumes: `tessellateContour` (`profile.js`), `profileCorners` (`contour-ops.js`), Tasks 1–2.
- Produces: `resampleTessellation(lifted)` → equal-length CCW rings, each starting at its seam (outermost +X-ray crossing from the ring's own centroid), sharp corners snapped exactly.

- [ ] **Step 1: Write the failing tests**

Append to `test/loft-rings.test.js`:

```js
import { resampleTessellation } from "../src/framework/geometry/loft-rings.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

test("resample: square → circle rings come out equal-N, CCW, seam on the +X axis", () => {
  const lifted = liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  const [sq, ci] = resampleTessellation(lifted);
  expect(sq.length).toBe(ci.length);
  // seams: first sample of each ring sits on its +X ray from centroid (y ≈ 0 for both)
  expect(sq[0][1]).toBeCloseTo(0, 9);
  expect(sq[0][0]).toBeCloseTo(5, 9);          // square crosses +X at x = 5
  expect(ci[0][1]).toBeCloseTo(0, 6);
  // CCW: shoelace positive
  const area = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  expect(area(sq)).toBeGreaterThan(0);
  expect(area(ci)).toBeGreaterThan(0);
});

test("resample: the square's four corners survive exactly (corner snapping)", () => {
  const lifted = liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  const [sq] = resampleTessellation(lifted);
  for (const [cx, cy] of SQ)
    expect(sq.some(([x, y]) => x === cx && y === cy)).toBe(true);
});

test("resample: N is the max ring vertex count", () => {
  const oct = regularPolygon(8, 5);
  const lifted = liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: oct, z: 9 }]);
  const rings = resampleTessellation(lifted);
  expect(rings[0].length).toBe(8);
  expect(rings[1].length).toBe(8);
});

test("resample: CW input ring is normalized CCW before resampling", () => {
  const CW = [[-5, -5], [-5, 5], [5, 5], [5, -5]];
  const lifted = liftLoftRings([{ polygon: CW, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  const [sq] = resampleTessellation(lifted);
  const area = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  expect(area(sq)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loft-rings.test.js`
Expected: FAIL — `resampleTessellation` not exported.

- [ ] **Step 3: Implement `resampleTessellation`**

```js
import { tessellateContour } from "./profile.js";
import { profileCorners } from "./contour-ops.js";

const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

// Deterministic seam: the outermost crossing of the +X ray from the ring's centroid.
// Returns { edge, t } — a parametric position on the ring's edge list. Falls back to
// all crossings of the full horizontal line, then to vertex 0, so it is total.
const seamOf = (ring) => {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  let best = null;
  for (let pass = 0; pass < 2 && !best; pass++) {
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = ring[i], [qx, qy] = ring[(i + 1) % ring.length];
      if ((py <= cy) === (qy <= cy)) continue;            // half-open: each crossing once
      const t = (cy - py) / (qy - py);
      const x = px + t * (qx - px);
      if (pass === 0 && x <= cx) continue;                // pass 0: +X ray only
      if (!best || x > best.x) best = { edge: i, t, x };
    }
  }
  return best ?? { edge: 0, t: 0, x: ring[0][0] };
};

// Arc-length resample one CCW ring to N points starting at its seam, then snap each
// sharp corner onto its nearest sample (closest corner wins a contested sample).
const resampleRing = (ring, N, corners) => {
  const seam = seamOf(ring);
  const pts = [];
  // unroll the ring into an open polyline starting exactly at the seam point
  const start = [ring[seam.edge][0] + seam.t * (ring[(seam.edge + 1) % ring.length][0] - ring[seam.edge][0]),
                 ring[seam.edge][1] + seam.t * (ring[(seam.edge + 1) % ring.length][1] - ring[seam.edge][1])];
  pts.push(start);
  for (let k = 1; k <= ring.length; k++) {
    const i = (seam.edge + k) % ring.length;
    pts.push([ring[i][0], ring[i][1]]);
  }
  // pts is now start → all vertices → start's edge-begin; close it back to start
  pts.push([start[0], start[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const out = [];
  let seg = 0;
  for (let k = 0; k < N; k++) {
    const target = (k * L) / N;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    out.push([pts[seg][0] + t * (pts[seg + 1][0] - pts[seg][0]), pts[seg][1] + t * (pts[seg + 1][1] - pts[seg][1])]);
  }
  // corner snapping: a sharp corner within one sample-spacing of a sample replaces it
  const spacing = L / N;
  const owner = new Map(); // sample index -> snap distance
  for (const c of corners) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < out.length; i++) {
      const d = Math.hypot(out[i][0] - c[0], out[i][1] - c[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd < spacing && (!owner.has(bi) || bd < owner.get(bi))) {
      out[bi] = [c[0], c[1]];
      owner.set(bi, bd);
    }
  }
  return out;
};

// Resample mode: every ring tessellated at the fixed LOD, resampled to a common N.
export function resampleTessellation(lifted) {
  const rings = lifted.map((r) => {
    let ring = r.pts ?? tessellateContour(r.contour, LOFT_SEGS);
    // tessellateContour of a contour returns an explicitly closed ring — drop the closure
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
      ring = ring.slice(0, -1);
    if (shoelace(ring) < 0) ring = [...ring].reverse();
    return ring;
  });
  const N = Math.max(...rings.map((r) => r.length));
  return lifted.map((r, i) => {
    const corners = profileCorners(r.contour).map((c) => c.point);
    return resampleRing(rings[i], N, corners);
  });
}
```

Note: `profileCorners` reports non-smooth joints (> `SMOOTH_JOINT_DEG` = 1°), so a
polygonized circle at LOFT_SEGS contributes shallow "corners" too — those snaps are
no-ops within a sample spacing, and the guard `bd < spacing` keeps them harmless.
If the corner-survival test fails because a snapped point moved a neighbor's exact
equality, compare with `toBeCloseTo(…, 12)` instead of `===` — the requirement is
corner coordinates exact to double precision, not object identity.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loft-rings.test.js` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/loft-rings.js test/loft-rings.test.js
git commit -m "feat(loft): arc-length resample fallback with seam alignment and corner snapping"
```

---

### Task 4: `resolveLoftRings` + rewire `loftMesh` with triangulated caps

**Files:**
- Modify: `src/framework/geometry/loft-rings.js` (add `resolveLoftRings`)
- Modify: `src/framework/geometry/loft.js` (loftMesh consumes resolved rings; caps via `wasm.triangulate`; delete `resolveRings` + the arc-ring guard)
- Test: `test/loft-mesh.test.js` (update + extend), `test/loft-rings.test.js` (extend)

**Interfaces:**
- Produces: `resolveLoftRings(rings)` → `{ mode, hasCurve, resolved: [{ pts2d, z, contour }] }` — `contour` is the baked contour (used by OCCT's curve mode in Task 6). `loftMesh(wasm, ringsOrResolved, opts)` accepts either raw ring specs (tests, rim-bevel via k.loft is unaffected — it goes through the backend op) or a pre-resolved object (detected by the `resolved` property).
- `resolveRings` is **deleted**; `occt-backend.js` still imports it, so this task temporarily re-exports a shim `resolveRings(rings)` = `resolveLoftRings(rings).resolved` and Task 6 removes it. (This keeps every task green on its own.)

- [ ] **Step 1: Write the failing tests**

Append to `test/loft-rings.test.js`:

```js
import { resolveLoftRings } from "../src/framework/geometry/loft-rings.js";

test("resolveLoftRings: poly-exact resolved pts2d are byte-identical to the legacy bake", () => {
  const { mode, resolved } = resolveLoftRings([{ polygon: SQ, z: 0, scale: 2, rotate: 90 }, { polygon: SQ, z: 10 }]);
  expect(mode).toBe("poly-exact");
  expect(resolved[1].pts2d).toEqual(SQ); // identity transform: caller's numbers verbatim
  expect(resolved[0].z).toBe(0);
});

test("resolveLoftRings: curve mode carries both pts2d and the baked contour", () => {
  const rsq = roundedProfile(SQ, 2);
  const { mode, resolved } = resolveLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]);
  expect(mode).toBe("curve");
  expect(resolved[0].pts2d.length).toBe(resolved[1].pts2d.length);
  expect(resolved[0].contour.segments.filter((s) => s.via).length).toBe(4);
});

test("resolveLoftRings: resample mode has equal-N pts2d and null contours", () => {
  const { mode, resolved } = resolveLoftRings([{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 9 }]);
  expect(mode).toBe("resample");
  expect(resolved[0].pts2d.length).toBe(resolved[1].pts2d.length);
  expect(resolved[0].contour).toBeNull();
});
```

Update `test/loft-mesh.test.js`: **delete** the "arc profile … rejected" test (loft-mesh.test.js:63-70) and append:

```js
import { circleProfile } from "../src/framework/geometry/polygon.js";

// L-hexagon: non-convex, area 4·1 + 1·2 = 6. Centroid-fan caps would self-overlap here;
// the triangulated caps must produce the exact prism volume.
const L = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];

test("non-convex (L-shaped) rings loft to the exact prism volume (triangulated caps)", () => {
  const v = loftMesh(wasm, [{ polygon: L, z: 0 }, { polygon: L, z: 10 }]).volume();
  expect(v).toBeCloseTo(60, 5);
});

test("CW non-convex rings still self-correct to a positive-volume solid", () => {
  const LCW = [...L].reverse();
  expect(loftMesh(wasm, [{ polygon: LCW, z: 0 }, { polygon: LCW, z: 10 }]).volume()).toBeCloseTo(60, 5);
});

test("an arc-contour ring (roundedProfile) now lofts — volume ≈ rounded-square prism", () => {
  const rsq = roundedProfile(SQ, 2);
  const v = loftMesh(wasm, [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10 }]).volume();
  // exact area 10² − (4−π)·2² = 96.5663…; inscribed-facet deficit at LOFT_SEGS is < 0.03/ring
  expect(v).toBeGreaterThan(963);
  expect(v).toBeLessThan(965.7);
});

test("unequal-N point rings auto-resample instead of throwing (square → octagon)", () => {
  const oct = regularPolygon(8, 5);
  expect(() => loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: oct, z: 10 }])).not.toThrow();
  const v = loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: oct, z: 10 }]).volume();
  expect(v).toBeGreaterThan(0);
  expect(loftMesh(wasm, [{ polygon: SQ, z: 0 }, { polygon: oct, z: 10 }]).genus()).toBe(0);
});

test("square → circle morph is watertight, genus 0, volume between the two prisms", () => {
  const rings = [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }];
  const m = loftMesh(wasm, rings);
  expect(m.genus()).toBe(0);
  const v = m.volume();
  expect(v).toBeGreaterThan(Math.PI * 16 * 10 * 0.9); // > cylinder-ish lower bound
  expect(v).toBeLessThan(100 * 10);                   // < square prism
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loft-rings.test.js test/loft-mesh.test.js`
Expected: `resolveLoftRings` missing; loft-mesh new tests throw (arc guard / unequal-N guard / fan caps).

- [ ] **Step 3: Implement `resolveLoftRings` and rewrite `loft.js`**

In `loft-rings.js`:

```js
export function resolveLoftRings(rings) {
  const lifted = liftLoftRings(rings);
  const { mode, hasCurve } = classifyLoftRings(lifted);
  let ptRings;
  if (mode === "poly-exact") ptRings = lifted.map((r) => r.pts ?? matchedTessellation([r, r])[0]);
  else if (mode === "curve") ptRings = matchedTessellation(lifted);
  else ptRings = resampleTessellation(lifted);
  return {
    mode, hasCurve,
    resolved: lifted.map((r, i) => ({ pts2d: ptRings[i], z: r.z, contour: mode === "curve" ? r.contour : null })),
  };
}
```

(For the rare poly-exact ring that arrived as an all-line *contour* rather than a point
list, `matchedTessellation([r, r])[0]` yields its vertices; point-list rings keep their
legacy-baked `pts` untouched.)

Rewrite `loft.js` to keep only the mesh path:

```js
// Backend-shared loft support: resolveLoftRings (loft-rings.js) validates and
// tessellates the declarative ring specs; loftMesh() is the Manifold path — stacked
// rings stitched with side quads and closed with TRIANGULATED caps (wasm.triangulate),
// so non-convex Shape2D rings cap correctly (the old centroid fan was star-convex-only).
import { resolveLoftRings } from "./loft-rings.js";
import { sideQuads, manifoldFromMesh, reverseWinding } from "./mesh-build.js";

const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

// Triangulated end cap. Winding must stay CONSISTENT with the side walls: a CCW ring's
// top cap faces +Z and its bottom cap −Z; a CW ring (legacy point lists — walls come
// out inverted and the whole-mesh volume check below flips everything at once) gets
// both caps inverted too, so the mesh is orientable either way.
function triCap(wasm, Tr, ringStart, pts2d, bottom) {
  const ccw = shoelace(pts2d) >= 0;
  const ring = ccw ? pts2d : [...pts2d].reverse();
  const tris = wasm.triangulate([ring], 1e-9);
  const remap = (i) => ringStart + (ccw ? i : pts2d.length - 1 - i);
  const flip = bottom !== !ccw; // XOR: see winding table in the test file
  for (const t of tris) {
    const a = remap(t[0]), b = remap(t[1]), c = remap(t[2]);
    if (flip) Tr.push(a, c, b); else Tr.push(a, b, c);
  }
}

export function loftMesh(wasm, rings, { closed = false } = {}) {
  const { resolved } = Array.isArray(rings) ? resolveLoftRings(rings) : rings;
  const N = resolved[0].pts2d.length;
  const V = [];
  for (const { pts2d, z } of resolved) for (const [x, y] of pts2d) V.push(x, y, z);
  const Tr = [];
  sideQuads(Tr, resolved.length, N, closed);
  if (!closed) {
    triCap(wasm, Tr, 0, resolved[0].pts2d, true);
    triCap(wasm, Tr, (resolved.length - 1) * N, resolved[resolved.length - 1].pts2d, false);
  }
  let out = manifoldFromMesh(wasm, V, Tr);
  if (out.volume() < 0) {          // CW rings / descending z: rebuild outward (unchanged)
    out.delete?.();
    reverseWinding(Tr);
    out = manifoldFromMesh(wasm, V, Tr);
  }
  return out;
}

// Transitional shim for occt-backend.js (removed in the OCCT task).
export const resolveRings = (rings) => resolveLoftRings(rings).resolved;
```

`fanCap` stays in `mesh-build.js` (helix-tube still uses it). If `wasm.triangulate`'s
return shape differs from array-of-`[i,j,k]` (manifold-3d 3.5.1 returns an array of
3-element arrays — verified by probe), adapt `triCap`'s destructuring, not the tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loft-rings.test.js test/loft-mesh.test.js`
Then the blast radius: `npx vitest run test/rim-bevel.test.js test/mesh-fillet.test.js test/rounded-solids.test.js test/helix-tube.test.js 2>/dev/null || npx vitest run` (if those exact filenames differ, run the whole suite: `npx vitest run` — the bit-exact legacy guarantee is the point of this step).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/loft-rings.js src/framework/geometry/loft.js test/loft-rings.test.js test/loft-mesh.test.js
git commit -m "feat(loft): resolveLoftRings orchestration and triangulated caps for non-convex rings"
```

---

### Task 5: Manifold backend — cache key + shading policy

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js:611-620` (the `loft` op)
- Modify: `src/framework/geometry/shading-policy.js:42-53` (`loftShadingPolicy`)
- Test: `test/loft-shading.test.js` (extend), `test/shading-policy` unit lines go in `test/loft-rings.test.js`

**Interfaces:**
- Consumes: `resolveLoftRings`, `loftRingsKey` (Task 4), existing `loftMesh`.
- Produces: `loftShadingPolicy(resolvedLoft, opts)` — **signature change**: first arg is now the `resolveLoftRings` result (`{ resolved, hasCurve }`), not the raw ring specs. `manifold-backend.js` is its only production caller (verify with `grep -rn "loftShadingPolicy" src/`).

- [ ] **Step 1: Write the failing tests**

Append to `test/loft-rings.test.js` (pure-JS policy unit tests):

```js
import { loftShadingPolicy, SMOOTH, FACETED } from "../src/framework/geometry/shading-policy.js";

test("shading: any curved ring segment ⇒ SMOOTH", () => {
  const rl = resolveLoftRings([{ polygon: roundedProfile(SQ, 2), z: 0 }, { polygon: roundedProfile(SQ, 2), z: 9 }]);
  expect(loftShadingPolicy(rl, {})).toBe(SMOOTH);
});

test("shading: low-count all-line rings stay FACETED; 32+ resolved sides shade SMOOTH", () => {
  expect(loftShadingPolicy(resolveLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 9 }]), {})).toBe(FACETED);
  expect(loftShadingPolicy(resolveLoftRings([{ sides: 48, radius: 8, z: 0 }, { sides: 48, radius: 8, z: 9 }]), {})).toBe(SMOOTH);
});

test("shading: explicit hint and ruled:false still win", () => {
  const rl = resolveLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 9 }]);
  expect(loftShadingPolicy(rl, { shading: "smooth" })).toBe(SMOOTH);
  expect(loftShadingPolicy(rl, { ruled: false })).toBe(SMOOTH);
  expect(() => loftShadingPolicy(rl, { shading: "flat" })).toThrow(/smooth.*faceted/);
});
```

Append a kernel-level test to `test/loft-shading.test.js` (it already boots `bootManifoldKernel`):

```js
test("a Shape2D rounded-square loft previews with smoothed arc walls", async () => {
  const rsq = k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(4);
  const solid = k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 12, scale: 0.6 }] });
  const m = solid.mesh();
  const { flat, total } = wallTris(m);
  expect(total).toBeGreaterThan(0);
  expect(flat).toBeLessThan(total); // some walls smoothed — FACETED would flat-shade all
});

test("Shape2D rings cache-key by content: same shape twice hits, different fillet misses", () => {
  const mk = (r) => k.loft({ rings: [
    { polygon: k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(r), z: 0 },
    { polygon: k.shape2d([[-10, -10], [10, -10], [10, 10], [-10, 10]]).fillet(r), z: 12 },
  ] });
  expect(mk(4)._hash).toBe(mk(4)._hash);
  expect(mk(4)._hash).not.toBe(mk(3)._hash);
});
```

(Adapt `wallTris` usage to its actual return shape in that file — it counts `flat`/`total` locals; return them or inline the loop as the existing tests do. If `Solid.mesh()` is spelled differently in the kernel surface, mirror whatever the existing tests in this file call.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loft-rings.test.js test/loft-shading.test.js`
Expected: FAIL — `loftShadingPolicy` still reads raw ring specs (returns FACETED for Shape2D rings whose `polygon` isn't an array); the backend key path throws or mis-keys on Shape2D rings.

- [ ] **Step 3: Implement**

`shading-policy.js` — replace `loftShadingPolicy`:

```js
// Loft shading inference over RESOLVED rings (resolveLoftRings' result). An explicit
// `shading` hint wins; `ruled:false` must preview smooth (it exports smooth via OCCT);
// any curved ring segment (arc/cubic) is smooth-surface intent; otherwise low
// resolved side counts are intentional facets.
export function loftShadingPolicy(resolvedLoft, { shading, ruled } = {}) {
  if (shading === "smooth") return SMOOTH;
  if (shading === "faceted") return FACETED;
  if (shading != null) throw new Error('loft: shading must be "smooth" | "faceted"');
  if (ruled === false) return SMOOTH;
  if (resolvedLoft?.hasCurve) return SMOOTH;
  let maxSides = 0;
  for (const r of resolvedLoft?.resolved ?? []) if (r.pts2d.length > maxSides) maxSides = r.pts2d.length;
  return maxSides >= SMOOTH_SIDES_MIN ? SMOOTH : FACETED;
}
```

`manifold-backend.js` loft op (replace lines 611-620):

```js
    loft: (rings, opts = {}) => {
      const key = h("loft", loftRingsKey(rings), opts);
      return cache.lookup(key, () => {
        const rl = resolveLoftRings(rings);        // resolve once: mesh + shading share it
        const raw = T(loftMesh(wasm, rl, opts));
        const m = T(raw.asOriginal());
        const id = m.originalID();
        oidPolicies.set(id, loftShadingPolicy(rl, opts));
        return { value: wrap(m, key), pin: m, dispose: () => { oidPolicies.delete(id); m.delete?.(); } };
      });
    },
```

Add `import { resolveLoftRings, loftRingsKey } from "./loft-rings.js";` to the backend's imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loft-rings.test.js test/loft-shading.test.js test/loft-mesh.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/shading-policy.js test/loft-rings.test.js test/loft-shading.test.js
git commit -m "feat(loft): Shape2D-safe cache keys and curve-aware shading on the Manifold backend"
```

---

### Task 6: OCCT backend — curve wires when compatible, shared polygons otherwise

**Files:**
- Modify: `src/framework/geometry/occt-backend.js:26,428-435`
- Modify: `src/framework/geometry/loft.js` (delete the `resolveRings` shim)
- Test: Create `test/loft-shape2d-occt.test.js` (OCCT boots alone — never with Manifold)

**Interfaces:**
- Consumes: `resolveLoftRings`, `loftRingsKey`; existing `contourDrawing` (handles curve contours already — arcs → `threePointsArcTo`, cubics → `cubicBezierCurveTo`).
- Produces: OCCT `loft` behavior — mode `curve` lofts original curve wires; `poly-exact`/`resample` loft the resolved point rings (identical to Manifold's).

- [ ] **Step 1: Write the failing tests**

```js
// test/loft-shape2d-occt.test.js
// OCCT-only file (vitest isolates per file; never boot Manifold here). Parity with the
// Manifold numbers is asserted against shared ANALYTIC values, not a co-booted kernel:
//  - curve mode: exact rounded-square prismatoid (OCCT is curve-exact ⇒ tight tolerance);
//  - resample mode: the prismatoid estimate V = h/6 · (A0 + 4·A½ + A1) over the SAME
//    resolved rings both backends consume. Not exact for either backend (OCCT's ruled
//    faces between skew edges are saddle patches; Manifold splits each wall quad into
//    two triangles), but both land within a fraction of a percent of it — and of each
//    other — because they loft the identical vertex correspondence. Both files pin the
//    same formula at the same tolerance; that shared anchor is the parity assertion.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { resolveLoftRings } from "../src/framework/geometry/loft-rings.js";
import { roundedProfile, circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

test("curve mode: rounded-square rings loft as EXACT B-rep — analytic prism volume", () => {
  const rsq = roundedProfile(SQ, 2);
  const v = k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10 }] }).volume();
  const exact = (100 - (4 - Math.PI) * 4) * 10;   // 965.6637061…
  expect(v).toBeCloseTo(exact, 3);                 // curve-exact, not faceted
});

test("curve mode: STEP export keeps true CIRCLE edges", async () => {
  const rsq = roundedProfile(SQ, 2);
  const solid = k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10, scale: 0.5 }] });
  const step = await k.toSTEP([{ name: "loft", solid }]);
  const text = typeof step === "string" ? step : new TextDecoder().decode(step);
  expect(text).toMatch(/CIRCLE/);
});

test("resample mode: volume tracks the prismatoid of the shared resolved rings (parity anchor)", () => {
  const rings = [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }];
  const { resolved } = resolveLoftRings(rings);
  const mid = resolved[0].pts2d.map((p, i) => [
    (p[0] + resolved[1].pts2d[i][0]) / 2, (p[1] + resolved[1].pts2d[i][1]) / 2]);
  const expected = (10 / 6) * (shoelace(resolved[0].pts2d) + 4 * shoelace(mid) + shoelace(resolved[1].pts2d));
  const v = k.loft({ rings }).volume();
  expect(Math.abs(v - expected) / expected).toBeLessThan(0.005); // same anchor+tolerance as loft-mesh.test.js
});

test("resample mode: STEP export is faceted (no CIRCLE edges) — the documented trade", async () => {
  const solid = k.loft({ rings: [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }] });
  const step = await k.toSTEP([{ name: "loft", solid }]);
  const text = typeof step === "string" ? step : new TextDecoder().decode(step);
  expect(text).not.toMatch(/CIRCLE/);
});

test("closed:true still throws on OCCT in every mode", () => {
  const rsq = roundedProfile(SQ, 2);
  expect(() => k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10 }], closed: true }))
    .toThrow(/Manifold backend/);
});
```

Add the analogous Manifold-side prismatoid assertion to `test/loft-mesh.test.js` so the two files pin the same number:

```js
test("resample-mode Manifold volume tracks the shared-ring prismatoid (parity anchor)", () => {
  const rings = [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }];
  const { resolved } = resolveLoftRings(rings);
  const sh = (ring) => ring.reduce((a, [x, y], i) => { const [nx, ny] = ring[(i + 1) % ring.length]; return a + x * ny - nx * y; }, 0) / 2;
  const mid = resolved[0].pts2d.map((p, i) => [(p[0] + resolved[1].pts2d[i][0]) / 2, (p[1] + resolved[1].pts2d[i][1]) / 2]);
  const expected = (10 / 6) * (sh(resolved[0].pts2d) + 4 * sh(mid) + sh(resolved[1].pts2d));
  const v = loftMesh(wasm, rings).volume();
  expect(Math.abs(v - expected) / expected).toBeLessThan(0.005); // same anchor+tolerance as loft-shape2d-occt.test.js
});
```

(with `import { resolveLoftRings } from "../src/framework/geometry/loft-rings.js";` at the top).

`k.toSTEP`'s exact calling convention: mirror `test/export-occt.test.js` — if it differs from `toSTEP(named[])` above, follow that file, not this plan.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/loft-shape2d-occt.test.js`
Expected: FAIL — curve rings reach `contourDrawing(pts2d)` as polygons (volume lands below the exact value; STEP has no CIRCLE) or the old shim path mis-shapes.

- [ ] **Step 3: Implement the OCCT loft op**

`occt-backend.js:26` — replace the import:

```js
import { resolveLoftRings, loftRingsKey } from "./loft-rings.js";
```

Replace `loftOp` (occt-backend.js:428-435):

```js
  // ring loft: mode "curve" (structurally identical curve rings) lofts the ORIGINAL
  // baked contours as true arc/spline wires — STEP stays curve-exact; every other mode
  // lofts the same resolved point rings the Manifold backend stitches, so parity is by
  // construction (ThruSections' own wire-matching never gets to pick a different seam).
  // closed:true loops are Manifold-only (replicad loft is open).
  const loftOp = (rings, { ruled = true, closed = false } = {}) => {
    if (closed) throw new Error("loft: closed:true loops are only supported on the Manifold backend");
    const key = h("loft", loftRingsKey(rings), ruled);
    return cached(key, () => {
      const { mode, resolved } = resolveLoftRings(rings);
      const wires = resolved.map(({ pts2d, contour, z }) =>
        (mode === "curve" ? contourDrawing(contour) : contourDrawing(pts2d)).sketchOnPlane("XY", z).wire);
      return wrap(loft(wires, { ruled }), [], key);
    });
  };
```

Delete the `resolveRings` shim line from `loft.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loft-shape2d-occt.test.js test/loft-mesh.test.js`
Then the OCCT regression set: `npx vitest run test/export-occt.test.js test/calling-convention-occt.test.js test/occt-backend.test.js`.

**If the curve-mode volume or STEP test fails with a twisted/self-intersecting shape:** this is the known ThruSections wire-matching risk (design doc §modes). Diagnose by exporting the two-ring scaled loft and checking whether walls cross. The fix inside this task's scope: build each wire so its FIRST edge starts at the contour's `start` (contourDrawing already does — `draw(contour.start)`), and if OCCT still re-matches, drop curve mode for *scaled* rings only (`mode: "curve"` requires all rings to share `scale`), falling back to resample. Record whichever holds in the design doc.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/occt-backend.js src/framework/geometry/loft.js test/loft-shape2d-occt.test.js test/loft-mesh.test.js
git commit -m "feat(loft): OCCT lofts original curve wires for compatible rings, shared polygons otherwise"
```

---

### Task 7: contract prose, authoring docs, error patterns, version bump

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md` (loft row ~line 287; the parity paragraph ~line 306; shading note ~line 388)
- Modify: `docs/AUTHORING-PARTS.md` (loft section — locate with `grep -n "loft" docs/AUTHORING-PARTS.md`)
- Modify: `docs/ERROR-PATTERNS.md` (new entries; update any stale loft entries — `grep -n "loft" docs/ERROR-PATTERNS.md`)
- Modify: `src/framework/geometry/kernel.js` (the `loft` `@typedef`, kernel.js:145)
- Modify: `package.json` (version `0.80.0` → `0.81.0`)
- Test: `test/kernel-contract.test.js`, `test/error-patterns.test.js` (existing suites must stay green)

**Interfaces:** none — documentation of Tasks 1–6's behavior. Contract version stays 4 (loosened validation is additive per the Versioning section).

- [ ] **Step 1: Update `KERNEL-CONTRACT.md`**

Replace the `loft` row (line ~287) with:

```markdown
| `loft({rings, ruled?, closed?})` | Stack cross-sections along Z with ruled walls and capped ends (per-ring `z`/`rotate`/`scale`). A ring's `polygon` may be a point list, `sides`+`radius`, a curve contour, or a single-region hole-free `Shape2D` (multi-region / holed shapes throw). Rings with **identical segment structure** (one shape reused at different z/scale/rotate) loft **curve-natively** on a B-rep kernel — STEP keeps true arcs — while a mesh kernel facets the same sections at a fixed LOD (`hull`'s parity class). **Structurally different rings** (a rounded square morphing to a circle, unequal-N point lists) are arc-length-resampled once, in shared pure-JS code, to a common vertex count with a deterministic seam (the outermost +X-ray crossing from each ring's centroid; per-ring `rotate` tunes the phase) and snapped corners — every backend then lofts the **identical** point rings, so the result is parity **by construction** and STEP is faceted at the sampling LOD. Must self-correct a fully inverted result (CW rings / descending z) to an outward solid. |
```

In the parity paragraph after the op table (~line 306-312), extend the "by construction" sentence:

```markdown
Where both backends build the same shape they do it **by construction, not by
tolerance**: sweep elbows loft the identical station list (`sweep.js`), and
structurally-different loft rings loft the identical resampled ring list
(`loft-rings.js`) on both backends. Structurally-identical curve rings are the
exception by design: the B-rep kernel keeps the exact curves (STEP-exact) while a
mesh kernel facets them — `hull`'s parity class.
```

- [ ] **Step 2: Update `AUTHORING-PARTS.md`, `kernel.js` typedef, `ERROR-PATTERNS.md`**

`kernel.js:145` — extend the loft `@typedef` comment: `polygon?: number[][] | Contour | Shape2D` (match the file's existing type-name spellings; keep the legacy note).

`AUTHORING-PARTS.md` loft section: document the three ring forms, the two parity behaviors (same-curve rings → STEP-exact arcs; different rings → shared resample, faceted STEP), the seam rule (+X ray from ring centroid; use per-ring `rotate` to tune twist), and the hole-free single-region rule with the workaround (cut holes from the lofted solid).

`ERROR-PATTERNS.md` — add two entries in the file's `##` format:

```markdown
## loft: ring N is a Shape2D with M regions

**Symptom:** `Error: loft: ring 0 is a Shape2D with 2 regions — a loft ring must be a single closed outline`
**Cause:** the Shape2D handed to a loft ring holds several disjoint outlines (usually the result of a union that never overlapped).
**Fix:** loft each region as its own solid and union the lofts, or rebuild the profile so the outlines actually merge into one.

## loft: ring N has holes

**Symptom:** `Error: loft: ring 0 has holes — loft rings must be hole-free outlines`
**Cause:** the ring Shape2D has an inner contour (a `.cut()` inside the outline). Lofting hole tunnels needs its own correspondence and is not supported.
**Fix:** loft the outer outline, then `.cut()` a second loft (or an extrusion) of the hole profile from the solid.
```

Also delete/rewrite any existing pattern that documents "every ring must have the same
number of points" as an error — that input now auto-resamples.

- [ ] **Step 3: Bump `package.json` to `0.81.0`**

Feature release; the publish workflow tags and publishes on merge (AGENTS.md "Releasing" — forgetting this bump is the known quiet failure mode).

- [ ] **Step 4: Run the doc-consistency suites**

Run: `npx vitest run test/kernel-contract.test.js test/error-patterns.test.js`
Expected: PASS (contract version header untouched at 4; new error entries parse).

- [ ] **Step 5: Commit**

```bash
git add docs/KERNEL-CONTRACT.md docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md src/framework/geometry/kernel.js package.json
git commit -m "docs(loft): Shape2D ring forms, parity classes, error patterns; bump to 0.81.0"
```

---

### Task 8: reference part — `lofted-bottle`

**Files:**
- Create: `src/parts/lofted-bottle.js`, `lofted-bottle.html`, `src/app-lofted-bottle.js`, `src/lofted-bottle-worker.js`
- Modify: `docs/REFERENCE-PARTS.md` (add a row — follow the file's existing format), `AGENTS.md` (the parts list: "thirteen" → "fourteen", add the one-line description)
- Test: CLI gates (`lint` + `measure`), not vitest

**Interfaces:** consumes only the public part surface (`k.shape2d`, `k.loft`, `circleProfile` from `partforge/geometry`).

- [ ] **Step 1: Write the part**

```js
// src/parts/lofted-bottle.js
// Example PartDefinition — the Shape2D-loft reference part. One rounded-square Shape2D
// is reused up the body with per-ring scales (structurally identical rings: OCCT lofts
// the original arc wires, so STEP keeps true circles); the shoulder morphs that square
// into a circle (structurally different rings: both backends loft the identical
// resampled sections). See docs/AUTHORING-PARTS.md for the conventions.
import { circleProfile } from "partforge/geometry";

export default {
  meta: { title: "Lofted Bottle", units: "mm" },
  parameters: [
    {
      id: "body",
      title: "Bottle",
      description: "A bottle lofted from a rounded-square base to a round neck (`k.loft` " +
        "with `Shape2D` rings). **Corner radius** shapes the base; **Belly** bulges the body.",
      presets: {
        "Flask": { width: 40, bodyH: 70, cornerR: 8, belly: 1.15, neckD: 22, neckH: 25 },
        "Square jar": { width: 60, bodyH: 50, cornerR: 6, belly: 1.0, neckD: 40, neckH: 12 },
        "Slim vial": { width: 24, bodyH: 60, cornerR: 10, belly: 1.05, neckD: 14, neckH: 20 },
      },
      advanced: [
        { key: "width", label: "Base width", unit: "mm", min: 20, max: 80, step: 1, description: "Across-flats width of the rounded-square base." },
        { key: "bodyH", label: "Body height", unit: "mm", min: 30, max: 120, step: 1, description: "Height of the square-section body." },
        { key: "cornerR", label: "Corner radius", unit: "mm", min: 1, max: 12, step: 0.5, description: "Base corner rounding — these arcs stay true circles in STEP." },
        { key: "belly", label: "Belly", min: 0.9, max: 1.4, step: 0.05, description: "Mid-body scale — above 1 bulges, below 1 pinches." },
        { key: "neckD", label: "Neck diameter", unit: "mm", min: 10, max: 50, step: 1, description: "Round neck diameter at the mouth." },
        { key: "neckH", label: "Neck height", unit: "mm", min: 8, max: 40, step: 1, description: "Height of the square-to-circle shoulder." },
      ],
    },
  ],
  defaults: { width: 40, bodyH: 70, cornerR: 8, belly: 1.15, neckD: 22, neckH: 25 },
  parts: {
    bottle: {
      label: "Bottle", views: ["bottle"], export: { name: "lofted-bottle" },
      build: (k, p) => {
        const half = p.width / 2;
        const r = Math.min(p.cornerR, half - 0.5); // fillet must fit the half-width
        const sq = k.shape2d([[-half, -half], [half, -half], [half, half], [-half, half]]).fillet(r);
        // Body: one Shape2D reused with per-ring scale → curve mode (STEP-exact arcs).
        const body = k.loft({ rings: [
          { polygon: sq, z: 0 },
          { polygon: sq, z: p.bodyH * 0.45, scale: p.belly },
          { polygon: sq, z: p.bodyH },
        ] }).label("Body");
        // Shoulder: rounded square → circle → resample mode (shared rings, both backends).
        const shoulder = k.loft({ rings: [
          { polygon: sq, z: p.bodyH },
          { polygon: circleProfile(p.neckD / 2), z: p.bodyH + p.neckH },
        ] }).label("Shoulder");
        return body.union(shoulder);
      },
    },
  },
  views: { bottle: { label: "Bottle" } },
  verify: {
    expect: {
      bottle: { holes: 0, bbox: "<=[120,120,165]" },
      _view: { overlaps: 0 },
    },
  },
};
```

(Check `docs/AUTHORING-PARTS.md`'s verify-block grammar before finalizing `expect` — mirror `faceted-vase.js`'s keys, which are proven.)

- [ ] **Step 2: Wire the app glue (copy the demo trio, substituting the part name)**

`src/app-lofted-bottle.js` — copy `src/app-demo.js`, importing `./parts/lofted-bottle.js` and pointing the inline `new Worker(new URL("./lofted-bottle-worker.js", import.meta.url), { type: "module", name })` at the new worker (the `new URL` call **must stay inline** or Vite won't bundle it).

`src/lofted-bottle-worker.js`:

```js
import part from "./parts/lofted-bottle.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

`lofted-bottle.html` — copy `demo.html`, retitle `Lofted Bottle — Shape2D loft reference`, point its `<script type="module">` at `/src/app-lofted-bottle.js`. Dev-only page: do **not** add it to `vite.config` `rollupOptions.input`.

- [ ] **Step 3: Run the CLI gates**

```bash
npx partforge lint src/parts/lofted-bottle.js
npx partforge measure src/parts/lofted-bottle.js
```

Expected: lint clean; measure watertight, `holes: 0`, verify gate passes. On failure, grep `docs/ERROR-PATTERNS.md` first.

- [ ] **Step 4: Update `docs/REFERENCE-PARTS.md` and `AGENTS.md`**

REFERENCE-PARTS.md: add a `lofted-bottle` row following the file's format — "the `Shape2D` loft reference part — curve-mode body (STEP-exact arc rings) + resample-mode shoulder (square→circle morph)".
AGENTS.md: "thirteen" → "fourteen"; append `lofted-bottle.js` to the parts list sentence with the same one-line description.

- [ ] **Step 5: Full suite + smoke**

```bash
npm test
node scripts/check-app.mjs lofted-bottle.html
```

Expected: suite green; smoke boots (needs Playwright Chromium — if not installed: `npm i -D playwright && npx playwright install chromium`).

- [ ] **Step 6: Commit**

```bash
git add src/parts/lofted-bottle.js lofted-bottle.html src/app-lofted-bottle.js src/lofted-bottle-worker.js docs/REFERENCE-PARTS.md AGENTS.md
git commit -m "feat(parts): lofted-bottle — the Shape2D loft reference part"
```
