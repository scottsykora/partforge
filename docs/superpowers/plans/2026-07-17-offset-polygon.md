# offsetPolygon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-JS `offsetPolygon(profile, delta, {corners, segs})` in polygon.js — printer-clearance offsets (outward and inset) on point-list profiles and `{outer, holes}` regions, with round/chamfer/sharp corners and loud failure on degenerate results.

**Architecture:** One exported function plus four private helpers appended to `src/framework/geometry/polygon.js` (already the `partforge/geometry` entry, so the export surfaces automatically). Per contour: displace each edge along its outward normal, then join at each vertex — trim by line intersection where offset edges cross, fill the wedge per corner style where they diverge. Validate input and output simplicity (O(n²) segment tests) and throw greppable errors instead of returning degenerate geometry.

**Tech Stack:** Plain ESM JavaScript, vitest (pure tests, no WASM except one smoke line in the existing Manifold suite).

**Spec:** `docs/superpowers/specs/2026-07-17-offset-polygon-design.md` — the authority on semantics and error strings.

## Global Constraints

- **Node 24 required:** run `nvm use` in the repo root before any npm/vitest command.
- Work on branch `offset-polygon` (already created off main@694eeb5). Commit per task; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do NOT touch the untracked `embed-test.html` / `src/app-embed-test.js` (another session's files).
- polygon.js stays dependency-free (zero imports). No kernel-contract changes; `CONTRACT_VERSION` untouched.
- Error strings are contract surface — use the spec's exact strings (Task 3 greps them into ERROR-PATTERNS.md).
- Output contours are always CCW; either input winding accepted (normalized by signed area).
- Kernel calls in tests use the options-object form (`k.extrude({ profile, h })`) — it is the canonical convention on main now.
- Full-suite gate for every task: `npx vitest run` all green.

---

### Task 1: offsetPolygon core — point lists, three corner styles, full validation

> **Execution correction:** the reference implementation below has two verified
> bugs its own tests catch: (1) a symmetric over-inset can re-emerge as a
> positive-area CCW "phantom" polygon (square −7 → area-16 square) that the
> area+simplicity checks pass — fixed in the committed code by tracking the trim
> parameter along each offset edge and treating edge inversion as collapse;
> (2) the dumbbell's failure mode is a self-*touch* (vertex interior to a
> non-adjacent edge, `orient = 0`), which proper-crossing-only `segmentsCross`
> misses by design — fixed by a `pointOnSegment` check inside `isSimplePolygon`.
> See the committed polygon.js, which is the authority.

**Files:**
- Modify: `src/framework/geometry/polygon.js` (append at end of file)
- Test: `test/offset-polygon.test.js` (create)

