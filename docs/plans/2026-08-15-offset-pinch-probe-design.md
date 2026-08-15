# Adaptive winding probes at offset pinch points

**Date:** 2026-08-15
**Status:** Approved
**Branch:** `claude/offset-winding-resolver`

## Problem

The winding resolver classifies each split offset-boundary piece by probing a fixed
distance to its left. At a narrow pinch, that probe can cross a nearby boundary and land
in the wrong winding cell. Both real departures from the pinch are then classified as
outside-to-negative (`wLeft = 0`, `wRight = -1`) and dropped. The remaining kept pieces
dead-end during chaining.

This produces both hard and silent failures:

- the four-notch comb at delta `-2.4975` throws for round and chamfer corners;
- `"Scott"` at large positive deltas throws after every fallback rung;
- other glyph cases return geometry with incorrect component or counter topology without
  throwing.

The fallback ladder cannot fix the problem because every rung repeats the same
misclassification. The fix belongs in `_classify`, before chaining.

## Decision

Choose a winding-probe location and distance from the local geometric clearance around
the piece. Do not repair the graph after classification and do not choose a probe because
its answer happens to make chaining succeed.

For each non-degenerate, non-duplicate piece:

1. Generate a small fixed set of interior locator points along the piece, including its
   midpoint.
2. Project each locator onto the source ring tessellation used by `_windingAt`, preserving
   the existing invariant that the probe is anchored to the queried geometry.
3. Measure the distance from that projected point to every non-incident edge in the full
   tessellated arrangement.
4. Select the candidate with the largest clearance. This moves the query away from a
   contested midpoint when another part of the arrangement crowds it.
5. Set the probe distance to the minimum of `PROBE_EPS`, the existing piece-length cap,
   and a conservative fraction of the measured clearance.
6. Perform the existing single left-side winding query and derive the right side from the
   coincident-edge multiplicity exactly as today.

Candidate selection and probe distance are therefore functions only of geometry. The
classifier does not retry until it gets `keep: true`, inspect `_chain`, or use oracle
answers at runtime.

## Alternatives rejected

### Re-probe only after a chaining dead end

This is smaller but treats the throw rather than the classification error. It cannot fix
silent topology defects where the remaining pieces still form closed, wrong rings.

### Repair degree-imbalanced vertices after classification

Forcing edges back into the kept graph makes the graph close but does not establish which
adjacent face satisfies positive winding. It can manufacture material in collapsed holes
or preserve a boundary that should disappear.

### Build and label a complete DCEL face arrangement

This is the most general solution, but it replaces rather than repairs the existing
resolver. It substantially increases implementation scope, performance risk, and the
surface requiring new oracle coverage. It remains a future option if adaptive probing
cannot classify the committed failure corpus without heuristics.

## Correctness constraints

- Positive winding remains the offset fill rule: `inside(w) = w >= 1`.
- Coincident spans still use `_coincidence`'s net multiplicity.
- Every winding decision uses one measured side and one arithmetically derived side.
- Probe selection cannot depend on a desired topology, oracle result, or successful chain.
- Curve-native output, crossing clustering, splitting, and tangent-based chaining remain
  unchanged unless evidence identifies a separate defect.
- A numerically unusable piece is dropped explicitly; the classifier must not fabricate a
  winding pair.

## Testing strategy

Work test-first in increasing scope:

1. Add a low-level regression that exposes the two misclassified departures at the comb
   pinch and proves the current fixed probe drops them.
2. Convert the comb's parked round/chamfer throw assertions to correct topology and area
   assertions against the existing independent oracle.
3. Convert the glyph matrix from pinned throws/divergences to topology and area agreement,
   including `"Scott"` at `0.8`, `1.0`, `1.5`, `2.0`, and `3.0`.
4. Run the resolver unit tests, offset tests, Manifold oracle tests, worker-layering test,
   and full suite.
5. Run `npm run offset-rates` and compare all 36,090 committed cases. Any new throw,
   topology loss, or material divergence is a blocker rather than a re-baseline.
6. Measure the 24-glyph cleanup benchmark. The resolver must remain within the design's
   approximately 1.5x performance budget.

If the adaptive probe fixes throws but leaves silent glyph topology errors, stop and
investigate those arrangements separately. Do not broaden the classifier until evidence
shows they share the same root cause.

## Release boundary

The branch remains unshippable until the original `"Scott"` report, the glyph corpus, the
parked pinch fixtures, the full test suite, the committed offset corpus, and the
performance gate all pass. Only then may the documentation be updated and the package
version bumped to `0.60.0`.

## Amendment: source-hole inradius gate

The adaptive probe fixes the diagnosed pinch dead ends and makes the resolver agree with
the positive winding fill of its raw input. Glyph measurement after that fix exposed a
separate upstream defect: at large round dilations, the raw offset of a fully eroded
counter can itself retain a genuine negative-winding pocket. Clipper2 positive-filling
the native raw outline reproduces the same residual holes (`o`: 0.291 mm², `e`: 1.992
mm², `p`: 0.318 mm²), proving that no classifier or chaining change can remove them
honestly.

The source contour supplies the missing fact. A hole survives positive round material
dilation by `delta` exactly when the source hole contains a disk of radius `delta`.
Measured source inradii separate the target cases cleanly: `o` ≈ 2.109 mm, `e` ≈ 1.064
mm, `p` ≈ 1.865 mm. Thus `o` survives at +2 and vanishes at +3, while `e` and `p` have
already collapsed by +2.

Before generating a raw offset for a source hole under `delta > 0` and round corners:

1. Tessellate the source hole using the same deterministic contour sampler used elsewhere
   in the geometry worker.
2. Run a branch-and-bound largest-inscribed-disk decision over its bounding box. Each cell
   stores signed distance at its center and an upper bound obtained from the distance
   function's 1-Lipschitz property.
3. Return "survives" immediately when a sampled interior point clears the requested radius.
4. Return "collapsed" only when every remaining cell's upper bound proves that no point can
   clear `delta` within the geometry tolerance.
5. Conservatively keep the hole when the decision lies within the tolerance band.

This is not the removed Part-2 distance prune. That prune judged a tangled *raw output
boundary* and deleted 36 of 76 valid counters because a raw self-overlap can legitimately
approach another branch of its own source. The new gate asks the source-domain erosion
question directly and runs before raw offset construction.

Initial scope is `delta > 0` with `corners: "round"`. Sharp and chamfer use different
structuring elements, so applying a Euclidean disk criterion to them would be an unjustified
semantic expansion. Negative offsets grow holes and cannot collapse them.

Required regressions:

- `o` keeps its counter at +2 and loses it at +3;
- `e`, `a`, and `p` lose counters only after their measured inradius threshold;
- `"Scott"` at +3 returns one region and zero holes;
- the existing Roboto `P` +0.3, cubic-circle +0.2, and rounded-rectangle +2 counters survive;
- a near-threshold analytic circle is kept conservatively rather than silently dropped;
- worker layering and the committed corpus remain green.
