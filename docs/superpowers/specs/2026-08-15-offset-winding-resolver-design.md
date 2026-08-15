# Winding-number resolver for contour offset — design

**Date:** 2026-08-15
**Status:** Approved design, pre-implementation
**Owner:** Scott Sykora
**Follows:** `2026-08-14-native-contour-offset-design.md` (shipped as 0.59.0)

## Motivation

0.59.0 replaced both kernels' offset routes with a native curve-native engine. It has
two paths: an exact **fast path** for offsets that validate clean, and a **cleanup path**
built on paper.js booleans for everything else. The fast path is correct. The cleanup
path is the weak link, and a user report made that concrete.

### The reported bug

Text `"Scott"` at size 10 offset outward:

| delta | native | correct (Clipper2) |
|---|---|---|
| 0.8 | 1 region, 2 holes | 1 region, 2 holes ✓ |
| 2.0 | 3 regions, 6 holes | 1 region, 2 holes |
| 3.0 | 2 regions, **12 holes** | 1 region, **0 holes** |

It is not a multi-glyph merging problem. Single glyphs fail alone: `"o"` at delta 3
yields 8 spurious holes, `"t"` breaks into 3 fragments. `"S"` and `"c"` are fine at
every delta tested — the difference is that they have no enclosed counter.

### Root cause

The failure is in the **counters** (holes). When an outward offset exceeds a counter's
half-width the counter should vanish. Nothing detects that it has:

- the offset counter's signed area decays toward zero but never flips sign
  (`"o"`: −19.242 → −0.222 at delta 2 → −0.129 at delta 3), so a sign test misses it;
- no piece reverses far enough to set `dirty`;
- the whole-ring collapse gate requires **every** piece to be a plain line, and a glyph
  counter is cubics — so that gate can never fire on text.

The result is a self-tangled near-zero-area ring that is unioned and subtracted from an
otherwise perfect outer, punching the spurious holes. Verified: resolving the outers
alone gives exactly 1 region and 0 holes.

Past collapse it gets worse rather than better — at delta 3 `"e"`'s counter contributes a
**3.05 mm²** spurious hole and `"a"`'s a **4.42 mm²** one. These are not hairline slivers.

### Why not a targeted fix

Measured and rejected during investigation:

- **Non-zero fill rule in the cleanup** — no effect; the outers already resolve fine.
- **Sign-flip detection** — never triggers (area stays negative throughout).
- **Thinness threshold** (`2·area / perimeter`) — does not separate. `"p"` at delta 2
  should survive at ratio 0.084 while `"e"` at delta 1.5 should vanish at ratio 0.095.
  Overlapping ranges, so any threshold misclassifies real counters.
- **Erosion test per hole** ("does a disk of radius delta still fit inside?") — correct
  for this case, but it treats one symptom and leaves the same class of bug elsewhere.

### The insight

The correct result of an offset is the **non-zero winding region of the raw offset
outline**. Every artifact observed — self-overlap loops, collapsed counters, unmerged
seams, pinched necks — is a place where the pipeline approximates that rule with
paper.js booleans instead of computing it. Applying the rule directly fixes them from
one mechanism instead of four special cases.

## Decisions (locked with owner)

1. **Replace the cleanup path entirely.** Winding resolution becomes the way tangled
   offsets are resolved. The exact fast path is untouched.
2. **Curve-native topology, curve-native output.** Find crossings with paper's existing
   fat-line Bézier clipper — recursive subdivision, exact `(curve, t)` on the original
   curves — and emit surviving pieces as the original arcs/cubics trimmed via
   `trimSegment`. Tessellation survives only as the ray-cast target for integer winding
   queries, where its precision is irrelevant.

   *(Amended after the initial design. The first version intersected a dense
   tessellation and carried provenance through the samples. Borrowing paper's clipper is
   strictly better: exact parameters, no density tolerance in the topology path, no
   snapping samples back onto curves, and no intersector to write. Paper's fragility in
   this engine was never in finding intersections — it is in the tracing and branch
   selection that follow, which is precisely what this resolver replaces.)*
3. **Ships as 0.60.0** — offset output changes materially; not a patch.

## Non-goals

- Changing the fast path, the per-segment offset math, or the join construction.
- Open-path / stroke offsetting.
- Replacing `booleanRegions` for the ordinary Shape2D boolean ops — this is the offset
  cleanup path only.

## Architecture

**New module: `src/framework/geometry/contour-winding.js`** — a pure leaf in the worker
graph (DOM-free, `three`-free, `node:`-free), exporting:

```js
resolveOffsetWinding(rawRings) -> regions
```

`rawRings` is the flat list of raw offset rings (outers and holes together). Holes keep
their stored CW winding — that is precisely what makes them subtract under the non-zero
rule, so no special-casing is needed for holes anywhere in the resolver.

### Pipeline

