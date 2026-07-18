# Curve-native profile IR (cubic Béziers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let 2-D profiles carry cubic Bézier segments that go *exact* into the OCCT (STEP) backend and *faceted at mesh LOD* into the Manifold backend — generalizing the existing circular-arc mechanism.

**Architecture:** partforge already carries curves symbolically as an `ArcContour` (`{start, segments:[{to}|{to,via}]}`): OCCT maps segments to replicad pen calls (exact B-rep), Manifold tessellates them at the kernel `segs` LOD. This plan adds one segment kind — `{to, c1, c2}` (cubic) — discriminated structurally, so legacy point arrays and existing arc contours stay byte-for-byte identical. A new `sampleBezier` flattens cubics by adaptive subdivision keyed to `segs`; a `pathProfile` builder makes curves authorable.

**Tech Stack:** plain ESM JS, vitest, Manifold (WASM mesh CSG) + replicad/OCCT (WASM B-rep), Node 24.

## Global Constraints

- **Node 24** — run `nvm use` before any `npm`/`npx vitest` command.
- **Units are millimetres** throughout.
- **`build`/helpers must be pure** — no `Math.random`, clock, or module-level mutable state (the preview kernel memoizes by content hash).
- **Part modules and geometry helpers are DOM-free and side-effect-free** (load in worker + main thread + Node).
- **OCCT and Manifold must not boot in the same process** — keep OCCT tests in their own file (vitest isolates per file); boot OCCT via `bootOcctKernel()`, Manifold via `bootManifoldKernel()`.
- **Structural discrimination, no `kind` tag:** `{to}`=line, `{to,via}`=arc, `{to,c1,c2}`=cubic. Legacy arrays/arc contours must remain unchanged (no cache-busting).
- **Version bump is additive** — do NOT change `CONTRACT_VERSION`.
- **Every export of `polygon.js` must be named with backticks in `docs/KERNEL-CONTRACT.md`** (lint: `test/kernel-contract.test.js` "names every partforge/geometry helper").
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Cubic-segment validation + `isPathContour` alias

**Files:**
- Modify: `src/framework/geometry/profile.js` (add `isPathContour`; extend `validateContour`)
- Test: `test/profiles.test.js`
- Modify: `docs/ERROR-PATTERNS.md` (entries for the two new literals)

**Interfaces:**
- Consumes: existing `isArcContour(c)`, `validateContour(c, role)`, `normalizeProfile(profile)` in `profile.js`.
- Produces:
  - `isPathContour(c): boolean` — alias of `isArcContour` (symbolic-form predicate).
  - `validateContour` now throws for cubic segments:
    - `extrude: <role> segment cannot mix arc (via) and cubic (c1/c2)`
    - `extrude: <role> cubic segment needs c1 and c2 as finite [x,y]`

- [ ] **Step 1: Write the failing tests**

Add to `test/profiles.test.js`:

```js
import { normalizeProfile, isPathContour } from "../src/framework/geometry/profile.js";

test("isPathContour accepts the symbolic form (line/arc/cubic), rejects arrays", () => {
  expect(isPathContour({ start: [0, 0], segments: [{ to: [1, 0], c1: [0, 1], c2: [1, 1] }] })).toBe(true);
  expect(isPathContour([[0, 0], [1, 0], [1, 1]])).toBe(false);
});

test("cubic segment validation: mixing via+cubic and missing controls throw", () => {
  const mix = { start: [0, 0], segments: [{ to: [1, 1], via: [0, 1], c1: [0, 0], c2: [1, 0] }] };
  expect(() => normalizeProfile(mix)).toThrow("segment cannot mix arc (via) and cubic (c1/c2)");

  const half = { start: [0, 0], segments: [{ to: [1, 1], c1: [0, 1] }] };
  expect(() => normalizeProfile(half)).toThrow("cubic segment needs c1 and c2 as finite [x,y]");

  const nan = { start: [0, 0], segments: [{ to: [1, 1], c1: [0, NaN], c2: [1, 0] }] };
  expect(() => normalizeProfile(nan)).toThrow("cubic segment needs c1 and c2 as finite [x,y]");
});

test("a valid cubic contour passes normalizeProfile unchanged", () => {
  const c = { start: [0, 0], segments: [{ to: [10, 0], c1: [3, 4], c2: [7, 4] }] };
  expect(normalizeProfile(c).outer).toBe(c);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/profiles.test.js -t "cubic segment validation"`
