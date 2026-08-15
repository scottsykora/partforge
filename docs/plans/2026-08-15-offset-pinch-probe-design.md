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