**1. Find intersections with paper's curve clipper.** Build each raw ring as a paper
path via the existing `toPaperPath(scope, contour, segMap)` and call `getIntersections()`
(self-intersections) and `getIntersections(other)` (between rings). Paper implements
fat-line Bézier clipping (Sederberg–Nishita) with convex-hull rejection — recursive
subdivision, capped at 40 levels / 4096 calls — which is the robust form of a bisection
search for crossings, and it returns exact `(curve index, t)` on the original curves.

This is deliberately *borrowing the half of paper.js that works*. Paper's weakness in
this engine has always been the tracing and branch-selection that follows intersection
finding, which is exactly what steps 3–6 replace. Verified on the pathological case (the
tangled `"o"` counter at delta 3): 56 self-intersections found, and `segMap` mapped every
one of the 137 paper curves back to its IR segment.

Two consequences, both simplifications over an intersect-by-tessellation approach:
there is **no tessellation-density tolerance** anywhere in the topology path, and the
`t` values feed `trimSegment` directly, so no sampled point ever has to be snapped back
onto a curve.

**2. Merge intersection clusters.** Near-tangency produces several intersections within
a few microns of each other — the same case measured at (0.9223, −0.9347),
(0.9224, −0.9337), (0.9222, −0.9343). Merge intersections closer than a clustering
tolerance into a **single shared vertex**, stored as an index into a point pool.
Chaining in step 5 then joins by vertex identity, never by coordinate comparison. This is
where the near-tangency risk now lives; the tolerance must be derived and documented, not
guessed.

**3. Split.** Cut every ring at its merged intersection parameters into elementary
pieces, each carrying its source segment and `[tStart, tEnd]` range.

**4. Classify per piece, with one probe.** Crossing a directed edge changes the winding
number by exactly ±1, so a second probe is unnecessary and actively harmful — two
independent probes can disagree (both reading "inside") when either lands badly. Instead:
take one probe point offset from the piece midpoint along its normal, compute the
**integer** winding number of the whole raw ring set there by ray casting, and derive the
other side arithmetically as ±1 by the piece's direction. Keep the piece iff exactly one
of the two sides is non-zero. The two sides are then consistent by construction.

Ray casting runs against a tessellation of the raw rings. Its precision does not matter
here and carries none of the risk it would in step 1: winding is an integer, and the
probe sits deliberately off the boundary, so a chord error orders of magnitude smaller
than the probe offset cannot change the count.

`ε`, the probe offset, must clear the clustering tolerance of step 2 and stay below the
thinnest feature worth keeping. Derive it from the clustering tolerance — a small
multiple — never as a bare constant, and document the derivation next to the code. For a
piece shorter than `2ε`, scale the probe distance to the piece length so short pieces at
a pinch are still classified.

**5. Chain.** Join kept pieces end-to-end at their shared intersection vertices into
closed rings. Junctions with more than two kept pieces (a pinch point) are resolved by
taking the most counter-clockwise turn, the standard planar-arrangement rule, so rings
come out simple.

**6. Emit curve-native.** Each kept piece maps back through its provenance to the source
segment and is trimmed with `trimSegment(from, seg, tStart, tEnd)` from `contour-ops.js`,
producing the exact original arc/cubic/line. Cleanup output therefore becomes *better*
than today, where paper.js degrades arcs to cubics.

**7. Nest.** Assemble outers and holes by containment and normalize winding, reusing
`assembleRegions` and the existing orientation logic.

### What this replaces

- `cleanupRegions` in `contour-offset.js` — deleted, calls `resolveOffsetWinding`.
- `splitAtDuplicateEdges` and `splitPinchedRegions` — deleted. Winding handles pinched
  necks natively; this is also expected to fix the late-found round/chamfer dumbbell
  defect that the duplicate-edge recovery never covered.
- `resolveSelfRegions` in `paper-bridge.js` — loses its only caller. Verify with a
  repo-wide grep and delete if genuinely orphaned. Note this does **not** remove paper.js
  from the offset path: `paper-bridge.js` instead gains a small intersection helper
  wrapping `toPaperPath` + `getIntersections`, returning `(segmentIndex, t)` pairs in IR
  terms via `segMap`. Paper keeps the job it does well and loses the one it does badly.
  `booleanRegions` stays (the ordinary
  Shape2D booleans still use it).

`offsetRegions`'s fast path, validation, and collapse throw are unchanged.

## Correctness targets

The definition of done. All comparisons against the Clipper2 oracle unless noted.