Expected: FAIL — `isPathContour` is not exported / no mix+control validation yet.

- [ ] **Step 3: Implement the alias + validation**

In `src/framework/geometry/profile.js`, just below `isArcContour`, add:

```js
// Curves generalize arcs; the symbolic-form predicate is the same. Prefer this name.
export const isPathContour = isArcContour;
```

Extend `validateContour` — inside the `if (isArcContour(c))` branch, after the
`c.segments` length check and before `return`, insert the per-segment cubic checks:

```js
    for (const s of c.segments) {
      const hasCubic = s.c1 != null || s.c2 != null;
      if (hasCubic) {
        if (s.via != null)
          throw new Error(`extrude: ${role} segment cannot mix arc (via) and cubic (c1/c2)`);
        const ok = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
        if (!ok(s.c1) || !ok(s.c2))
          throw new Error(`extrude: ${role} cubic segment needs c1 and c2 as finite [x,y]`);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvm use && npx vitest run test/profiles.test.js`
Expected: PASS (all profile tests, including the three new ones).

- [ ] **Step 5: Add ERROR-PATTERNS entries**

In `docs/ERROR-PATTERNS.md`, in the same section as the other `extrude:` contour
entries, add two entries (match the house format: `##` kebab heading, then
**Symptom**/**Cause**/**Fix** bullets; Symptom opens with the backtick literal):

```markdown
## cubic-segment-mixes-arc-and-cubic

- **Symptom:** `extrude: <role> segment cannot mix arc (via) and cubic (c1/c2)`
- **Cause:** A path-contour segment carries both `via` (three-point arc) and
  `c1`/`c2` (cubic Bézier). A segment is exactly one kind.
- **Fix:** Drop `via` for a cubic, or drop `c1`/`c2` for an arc. Use
  `pathProfile().arcTo(to, via)` or `.cubicTo(to, c1, c2)` to build segments.

## cubic-segment-missing-controls

- **Symptom:** `extrude: <role> cubic segment needs c1 and c2 as finite [x,y]`
- **Cause:** A cubic segment is missing `c1` or `c2`, or a control point is not
  a finite `[x,y]` (e.g. `NaN`, wrong length).
- **Fix:** Provide both control points as finite `[x,y]`. A cubic Bézier needs
  two controls between the previous point and `to`.
```

- [ ] **Step 6: Run the error-patterns lint**

Run: `nvm use && npx vitest run test/error-patterns.test.js`
Expected: PASS (entry format accepted).

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/profile.js test/profiles.test.js docs/ERROR-PATTERNS.md
git commit -m "feat: validate cubic path-contour segments; add isPathContour

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `sampleBezier` + Manifold tessellation of cubics

**Files:**
- Modify: `src/framework/geometry/profile.js` (add `sampleBezier`; add cubic branch to `tessellateContour`)
- Test: `test/profiles.test.js`

**Interfaces:**
- Consumes: `tessellateContour(contour, segs)` walk (has `prev`, pushes into `ring`); existing `sampleArc(p0, via, p1, segs)`.
- Produces:
  - `sampleBezier(p0, c1, c2, p1, segs): [[x,y],…]` — points **after** `p0`, last pinned exactly to `p1`; pure in `(args, segs)`.
  - `tessellateContour` now flattens `{to,c1,c2}` segments via `sampleBezier`.

- [ ] **Step 1: Write the failing tests**

Add to `test/profiles.test.js`:

```js
import { sampleBezier } from "../src/framework/geometry/profile.js";

// Standard cubic approximation of a quarter circle radius R, (R,0)→(0,R).
const KAPPA = 0.5522847498307936;
const quarterArcCubic = (R) => ({ p0: [R, 0], c1: [R, R * KAPPA], c2: [R * KAPPA, R], p1: [0, R] });

test("sampleBezier excludes the start and pins the exact endpoint", () => {
  const { p0, c1, c2, p1 } = quarterArcCubic(10);
  const pts = sampleBezier(p0, c1, c2, p1, 32);
  expect(pts.length).toBeGreaterThan(1);
  expect(pts[0]).not.toEqual(p0);
  expect(pts[pts.length - 1]).toEqual(p1);
});

test("sampleBezier facet count rises with segs on a curved input", () => {
  const { p0, c1, c2, p1 } = quarterArcCubic(10);
  const lo = sampleBezier(p0, c1, c2, p1, 8).length;
  const hi = sampleBezier(p0, c1, c2, p1, 64).length;
  expect(hi).toBeGreaterThan(lo);
});

test("sampleBezier of a quarter-circle cubic stays near radius R (LOD tightens with segs)", () => {
  const R = 10, { p0, c1, c2, p1 } = quarterArcCubic(R);
  const maxErr = (segs) => Math.max(...sampleBezier(p0, c1, c2, p1, segs).map(([x, y]) => Math.abs(Math.hypot(x, y) - R)));
  expect(maxErr(16)).toBeLessThan(0.1);      // within 0.1 mm of the true circle
  expect(maxErr(64)).toBeLessThan(maxErr(16)); // finer LOD → tighter
});

test("sampleBezier of a near-straight cubic collapses to few chords", () => {
  const pts = sampleBezier([0, 0], [3, 0], [7, 0], [10, 0], 32); // controls on the line
  expect(pts.length).toBeLessThanOrEqual(2);
  expect(pts[pts.length - 1]).toEqual([10, 0]);
});

test("sampleBezier is pure (same input twice → deep equal)", () => {
  const { p0, c1, c2, p1 } = quarterArcCubic(7);
  expect(sampleBezier(p0, c1, c2, p1, 24)).toEqual(sampleBezier(p0, c1, c2, p1, 24));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/profiles.test.js -t "sampleBezier"`
Expected: FAIL — `sampleBezier` is not exported.

- [ ] **Step 3: Implement `sampleBezier`**

In `src/framework/geometry/profile.js`, add (near `sampleArc`):

```js
// Flatten the cubic Bézier (p0,c1,c2,p1) into points p1…pN — EXCLUDING the start
// p0 (the ring already holds it), last point pinned exactly to p1. Adaptive: split
// at t=½ (de Casteljau) until the control polygon's total unsigned turn is ≤ 2π/segs
// — the exact generalization of sampleArc's "a point every 2π/segs of sweep", so a
// cubic tracing a circular arc facets like the arc primitive at the same segs. Summing
// |turn| at BOTH interior control points also catches S-curves a pure endpoint-tangent
// test would miss. Depth cap guarantees termination. Pure in (args, segs).
export function sampleBezier(p0, c1, c2, p1, segs) {
  const maxTurn = (2 * Math.PI) / Math.max(3, segs);
  const out = [];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const turn = (u, v) => {
    const du = Math.hypot(u[0], u[1]), dv = Math.hypot(v[0], v[1]);
    if (du < 1e-12 || dv < 1e-12) return 0;
    let c = (u[0] * v[0] + u[1] * v[1]) / (du * dv);
    if (c > 1) c = 1; else if (c < -1) c = -1;
    return Math.acos(c);
  };
  const recurse = (a, b, c, d, depth) => {
    const ab = [b[0] - a[0], b[1] - a[1]];
    const bc = [c[0] - b[0], c[1] - b[1]];
    const cd = [d[0] - c[0], d[1] - c[1]];
    if (depth >= 12 || turn(ab, bc) + turn(bc, cd) <= maxTurn) { out.push([d[0], d[1]]); return; }
    const p01 = mid(a, b), p12 = mid(b, c), p23 = mid(c, d);
    const p012 = mid(p01, p12), p123 = mid(p12, p23), m = mid(p012, p123);
    recurse(a, p01, p012, m, depth + 1);
    recurse(m, p123, p23, d, depth + 1);
  };
  recurse(p0, c1, c2, p1, 0);
  if (out.length === 0) out.push([p1[0], p1[1]]);
  out[out.length - 1] = [p1[0], p1[1]];   // pin the exact endpoint
  return out;
}
```

Add the cubic branch to `tessellateContour` — replace the segment loop body:

```js
  for (const seg of contour.segments) {
    if (seg.c1) for (const p of sampleBezier(prev, seg.c1, seg.c2, seg.to, segs)) ring.push(p);
    else if (seg.via) for (const p of sampleArc(prev, seg.via, seg.to, segs)) ring.push(p);
    else ring.push([seg.to[0], seg.to[1]]);
    prev = seg.to;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvm use && npx vitest run test/profiles.test.js`
