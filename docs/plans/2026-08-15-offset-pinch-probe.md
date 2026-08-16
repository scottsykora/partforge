# Adaptive Offset Pinch Probe Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Classify offset-boundary pieces correctly at narrow pinch points so the winding resolver returns the positive-winding topology for the committed comb and glyph failures without introducing new corpus, fidelity, or performance regressions.

**Architecture:** Keep the existing crossing, splitting, multiplicity, fill-rule, and chaining pipeline. Replace `_classify`'s single fixed midpoint probe with a geometry-only selection among interior piece samples, and cap its distance by clearance to non-incident arrangement edges. Validate in layers: classifier balance, end-to-end comb truth, glyph topology, committed corpus, full suite, and performance.

**Tech Stack:** Plain ESM JavaScript, Vitest, paper.js-backed contour intersections, Clipper2/Minkowski/SDF test oracles, Node 24.

---

### Task 1: Pin the classifier failure below `_chain`

**Files:**
- Modify: `test/contour-winding.test.js`

**Step 1: Add the raw comb fixture and classifier-balance test**

Import `_rawOffset` from `src/framework/geometry/contour-offset.js`. Add the existing four-notch comb fixture from `test/offset-oracle-manifold.test.js` and build its raw round offset at `-2.4975`.

Flatten the raw regions to rings, then call the real arrangement stages:

```js
const raw = _rawOffset(comb, -2.4975, "round").raw;
const rings = raw.flatMap((rg) => [rg.outer, ...rg.holes]);
const merged = _mergeCrossings(ringCrossings(rings));
const pieces = _splitRings(rings, merged);
const classified = _classify(pieces, tess(rings), {
  debug: true,
  inside: (w) => w >= 1,
});
```

For every pooled vertex, count kept pieces entering and leaving it. Assert that the counts match, and include the vertex id plus the debug records in the assertion message. This is the invariant `_chain` requires and the current fixed probe violates at exactly one pinch.

Also assert that at least one currently dropped departure reports `wLeft === 0` and `wRight === -1`; this proves the test exercises the diagnosed mechanism rather than an unrelated chain failure.

**Step 2: Run the new test and verify RED**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use
npx vitest run test/contour-winding.test.js -t "balances the positive boundary at the narrow comb pinch"
```

Expected: FAIL because one vertex has unequal kept in/out degree. The diagnostic must show dropped `0/-1` departures.

**Step 3: Commit the failing test**

```bash
git add test/contour-winding.test.js
git commit -m "test: expose winding misclassification at a narrow pinch"
```

---

### Task 2: Select a probe by arrangement clearance

**Files:**
- Modify: `src/framework/geometry/contour-winding.js:169-190`
- Modify: `src/framework/geometry/contour-winding.js:292-414`
- Modify: `test/contour-winding.test.js`

**Step 1: Add focused helper tests**

Export a test hook named `_probeForPiece` only if the behavior cannot be asserted through `_classify` without duplicating implementation details. Prefer assertions through `_classify`.

Add focused tests that establish:

- an isolated square remains byte-identical under default and positive fill;
- a deliberately crowded pair of non-crossing edges chooses a probe distance smaller than `PROBE_EPS`;
- translating and reversing the crowded fixture preserves the classification result;
- coincident-span multiplicity fixtures remain unchanged.

Run these tests before production changes and verify that only the new crowded-clearance expectation fails.

**Step 2: Reuse interior arc-length samples**

Generalize `pieceSamples(piece)` so `_classify` can reuse its five interior points and total length. Keep the fixed sample count small and deterministic.

**Step 3: Return the projected source edge**

Extend `projectToRing`'s result:

```js
best = { point, dir: [ex / L, ey / L], d2, edge: i };
```

This identifies the incident source edge that must not count as an obstruction.

**Step 4: Add point-to-edge clearance**

Add a pure helper equivalent to:

```js
function pointEdgeDistance(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const L2 = ex * ex + ey * ey;
  let t = L2 > 1e-18 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey));
}
```

Compute clearance against every tessellated edge except the projected source edge and its immediate source-ring neighbours. Treat geometrically coincident spans already handled by `_coincidence` as non-obstructions; confirm this from the existing multiplicity fixtures rather than assuming it.

**Step 5: Choose the probe geometrically**

For each interior piece sample:

1. project it to `tessRings[piece.ring]`;
2. measure its non-incident clearance;
3. retain the candidate with greatest clearance, with stable first-candidate tie breaking.

Set:

```js
const eps = Math.min(
  PROBE_EPS,
  Math.max(len / 4, 1e-9),
  Math.max(clearance / 4, 1e-9),
);
```

If measurement shows that coincident representatives produce zero clearance, exclude only edges confirmed coincident with the selected source span. Do not disable adaptive clearance for all `mult !== 1` pieces without an explicit regression test.

Use the selected candidate's `point` and `dir` for the existing left probe. Leave `_windingAt`, `wRight = wLeft - mult[i]`, the positive fill predicate, and `reverse` unchanged.

**Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run test/contour-winding.test.js
```