**Interfaces:**
- Consumes: nothing new (polygon.js has no imports; verify with `grep -n "^import" src/framework/geometry/polygon.js` — expect no hits — and check no existing helper named `signedArea`/`dedupePoints` collides: `grep -n "signedArea\|dedupePoints\|isSimplePolygon\|lineIntersect\|segmentsCross\|OFFSET_EPS" src/framework/geometry/polygon.js` — expect no hits).
- Produces: `export function offsetPolygon(profile, delta, opts?)` where `profile` is `[[x,y],…]` (this task) or `{outer, holes}` (Task 2 adds the region branch — Task 1's implementation already contains it; Task 2 only adds its tests), `delta` a finite number in mm, `opts = { corners = "round" | "chamfer" | "sharp", segs = 8 }`. Returns a new CCW point list (or region mirroring the input shape). Private helpers `dedupePoints`, `polySignedArea`, `segmentsCross`, `isSimplePolygon`, `lineIntersect` (not exported).

- [ ] **Step 1: Write the failing tests**

```js
// test/offset-polygon.test.js
// Pure unit tests for offsetPolygon — no WASM, no kernel boot.
import { expect, test } from "vitest";
import { offsetPolygon, regularPolygon } from "../src/framework/geometry/polygon.js";

const area = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

const SQ = (s) => [[0, 0], [s, 0], [s, s], [0, s]];   // CCW square, corner at origin

test("sharp outset/inset of a square are exact", () => {
  expect(area(offsetPolygon(SQ(10), 1, { corners: "sharp" }))).toBeCloseTo(144, 9);  // (10+2)²
  expect(area(offsetPolygon(SQ(10), -1, { corners: "sharp" }))).toBeCloseTo(64, 9);  // (10-2)²
  expect(area(offsetPolygon(SQ(10), -1, { corners: "round" }))).toBeCloseTo(64, 9);  // inset squares have no diverging corners — style irrelevant
});

test("chamfer outset cuts 2d² off the sharp area", () => {
  expect(area(offsetPolygon(SQ(10), 1, { corners: "chamfer" }))).toBeCloseTo(144 - 2, 9);
});

test("round outset area matches the inscribed-fan closed form", () => {
  // 4 corner fans of `segs` triangles: total corner area = 2·segs·d²·sin(π/(2·segs))
  const segs = 8, d = 1.5, s = 10;
  const expected = s * s + 4 * s * d + 2 * segs * Math.sin(Math.PI / (2 * segs)) * d * d;
  expect(area(offsetPolygon(SQ(s), d, { corners: "round", segs }))).toBeCloseTo(expected, 6);
});

test("round is the default corner style", () => {
  expect(area(offsetPolygon(SQ(10), 1))).toBeCloseTo(area(offsetPolygon(SQ(10), 1, { corners: "round" })), 12);
});

test("output is CCW and either input winding is accepted", () => {
  const cw = SQ(10).slice().reverse();
  const out = offsetPolygon(cw, 1, { corners: "sharp" });
  expect(area(out)).toBeCloseTo(144, 9);     // positive ⇒ CCW
});

test("delta 0 returns a normalized copy, not the caller's arrays", () => {
  const input = SQ(10);
  const out = offsetPolygon(input, 0);
  expect(out).toEqual(input);
  expect(out).not.toBe(input);
  expect(out[0]).not.toBe(input[0]);
});

test("L-shape: reflex corner trims; sharp round-trips to identity", () => {
  const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];   // CCW, area 300
  const grown = offsetPolygon(L, 1, { corners: "sharp" });
  expect(area(grown)).toBeGreaterThan(300);
  const back = offsetPolygon(grown, -1, { corners: "sharp" });
  expect(back.length).toBe(L.length);
  for (let i = 0; i < L.length; i++) {
    expect(back[i][0]).toBeCloseTo(L[i][0], 9);
    expect(back[i][1]).toBeCloseTo(L[i][1], 9);
  }
});

test("sharp falls back to chamfer past the miter limit (2·|delta|)", () => {
  // ~30° apex: miter distance d/sin(15°) ≈ 3.86d > 2d → apex chamfers (2 points);
  // 75° base corners miter (1 point each) → 4 points total.
  const needle = [[-2.679, 0], [2.679, 0], [0, 10]];
  const out = offsetPolygon(needle, 1, { corners: "sharp" });
  expect(out.length).toBe(4);
  for (const [x, y] of out) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
});

test("input validation errors", () => {
  expect(() => offsetPolygon([[0, 0], [1, 0]], 1)).toThrow("offsetPolygon: need at least 3 points");
  expect(() => offsetPolygon(SQ(10), NaN)).toThrow("offsetPolygon: delta must be a finite number");
  expect(() => offsetPolygon(SQ(10), "0.2")).toThrow("offsetPolygon: delta must be a finite number");
  expect(() => offsetPolygon(SQ(10), 1, { corners: "bevel" }))
    .toThrow('offsetPolygon: corners must be "round" | "chamfer" | "sharp"');
  expect(() => offsetPolygon([[0, 0], [1, NaN], [1, 1]], 1)).toThrow("offsetPolygon: coordinates must be finite numbers");
  expect(() => offsetPolygon(null, 1)).toThrow("offsetPolygon: profile must be a point list or {outer, holes}");
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]];
  expect(() => offsetPolygon(bowtie, 0.5)).toThrow("offsetPolygon: input polygon self-intersects");
});

test("collapse and result-self-intersection throw", () => {
  expect(() => offsetPolygon(SQ(10), -5, { corners: "sharp" })).toThrow("offsetPolygon: inset collapses the polygon");
  expect(() => offsetPolygon(SQ(10), -7, { corners: "sharp" })).toThrow("offsetPolygon: inset collapses the polygon");
  // dumbbell: two 10-wide lobes joined by a 2-wide waist — inset past the waist
  // would split the region; we throw instead of returning a figure-eight.
  const dumbbell = [
    [0, 0], [10, 0], [10, 4], [14, 4], [14, 0], [24, 0],
    [24, 10], [14, 10], [14, 6], [10, 6], [10, 10], [0, 10],
  ];
  expect(() => offsetPolygon(dumbbell, -1.5, { corners: "sharp" }))
    .toThrow("offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/offset-polygon.test.js`
Expected: FAIL — `offsetPolygon` is not exported from polygon.js.

- [ ] **Step 3: Append the implementation to polygon.js**

```js
// --- offsetPolygon ---------------------------------------------------------

const OFFSET_EPS = 1e-9;

// Fresh copies, consecutive duplicates dropped, closing point (== first) dropped.
function dedupePoints(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > OFFSET_EPS) out.push([p[0], p[1]]);
  }
  while (out.length > 1 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= OFFSET_EPS) out.pop();
  return out;
}

function polySignedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// True where segments a-b and c-d properly cross. Shared endpoints and collinear
// touches don't count — adjacent edges always share a vertex, and the collinear
// case is degenerate input the dedupe/straight-vertex paths already absorb.
function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

// O(n²) simplicity test — trivial at profile point counts (tens to hundreds).
function isSimplePolygon(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // adjacent edges share a vertex
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

// Intersection of two infinite lines given as point + unit direction; null if parallel.
function lineIntersect(p, dp, q, dq) {
  const denom = dp[0] * dq[1] - dp[1] * dq[0];
  if (Math.abs(denom) < OFFSET_EPS) return null;
  const t = ((q[0] - p[0]) * dq[1] - (q[1] - p[1]) * dq[0]) / denom;
  return [p[0] + dp[0] * t, p[1] + dp[1] * t];
}

// Offset a profile by `delta` mm: positive grows material outward, negative
// insets. `profile` is a CCW [[x,y],…] point list (either winding accepted,
// output always CCW) or an {outer, holes} region — regions offset as material:
// outer by +delta, holes by −delta, so a +0.2 clearance on a cut region loosens
// the whole cut. Corners where the offset edges diverge fill per `corners`:
// "round" (arc of radius |delta| about the original vertex, `segs` segments —
// the true Minkowski clearance), "chamfer" (the arc's chord), or "sharp" (true
// miter, falling back to chamfer past a miter length of 2·|delta|). Where
// offset edges cross (reflex on outset, convex on inset) they trim to their
// intersection regardless of style. Simple polygon in, simple polygon out:
// a result that self-intersects or vanishes THROWS (greppable errors below)
// rather than returning degenerate geometry — offsets that would split a
// region (dumbbell insets) are out of scope. Pure and deterministic; usable in
// derive() and build() alike. See AUTHORING-PARTS.md "Profiles & patterns".
export function offsetPolygon(profile, delta, opts = {}) {
  const { corners = "round", segs = 8 } = opts;
  if (profile !== null && typeof profile === "object" && !Array.isArray(profile)) {
    if (!Array.isArray(profile.outer)) throw new Error("offsetPolygon: profile must be a point list or {outer, holes}");
    const region = { outer: offsetPolygon(profile.outer, delta, opts) };
    if (profile.holes) region.holes = profile.holes.map((h) => offsetPolygon(h, -delta, opts));
    return region;
  }
  if (!Array.isArray(profile)) throw new Error("offsetPolygon: profile must be a point list or {outer, holes}");
  if (typeof delta !== "number" || !Number.isFinite(delta)) throw new Error("offsetPolygon: delta must be a finite number");
  if (corners !== "round" && corners !== "chamfer" && corners !== "sharp")
    throw new Error('offsetPolygon: corners must be "round" | "chamfer" | "sharp"');
  for (const p of profile)
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error("offsetPolygon: coordinates must be finite numbers");

  const pts = dedupePoints(profile);
  if (pts.length < 3) throw new Error("offsetPolygon: need at least 3 points");
  if (polySignedArea(pts) < 0) pts.reverse();                     // work in CCW
  if (!isSimplePolygon(pts)) throw new Error("offsetPolygon: input polygon self-intersects");
  if (delta === 0) return pts;

  // Each edge i (pts[i] → pts[i+1]): unit direction and endpoints displaced
  // along the outward normal (CCW ⇒ outward = (dy, −dx)).
  const n = pts.length, dir = [], off = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const d = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const mx = d[1] * delta, my = -d[0] * delta;
    dir.push(d);
    off.push([[p[0] + mx, p[1] + my], [q[0] + mx, q[1] + my]]);
  }

  // Join edge (i−1)'s offset to edge i's offset at each original vertex.
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n, V = pts[i];
    const endPrev = off[prev][1], startNext = off[i][0];
    const cross = dir[prev][0] * dir[i][1] - dir[prev][1] * dir[i][0];

    if (Math.abs(cross) < OFFSET_EPS) { out.push(endPrev); continue; }   // straight vertex

    if (cross * delta < 0) {                                             // offset edges cross → trim
      const m = lineIntersect(off[prev][0], dir[prev], off[i][0], dir[i]);
      out.push(m ?? endPrev);
      continue;
    }

    // Offset edges diverge → fill the wedge per style.
    if (corners === "sharp") {
      const m = lineIntersect(off[prev][0], dir[prev], off[i][0], dir[i]);
      if (m && Math.hypot(m[0] - V[0], m[1] - V[1]) <= 2 * Math.abs(delta)) { out.push(m); continue; }
      out.push(endPrev, startNext);                                      // past the miter limit → chamfer
    } else if (corners === "chamfer") {
      out.push(endPrev, startNext);
    } else {                                                             // round: short arc about V
      const a0 = Math.atan2(endPrev[1] - V[1], endPrev[0] - V[0]);
      let dA = Math.atan2(startNext[1] - V[1], startNext[0] - V[0]) - a0;
      while (dA <= -Math.PI) dA += 2 * Math.PI;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      const r = Math.abs(delta);
      for (let s = 0; s <= segs; s++) {
        const a = a0 + (dA * s) / segs;
        out.push([V[0] + r * Math.cos(a), V[1] + r * Math.sin(a)]);
      }
    }
  }

  const cleaned = dedupePoints(out);
  if (cleaned.length < 3 || polySignedArea(cleaned) <= OFFSET_EPS)
    throw new Error("offsetPolygon: inset collapses the polygon");
  if (!isSimplePolygon(cleaned))
    throw new Error("offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)");
  return cleaned;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/offset-polygon.test.js`
Expected: PASS (11 tests). If the round-area or round-trip assertions are off by more than float noise, do NOT loosen the tolerances — the construction is wrong; re-check normal orientation (`(dy, −dx)` for CCW) and the arc sweep normalization.

- [ ] **Step 5: Run the full suite and commit**

Run: `npx vitest run`
Expected: all green (existing 588 + 11 new).

```bash
git add src/framework/geometry/polygon.js test/offset-polygon.test.js
git commit -m "feat: offsetPolygon — 2-D profile offsetting with corner styles"
```

---

### Task 2: Region tests, planter-formula pin, purity, kernel smoke

**Files:**
- Modify: `test/offset-polygon.test.js` (append)
- Modify: `test/manifold-backend.test.js` (append one test)

**Interfaces:**
- Consumes: `offsetPolygon` from Task 1 (the region branch is already implemented; this task pins its behavior). `regularPolygon(n, r)` from polygon.js (CCW n-gon of circumradius r).
- Produces: nothing new — test coverage only.

- [ ] **Step 1: Append the failing/pinning tests to test/offset-polygon.test.js**

```js
test("regions offset as material: outer grows, holes shrink", () => {
  const region = { outer: SQ(40), holes: [[[15, 15], [25, 15], [25, 25], [15, 25]]] };
  const out = offsetPolygon(region, 1, { corners: "sharp" });
  expect(area(out.outer)).toBeCloseTo(42 * 42, 9);
  expect(area(out.holes[0])).toBeCloseTo(8 * 8, 9);
  // input without holes mirrors shape: no holes key on output
  expect(offsetPolygon({ outer: SQ(10) }, 1, { corners: "sharp" }).holes).toBeUndefined();
});

test("a hole that would vanish throws collapse", () => {
  const region = { outer: SQ(40), holes: [[[15, 15], [25, 15], [25, 25], [15, 25]]] };
  expect(() => offsetPolygon(region, 6, { corners: "sharp" }))
    .toThrow("offsetPolygon: inset collapses the polygon");
});

test("sharp inset of a regular n-gon reproduces planter's closed form", () => {
  // planter.js derives Rin = Rout − wall/cos(π/n); a sharp inset along the face
  // normals is exactly that — each inset vertex is the original scaled by Rin/Rout.
  for (const n of [3, 6, 9]) {
    const Rout = 60, wall = 3;
    const outer = regularPolygon(n, Rout);
    const inner = offsetPolygon(outer, -wall, { corners: "sharp" });
    const scale = (Rout - wall / Math.cos(Math.PI / n)) / Rout;
    expect(inner.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(inner[i][0]).toBeCloseTo(outer[i][0] * scale, 9);
      expect(inner[i][1]).toBeCloseTo(outer[i][1] * scale, 9);
    }
  }
});

test("purity: identical input twice gives deeply equal output", () => {
  const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
  expect(offsetPolygon(L, 0.7, { corners: "round" }))
    .toEqual(offsetPolygon(L, 0.7, { corners: "round" }));
});
```

- [ ] **Step 2: Run to verify state**

Run: `npx vitest run test/offset-polygon.test.js`
Expected: PASS (the region branch shipped in Task 1) — these are pins, not RED tests; the planter-formula pin is the one most likely to catch a real construction bug. If any fails, fix the implementation, never the closed form.

- [ ] **Step 3: Append the kernel smoke test to test/manifold-backend.test.js**

Match the file's existing import of polygon helpers (extend it if `offsetPolygon` isn't imported yet) and append:

```js
test("extrude accepts an offsetPolygon result", () => {
  const grown = offsetPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], 0.5, { corners: "sharp" });
  expect(k.extrude({ profile: grown, h: 5 }).volume()).toBeCloseTo(11 * 11 * 5, 3);
});
```

- [ ] **Step 4: Run the touched files, then the full suite**

Run: `npx vitest run test/offset-polygon.test.js test/manifold-backend.test.js`
Expected: PASS.
Run: `npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add test/offset-polygon.test.js test/manifold-backend.test.js
git commit -m "test: offsetPolygon regions, planter closed-form pin, kernel smoke"
```

---

### Task 3: Planter migration, docs, version bump

**Files:**
- Modify: `src/parts/planter.js` (derive block, ~lines 70–85)
- Modify: `docs/AUTHORING-PARTS.md` ("Profiles & patterns" section), `docs/ERROR-PATTERNS.md` (Core framework section), `package.json`

**Interfaces:**
- Consumes: `offsetPolygon` (Task 1). Planter's local `ngon(r, n)` helper and its existing derive fields (`outerPts`, `innerPts`, `innerTaper`, `drainR`) — field names and geometry must not change.

- [ ] **Step 1: Migrate planter's derive**

Replace the current derive block (which computes `Rin` by closed form and clamps it to ≥ 1):

