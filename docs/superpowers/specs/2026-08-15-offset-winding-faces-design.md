# Winding resolver, face-labeled — design

**Date:** 2026-08-15
**Status:** Approved design, pre-implementation
**Owner:** Scott Sykora
**Supersedes (as an implementation):** the probe-based resolver on branch
`claude/offset-winding-resolver` (43 commits, not shipped — see
`docs/superpowers/handoffs/2026-08-15-offset-winding-resolver-handoff.md`).
This is a clean rewrite off `origin/main` (`f3ce357` = shipped 0.59.0) that keeps that
branch's verified components and replaces its classification core.

## What is kept from the prior branch, verbatim or near-verbatim

Every item below was independently verified during that branch's review (ledger:
`.superpowers/sdd/2026-08-15-offset-winding-resolver/progress.md`, 18 rulings). None of it
is re-derived here; it is ported.

1. **Fill rule: POSITIVE winding (w ≥ 1), not non-zero** (Ruling 6). Clipper2's
   `ClipperOffset` uses `FillRule::Positive`; a negative-winding face in offset output is
   by definition collapsed material.
2. **`ringCrossings` + `irTime`** (paper-bridge.js): paper's fat-line clipper finds
   crossings; the IR parameter is recovered from the intersection *point* — linear in
   position for a line, linear in *angle* for an arc, paper's time for a cubic (Rulings
   10–11, exact to ~2e-16). Self-intersections push both `loc` and `loc.intersection`
   (Ruling 2).
3. **`trimSegment` / `segTangent` exports** (contour-ops.js). Arc tangents recovered from
   the center, exact at both ends (Ruling 5).
4. **`_mergeCrossings`** — fixed-anchor clustering, `CLUSTER_TOL = 5e-3` mm, cluster
   diameter bounded at 2·tol, centroid-settled pool.
5. **`_splitRings`** — sort by (seg, t), drop same-position duplicate records (a point
   shared by 3+ rings arrives once per ring PAIR — Ruling 9), materialize trimmed pieces
   immediately, snap endpoints to pool vertices, throw on implicit ring closure and on a
   degenerate run between distinct vertices.
6. **`_coincidence`** — where k directed edges lie on one span the winding jumps by their
   NET count (Ruling 8); representatives carry `mult`, copies are `duplicate`.
7. **`_chain`** — join by pool-vertex identity, leftmost turn (smallest positive rotation
   from the reversed inbound direction) using exact tangents (Rulings 4–5), loud throw
   (`CHAIN_INCOMPLETE_MESSAGE`) on an unclosable arrangement.
8. **Orchestrator changes in contour-offset.js**: the overlap-side trim gated on the
   crossing being in-extent of both raw segments (Ruling 13 / Task 7B — ungated trim
   fabricates ~30 % extra area on ordinary reflex geometry); `segsIntersect` counting
   endpoint-incident crossings plus `dedupeRing` (Ruling 15 / Task 7C — a ring crossing
   itself AT its own vertex previously took the fast path and silently lost a third of a
   T-slot part); `rawOffset` extraction; the fallback ladder with its rung order and the
   `_rawOffset` / `_offsetNoFallback` / `_ladderRungs` instrumentation hooks.
9. **Test infrastructure**: the Minkowski dilate/erode oracle
   (`test/helpers/minkowski-oracle.js` — Clipper2 used only as a polygon-set assembler,
   never its offsetter), the committed seeded corpus (`test/helpers/offset-corpus.js`),
   the rate sweep (`scripts/offset-rates.mjs`, `npm run offset-rates`), the fuzz suite
   (`test/offset-fuzz.test.js`), and the oracle test expansions.
10. **Keep the throw over silent degradation** (Ruling 12 as amended by 16): the chain
    failure surfaces loudly, and the ladder retries numerically before it reaches the
    caller. All pinned `Shape2D.offset` error strings stay byte-identical.

## What is replaced, and why

The prior branch classified each piece **independently, with a geometric probe**: ray-cast
the winding number at a point offset `eps` off the piece's midpoint, derive the far side
arithmetically. Three review rounds hardened the probe (anchor to the queried tessellation,
length-proportional eps, coincidence multiplicity) and it still regressed the reported
case: at a pinch vertex two departing pieces both probe `wLeft = 0, wRight = −1`, neither
straddles the positive rule, both are dropped, and `_chain` dead-ends —
`"Scott" size 10 round` THROWS at deltas 0.8 / 1.5 / 2.0 / 3.0, where even shipped 0.59.0
returned (topologically wrong) geometry and pre-0.59.0 Clipper2 was exact. The dead-end is
a property of the probe, not of numerical noise: no perturbation rung of the fallback
ladder reaches it.

The root problem is architectural: N independent geometric probes can be *individually*
plausible and *mutually* inconsistent, and an inconsistent keep-set has no valid chaining.

### The replacement: label faces, not pieces

Classify by building the **planar arrangement face structure** and propagating winding
combinatorially — the standard robust construction for map booleans:

1. **Half-edges.** Every non-duplicate crossed piece is one arrangement edge with a
   forward and a backward half-edge. At each pool vertex, order departures by their exact
   outgoing tangent angle (from the *source curve* at the crossing parameter, captured in
   `_splitRings` — exact regardless of how short the trimmed piece is), tie-broken by
   signed curvature (an edge curving harder left is infinitesimally more CCW).
2. **Faces.** `next(h)` = the departure with the smallest positive rotation from the
   reversed inbound direction — the same leftmost-turn rule `_chain` already uses, which
   was adversarially verified — with the literal twin ranked last (turn 2π), the standard
   DCEL convention. Orbits of `next` partition the half-edges into face boundary cycles,
   interior on the left.
