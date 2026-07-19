# Curve-native offset — `Shape2D.offset` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Shape2D.offset(delta, { corners, segs? })` — a curve-preserving 2-D offset that grows/insets a `Shape2D`, using each backend's native offset, and throws a clear error on collapse.

**Architecture:** One new method on the F2 `Shape2D` value, mirroring its boolean methods. Manifold → `CrossSection.offset` (Clipper2); OCCT → replicad `Drawing.offset` (curve-preserving). `offsetPolygon`'s `round/chamfer/sharp` styles map to each backend's native join type. The pure `offsetPolygon` helper is untouched.

**Tech Stack:** plain ESM JS, vitest, Manifold + replicad/OCCT (WASM), Node 24. Stacked on F2 (`shape2d-booleans`, unmerged PR #52).

## Global Constraints

- **Node 24** — `source ~/.nvm/nvm.sh && nvm use` before any `npm`/`npx vitest`; confirm `node -v` = v24.x. If the sandbox lacks it, implement + report "needs controller verification" (never fake).
- **Units mm**; helpers pure; DOM-free; **OCCT and Manifold never co-boot** (separate test files).
- **Manifold WASM has no GC** — every `CrossSection` created must be `T()`-tracked and cache-`dispose`d. **replicad offset consumes its operand** — `.clone()` first.
- **Corner mapping** (both backends support all three):
  - Manifold `JoinType`: `round`→`'Round'`, `chamfer`→`'Square'`, `sharp`→`'Miter'`.
  - OCCT `lineJoinType`: `round`→`'round'`, `chamfer`→`'bevel'`, `sharp`→`'miter'`.
- **Sign:** positive `delta` grows, negative insets.
- **Collapse throws immediately** at `.offset()` with the literal `Shape2D.offset: offset collapses the shape (reduce |delta|)`.
- **Lints:** `"offset"` in `SHAPE2D_OPS` (kernel.js) + named in `docs/KERNEL-CONTRACT.md` (the Shape2D public-surface lint + "names every op" lint). Adding it makes the Manifold Shape2D expose `offset`; that satisfies the lint (the contract test boots Manifold) — so `SHAPE2D_OPS`, KERNEL-CONTRACT, and the Manifold method land together in Task 1.
- **Version bump additive** — do NOT change `CONTRACT_VERSION`.
- **Do NOT touch** `embed-test.html` / `src/app-embed-test.js`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Manifold `Shape2D.offset` + surface/lint/errors

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (add `offset` to `wrapShape2d`)
- Modify: `src/framework/geometry/kernel.js` (`SHAPE2D_OPS` += `"offset"`)
- Modify: `docs/KERNEL-CONTRACT.md` (name `offset` in the Shape2D method list)
- Modify: `docs/ERROR-PATTERNS.md` (collapse entry)
- Test: `test/shape2d-manifold.test.js`, plus a pure `test/shape2d-hash.test.js` addition

**Interfaces:**
- Produces (Manifold): `Shape2D.offset(delta, { corners = "round", segs? }) => Shape2D`; cached by `h("offset2d", hash, delta, corners, segs)`; throws on non-finite delta, bad corners, or collapse.

- [ ] **Step 1: Write the failing tests**

Add to `test/shape2d-manifold.test.js` (the `SQ` helper already exists):
```js
test("offset grows a square by delta on every side (round corners add quarter-circles)", () => {
  const s = k.shape2d(SQ(0, 0, 10)).offset(1);           // 10x10 + perimeter*1 + 4 quarter-circles
  expect(s.area()).toBeCloseTo(100 + 40 + Math.PI, 1);   // 100 + 4*10*1 + π*1²
});

test("negative offset insets a square to 8x8", () => {
  expect(k.shape2d(SQ(0, 0, 10)).offset(-1).area()).toBeCloseTo(64, 1); // inset convex corners stay sharp → 8x8
});

test("corner styles differ at convex right angles (sharp > round > chamfer)", () => {
  const sharp = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "sharp" }).area();
  const round = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "round" }).area();
  const cham  = k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "chamfer" }).area();
  expect(sharp).toBeGreaterThan(round);
  expect(round).toBeGreaterThan(cham);
});

test("offset of a circle scales the radius", () => {
  const a = k.shape2d(circleProfile(5)).offset(1).area();
  expect(a).toBeCloseTo(Math.PI * 36, 0);                // π(5+1)²  (faceted → loose)
});

test("collapse throws immediately", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(-6)).toThrow("Shape2D.offset: offset collapses the shape");
});

test("offset validates delta and corners", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "bevel" }))
    .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
});

test("offset is content-hash cached (hit on repeat)", () => {
  k.beginSubPart("off"); k.resetCacheStats();
  const one = () => k.shape2d(SQ(0, 0, 10)).offset(1).area();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});
```
Add to `test/shape2d-hash.test.js`:
```js
test("offset2d hash is param-sensitive", () => {
  const a = "aaa";
  expect(h("offset2d", a, 1, "round", 116)).toBe(h("offset2d", a, 1, "round", 116));
  expect(h("offset2d", a, 1, "round", 116)).not.toBe(h("offset2d", a, 2, "round", 116));
  expect(h("offset2d", a, 1, "round", 116)).not.toBe(h("offset2d", a, 1, "sharp", 116));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-manifold.test.js -t "offset"`
Expected: FAIL — `s.offset is not a function`.

- [ ] **Step 3: Implement Manifold `offset`**

In `src/framework/geometry/manifold-backend.js`, inside `wrapShape2d`, after `intersect`, add:
```js
    offset: (delta, { corners = "round", segs: nSeg = segs } = {}) => {
      const joinType = { round: "Round", chamfer: "Square", sharp: "Miter" }[corners];
      if (!joinType) throw new Error('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
      if (!Number.isFinite(delta)) throw new Error("Shape2D.offset: delta must be a finite number");
      return cachedCS(h("offset2d", hash, delta, corners, nSeg), () => {
        const out = T(cs.offset(delta, joinType, 2, nSeg));       // miterLimit 2 (Clipper2 default)
        if (out.numContour() === 0) throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
        return out;
      });
    },
```
(Validation runs before `cachedCS` so it throws without a cache entry. The collapse `out` is `T()`-tracked, so throwing inside `make` still lets `cleanup()` free it; the cache entry is never registered because `make` threw.)

- [ ] **Step 4: List + document + ERROR-PATTERNS**

In `src/framework/geometry/kernel.js`, add `"offset"` to `SHAPE2D_OPS`:
```js
export const SHAPE2D_OPS = [
  "union", "cut", "cutAll", "intersect", "offset", "area", "boundingBox", "toRegions", "simple", "clone",
];
```
In `docs/KERNEL-CONTRACT.md`, in the Shape2D method table/list (beside `intersect`), name `offset`:
```markdown
| `offset(delta, {corners?, segs?})` | Grows (`delta>0`) or insets (`delta<0`) by `delta` mm; `corners` = `round` (default) / `chamfer` / `sharp`. Curve-preserving on OCCT, faceted at mesh LOD on Manifold. Throws if the offset collapses the shape. |
```
In `docs/ERROR-PATTERNS.md`, add:
```markdown
## shape2d-offset-collapses

- **Symptom:** `Shape2D.offset: offset collapses the shape (reduce |delta|)`
- **Cause:** A negative (inset) `offset` removed more than the shape's half-width,
  leaving no geometry — or the delta is larger than the feature it offsets.
- **Fix:** Reduce `|delta|`, or check the source profile is large enough for the
  inset. Realistic clearances (fractions of a mm) and wall insets up to the
  narrowest feature never trip this.
```

- [ ] **Step 5: Run tests + lints**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-manifold.test.js test/shape2d-hash.test.js test/kernel-contract.test.js test/error-patterns.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/kernel.js docs/KERNEL-CONTRACT.md docs/ERROR-PATTERNS.md test/shape2d-manifold.test.js test/shape2d-hash.test.js
git commit -m "feat: Manifold Shape2D.offset — native 2-D offset, corner styles, collapse throws

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: OCCT `Shape2D.offset` (curve-preserving) + parity

**Files:**
- Modify: `src/framework/geometry/occt-backend.js` (add `offset` to `wrapShape2d`)
- Test: `test/shape2d-occt.test.js`

**Interfaces:**
- Produces (OCCT): `Shape2D.offset(delta, { corners = "round" }) => Shape2D`, curve-preserving; same validation + collapse literal as Manifold.

- [ ] **Step 1: Verify the collapse-empty shape (probe first)**

Before writing collapse detection, confirm what replicad returns for a collapsing offset. Add a temporary probe to `test/shape2d-occt.test.js`:
```js
test("probe: collapsing offset", () => {
  try {
    const r = k.shape2d([[0,0],[10,0],[10,10],[0,10]])._drawing.clone().offset(-6, { lineJoinType: "round" });
    console.log("collapse →", { blueprints: r?.blueprints?.length, innerShape: r?.innerShape });
  } catch (e) { console.log("collapse threw:", e.message); }
});
```
Run it, record in the report whether replicad returns an empty `Drawing` (`blueprints.length === 0` / null `innerShape`), throws, or yields a degenerate shape. Delete the probe. Gate the real collapse check on whatever you observed.

- [ ] **Step 2: Write the failing tests**

Add to `test/shape2d-occt.test.js` (`SQ`/`stepText` already exist):
```js
test("offset grows/insets and extrudes to the expected volume", () => {
  const grown = k.extrude({ profile: k.shape2d(SQ(0,0,10)).offset(1, { corners: "sharp" }), h: 4 });
  expect(grown.volume()).toBeCloseTo(144 * 4, -1);       // 12x12x4 (sharp corners = exact square)
});

test("offset of a curved Shape2D stays exact → STEP has a B_SPLINE", async () => {
  const KAPPA = 0.5522847498307936, R = 5, k4 = R * KAPPA;
  const circle = pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R]).cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R]).cubicTo([R, 0], [k4, -R], [R, -k4]).close();
  const step = await stepText(k.extrude({ profile: k.shape2d(circle).offset(1), h: 3 }));
  expect(step).toMatch(/B_SPLINE/);
});

test("collapse throws immediately (OCCT)", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(-6)).toThrow("Shape2D.offset: offset collapses the shape");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-occt.test.js -t "offset"`
Expected: FAIL — `s.offset is not a function`.

- [ ] **Step 4: Implement OCCT `offset`**

In `src/framework/geometry/occt-backend.js`, inside `wrapShape2d`, after `intersect`, add (adapt the collapse check to the Step-1 probe result):
```js
      offset: (delta, { corners = "round" } = {}) => {
        const lineJoinType = { round: "round", chamfer: "bevel", sharp: "miter" }[corners];
        if (!lineJoinType) throw new Error('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
        if (!Number.isFinite(delta)) throw new Error("Shape2D.offset: delta must be a finite number");
        const result = drawing.clone().offset(delta, { lineJoinType });   // clone — replicad consumes the operand
        if (!result || (result.blueprints && result.blueprints.length === 0))
          throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
        return wrapShape2d(result);
      },
```
**If Step 1 showed replicad THROWS on collapse** rather than returning empty, wrap the `offset` call in try/catch and re-throw the `Shape2D.offset: offset collapses the shape (reduce |delta|)` literal instead. Match the literal exactly either way.

- [ ] **Step 5: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-occt.test.js`
Expected: PASS (volumes, STEP `B_SPLINE`, collapse throws).

- [ ] **Step 6: Cross-backend parity test**

Add to `test/shape2d-occt.test.js`:
```js
test("offset+extrude volume is close to Manifold (parity)", () => {
  // 10x10 square, +1 sharp offset → 12x12; both backends should agree closely.
  const v = k.extrude({ profile: k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "sharp" }), h: 4 }).volume();
  expect(v).toBeCloseTo(144 * 4, -1);
});
```
(The Manifold side already asserts the matching area in Task 1; this pins the OCCT volume to the same closed form.)

- [ ] **Step 7: Commit**
```bash
git add src/framework/geometry/occt-backend.js test/shape2d-occt.test.js
git commit -m "feat: OCCT Shape2D.offset — curve-preserving native offset

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Docs + version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (offset example in the 2-D booleans section)
- Modify: `package.json` (+ lockfile sync)
- Test: full suite

