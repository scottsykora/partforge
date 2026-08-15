# Handoff: text offset artifacts and the winding-resolver branch

**Status:** branch `claude/offset-winding-resolver` is **not shippable**. It fixes a
substantial class of real defects but **regresses the case it was written to fix**.
Do not bump the version or merge as-is.

**Date:** 2026-08-15
**Branch:** `claude/offset-winding-resolver`, 43 commits ahead of `origin/main`, version
still `0.59.0` (unbumped), full suite green (2506 tests).
**Base:** `origin/main` = `f3ce357` = published `partforge@0.59.0`.
(Note: a local `main` may be stale at 0.58.1 — compare against `origin/main`.)

---

## 1. The bug

Reported on partforge cloud: text **"Scott"** offset by a **large** delta produces bad
geometry. The letter outlines dilate until they touch and merge, and the merge leaves
spurious holes and extra regions where there should be one clean blob.

Reproduce against **shipped 0.59.0** (`origin/main`):

```
"Scott", size 10, corners "round", offsetRegions(regions, delta, "round")

delta | 0.59.0 result      | truth (Clipper2, the pre-0.59.0 route)
  0.2 | 5r  1h  140.006    | 5r  1h  140.068   ok
  0.5 | 4r  1h  196.739    | 4r  1h  196.816   ok
  0.8 | 1r  2h  252.896    | 1r  2h  252.996   ok
  1.0 | 1r  5h  288.426    | 1r  3h  288.531   2 spurious holes
  1.5 | 1r  5h  362.078    | 1r  5h  362.105   ok
  2.0 | 3r  6h  419.497    | 1r  2h  419.571   2 spurious regions, 4 spurious holes
  3.0 | 2r 12h  521.623    | 1r  0h  522.349   1 spurious region, 12 spurious holes
```

`r` = regions, `h` = holes. **Area is right to ~0.1% at every delta; topology is not.**
That is the signature: the offset outlines are geometrically correct, and the *cleanup*
stage that decides which loops are material and which are voids gets it wrong once the
letters overlap. Twelve phantom counters at delta 3 is what the user saw.

