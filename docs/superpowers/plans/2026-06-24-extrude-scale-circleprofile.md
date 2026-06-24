# prism twist/taper, scale, circleProfile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three backend-agnostic geometry primitives — twist/taper options on `prism`, a uniform `scale` transform, and a `circleProfile` 2-D helper — with torus expressed as the composition `revolve(circleProfile(...))`.

**Architecture:** All three work identically on Manifold and OCCT (STEP export unaffected). `prism` gains an options object the underlying extrude already supports on both backends; `scale` is a uniform affine transform peer to translate/rotate/mirror; `circleProfile` is a pure 2-D point generator in the existing profile-helper family. No new backend-routing.

**Tech Stack:** Manifold (`manifold-3d`), replicad (`replicad`), Vitest (Manifold + OCCT in separate files; pure helpers in Node), Node 24.

## Global Constraints

- **Node 24 for tests** (`nvm use` first).
- **All three additions are backend-agnostic** — implemented on both Manifold and OCCT; none is OCCT-only; no change to `OCCT_ONLY`/routing. STEP export must keep working.
- **`scale` is uniform only** (a single scalar `factor`); non-uniform scaling is intentionally excluded (replicad scale is uniform; non-uniform would break STEP).
- **Manifold and OCCT must NOT boot in the same test process** — Manifold tests in `test/manifold-backend.test.js`, OCCT tests in `test/occt-backend.test.js` (Vitest isolates files).
- **Backward compatible:** `prism(pts, h)` with no options reproduces today's exact extrude (preserve the current code path when `twist === 0 && scaleTop === 1`).
- **Torus is NOT a kernel op** — it is the documented composition `k.revolve(circleProfile(minorR, [majorR, 0]))` (`majorR > minorR`).
- A pre-existing intermittent flake in `test/cli-occt.test.js`'s render race was fixed; if any unrelated flake appears, confirm the task's own tests pass in isolation.
- Commit messages follow repo convention; end with the `Co-Authored-By:`/`Claude-Session:` trailers.

---

## Task 1: `circleProfile` 2-D helper

A pure profile generator, plus the torus-recipe composition test that justifies it.

**Files:**
- Modify: `src/framework/geometry/polygon.js` (append `circleProfile`)
- Test: `test/profiles.test.js` (extend — pure), `test/manifold-backend.test.js` (extend — torus composition)

**Interfaces:**
- Produces: `circleProfile(r, center = [0, 0], segs = 48) => number[][]` — CCW closed polygon of `segs` points approximating a circle of radius `r` centered at `[cx, cy]`.

- [ ] **Step 1: Write the failing pure tests**

Append to `test/profiles.test.js` (it already imports the helpers and defines `signedArea`/`bbox` — add `circleProfile` to the existing import from `../src/framework/geometry/polygon.js`):

```js
test("circleProfile: CCW, segs points, all at radius r about center", () => {
  const c = circleProfile(5, [10, 0], 32);
  expect(c.length).toBe(32);
  expect(signedArea(c)).toBeGreaterThan(0);
  for (const [x, y] of c) expect(Math.hypot(x - 10, y - 0)).toBeCloseTo(5, 6);
});

test("circleProfile spans 2r centered on `center`", () => {
  const b = bbox(circleProfile(5, [10, 0]));
  expect(b.w).toBeCloseTo(10, 6);
  expect(b.h).toBeCloseTo(10, 6);
});

test("circleProfile defaults center to origin and rejects r <= 0", () => {
  const c = circleProfile(3);
  for (const [x, y] of c) expect(Math.hypot(x, y)).toBeCloseTo(3, 6);
  expect(() => circleProfile(0)).toThrow(/r must be/);
  expect(() => circleProfile(-1)).toThrow(/r must be/);
});
```

- [ ] **Step 2: Run the pure tests to verify they fail**

Run: `nvm use && npx vitest run test/profiles.test.js`
Expected: FAIL — `circleProfile is not a function` (or import error).

- [ ] **Step 3: Implement `circleProfile`**

Append to `src/framework/geometry/polygon.js`:

```js
// CCW circle of radius r centered at [cx, cy]. A shared 2-D profile primitive:
// compose with the kernel's profile ops — e.g. revolve(circleProfile(minorR,
// [majorR, 0])) is a torus, prism(circleProfile(r), h) a cylinder.
export function circleProfile(r, center = [0, 0], segs = 48) {
  if (!(r > 0)) throw new Error("circleProfile: r must be > 0");
  const [cx, cy] = center;
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
```

- [ ] **Step 4: Run the pure tests to verify they pass**

Run: `nvm use && npx vitest run test/profiles.test.js`
Expected: PASS.

- [ ] **Step 5: Write + run the torus-recipe composition test**

Append to `test/manifold-backend.test.js`. Add `circleProfile` to the import from `../src/framework/geometry/polygon.js` (add the import if the file doesn't already import from polygon.js):

```js
import { circleProfile } from "../src/framework/geometry/polygon.js";

test("revolve(circleProfile) yields a torus near the Pappus volume", () => {
  const majorR = 10, minorR = 2;
  const exact = 2 * Math.PI ** 2 * majorR * minorR ** 2; // Pappus: ~789.6 mm³
  const v = k.revolve(circleProfile(minorR, [majorR, 0])).volume();
  expect(v).toBeLessThan(exact);          // faceted ⇒ inscribed ⇒ slightly under
  expect(v).toBeGreaterThan(exact * 0.9); // but close
});
```

Run: `nvm use && npx vitest run test/profiles.test.js test/manifold-backend.test.js`
Expected: PASS (pure circleProfile tests + the torus composition test).

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/polygon.js test/profiles.test.js test/manifold-backend.test.js
git commit -m "feat: add circleProfile 2D helper (torus = revolve(circleProfile))"
```

---

## Task 2: `prism` twist/taper

Extend the extrude make-op on both backends with `{ twist, scaleTop }`.

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (the `prism:` make-op, ~line 92)
- Modify: `src/framework/geometry/occt-backend.js` (the `prism` function, ~line 130)
- Modify: `src/framework/geometry/kernel.js` (typedef for `prism`)
- Test: `test/manifold-backend.test.js`, `test/occt-backend.test.js` (extend)

**Interfaces:**
- Produces: `k.prism(points2D, h, { twist = 0, scaleTop = 1 } = {}) => Solid`. `twist` degrees over the height; `scaleTop` uniform top-profile factor (1 straight, <1 taper, 0 point). `scaleTop < 0` throws.

- [ ] **Step 1: Write the failing Manifold tests**

Append to `test/manifold-backend.test.js` (`bboxSize` is already imported):

```js
const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("prism scaleTop<1 tapers — less volume than a straight extrude", () => {
  const straight = k.prism(SQ, 10).volume();
  const taper = k.prism(SQ, 10, { scaleTop: 0.5 }).volume();
  expect(taper).toBeLessThan(straight);
  expect(taper).toBeGreaterThan(0);
});

test("prism scaleTop:0 converges to a point (positive-volume cone)", () => {
  const cone = k.prism(SQ, 10, { scaleTop: 0 });
  expect(cone.volume()).toBeGreaterThan(0);
  expect(cone.toMesh().triangles).toBeGreaterThan(0);
});

test("prism twist keeps positive volume and full height", () => {
  const tw = k.prism(SQ, 20, { twist: 90 });
  expect(tw.volume()).toBeGreaterThan(0);
  const [, , ht] = bboxSize(tw.toMesh().positions);
  expect(ht).toBeCloseTo(20, 0);
});

test("prism rejects negative scaleTop", () => {
  expect(() => k.prism(SQ, 10, { scaleTop: -1 })).toThrow(/scaleTop/);
});
```

- [ ] **Step 2: Write the failing OCCT tests**

Append to `test/occt-backend.test.js`:

```js
const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("prism scaleTop<1 tapers — less volume than straight", () => {
  const straight = k.prism(SQ, 10).volume();
  const taper = k.prism(SQ, 10, { scaleTop: 0.5 }).volume();
  expect(taper).toBeLessThan(straight);
  expect(taper).toBeGreaterThan(0);
});

test("prism twist meshes to a positive-volume solid", () => {
  const tw = k.prism(SQ, 20, { twist: 90 });
  expect(tw.toMesh().triangles).toBeGreaterThan(0);
  expect(tw.volume()).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t prism`
Expected: FAIL — options ignored (taper volume equals straight) / no throw on negative scaleTop.

- [ ] **Step 4: Implement in the Manifold backend**

In `src/framework/geometry/manifold-backend.js`, replace the current `prism` make-op:

```js
    prism: (pts, h) => {
      const cs = T(CrossSection.ofPolygons([pts]));
      return wrap(T(cs.extrude(h)));
    },
```

with:

```js
    prism: (pts, h, { twist = 0, scaleTop = 1 } = {}) => {
      if (scaleTop < 0) throw new Error("prism: scaleTop must be ≥ 0");
      const cs = T(CrossSection.ofPolygons([pts]));
      if (twist === 0 && scaleTop === 1) return wrap(T(cs.extrude(h)));
      // divisions ∝ twist so the twist meshes smoothly (1 when untwisted)
      const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
      return wrap(T(cs.extrude(h, nDiv, twist, scaleTop)));
    },
```

- [ ] **Step 5: Implement in the OCCT backend**

In `src/framework/geometry/occt-backend.js`, replace the current `prism` function:

```js
  const prism = (pts, h) => {
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return wrap(pen.close().sketchOnPlane("XY").extrude(h));
  };
```

with:

```js
  const prism = (pts, h, { twist = 0, scaleTop = 1 } = {}) => {
    if (scaleTop < 0) throw new Error("prism: scaleTop must be ≥ 0");
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    const sketch = pen.close().sketchOnPlane("XY");
    if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(h));
    const cfg = {};
    if (twist !== 0) cfg.twistAngle = twist;
    if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
    return wrap(sketch.extrude(h, cfg));
  };
```

- [ ] **Step 6: Update the kernel typedef**

In `src/framework/geometry/kernel.js`, update the `prism` `@property` line to:

```js
 * @property {(points2D:number[][], h:number, opts?:{twist?:number,scaleTop?:number}) => Solid} prism   extrude polygon from z=0 (optional twist° + uniform top taper)
```

- [ ] **Step 7: Run both backends' prism tests to verify they pass**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t prism`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/kernel.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: add twist/taper options to prism on both backends"
```

---

## Task 3: `scale` uniform transform

A uniform affine scale on `Solid`, on both backends.

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (the `wrap` object, after `mirror:`)
- Modify: `src/framework/geometry/occt-backend.js` (the `wrap` object, after `mirror:`)
- Modify: `src/framework/geometry/probe.js` (the `proxy` object, after `mirror()`)
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Test: `test/manifold-backend.test.js`, `test/occt-backend.test.js` (extend)

**Interfaces:**
- Produces: `s.scale(factor, center = [0,0,0]) => Solid` — uniform scale about `center` (default world origin). `factor <= 0` throws.

- [ ] **Step 1: Write the failing Manifold tests**

Append to `test/manifold-backend.test.js`:

```js
test("scale(2) multiplies volume ~8x (uniform 3D)", () => {
  const v1 = k.box([0, 0, 0], [2, 3, 4]).volume();
  const v2 = k.box([0, 0, 0], [2, 3, 4]).scale(2).volume();
  expect(v2).toBeCloseTo(v1 * 8, 1);
});

test("scale about the part's own center leaves the bbox center fixed", () => {
  const c = k.box([10, 10, 10], [14, 16, 18]).boundingBox().center; // off-origin
  const c2 = k.box([10, 10, 10], [14, 16, 18]).scale(2, c).boundingBox().center;
  for (let i = 0; i < 3; i++) expect(c2[i]).toBeCloseTo(c[i], 3);
});

test("scale rejects factor <= 0", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).scale(0)).toThrow(/factor must be/);
});
```

- [ ] **Step 2: Write the failing OCCT tests**

Append to `test/occt-backend.test.js`:

```js
test("scale(2) multiplies volume ~8x", () => {
  const v1 = k.box([0, 0, 0], [2, 3, 4]).volume();
  const v2 = k.box([0, 0, 0], [2, 3, 4]).scale(2).volume();
  expect(v2).toBeCloseTo(v1 * 8, 0);
});