- [ ] **Step 1: AUTHORING-PARTS example**

In `docs/AUTHORING-PARTS.md`, in the "2-D booleans" subsection (added in F2), add an offset line:
```js
// A 0.2 mm printer clearance around a bore, then a 2 mm wall inset:
const bore  = k.shape2d(circleProfile(3)).offset(0.2);            // looser
const wall  = k.shape2d(outer).offset(-2, { corners: "sharp" });  // inset, mitered
```
Add one sentence: *"`Shape2D.offset(delta, {corners})` grows (`delta>0`) or insets (`delta<0`) a shape with round/chamfer/sharp corners — curve-preserving on OCCT, faceted at mesh LOD on Manifold; it throws if the offset collapses the shape. (For `derive()`/main-thread clearance math on plain point lists, use the pure `offsetPolygon` helper instead.)"*

- [ ] **Step 2: Version bump**

Edit `package.json` — bump the minor version (do NOT touch `CONTRACT_VERSION`), then sync:
```bash
source ~/.nvm/nvm.sh && nvm use && npm install --package-lock-only
```

- [ ] **Step 3: Full suite**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run`
Expected: all green.

- [ ] **Step 4: Commit**
```bash
git add docs/AUTHORING-PARTS.md package.json package-lock.json
git commit -m "docs: document Shape2D.offset; version bump

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `Shape2D.offset(delta, {corners, segs})` both backends via native offset → Tasks 1 (Manifold), 2 (OCCT). ✅
- Corner-style mapping (round/chamfer/sharp) → both tasks. ✅
- Sign convention, caching (Manifold), clone (OCCT) → Tasks 1, 2. ✅
- Collapse throws immediately → Tasks 1, 2 (OCCT detection verified in Task 2 Step 1). ✅
- Curve-preserving OCCT → STEP `B_SPLINE` → Task 2. ✅
- `SHAPE2D_OPS` + KERNEL-CONTRACT + ERROR-PATTERNS → Task 1. ✅
- Validation (delta/corners) + hash unit test → Task 1. ✅
- Cross-backend parity → Task 2 Step 6. ✅
- Docs + version → Task 3. ✅
- Pure `offsetPolygon` untouched → not modified in any task. ✅

**Placeholder scan:** no logic placeholders. One integration verify-point: OCCT collapse-return shape (empty Drawing vs throw), made an explicit probe-first step (Task 2 Step 1) with both code paths given.

**Type consistency:** `offset(delta, {corners, segs?})`, the `round/chamfer/sharp` → `Round/Square/Miter` (Manifold) / `round/bevel/miter` (OCCT) maps, and the three error literals (`delta must be a finite number`, `corners must be "round" | "chamfer" | "sharp"`, `offset collapses the shape (reduce |delta|)`) are identical across Tasks 1-2 and match `SHAPE2D_OPS`/KERNEL-CONTRACT/ERROR-PATTERNS.

**Out of scope (from spec):** pure `offsetPolygon` changes, a standalone `k.offset2d`, variable-distance/open-path offsets.