3. **Anchor.** Per graph-connected component: the face just below the component's
   bottom-most tessellated point is its local exterior (nothing of the component lies
   below it). Its winding contribution from the component itself is 0 **by topology, not
   by measurement**; its total winding is one ray cast against the *other* components'
   rings only (`ambient`). If the bottom-most point is interior to a piece, the anchor
   half-edge is the one whose travel at that point runs in −x (left side faces down); if
   it is a pool vertex, it is the left face of the departure with the largest angle in
   [0, π].
4. **Propagate.** BFS across edges: crossing a directed edge from its left face to its
   right face subtracts the edge's net multiplicity (`mult`, Ruling 8's identity, now by
   construction). A label conflict means the intersection set was incomplete or
   inconsistent (paper's documented 40-level/4096-call bail) → throw
   `CHAIN_INCOMPLETE_MESSAGE` — a sharper, earlier detector than an unconsumed piece.
5. **Classify.** Keep a piece iff `inside(wLeft) !== inside(wRight)` with
   `inside = (w) => w >= 1`; reverse is provably unreachable under the positive rule
   (mult ≥ 0 ⇒ wRight ≤ wLeft). Uncrossed whole rings shortcut: `wLeft = ambient +
   (ccw ? 1 : 0)`, `wRight = wLeft − 1`, ambient by the same bottom-point rule.
6. **Chain and emit** exactly as before (`_chain`, then area-filter, `assembleRegions`,
   winding normalization). With a consistent keep-set a dead-end vertex cannot exist —
   the boundary of a union of faces is closed by construction — so `_chain`'s throw
   becomes defense in depth rather than a live failure mode.

### What this buys, concretely

- **The pinch class dies structurally.** There is no probe to land in the wrong cell; the
  two departing pieces at a pinch get labels from the same face graph as everything else.
  This is the diagnosed mechanism behind both the glyph throws and the parked comb class.
- **Consistency is checkable.** BFS conflicts convert "silently wrong arrangement" into a
  loud throw at the earliest possible stage.
- **The parked perf risk (R3) falls out.** Per-piece O(pieces × edges) ray casts become
  one ray cast per component plus an O(E log deg) graph pass.
- **PROBE_EPS scar tissue disappears.** `pieceMid`, `projectToRing`, probe anchoring
  (Ruling 3), length-proportional eps, `MIN_PIECE_LEN` — all deleted, along with their
  documented bounded imprecisions.

### Known residual approximations (stated, not hidden)

- **CLUSTER_TOL welding** is unchanged: crossings within 5e-3 mm merge, moving the emitted
  boundary by up to that radius, and the ladder's `clusterTol` rungs still trade topology
  for resolvability. Absolute-vs-delta concern (R4) remains open and documented.
- **Tangent-tie ordering** at exactly-tangent junctions is resolved to second order
  (curvature); higher-order contact (two curves agreeing in tangent *and* curvature)
  falls back to deterministic-but-arbitrary order. No known corpus case reaches this.
- **Ambient ray cast** can still be fooled if another component's boundary passes within
  float-noise of this component's bottom-most point — one well-conditioned cast per
  component instead of one forced cast per piece; strictly rarer, not impossible.
- The **fallback ladder is retained unchanged** as insurance; its rescue rates must be
  re-measured (expected to drop sharply — most rescued cases were probe misclassifications).

## Correctness targets

All prior targets stand (they are pinned in the ported tests), plus the ones the prior
branch failed, measured against Clipper2 / the Minkowski oracle / the closed forms:

| Case | Prior branch | Target |
|---|---|---|
| `"Scott"` size 10 round, deltas 0.2–3.0 | THROWS at 0.8/1.5/2.0/3.0; 3r/5h at 1.0 | no throw at any delta; topology matches Clipper2 (5r1h / 4r1h / 1r2h / 1r3h / 1r5h / 1r2h / 1r0h), area within 0.5 % |
| glyph corpus, 6 chars × 5 deltas, round | 20 agree / 9 throw / 1 diverge | 30 agree on topology+area, 0 throws |
| four-notch comb, −2.4975 round | chain throw (parked class 1) | 2 regions, area ≈ 91.745 |
| two-notch plate, −3.25 sharp & chamfer | chain throw, ladder does not rescue | exact (40.20778 / 45.20274) |
| T-slot block delta −2 (Ruling 15) | fixed on branch | stays fixed: 48 exactly, all widths 1–8 |
| concaveV erode 3 / thinNeck erode 3 | fixed on branch (26.729 / 94.407) | stays fixed |
| 240-case sweep vs 0.59.0 | 0 worse, 36 better, 12 throws resolved | no regression vs the branch's own results |
| merged-hole / breakthrough closed forms | 192.677 / 249.715 exact | stays exact |
| full existing suite (2365 tests at f3ce357) | — | green throughout |

Every re-baseline must be justified against an independent oracle (Minkowski, SDF-style
reasoning, or a closed form) — never on faith. Rates quoted in docs must come from
`npm run offset-rates` on the committed corpus (Ruling 18).

## Performance

Budget unchanged from the original spec: cleanup of the 24-glyph text case within ~1.5× of
0.59.0's timing (reference: ~85 ms end to end). Expected to land well under it. Measure
with the committed instrument and report actual numbers.

## Release

Ships as **0.60.0** — offset output changes materially. Bump `package.json` on this branch
as part of the PR; the publish workflow tags and publishes on merge. 0.59.0 is already
published and cannot be reused.