This is a regression introduced by 0.59.0 (PR #128), which replaced the kernel's Clipper2
offset with a native curve-preserving engine (`src/framework/geometry/contour-offset.js`).
Before 0.59.0, `Shape2D.offset` ran Clipper2 and returned the "truth" column.

---

## 2. Why 0.59.0 gets it wrong

`contour-offset.js` offsets each contour segment-by-segment and walks the result into raw
rings. Where a shape's offset self-overlaps, those raw rings contain **reversed loops** —
loops traced backwards, representing material that collapsed. The correct fix is a **fill
rule**: keep only the boundary of the region with positive winding number.

0.59.0 instead did a **boolean cleanup** (`resolveSelfRegions` in `paper-bridge.js`): union
the regions pairwise with paper.js and hope the reversed loops cancel. Under paper's
even-odd/non-zero semantics they don't cancel correctly when three or more offset outlines
overlap at once — which is exactly what adjacent letters at a large delta produce. Hence:
right area, wrong topology.

---

## 3. What was attempted (this branch)

A **winding-number resolver**: `src/framework/geometry/contour-winding.js` (573 lines, new).

Pipeline, all on the contour IR (`{start, segments:[{to}|{to,via}|{to,c1,c2}]}`):

1. `ringCrossings(rings)` (in `paper-bridge.js`) — find every self- and pair-intersection,
   using paper's Bézier fat-line clipper, reported in **IR parameter space**.
2. `_mergeCrossings` — cluster coincident crossings into a shared vertex pool
   (`CLUSTER_TOL = 5e-3` mm).
3. `_splitRings` — cut every ring into pieces at those vertices.
4. `_classify` — for each piece, probe the winding number just to its left, derive the
   right side, and keep the piece iff the two sides straddle the fill rule.
5. `_chain` — reassemble kept pieces into closed rings, ordering branches at a junction by
   **curve tangent**.
6. `resolveOffsetWinding` — nest outers and holes.

Wired into `offsetRegions` in `contour-offset.js`; the boolean cleanup path was deleted.

**Design docs:**
- `docs/superpowers/specs/2026-08-15-offset-winding-resolver-design.md`
- `docs/superpowers/plans/2026-08-15-offset-winding-resolver.md`

**Full decision log with 18 rulings and per-task review findings:**
`.superpowers/sdd/2026-08-15-offset-winding-resolver/progress.md` — **read this before
changing anything.** It records nine genuine defects found by review, several of which were
defects in the *plan*, not the implementation. The most consequential:

- **The fill rule is POSITIVE winding (w ≥ 1), not non-zero** (Ruling 6). The spec
  originally said non-zero; that fills every `w = −1` region, which in offset output is by
  definition collapsed material. Clipper2's `ClipperOffset` uses `FillRule::Positive` for
  the same reason.
- **`wRight = wLeft − 1` breaks at multiplicity** (Ruling 8). Where *k* directed edges
  coincide, the winding jumps by their net count. `_coincidence` measures it.
- **Paper's curve time ≠ IR parameter** (Rulings 10–11). An arc >90° becomes several paper
  cubics sharing one segMap entry. The parameter must be recovered from the intersection
  *point* — linear in position for a line, linear in *angle* for an arc.
- **The probe must be anchored to the queried tessellation**, not the true curve
  (Ruling 3). The ring sagitta 1.2045e−3·r exceeds `PROBE_EPS` above r ≈ 8.3 mm, which
  silently misclassified pieces on any ordinary-sized arc.

---

## 4. What the branch actually improved

Measured against two **independent** oracles built for this work — a Minkowski
dilate/erode construction (`test/helpers/minkowski-oracle.js`, uses Clipper2 only as a
polygon-set assembler, never its offsetter) and a signed-distance level-set oracle:

- **Two shape families corrected that both 0.59.0 and the old cleanup get wrong.**
  `concaveV` erode 3: truth 2 components / 26.732 — branch 26.729, 0.59.0 gives 3r/35.014.
  `thinNeck` erode 3: truth 2 / 94.402 — branch 94.407, 0.59.0 gives 3r/110.909.
- **Merged-hole and breakthrough cases now exact** (192.677 and 249.715, closed-form).
- **A silent one-third material loss fixed** (Ruling 15). `segsCross` discarded the
  collinear case, so a ring crossing itself *at one of its own vertices* passed validation
  and took the fast path. A T-slot block at delta −2 returned 33.7 against a truth of 48.
  This was pre-existing in 0.59.0 and is a regression against the pre-0.59.0 Clipper2 path.
- Across a 240-case sweep (8 shapes × 3 corner modes × 10 deltas) vs. the old cleanup:
  **zero cases worse, 36 materially better, 12 old-only throws resolved to exact truth.**
- **An overlap-side trim bug fixed** (Ruling 13/Task 7B). The trim was a workaround for not
  having a fill rule; at large |delta| its intersection landed outside both segments'
  extents, giving ~30% area error on ordinary reflex geometry in all three corner modes.
  Gating the trim on the crossing being in-extent beat both keeping and removing it.
- **A committed corpus** (`test/helpers/offset-corpus.js`, `scripts/offset-rates.mjs`,
  `npm run offset-rates`) — 606 seeded cases × 20 deltas × 3 styles = 36,090 offsets. Every
  rate quoted in the docs is now reproducible from the repo. Seven previously-published
  doc claims were falsified against it and corrected (Ruling 18).

---

## 5. Why it is not shippable

`_chain` throws `contour-winding: could not chain offset boundary (incomplete intersection
set)` on the reported case. Three-way comparison, freshly measured at branch HEAD:

```
"Scott", size 10, corners "round"

delta | this branch      | 0.59.0 (shipped)  | Clipper2 (pre-0.59.0, correct)
  0.2 | 5r  1h  140.006  | 5r  1h  140.006   | 5r  1h  140.068
  0.5 | 4r  1h  196.736  | 4r  1h  196.739   | 4r  1h  196.816
  0.8 | THROW            | 1r  2h  252.896   | 1r  2h  252.996
  1.0 | 3r  5h  288.627  | 1r  5h  288.426   | 1r  3h  288.531
  1.5 | THROW            | 1r  5h  362.078   | 1r  5h  362.105
  2.0 | THROW            | 3r  6h  419.497   | 1r  2h  419.571
  3.0 | THROW            | 2r 12h  521.623   | 1r  0h  522.349
```

The user reported *large* offsets on text. That is precisely the range that now hard-fails.
A throw from `Shape2D.offset` is a build failure — in a parametric app with a delta slider,
it reads as "the part builds at 0.5 mm and dies at 0.8 mm".

Note the failure is **not monotonic in delta**: 0.8 throws, 1.0 succeeds, 1.5 throws. This
is a degeneracy, not a scale effect.

Glyph corpus, 6 chars (`o e a p t Scott`) × 5 deltas (0.2/0.5/1/2/3), round corners, area
compared to Clipper2 at 0.5% tolerance:

```
20 agree / 9 throw / 1 diverge  (of 30)
```

All 9 throws are at delta 2 or 3. (Topology is compared separately and is worse than area
agreement suggests — see the `d=1` row above: 3r/5h where truth is 1r/3h.)

### Repro script

Save at the repo root and run with Node 24 (`source ~/.nvm/nvm.sh && nvm use`):

```js
import { offsetRegions } from "./src/framework/geometry/contour-offset.js";
import { textGlyphs } from "./src/framework/geometry/text2d.js";
import { loadDefaultFont } from "./test/helpers/offset-corpus.js";

const font = await loadDefaultFont();
const regions = textGlyphs(font, "Scott", { size: 10 });

for (const d of [0.2, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0]) {
  try {
    const out = offsetRegions(regions, d, "round");
    console.log(`d=${d}: ${out.length}r ${out.reduce((n, r) => n + r.holes.length, 0)}h`);
  } catch (e) {
    console.log(`d=${d}: THROW — ${e.message}`);
  }
}
```

---

## 6. The diagnosed root cause

Confirmed independently by a reviewer on a separate fixture (four-notch comb at delta
−2.4975 round), and it is the same mechanism as the parked class 1 in Task 7D:

> At a pinch vertex the boundary **dead-ends**. Exactly one vertex has two departing
> pieces, and `_classify` probes **both** as `wLeft = 0, wRight = −1`. Under the positive
> rule (`inside(w) = w >= 1`) neither straddles, so `keep = false` for both, and `_chain`
> arrives at a vertex with no outgoing edge.

Location: `_classify`, `src/framework/geometry/contour-winding.js:380-414` — specifically
the probe at lines 402-410.

Why the existing mitigations cannot help: the fallback ladder in
`contour-offset.js:605-636` (`chainFallback`, 7 rungs) perturbs delta, cluster tolerance,
and tessellation. All rungs re-run the same classification. A reviewer confirmed no
perturbation rung reaches this case — the dead-end is a property of the probe, not of
numerical noise.

Likely shape of the fix (**unverified — this is a hypothesis, not a conclusion**): at a
pinch the two departing pieces are separated by less than the probe offset, so both probes
land in the same exterior cell. Candidates worth testing:
- Shorten the probe adaptively at pinch vertices (`eps` is already reduced for short
  pieces at line 405 — it may need to key on *vertex degree* or on distance to the nearest
  other piece, not on piece length).
- Probe at a parameter away from the piece midpoint when the midpoint's neighbourhood is
  contested.
- Detect degree-2 dead-ends after classification and re-probe those pieces specifically.

If this is fixed, expect it to close **both** the glyph throws and the parked comb class —
they share the mechanism.

---

## 7. Known open items beyond the pinch bug

From the ledger's parked list (all recorded with measurements):

- **Perf (R3).** `_windingAt` is O(all tessellated edges) per piece and `projectToRing` is
  O(ring) per piece, so the resolver is O(pieces × edges). 4→100 squares measured 8→56 ms
  round. A full text line with hundreds of counters has not been profiled. This is W9's
  perf gate and was never run.
- **`CLUSTER_TOL = 5e-3` mm is absolute (R4).** At the 0.1–0.5 mm deltas text offsetting
  uses, that is 1–5% of delta, and the endpoint-snap deviation on trimmed arcs reaches
  `2 × CLUSTER_TOL`. Pre-existing but production-visible once wired.
- **The polyline fallback rungs cost the result its arcs.** Verified: one case returned 0
  arcs / 179 line segments where the raw offset carried 2 arcs. Arc preservation is this
  branch's headline STEP-fidelity property; the loss is documented in a source comment but
  belongs in `docs/KERNEL-CONTRACT.md`.
- **The `clusterTol` rungs can return one region fewer than truth** at a sever threshold
  (6 of 19,200 cases). `clusterTol × 20 = 0.1 mm` also sits above the 0.05 mm feature floor
  that `CLUSTER_TOL`'s own derivation says it must stay well below.
- **`reversePieceSegs` and `_chain`'s reverse branch are unreachable** under the positive
  rule and untested. Fine while `_chain` is a general primitive; don't assume covered.
- `test/offset-oracle-manifold.test.js:436` asserts `toHaveLength(3)` on a comb that the
  oracle counts at 4; the 3 is a fallback artifact (a dropped ~0.007 mm² sliver).

---

## 8. Recommended paths

**A — Fix the pinch bug and finish this branch (recommended).** It is specific, diagnosed,
localized to `_classify`, and has a reproducible fixture at both the glyph and comb scale.
Everything else on the branch is verified against independent oracles. After the fix,
re-run §5's repro and `npm run offset-rates`, then complete W9 (perf gate, doc updates,
version bump to 0.60.0).