test("scale rejects factor <= 0", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).scale(0)).toThrow(/factor must be/);
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t scale`
Expected: FAIL — `.scale is not a function`.

- [ ] **Step 4: Implement in the Manifold backend**

In `src/framework/geometry/manifold-backend.js`, inside the `wrap` object, after the `mirror:` line, add (mirrors the existing center-offset `rotate`):

```js
    scale: (factor, center = [0, 0, 0]) => {
      if (!(factor > 0)) throw new Error("scale: factor must be > 0");
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.scale([factor, factor, factor]));
      return wrap(T(b.translate(center)));
    },
```

- [ ] **Step 5: Implement in the OCCT backend**

In `src/framework/geometry/occt-backend.js`, inside the `wrap` object, after the `mirror:` line, add:

```js
    scale: (factor, center = [0, 0, 0]) => {
      if (!(factor > 0)) throw new Error("scale: factor must be > 0");
      return wrap(shape.scale(factor, center));
    },
```

- [ ] **Step 6: Add `scale` to the probe proxy**

In `src/framework/geometry/probe.js`, inside the `proxy` object, after the `mirror()` entry, add:

```js
    scale() { note("scale"); return proxy; },
```

- [ ] **Step 7: Update the kernel typedef**

In `src/framework/geometry/kernel.js`, add to the `Solid` typedef (near `mirror`):

```js
 * @property {(factor:number, center?:number[]) => Solid} scale   uniform scale about center (default origin)