| Case | Current | Target |
|---|---|---|
| `"Scott"` delta 3 | 2 regions, 12 holes, 521.733 | 1 region, 0 holes, 522.349 |
| `"Scott"` deltas 0.2–2.0 | spurious holes from 0.8 up | matches oracle at every delta |
| glyph `"o"` delta 3 | 8 holes, 139.142 | 1 contour, 139.537 |
| glyph `"t"` delta 3 | 3 regions, 121.347 | 1 contour, 121.842 |
| glyphs `e`,`a`,`p` past collapse | 3.05 / 4.42 mm² spurious holes | counters gone |
| wide L-pocket, 5-unit arms, +3 | residual ~921.19 | 0 holes, 928.274 |
| merge (two 6×8 holes 3 mm apart, −2) | 348 ✓ (fixed in 0.59.0) | stays 348 |
| breakthrough (10×10 hole 2 mm from edge, −2) | 408 ✓ (fixed in 0.59.0) | stays 408 |
| 9-gon chamfer −2.79 | ~7.71 | 2.76 |
| pinched dumbbell, round / chamfer | 97.258 / 96.000 | 72.354 / 74.000 |
| entire existing corpus | passing | unchanged |

The two `test.todo` entries and the "known divergences (parked)" characterization block
convert to correctness assertions as their cases are fixed. Any case that does **not**
reach its target is reported, not re-baselined.

`docs/KERNEL-CONTRACT.md`'s "Offset: known limitations" section is updated in the same
change: both currently-documented limitations name root causes this resolver removes
("only a *global* containment check catches this, and none currently runs";
"`resolveSelfRegions` doesn't fully untangle the self-intersections"). Each one is
deleted as its case reaches target, and the section as a whole goes if none remain.
Anything still unfixed stays documented, rewritten to name its real cause.

## Testing

- **Unit tests** for the resolver itself: intersection-cluster merging, piece
  classification on a hand-checkable figure-eight, chaining at a pinch junction, and a
  provenance round-trip (a trimmed arc comes back as an arc with the right endpoints,
  not a cubic). Also pin the one-probe rule directly: a piece's two sides must always
  differ by exactly 1, which is a cheap invariant to assert across the whole corpus.
- **Oracle corpus gains glyph cases** — their absence is the specific reason this bug
  shipped. Add single glyphs with counters (`o`, `e`, `a`, `p`) and a multi-glyph string,
  across deltas that bracket counter collapse.
- **Topology assertions, not just area.** The buggy text case sits within 0.1–0.3 % on
  area while being badly wrong topologically. Every oracle comparison must assert region
  and hole counts alongside area and Hausdorff distance.
- **Randomized fuzz vs Clipper2** across shape families (polygons, curved pockets, text,
  multi-region), comparing topology and area, with a fixed seed list so failures are
  reproducible.

## Performance

The resolver runs in the geometry worker on every parameter change, on the cleanup path
only. Current reference: 24-glyph text at +0.3 takes ~85 ms end to end; 200 disjoint
squares takes ~2 ms (post-AABB-prefilter).

Borrowing paper's clipper removes the need to write a spatial index for intersection
finding — its hull rejection already prunes non-crossing pairs, and pairing rings is
O(rings²) on a small count, not O(samples²). Two costs remain to watch:

- **Winding queries.** One ray cast per piece against the tessellated raw rings is
  O(pieces × segments), and the tangled `"o"` case alone yields 56 intersections on a
  137-segment ring. If measurement shows this dominating, index the ray-cast target by
  y-bucket; do not add the index speculatively.
- **Intersection count on text.** Many glyphs each self-intersecting is the realistic
  worst case, so the 24-glyph string is the benchmark, not a single letter.

Budget: cleanup of the 24-glyph text case must stay within ~1.5× of today's timing.
Measure before and after and report; a regression beyond that is a finding, not a
footnote.

## Risks

- **Near-tangent intersections** — two offset boundaries grazing rather than crossing.
  Still the classic hard case, but the risk has *moved*: it is no longer about
  tessellation density (there is none in the topology path now) but about the step-2
  clustering tolerance that merges near-coincident crossings into one vertex. Too tight
  and chaining sees degenerate slivers; too loose and genuinely distinct crossings get
  welded. Derive it, measure it against the glyph corpus, and state the derivation.
- **Paper's recursion caps.** `addCurveIntersections` bails at 40 levels of recursion or
  4096 calls and returns what it has. On pathological input that means *silently
  incomplete* intersection sets, which would corrupt the arrangement. Detect it — an
  unpaired or unconsumed piece during chaining is the signal — and throw rather than
  emit a wrong ring.
- **Chaining failures** — if pieces do not meet exactly, rings do not close. Mitigation:
  shared vertex identity through a point pool (never float comparison), plus an explicit
  assertion that every kept piece is consumed exactly once and every emitted ring closes.
  A chaining failure must throw loudly rather than emit a broken ring.
- **Performance** — see budget above.
- **Scope of change** — this is the engine's correctness core. It gets the full review
  treatment: per-task review plus a final whole-branch review, with the oracle corpus as
  the arbiter rather than hand-computed expectations.

## Release

Ships as **0.60.0**. Bump `package.json` on the feature branch as part of the PR — the
publish workflow tags and publishes on merge, and forgetting the bump is a silent no-op.
Note 0.59.0 is already published, so the version must exceed it.
