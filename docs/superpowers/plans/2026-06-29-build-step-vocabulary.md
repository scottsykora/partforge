# Self-describing Build-Step Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small, self-describing build-step vocabulary (`rotateX/Y/Z`, `rotateAbout`, `along`, `at`) to the partforge Solid handle so parts are LLM-authorable-correctly and human-readable, and adopt it as the canonical style.

**Architecture:** The ops are pure sugar over the existing `rotate`/`translate` primitives, defined once in a shared `addSugar(solid)` decorator that both geometry backends funnel every wrapped Solid through — so the sugar is geometry-identical to the hand-written primitive calls on both Manifold and OCCT.

**Tech Stack:** Plain ESM JavaScript (no TypeScript), Node 24, vitest, manifold-3d + replicad/OCCT.

## Global Constraints

- **Plain ESM JS, no TypeScript.**
- **Node 24** — run tests with the nvm prelude: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run …` (default shell Node is v16; tests fail on it).
- **Geometry-identical by construction** — every sugar method composes the existing `rotate`/`translate` primitives ONLY; it must add no new geometry path. `along("+Y")` is exactly `rotate(-90,[0,0,0],[1,0,0])`.
- **Both backends funnel through the one shared `addSugar`** — no per-backend reimplementation of the sugar.
- **`along(dir)` mapping (canonical build axis is +Z):** `+Z`→identity, `-Z`→`rotate(180,o,[1,0,0])`, `+Y`→`rotate(-90,o,[1,0,0])`, `-Y`→`rotate(90,o,[1,0,0])`, `+X`→`rotate(90,o,[0,1,0])`, `-X`→`rotate(-90,o,[0,1,0])` (o = `[0,0,0]`).
- **`at([x,y,z])` is an alias of `translate([x,y,z])`** (move by the vector; for build-at-origin-then-place).
- **Retire `rotate` from the *authoring* surface, do not delete it** — it stays as the internal primitive the sugar compiles to and the escape hatch for arbitrary axis/centre.
- **Branch:** work on `build-step-vocabulary` (already checked out).
- **Commit trailer:** every commit ends with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `src/framework/geometry/solid-sugar.js` — `addSugar(solid)`: attaches `rotateX/Y/Z`, `rotateAbout`, `along`, `at` to a wrapped Solid, composed from its `rotate`/`translate`.
- **Modify** `src/framework/geometry/manifold-backend.js` — route `wrap(...)` through `addSugar`.
- **Modify** `src/framework/geometry/occt-backend.js` — route `wrap(...)` through `addSugar`.
- **Modify** `src/framework/geometry/kernel.js` — add the five method signatures to the `Solid` typedef; annotate `rotate` as internal.
- **Modify** `src/parts/demo.js`, `src/parts/filleted-box.js` — migrate bore placement `translate → at` (real in-repo usage).
- **Modify** `docs/AUTHORING-PARTS.md` — Solid API table + a "Build-step style" subsection.
- **Modify** `docs/superpowers/specs/2026-06-29-build-step-vocabulary-design.md` — status line.
- **Tests:** `test/solid-sugar.test.js` (new), `test/solid-sugar-occt.test.js` (new).

---

### Task 1: `addSugar` + per-op equivalence (Manifold)

**Files:**
- Create: `src/framework/geometry/solid-sugar.js`
- Test: `test/solid-sugar.test.js`

**Interfaces:**
- Produces: `addSugar(solid) → solid` — mutates the passed wrapped Solid to add `rotateX(deg)`, `rotateY(deg)`, `rotateZ(deg)`, `rotateAbout({axis, deg, through?})`, `along(dir)`, `at([x,y,z])`, each returning a (sugared) Solid via the solid's own `rotate`/`translate`. Throws on an unknown `axis` or `dir`. Returns the same solid for `along("+Z")` (identity).

- [ ] **Step 1: Write the failing test**

```js
// test/solid-sugar.test.js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { addSugar } from "../src/framework/geometry/solid-sugar.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