```

- [ ] **Step 8: Run both backends' scale tests to verify they pass**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t scale`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js src/framework/geometry/kernel.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: add uniform Solid.scale(factor, center?) to both backends"
```

---

## Task 4: Document the new ops

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Document `prism` options and `scale`**

In `docs/AUTHORING-PARTS.md`, update the kernel "make solids" / `Solid` tables. Change the `prism` row to note the options, and add a `scale` row to the `Solid` table. Find the `prism` make-solids row (currently `| \`k.prism(points2D, h)\` | extrude a 2-D polygon ... |`) and replace its description to include the options:

```markdown
| `k.prism(points2D, h, { twist?, scaleTop? })` | extrude a 2-D polygon from z=0; optional `twist` (degrees over the height) and `scaleTop` (uniform top taper: 1 straight, <1 taper in, 0 → point/cone) |
```

In the `Solid` transform table (with `translate`/`rotate`/`mirror`), add:

```markdown
| `s.scale(factor, center?)` | uniform scale (single factor) about `center` (default origin) — scaling an off-origin part about the origin also moves it; pass a center (e.g. `s.boundingBox().center`) to resize in place |
```

- [ ] **Step 2: Document `circleProfile` and the torus recipe**

In the "Profiles & patterns" section's 2-D profiles list, add `circleProfile` and a torus recipe note:

```markdown
`circleProfile(r, center?)` — a circle of radius `r` centered at `[cx,cy]` (default origin).
Compose it for round solids: `k.prism(circleProfile(r), h)` is a cylinder, and
**a torus is `k.revolve(circleProfile(minorR, [majorR, 0]))`** (with `majorR > minorR`) —
partforge has no `torus` primitive because it's just a revolved circle.
```

- [ ] **Step 3: Verify docs render and nothing broke**

Run: `nvm use && npx vitest run`
Expected: PASS (docs don't affect tests). Skim the edited Markdown: tables aligned, code spans balanced.

- [ ] **Step 4: Commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -m "docs: document prism twist/taper, scale, circleProfile + torus recipe"
```

---

## Self-review notes

- **Spec coverage:** circleProfile + torus composition (Task 1); prism twist/taper both backends (Task 2); scale both backends + probe + typedef (Task 3); docs (Task 4). All spec sections covered.
- **Placeholder scan:** none — full code/commands throughout.
- **Type consistency:** `prism(pts, h, { twist, scaleTop })`, `scale(factor, center?)`, `circleProfile(r, center?, segs?)` are used identically across backends, tests, typedef, and docs. `scaleTop`/`factor` validation messages match the test regexes (`/scaleTop/`, `/factor must be/`, `/r must be/`).
- **Backend-agnostic:** no `OCCT_ONLY`/routing change; STEP unaffected. Backward-compatible prism path preserved when no options.
- **Process isolation:** Manifold and OCCT tests stay in their separate files.