Expected: all resolver tests pass, including the new balanced-pinch test and all coincidence/tangent/provenance regressions.

**Step 7: Commit the minimal classifier fix**

```bash
git add src/framework/geometry/contour-winding.js test/contour-winding.test.js
git commit -m "fix: adapt winding probes to local boundary clearance"
```

---

### Task 3: Promote the comb pinch to oracle-backed correctness

**Files:**
- Modify: `test/offset-oracle-manifold.test.js:416-457`

**Step 1: Replace parked throw assertions with truth assertions**

For round, chamfer, and sharp at `-2.4975`, assert:

- `offsetRegions` does not throw;
- native region/hole counts equal the independent oracle topology;
- net area meets the file's existing exact/relative tolerance policy;
- the tiny second component identified by the oracle is retained when it exceeds the corpus feature floor.

Do not copy a new literal expectation from the implementation. Derive it through the test's existing oracle helpers.

**Step 2: Verify RED or immediate GREEN for the correct reason**

Run:

```bash
npx vitest run test/offset-oracle-manifold.test.js -t "four-notch comb at −2.4975"
```

If the test passes immediately after Task 2, confirm it failed on the parent commit before retaining it. If topology is still wrong, stop and return to systematic root-cause investigation; do not weaken the oracle assertion.

**Step 3: Run neighbouring comb and plate fixtures**

Run:

```bash
npx vitest run test/offset-oracle-manifold.test.js -t "known topology divergences|four-notch comb|two-notch plate"
```

Expected: no new throw, topology, or area regression. The unrelated 1x1-hole parked case remains parked unless the classifier change genuinely fixes it against the oracle.

**Step 4: Commit the promoted regression**

```bash
git add test/offset-oracle-manifold.test.js
git commit -m "test: promote narrow offset pinch to correctness"
```

---

### Task 4: Drop source holes only when round erosion is provably empty

**Files:**
- Modify: `src/framework/geometry/contour-offset.js`
- Modify: `test/contour-offset.test.js`
- Modify: `test/offset-oracle-manifold.test.js`

**Step 1: Add failing collapse-threshold tests**

Pin the source-domain behavior before implementation:

- Roboto `o` at +2 round retains one hole;
- Roboto `o` at +3 round returns zero holes;
- Roboto `e`, `a`, and `p` lose their counters only when delta exceeds their source
  inradius;
- `"Scott"` at +3 round returns one region and zero holes;
- the existing small-offset curved-hole fixtures remain unchanged.

Derive end-to-end topology from the existing Clipper2 oracle rather than hardcoding engine
output. Run the focused tests and verify failures on the collapsed counters.

**Step 2: Implement a conservative source-hole disk decision**

Add pure helpers in `contour-offset.js` for point-to-ring signed distance and a max-heap
branch-and-bound over a tessellated source hole. A cell centered at `(x, y)` with half-width
`hx` and half-height `hy` has upper bound:

```js
max = signedDistance([x, y], ring) + Math.hypot(hx, hy)
```

The decision returns true as soon as an interior sample reaches `radius - tolerance`. It
returns false only when the heap's greatest remaining upper bound is below that threshold.
If subdivision reaches the tolerance scale while the bounds still straddle the threshold,
return true conservatively.

**Step 3: Gate only positive round hole offsets**

In `rawOffset`, before calling `_offsetContour` on a source hole, omit it only when:

```js
delta > 0 && corners === "round" && !sourceHoleContainsDisk(hole, delta)
```

Do not apply the Euclidean disk rule to sharp/chamfer or negative deltas. A dropped hole is
a clean collapse and must not dirty an otherwise exact outer.

**Step 4: Run focused tests and commit**

```bash
npx vitest run test/contour-offset.test.js -t "source-hole inradius|curved holes must survive"
npx vitest run test/offset-oracle-manifold.test.js -t "glyphs — the case class"
git add src/framework/geometry/contour-offset.js test/contour-offset.test.js test/offset-oracle-manifold.test.js
git commit -m "fix: drop round-eroded holes past their source inradius"
```

---

### Task 5: Re-evaluate the glyph matrix without re-baselining

**Files:**
- Modify: `src/framework/geometry/contour-offset.js`
- Modify: `test/offset-oracle-manifold.test.js:530-699`

**Step 0: Remove source-less positive-dilation components**

Add focused regressions for the detached `a` and `p` +0.5 slivers. After any positive offset
larger than the numerical tolerance band, retain an output region only when its material
contains a tessellated point from at least one source outer. This follows directly from
`S ⊆ S + B`, applies to round/chamfer/sharp, and must not be replaced with an area cutoff.
Verify that deliberately tiny but real source components survive.

**Step 1: Add the missing reported deltas**