// an asymmetric box, so bbox reveals orientation AND position
const box = () => k.box([0, 0, 0], [2, 4, 6]);
const sameGeom = (a, b) => {
  expect(a.volume()).toBeCloseTo(b.volume(), 6);
  const ba = a.boundingBox(), bb = b.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(ba.min[i]).toBeCloseTo(bb.min[i], 4);
    expect(ba.max[i]).toBeCloseTo(bb.max[i], 4);
  }
};

test("rotateX/Y/Z equal rotate about the world axis through origin", () => {
  sameGeom(addSugar(box()).rotateX(37), box().rotate(37, [0, 0, 0], [1, 0, 0]));
  sameGeom(addSugar(box()).rotateY(37), box().rotate(37, [0, 0, 0], [0, 1, 0]));
  sameGeom(addSugar(box()).rotateZ(37), box().rotate(37, [0, 0, 0], [0, 0, 1]));
});

test("rotateAbout maps a named axis + through-point (and a raw vector axis) to rotate", () => {
  sameGeom(addSugar(box()).rotateAbout({ axis: "Z", deg: 25, through: [5, 0, 0] }), box().rotate(25, [5, 0, 0], [0, 0, 1]));
  sameGeom(addSugar(box()).rotateAbout({ axis: [0, 1, 0], deg: 25 }), box().rotate(25, [0, 0, 0], [0, 1, 0]));
});

test("rotateAbout throws on an unknown axis", () => {
  expect(() => addSugar(box()).rotateAbout({ axis: "Q", deg: 10 })).toThrow();
});

test("along orients +Z to each direction, matching the mapped rotation", () => {
  const map = { "+Z": null, "-Z": [180, [1, 0, 0]], "+Y": [-90, [1, 0, 0]], "-Y": [90, [1, 0, 0]], "+X": [90, [0, 1, 0]], "-X": [-90, [0, 1, 0]] };
  for (const [dir, r] of Object.entries(map)) {
    const got = addSugar(box()).along(dir);
    const want = r ? box().rotate(r[0], [0, 0, 0], r[1]) : box();
    sameGeom(got, want);
  }
});

test("along throws on an unknown direction", () => {
  expect(() => addSugar(box()).along("up")).toThrow();
});