Expected: PASS (all profile tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/profile.js test/profiles.test.js
git commit -m "feat: sampleBezier — adaptive cubic flattening at mesh LOD

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `pathProfile` fluent builder

**Files:**
- Modify: `src/framework/geometry/polygon.js` (add `pathProfile`)
- Modify: `docs/KERNEL-CONTRACT.md` (name `` `pathProfile` `` — lint gate)
- Test: `test/profiles.test.js`

**Interfaces:**
- Produces: `pathProfile(start): builder` with chainable `.lineTo(to)`, `.arcTo(to, via)`, `.cubicTo(to, c1, c2)`, and `.close(): {start, segments}` (a path contour consumable by `extrude`/`revolve`/`prism`).

- [ ] **Step 1: Write the failing tests**

Add to `test/profiles.test.js`:

```js
import { pathProfile } from "../src/framework/geometry/polygon.js";

test("pathProfile builds the canonical { start, segments } with correct kinds", () => {
  const c = pathProfile([0, 0])
    .lineTo([10, 0])
    .arcTo([10, 10], [11, 5])
    .cubicTo([0, 10], [7, 12], [3, 12])
    .close();
  expect(c.start).toEqual([0, 0]);
  expect(c.segments).toEqual([
    { to: [10, 0] },
    { to: [10, 10], via: [11, 5] },
    { to: [0, 10], c1: [7, 12], c2: [3, 12] },
  ]);
});

test("pathProfile rejects bad points and empty paths", () => {
  expect(() => pathProfile([0])).toThrow("pathProfile: start must be a finite [x,y]");
  expect(() => pathProfile([0, 0]).lineTo([1, NaN])).toThrow("pathProfile: lineTo point must be a finite [x,y]");
  expect(() => pathProfile([0, 0]).close()).toThrow("pathProfile: need ≥1 segment before close()");
});

test("a pathProfile contour tessellates and normalizes like any path contour", () => {
  const c = pathProfile([0, 0]).lineTo([10, 0]).cubicTo([0, 10], [10, 4], [4, 10]).close();
  expect(normalizeProfile(c).outer).toBe(c);
  expect(tessellateContour(c, 24).length).toBeGreaterThan(3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/profiles.test.js -t "pathProfile"`
Expected: FAIL — `pathProfile` is not exported.

- [ ] **Step 3: Implement `pathProfile`**

In `src/framework/geometry/polygon.js`, add:

```js
// Fluent builder for a curve-native path contour { start, segments }. Segment kinds:
// lineTo → {to}, arcTo → {to,via} (three-point arc), cubicTo → {to,c1,c2} (cubic Bézier).
// close() returns the plain contour object (feeds extrude/revolve/prism), not a Solid.
export function pathProfile(start) {
  const fin2 = (p, what) => {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error(`pathProfile: ${what} must be a finite [x,y]`);
    return [p[0], p[1]];
  };
  const s = fin2(start, "start");
  const segments = [];
  const api = {
    lineTo(to) { segments.push({ to: fin2(to, "lineTo point") }); return api; },
    arcTo(to, via) { segments.push({ to: fin2(to, "arcTo point"), via: fin2(via, "arcTo via") }); return api; },
    cubicTo(to, c1, c2) {
      segments.push({ to: fin2(to, "cubicTo point"), c1: fin2(c1, "cubicTo c1"), c2: fin2(c2, "cubicTo c2") });
      return api;
    },
    close() {
      if (segments.length < 1) throw new Error("pathProfile: need ≥1 segment before close()");
      return { start: [s[0], s[1]], segments };
    },
  };
  return api;
}
```

- [ ] **Step 4: Name the export in KERNEL-CONTRACT.md (lint gate)**

In `docs/KERNEL-CONTRACT.md`, in the 2-D helper list (near `` `offsetPolygon` ``,
`` `roundedProfile` ``), add a bullet so the export is named in backticks:

```markdown
- `pathProfile` — fluent builder for a curve-native path contour (`lineTo` /
  `arcTo` / `cubicTo` / `close`); cubic segments become exact B-rep on OCCT and
  facet at mesh LOD on Manifold.
```

- [ ] **Step 5: Run tests + the geometry-helper doc lint**

Run: `nvm use && npx vitest run test/profiles.test.js test/kernel-contract.test.js`
Expected: PASS (including "KERNEL-CONTRACT.md names every partforge/geometry helper").

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/polygon.js docs/KERNEL-CONTRACT.md test/profiles.test.js
git commit -m "feat: pathProfile builder for curve-native contours

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: OCCT cubic B-rep edges

**Files:**
- Modify: `src/framework/geometry/occt-backend.js` (`contourDrawing` segment walk)
- Test: `test/curve-profile-occt.test.js` (new; OCCT-only, no Manifold co-boot)

**Interfaces:**
- Consumes: `pathProfile` (Task 3); replicad pen `cubicBezierCurveTo(to, c1, c2)`.
- Produces: cubic segments extrude as exact spline B-rep; STEP contains `B_SPLINE`.

**Known limitation (do NOT test revolve here):** `revolve`'s option-check
(`op-options.js` `revolveArgs` → `check: (pts) => { for (const [r] of pts) … }`)
assumes the profile is an `[[r,z],…]` point array and iterates it directly, so a
symbolic contour object `{start, segments}` throws "not iterable" *before* reaching
`contourDrawing`. This affects arc contours too — `revolve` has never accepted the
symbolic form. Extending `revolve` (and `prism`, which also bypasses region
tessellation on Manifold) to curve contours is deliberate follow-up, not F1. This
task proves the cubic B-rep through `extrude` only.

- [ ] **Step 1: Write the failing test**

Create `test/curve-profile-occt.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const KAPPA = 0.5522847498307936;
// A full circle radius R as four cubic quarter-arcs (the standard 4-Bézier circle).
const circleCubic = (R) => {
  const k4 = R * KAPPA;
  return pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R])
    .cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R])
    .cubicTo([R, 0], [k4, -R], [R, -k4])
    .close();
};

test("extruding a cubic circle gives ~π R² h with an exact B-rep (watertight)", () => {
  const R = 10, h = 5;
  const solid = k.extrude({ profile: circleCubic(R), h });
  expect(solid.volume()).toBeCloseTo(Math.PI * R * R * h, -1); // ~1571; OCCT exact
});

test("a cubic edge exports to STEP as a spline (B_SPLINE)", async () => {
  const solid = k.extrude({ profile: circleCubic(10), h: 5 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "p", solid }]));
  expect(step).toMatch(/B_SPLINE/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/curve-profile-occt.test.js`
Expected: FAIL — cubic segments currently fall through to `lineTo`, so the circle
is a 4-gon (volume far from πR²h) and STEP has no `B_SPLINE`.

- [ ] **Step 3: Implement the cubic branch**

In `src/framework/geometry/occt-backend.js`, in `contourDrawing`, replace the
`for (const seg of contour.segments) …` line (the arc/line walk) with:

```js
    for (const seg of contour.segments)
      pen = seg.c1 ? pen.cubicBezierCurveTo(seg.to, seg.c1, seg.c2)
          : seg.via ? pen.threePointsArcTo(seg.to, seg.via)
          : pen.lineTo(seg.to);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use && npx vitest run test/curve-profile-occt.test.js`
Expected: PASS (volume ≈ πR²h, revolve positive, STEP has `B_SPLINE`).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/occt-backend.js test/curve-profile-occt.test.js
git commit -m "feat: OCCT maps cubic segments to exact B-rep spline edges

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Manifold integration + cubic↔arc parity

**Files:**
- Test: `test/curve-profile-manifold.test.js` (new; Manifold-only)

**Interfaces:**
- Consumes: `bootManifoldKernel` (`../src/testing.js`); `pathProfile` (Task 3); `circleProfile` (`polygon.js`); the cubic tessellation from Task 2.
- Produces: none (integration test only).

- [ ] **Step 1: Write the failing test**

Create `test/curve-profile-manifold.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { pathProfile, circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const KAPPA = 0.5522847498307936;
const circleCubic = (R) => {
  const k4 = R * KAPPA;
  return pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R])
    .cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R])
    .cubicTo([R, 0], [k4, -R], [R, -k4])
    .close();
};

test("extruding a cubic circle yields ~π R² h and a watertight (genus 0) solid", () => {
  const R = 10, h = 5;
  const solid = k.extrude({ profile: circleCubic(R), h });
  expect(solid.volume()).toBeCloseTo(Math.PI * R * R * h, -2); // faceted → looser tol
  expect(solid.genus()).toBe(0);
});

test("cubic circle and circleProfile extrude to matching volumes (LOD parity)", () => {
  const R = 10, h = 5;
  const cubicVol = k.extrude({ profile: circleCubic(R), h }).volume();
  const arcVol = k.extrude({ profile: circleProfile(R), h }).volume();
  // Both facet the same circle at mesh LOD; adaptive vs fixed segs differ slightly.
  expect(Math.abs(cubicVol - arcVol) / arcVol).toBeLessThan(0.02); // within 2%
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `nvm use && npx vitest run test/curve-profile-manifold.test.js`
Expected: PASS — Task 2 already flattens cubics, so this exercises it end-to-end.
(If it fails on volume, the tessellation LOD from Task 2 needs revisiting — this
test is the guard that Task 2's `sampleBezier` produces a faithful circle.)

- [ ] **Step 3: Commit**

```bash
git add test/curve-profile-manifold.test.js
git commit -m "test: Manifold cubic extrude + cubic/circleProfile LOD parity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Docs + version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (import list + cubic example + behavior note)
- Modify: `docs/KERNEL-CONTRACT.md` (cubic exact/faceted parity note beside the arc note)
- Modify: `package.json` (+ `package-lock.json` sync) — minor bump, additive
- Test: full suite

**Interfaces:**
- Consumes: everything above.
- Produces: none.

- [ ] **Step 1: AUTHORING-PARTS.md — add `pathProfile` and an example**

In `docs/AUTHORING-PARTS.md`, add `pathProfile` to the "Profiles & patterns"
import list (beside `roundedProfile`, `offsetPolygon`), and add a short example
in the profiles code block:

```js
// A tab with one free-form curved side (exact on STEP, faceted at mesh LOD):
const tab = pathProfile([0, 0])
  .lineTo([20, 0]).lineTo([20, 8])
  .cubicTo([0, 8], [14, 16], [6, 16])   // curved top edge
  .close();
k.extrude({ profile: tab, h: 3 });
```

Add one sentence: *"Cubic segments (`cubicTo`) become exact B-rep spline edges on
the OCCT/STEP backend and facet at the mesh LOD on Manifold — the same
exact-vs-faceted split as `roundedProfile` arcs."*

- [ ] **Step 2: KERNEL-CONTRACT.md — extend the arc parity note**

Find the note stating arcs are exact on OCCT / faceted on Manifold and extend it
to name cubics — e.g. append:

```markdown
Cubic Bézier segments (`{to, c1, c2}`, built via `pathProfile().cubicTo(…)`)
follow the same rule: exact spline B-rep on OCCT (→ STEP), adaptively faceted at
the mesh `segs` LOD on Manifold. Measure-parity (volume/bbox) holds within
tolerance as facets converge; this is not a parity waiver.
```

- [ ] **Step 3: Bump the version**

Edit `package.json` — bump the minor version (additive; do NOT touch
`CONTRACT_VERSION`). Then sync the lockfile:

Run: `nvm use && npm install --package-lock-only`

- [ ] **Step 4: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: PASS — all files green (existing + the new curve tests + the doc lints).

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/KERNEL-CONTRACT.md package.json package-lock.json
git commit -m "docs: document pathProfile + cubic exact/faceted parity; version bump

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- IR (`{to,c1,c2}`, structural discrimination) → Tasks 1–2. ✅
- OCCT exact mapping → Task 4 (extrude + STEP spline). `revolve`-with-contours deferred (documented limitation in Task 4: `revolve`'s radius-check assumes point arrays; affects arcs too). ✅
- Manifold `sampleBezier` + LOD (adaptive curvature subdivision) → Task 2 (unit), Task 5 (integration/parity). ✅
- `pathProfile` builder → Task 3. ✅
- Validation + error taxonomy + ERROR-PATTERNS → Task 1. ✅
- Back-compat/purity (legacy arrays & arc contours unchanged; pure) → guarded by unchanged existing tests in `profiles.test.js`/`manifold-backend.test.js`/`occt-backend.test.js` (full suite, Task 6 Step 4); `sampleBezier` purity test (Task 2). ✅
- `isArcContour` re-export / `isPathContour` alias → Task 1. ✅
- Docs (AUTHORING-PARTS, KERNEL-CONTRACT parity note + lint) + version bump → Tasks 3 & 6. ✅
- Parity noted not waived → Task 6 Step 2. ✅

**Placeholder scan:** no TBD/TODO; every code step shows complete code; the depth cap (12) and the `2π/segs` turn criterion are concrete. ✅

**Type consistency:** `sampleBezier(p0,c1,c2,p1,segs)`, `pathProfile(start).lineTo/arcTo/cubicTo/close`, segment shape `{to,c1,c2}`, and the discrimination order `c1 → via → line` are identical across Tasks 2 (Manifold), 3 (builder), and 4 (OCCT). ✅

**Out of scope (unchanged from spec):** quadratic/spline/ellipse segments, SVG path-string parsing, F2 (booleans), F3 (curve offset).