Ensure `"Scott"` is exercised at `[0.2, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0]` under round corners. Keep the five-delta single-glyph matrix.

**Step 2: Compare every result directly to the derived Clipper2 truth**

Replace pinned throw/result tables only for cases that now agree. For each case assert:

- no error;
- region count;
- total hole count;
- area within `AREA_RTOL`;
- no extra raw sliver regions above the documented feature floor.

The required `"Scott"` truths include:

```text
0.8 -> 1 region, 2 holes
1.0 -> 1 region, 3 holes
1.5 -> 1 region, 5 holes
2.0 -> 1 region, 2 holes
3.0 -> 1 region, 0 holes
```

Derive areas from `truthOf`; do not pin implementation-generated values.

**Step 3: Run the glyph block**

Run:

```bash
npx vitest run test/offset-oracle-manifold.test.js -t "glyphs — the case class"
```

Expected: all cases agree. If throws are fixed but any of the six silent divergences remain, record which arrangements still fail and return to root-cause investigation before changing their expectations.

**Step 4: Commit only oracle-supported promotions**

```bash
git add test/offset-oracle-manifold.test.js
git commit -m "test: promote glyph offset topology to correctness"
```

---

### Task 6: Verify the geometry core and committed corpus

**Files:**
- Modify only if a verified regression requires a focused fix.

**Step 1: Run focused geometry tests**

```bash
npx vitest run test/contour-winding.test.js test/contour-offset.test.js test/offset-fuzz.test.js test/offset-oracle-manifold.test.js test/worker-layering.test.js
```

Expected: all pass with no new warnings.

**Step 2: Run the full suite**

```bash
npm test
```

Expected: all tests pass.

**Step 3: Run the committed offset corpus**

```bash
npm run offset-rates
```

Record before/after totals for round, chamfer, and sharp. Required outcome:

- zero glyph throws in the target matrix;
- no new chain-incomplete cases;
- no topology or area regression against the committed oracle comparisons;
- the residual throw rate is reduced, not merely moved between styles.

If a new failure appears, add its seeded fixture as a failing test before changing production code.

**Step 4: Run worker-layering separately if needed**

```bash
npx vitest run test/worker-layering.test.js
```

Expected: `contour-winding.js` remains DOM-free, `three`-free, and `node:`-free.

---

### Task 7: Measure performance and preserve curve fidelity

**Files:**
- Modify: benchmark/test files only if needed to commit a reproducible measurement.

**Step 1: Locate or add the 24-glyph cleanup benchmark**

Use the design's existing reference input. If it only exists as scratch code, add a small committed benchmark script under `scripts/` that reports median end-to-end offset time without asserting wall-clock timing in Vitest.

**Step 2: Measure parent and fixed commits under Node 24**

Run each enough times to warm modules/WASM and report the median. Required: fixed cleanup stays within approximately `1.5x` of the parent branch timing.

**Step 3: Verify arc preservation**

Assert or measure that the normal successful `"Scott"` results retain curve segments. A result that succeeds only through a polyline fallback is not sufficient for the branch's STEP-fidelity goal.

**Step 4: Commit any reproducible benchmark or fidelity regression test**

```bash
git add scripts test
git commit -m "test: verify offset probe performance and curve fidelity"
```

Skip this commit when no files change.

---

### Task 8: Update documentation and release version after all gates pass

**Files:**
- Modify: `docs/ERROR-PATTERNS.md`
- Modify: `docs/KERNEL-CONTRACT.md`
- Modify: `docs/superpowers/handoffs/2026-08-15-offset-winding-resolver-handoff.md`
- Modify: `.superpowers/sdd/2026-08-15-offset-winding-resolver/progress.md`
- Modify: `package.json`

**Step 1: Update measured failure documentation**

Remove only limitations eliminated by the verified fix. Preserve remaining limitations around absolute cluster tolerance, coarse fallback topology, polyline fallback arc loss, and any residual corpus failures.

Append a decision-log ruling with:

- confirmed shared root cause or explicit separation of glyph/comb causes;
- exact focused and corpus results;
- performance numbers;
- any remaining parked cases.

**Step 2: Retire or rewrite the handoff status**

Mark the branch shippable only if all release gates pass. Keep the original reproduction and explain the verified correction; do not erase the historical warning.

**Step 3: Bump the package version**

Change `package.json` from `0.59.0` to `0.60.0`. Do not publish or tag manually.

**Step 4: Run final verification from a clean state**

```bash
npm test
npm run offset-rates
npx vitest run test/worker-layering.test.js
git diff --check
git status --short
```

Expected: all commands pass; only intentional files are modified before the final commit.

**Step 5: Commit the release-ready branch**

```bash
git add package.json docs .superpowers
git commit -m "docs: complete offset winding resolver and bump to 0.60.0"
```

Do not push or open a pull request unless explicitly requested.