test("at equals translate", () => {
  sameGeom(addSugar(box()).at([3, -2, 7]), box().translate([3, -2, 7]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/solid-sugar.test.js`
Expected: FAIL — cannot import `addSugar`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/geometry/solid-sugar.js
// Self-describing build-step vocabulary, defined ONCE over both geometry backends.
// Every Solid a backend's wrap() returns is passed through addSugar(), which attaches
// readable transform/placement methods composed purely from the solid's existing
// rotate()/translate() primitives — so the sugar is geometry-identical to the
// hand-written primitive calls, on Manifold and OCCT alike.
const ORIGIN = [0, 0, 0];
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

// along(dir): orient the solid's canonical +Z build axis to point along dir.
const ALONG = {
  "+Z": (s) => s,
  "-Z": (s) => s.rotate(180, ORIGIN, [1, 0, 0]),
  "+Y": (s) => s.rotate(-90, ORIGIN, [1, 0, 0]),
  "-Y": (s) => s.rotate(90, ORIGIN, [1, 0, 0]),
  "+X": (s) => s.rotate(90, ORIGIN, [0, 1, 0]),
  "-X": (s) => s.rotate(-90, ORIGIN, [0, 1, 0]),
};

export function addSugar(s) {
  s.rotateX = (deg) => s.rotate(deg, ORIGIN, [1, 0, 0]);
  s.rotateY = (deg) => s.rotate(deg, ORIGIN, [0, 1, 0]);
  s.rotateZ = (deg) => s.rotate(deg, ORIGIN, [0, 0, 1]);
  s.rotateAbout = ({ axis, deg, through = ORIGIN }) => {
    const ax = Array.isArray(axis) ? axis : AXIS[axis];
    if (!ax) throw new Error(`rotateAbout: unknown axis ${JSON.stringify(axis)} (use "X"|"Y"|"Z" or a [x,y,z] vector)`);
    return s.rotate(deg, through, ax);
  };
  s.along = (dir) => {
    const f = ALONG[dir];
    if (!f) throw new Error(`along: unknown direction ${JSON.stringify(dir)} (use "+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z")`);
    return f(s);
  };
  s.at = (v) => s.translate(v);
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/solid-sugar.test.js`
Expected: PASS (all per-op equivalence tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/solid-sugar.js test/solid-sugar.test.js
git commit -m "feat: addSugar build-step vocabulary (composed from rotate/translate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire `addSugar` into both backends + kernel typedef

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (the `wrap` factory, ~line 61)
- Modify: `src/framework/geometry/occt-backend.js` (the `wrap` factory, ~line 80)
- Modify: `src/framework/geometry/kernel.js` (the `Solid` typedef)
- Test: `test/solid-sugar.test.js`, `test/solid-sugar-occt.test.js`

**Interfaces:**
- Consumes: `addSugar` (Task 1).
- Produces: every Solid returned by either backend is pre-sugared — `k.box(...).along("+Y").at(P)` works with no manual `addSugar`, and each chained op returns a sugared Solid.

- [ ] **Step 1: Write the failing tests**

Append to `test/solid-sugar.test.js`:

```js
test("kernel solids come pre-sugared (manifold) and along works end to end", () => {
  const s = k.box([0, 0, 0], [2, 4, 6]);
  expect(typeof s.along).toBe("function");
  sameGeom(s.along("+Y"), k.box([0, 0, 0], [2, 4, 6]).rotate(-90, [0, 0, 0], [1, 0, 0]));
});

test("sugar survives chaining (every returned solid is sugared)", () => {
  const s = k.box([0, 0, 0], [2, 4, 6]).rotateZ(10).at([1, 2, 3]);
  expect(typeof s.rotateX).toBe("function");
});
```

Create `test/solid-sugar-occt.test.js` (OCCT must boot in its own file):

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("OCCT solids are pre-sugared and along() matches the primitive rotation", () => {
  const s = k.box([0, 0, 0], [2, 4, 6]);
  expect(typeof s.along).toBe("function");
  const got = s.along("+Y");
  const want = k.box([0, 0, 0], [2, 4, 6]).rotate(-90, [0, 0, 0], [1, 0, 0]);
  expect(got.volume()).toBeCloseTo(want.volume(), 4);
  const a = got.boundingBox(), b = want.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(a.min[i]).toBeCloseTo(b.min[i], 3);
    expect(a.max[i]).toBeCloseTo(b.max[i], 3);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/solid-sugar.test.js test/solid-sugar-occt.test.js`
Expected: FAIL — `s.along` is not a function (backends don't sugar yet).

- [ ] **Step 3: Wire the backends + typedef**

In `src/framework/geometry/manifold-backend.js`, add the import near the other imports at the top of the file:

```js
import { addSugar } from "./solid-sugar.js";
```

Change the `wrap` factory opener so the returned object is sugared. Find:

```js
  const wrap = (m, hash) => ({
```

Replace with:

```js
  const wrap = (m, hash) => addSugar({
```

and change that object literal's closing `});` to `}));` (the close of `wrap`).

In `src/framework/geometry/occt-backend.js`, add the import at the top:

```js
import { addSugar } from "./solid-sugar.js";
```

Find:

```js
  const wrap = (shape) => ({
```

Replace with:

```js
  const wrap = (shape) => addSugar({
```

and change that object literal's closing `});` to `}));`.

In `src/framework/geometry/kernel.js`, in the `Solid` typedef add these property lines (next to `rotate`), and annotate `rotate`:

```js
 * @property {(deg: number, center: number[], axis: number[]) => Solid} rotate   internal primitive — prefer rotateX/Y/Z / rotateAbout
 * @property {(deg: number) => Solid} rotateX   rotate about world X through the origin
 * @property {(deg: number) => Solid} rotateY   rotate about world Y through the origin
 * @property {(deg: number) => Solid} rotateZ   rotate about world Z through the origin
 * @property {(o:{axis:"X"|"Y"|"Z"|number[], deg:number, through?:number[]}) => Solid} rotateAbout   general rotation (legible)
 * @property {(dir:"+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z") => Solid} along   orient the canonical +Z build axis along dir
 * @property {(v:number[]) => Solid} at   place an origin-built solid at point v (alias of translate)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/solid-sugar.test.js test/solid-sugar-occt.test.js`
Expected: PASS (pre-sugared on both backends; chaining preserves sugar).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/kernel.js test/solid-sugar.test.js test/solid-sugar-occt.test.js
git commit -m "feat: route both backends' solids through addSugar; typedef + occt funnel test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Comprehensive "mini-part both ways" equivalence

**Files:**
- Test: `test/solid-sugar.test.js`

**Interfaces:**
- Consumes: the pre-sugared kernel from Task 2.
- Produces: proof that the full vocabulary (`along`/`at`/`rotateAbout`/`cutAll`) composes to geometry identical to the raw-primitive build.

- [ ] **Step 1: Write the failing test**

Append to `test/solid-sugar.test.js`:

```js
test("a feature built with the vocabulary equals the raw-primitive build", () => {
  const viaVocab = k.box([0, 0, 0], [20, 20, 10]).cutAll([
    k.cylinder(2, 2, 30).along("+Y").at([10, -5, 5]),   // cross bore along Y
    k.cylinder(1.5, 1.5, 12).at([5, 5, -1]),            // vertical hole
    k.cylinder(1.5, 1.5, 12).at([15, 15, -1]),
  ]);
  let viaRaw = k.box([0, 0, 0], [20, 20, 10]);
  viaRaw = viaRaw.cut(k.cylinder(2, 2, 30).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([10, -5, 5]));
  viaRaw = viaRaw.cut(k.cylinder(1.5, 1.5, 12).translate([5, 5, -1]));
  viaRaw = viaRaw.cut(k.cylinder(1.5, 1.5, 12).translate([15, 15, -1]));
  sameGeom(viaVocab, viaRaw);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/solid-sugar.test.js`
Expected: PASS. (This test should pass immediately on Task 2's code — it is a higher-level guard, not new behavior. If it FAILS, a sugar op is not geometry-identical; fix the implementation, do not weaken the test.)

- [ ] **Step 3: Commit**

```bash
git add test/solid-sugar.test.js
git commit -m "test: mini-part built via the vocabulary equals the raw-primitive build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Migrate the in-repo example parts to `at`

**Files:**
- Modify: `src/parts/demo.js`
- Modify: `src/parts/filleted-box.js`
- Test: (existing) `test/demo-part.test.js`, `test/filleted-box.test.js`, `test/measure.test.js`, `test/cli.test.js`

**Interfaces:**
- Produces: real in-repo usage of `at`; geometry unchanged (existing tests stay green).

- [ ] **Step 1: Make the edits**

In `src/parts/demo.js`, the spacer build's bore cut — change `.translate([0, 0, -2])` to `.at([0, 0, -2])`:

```js
        return s.cut(k.cylinder(d.boreR, d.boreR, d.cutH).at([0, 0, -2]));
```

In `src/parts/filleted-box.js`, the bore cut line — change `.translate([p.w / 2, p.d / 2, -1])` to `.at([p.w / 2, p.d / 2, -1])`:

```js
        if (p.bore > 0) s = s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 2).at([p.w / 2, p.d / 2, -1]));
```

- [ ] **Step 2: Run the affected tests to verify geometry is unchanged**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/demo-part.test.js test/filleted-box.test.js test/measure.test.js test/cli.test.js`
Expected: PASS — `at` is a translate alias, so geometry (and every measured value) is identical.

- [ ] **Step 3: Commit**

```bash
git add src/parts/demo.js src/parts/filleted-box.js
git commit -m "refactor: use .at(...) for bore placement in the example parts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Docs + spec status + full suite

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/superpowers/specs/2026-06-29-build-step-vocabulary-design.md`

- [ ] **Step 1: Update the Solid API table**

In `docs/AUTHORING-PARTS.md`, find the `Solid` — combine / transform / export table (the rows include `s.translate([x,y,z])`, `s.rotate(deg, center, axis)`, …). Annotate the `rotate` row and add five rows directly after it:

```markdown
| `s.rotate(deg, center, axis)` | **internal primitive** — prefer `rotateX/Y/Z` / `rotateAbout` |
| `s.rotateX(deg)` / `s.rotateY(deg)` / `s.rotateZ(deg)` | rotate about a world axis through the origin |
| `s.rotateAbout({ axis, deg, through? })` | general rotation: `axis` = `"X"｜"Y"｜"Z"` or `[x,y,z]`; `through` = centre (default origin) |
| `s.along(dir)` | orient the canonical **+Z** build axis to point along `dir` (`"+X"｜"-X"｜"+Y"｜"-Y"｜"+Z"｜"-Z"`) |
| `s.at([x,y,z])` | place an origin-built solid at a point (readable alias of `translate`) |
```

- [ ] **Step 2: Add a "Build-step style" subsection**

In `docs/AUTHORING-PARTS.md`, immediately after the Solid API table (before the "Caching & determinism" subsection), insert:

````markdown
### Build-step style: orient → place, and batch features

Write build steps so intent is legible — an LLM (and a human) should not have to decode
magic vectors. Three habits:

- **Orient then place.** Build a primitive along its canonical **+Z** axis, point it with
  `along(dir)`, then position it with `at([x,y,z])`:

  ```js
  // ✗ cryptic: which axis? what centre?
  k.cylinder(r, r, L).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([rp, y1, sz])
  // ✓ legible
  k.cylinder(r, r, L).along("+Y").at([rp, y1, sz])
  ```

- **Rotate about a point with `rotateAbout`** when the axis isn't through the origin
  (use `rotateX/Y/Z` for the common origin cases):

  ```js
  // ✗  .rotate(angle, [rp, 0, 0], [0, 0, 1])
  // ✓
  tool.rotateAbout({ axis: "Z", deg: angle, through: [rp, 0, 0] })
  ```

- **Batch features** instead of reassigning through a cut-chain:

  ```js
  // ✗  body = body.cut(a); body = body.cut(b); body = body.cut(c);
  // ✓
  body.cutAll([a, b, c])          // and k.union([base, f1, f2]) for additive batches
  ```

The bare `rotate(deg, center, axis)` remains available as the low-level primitive for
anything `rotateX/Y/Z`/`rotateAbout` can't express, but prefer the vocabulary above.
````

- [ ] **Step 3: Update the spec status line**

In `docs/superpowers/specs/2026-06-29-build-step-vocabulary-design.md`, change the status line to:

```markdown
**Status:** Approved (design). Vocabulary implemented in partforge (2026-06-29):
rotateX/Y/Z, rotateAbout, along, at via a shared addSugar over both backends; example
parts migrated to `at`. Drum migration is a separate Drum-Machine change.
```

- [ ] **Step 4: Run the whole suite**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run`
Expected: PASS — all files, no regressions.

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/superpowers/specs/2026-06-29-build-step-vocabulary-design.md
git commit -m "docs: document the build-step vocabulary as the canonical style

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred (separate change)

- **Drum migration** — migrate `Drum-Machine`'s `bodies.js`/`stand.js`/`bridge.js`/`drum.js`
  to the vocabulary against the new partforge version, gated geometry-unchanged on the
  measure/assembly + Manifold↔OCCT parity tests (fixtures must not move).