**B — Abandon the branch; fix 0.59.0's text bug narrowly.** The original alternative was a
targeted erosion test in the boolean cleanup to stop counters collapsing. Smaller and less
ambitious, but it addressed the reported symptom directly. Note this leaves the T-slot
silent material loss (§4) and the concaveV/thinNeck errors unfixed.

**C — Revert `Shape2D.offset` to the Clipper2 route.** Correct on every case measured here,
but gives up curve preservation (STEP fidelity), which is why #128 was written.

Do **not** ship the branch under any version number as it stands.

---

## 9. Orientation for whoever picks this up

Read in this order:

1. This document.
2. `.superpowers/sdd/2026-08-15-offset-winding-resolver/progress.md` — the 18 rulings.
   Several document ways the *design* was wrong; re-deriving them costs days.
3. `docs/superpowers/specs/2026-08-15-offset-winding-resolver-design.md` — amended twice;
   the second amendment (commit `25be4fa`) is the positive-winding correction.
4. `src/framework/geometry/contour-winding.js` — the resolver.
5. `src/framework/geometry/contour-offset.js:516-660` — the orchestrator and fallback
   ladder.

Repo rules that bite here:
- **Node 24 required.** `source ~/.nvm/nvm.sh && nvm use` before any npm/npx command.
- `contour-winding.js` and everything in the worker graph must stay DOM-free, `three`-free
  and `node:`-free. `npx vitest run test/worker-layering.test.js` enforces it.
- OCCT and Manifold must not boot in the same process — keep OCCT tests in their own files.
- On any confusing failure, grep `docs/ERROR-PATTERNS.md` first.
- Never re-baseline a moved expectation on faith. Every re-baseline on this branch was
  justified against an independent oracle; that standard is why the branch's real defects
  were found at all.