```js
  derive: (p) => {
    const Rout = p.dia / 2;
    // Inset the outer polygon inward by `wall` along the FACE normals via
    // offsetPolygon (sharp corners keep the n-gon exact — see the closed-form
    // pin in test/offset-polygon.test.js). Cap the wall so the inset can never
    // collapse below circumradius 1 — same clamp as the old closed form (only
    // matters if wall is set past the slider bounds via the API).
    const wall = Math.min(p.wall, (Rout - 1) * Math.cos(Math.PI / p.facets));
    const outerPts = ngon(Rout, p.facets);
    const innerPts = offsetPolygon(outerPts, -wall, { corners: "sharp" });
    const Rin = Math.hypot(innerPts[0][0], innerPts[0][1]);   // read back from the geometry
    return {
      outerPts,
      innerPts,
      // Inner taper that holds the wall constant top-to-bottom even as the body flares:
      // pick it so inner_radius(top) = outer_radius(top) − wall.
      innerTaper: 1 + (Rout * (p.taper - 1)) / Rin,
      drainR: (p.drain + 0.2) / 2, // nominal hole + 0.2 mm print clearance, as a radius
    };
  },
```

Add the import at the top of planter.js alongside its existing partforge/geometry imports (check what's there: `grep -n "partforge/geometry\|polygon.js" src/parts/planter.js` and extend that import statement with `offsetPolygon`).

- [ ] **Step 2: Verify geometry is unchanged**

Run: `npx vitest run` (planter's measure/verify tests gate the geometry)
Expected: all green.
Run: `npx partforge measure src/parts/planter.js`
Expected: exit 0, measurements identical to main (spot-check volume against `git stash`-free baseline if in doubt: the sharp n-gon inset equals the old closed form by the Task 2 pin).

- [ ] **Step 3: Docs**

In `docs/AUTHORING-PARTS.md`, find the "Profiles & patterns" helper table (`grep -n "filletPolygon" docs/AUTHORING-PARTS.md`) and add a row after `filletPolygon`:

```markdown
| `offsetPolygon(profile, delta, {corners?, segs?})` | Offset a point-list polygon or `{outer, holes}` region by `delta` mm — positive grows material, negative insets; regions offset material-wise (outer `+delta`, holes `−delta`). `corners`: `"round"` (default; true clearance), `"chamfer"`, `"sharp"` (miter, chamfer fallback past 2·\|delta\|). Throws (greppable) on collapse or self-intersection instead of returning degenerate geometry. |
```

Below the table (same section), add the clearance example paragraph:

```markdown
The bread-and-butter use is print clearance on an arbitrary cut profile:
`k.extrude({ profile: offsetPolygon(slotPolygon(20, 3), 0.2), h: 10 })` cuts the
slot 0.2 mm looser all around, and `offsetPolygon(outline, -wall, { corners:
"sharp" })` insets a wall (see planter.js). Simple polygon in, simple polygon
out: an offset whose true result would split into multiple contours (e.g.
insetting a dumbbell past its waist) throws rather than guessing.
```

In `docs/ERROR-PATTERNS.md` (Core framework section, after the `box-center-with-corners` entry), add:

```markdown
## offset-polygon-bad-input

- **Symptom:** `offsetPolygon: need at least 3 points`
- **Cause:** malformed input to `offsetPolygon` — too few points after dedup, or (variant messages) a non-finite `delta`, non-finite coordinates, an unknown `corners` style, or a profile that is neither a point list nor `{outer, holes}`.
- **Fix:** pass a CCW `[[x,y],…]` list (≥ 3 distinct points) or `{outer, holes}`, a finite `delta` in mm, and `corners: "round" | "chamfer" | "sharp"` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

Variant literals under this entry: `offsetPolygon: delta must be a finite number`, `offsetPolygon: coordinates must be finite numbers`, `offsetPolygon: corners must be "round" | "chamfer" | "sharp"`, `offsetPolygon: profile must be a point list or {outer, holes}`.

## offset-polygon-input-self-intersects

- **Symptom:** `offsetPolygon: input polygon self-intersects`
- **Cause:** the input contour crosses itself — the profile is broken before any offsetting happens (checked up front so bad input is not blamed on the offset).
- **Fix:** repair the generating math for the contour; the offset envelope requires simple polygons in and out.

## offset-polygon-collapse

- **Symptom:** `offsetPolygon: inset collapses the polygon`
- **Cause:** the inset ate the whole polygon (result area ≤ 0 or fewer than 3 points) — `|delta|` exceeds the shape's narrowest half-width. Also thrown for a region hole that would vanish.
- **Fix:** reduce `|delta|`, or clamp it from the shape's dimensions before offsetting (see planter.js's wall cap). If a vanishing hole is intended, remove the hole from the region explicitly.

## offset-polygon-result-self-intersects

- **Symptom:** `offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)`
- **Cause:** the true offset of this shape at this `|delta|` is not a single simple polygon (e.g. insetting a dumbbell past its waist would split it in two) — out of `offsetPolygon`'s envelope.
- **Fix:** reduce `|delta|`, or decompose the profile into separately-offset simple contours.
```

Run: `npx vitest run test/error-patterns.test.js`
Expected: PASS (entry-shape lint).

- [ ] **Step 4: Version bump**

In `package.json`, bump `0.13.0` → `0.14.0` (additive export).

- [ ] **Step 5: Full suite + smoke, commit**

Run: `npx vitest run`
Expected: all green.
Run: `npm run check` (if Playwright Chromium is available; otherwise note the skip)
Expected: exit 0 (planter app boots clean).

```bash
git add src/parts/planter.js docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md package.json
git commit -m "feat: planter uses offsetPolygon; document the helper; bump to 0.14.0"
```
