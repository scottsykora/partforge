# Near-miss gap detection between sub-parts (issue #29)

**Goal:** catch the best-documented blind spot in LLM-CAD verification — sub-parts
that *should* touch but are separated by a small unintended gap (a failed union, a
boss that misses its plate). partforge today checks only the opposite failure
(`assemblyOverlaps` flags interpenetration > 1 mm³); two sub-parts 0.2 mm apart sail
through `measure.ok`. Grounded in the research survey
(`docs/research/llm-cad-generation-strategies.md`): a benchmark quadcopter frame
passed every numeric and VLM-render check while its arms didn't meet the hub
(arXiv 2603.26512) — fixed renders can't resolve sub-mm joint gaps and
volume/bbox/watertight metrics don't see them at all.

**Scope decisions (user-approved):**

- **Exact dual-BVH distance query**, not the sampled first cut the issue allows.
  Simultaneous traversal of two triangle BVHs pruned by node-bbox distance, exact
  triangle–triangle distance at leaf pairs. Exact at any tessellation; reuses the
  existing `closestOnTri` (Ericson) and the BVH design's anticipated extension
  point (`bvh.js` was explicitly built as "the reusable primitive for the deferred
  clearance gate").
- Near misses are **reported, not gated by default** — touching-vs-clearance intent
  is part-specific. Gating is opt-in via `verify.expect._view.contacts` /
  `.clearance`; unlisted near-miss pairs become verify **warnings**.
- Mesh-based only (no kernel booleans) — runs identically on Manifold and OCCT.
- Out of scope (follow-up): wiring `profile.clearance` (carried in
  `dfm-profiles.js` "for a future gap check") into the default threshold; that
  stays unenforced for now.

## 1. Distance primitive — `src/testing/bvh.js`

`buildBVH(mesh)` gains one method alongside `raycast`/`closestPoint`:

```
bvh.distanceTo(otherBvh) → { distance, at: [x,y,z], pointA: [x,y,z], pointB: [x,y,z] }
```

- **Dual traversal:** a stack of node pairs, pruned by AABB–AABB squared distance
  against the best-so-far (`aabbDistSq` — per-axis gap, 0 when boxes overlap).
  Descend the larger node; at leaf×leaf compute exact triangle–triangle distance.
- **Triangle–triangle distance:** min over the 6 vertex-to-other-triangle queries
  (existing `closestOnTri`) and the 9 edge–edge segment distances (new
  `closestSegSeg`, standard clamped closest-point-between-segments). This covers
  all closest-feature configurations exactly. Intersecting triangles read ~0 via
  these feature distances; an exact intersection test is not needed at the 0.5 mm
  threshold scale.
- `at` is the midpoint of the two closest points (`pointA` on this mesh, `pointB`
  on the other) — the report's `location` convention from the structured
  diagnostics contract (#32).
- **Early exit** when `distance` reaches 0 (touching/intersecting) — overlapping
  pairs cost little.
- Internals needed across the two trees (root node, triangle list) are exposed on
  the returned object as an underscore-prefixed field (e.g. `_root`) — internal to
  `src/testing`, not documented API.

## 2. Gap check — `src/testing/gaps.js`

Two layers, so `measure` doesn't rebuild geometry it already has:

```js
// Core: posed sub-part meshes → all pair distances.
meshGaps(built /* [{name, mesh}] */) → [{ a, b, distance, at }]   // every pair, sorted a<b by view order

// Wrapper mirroring assemblyOverlaps' signature and posing path (buildView →
// display pose), for standalone use:
assemblyGaps(kernel, part, view, params, { threshold = 0.5 } = {})
  → [{ a, b, distance, at }]   // only pairs with 0 < distance < threshold
```

- `meshGaps` builds one BVH per sub-part mesh and runs `distanceTo` on each pair
  (N is small — views have 2–6 sub-parts). Distance 0 = touching or
  interpenetrating; callers filter.
- `assemblyGaps` calls `buildView` (same posing as `assemblyOverlaps`), runs
  `meshGaps`, filters to `0 < distance < threshold`, and calls `kernel.cleanup?.()`.
- Exported from `src/testing.js` alongside `measure`/`verify`.

## 3. `measure` report additions — `src/testing/measure.js`

Two new fields next to `overlaps` (default threshold 0.5 mm, override via
`opts.gapThreshold`):

```js
{
  ...,
  overlaps:   [...],                       // unchanged
  gaps:       [{ a, b, distance, at }],    // ALL sub-part pairs (0 = contact/overlap)
  nearMisses: [{ a, b, distance, at }],    // 0 < distance < threshold, minus pairs in overlaps
  ok: ...,                                 // UNCHANGED — near misses do not affect ok
}
```

- `gaps` is the raw fact table verify gates read (a clearance pair 5 mm apart has
  no near-miss entry but still needs its measured distance). `nearMisses` is the
  filtered "did you mean these to touch?" signal the issue asks for.
- Computed from the meshes `buildView` already produced (via `meshGaps`) — no
  second build, no kernel dependency, so it runs on OCCT too (where `overlaps` is
  skipped).
- Pairs whose surfaces read distance 0 but which appear in `overlaps` are excluded
  from `nearMisses` by name-pair, not by distance (a fully-contained sub-part
  overlaps with surface distance > 0; the overlap check already owns that case).
- CLI `printMeasure` prints a `near-misses:` line next to `overlaps:` using the
  same `a×b (…mm at [x, y, z])` formatting. The JSON report (`--json`/`--out`)
  carries both fields automatically.
- Single-sub-part views: both arrays empty — no noise on demo/planter.

## 4. Verify gates — `src/testing/verify.js`

Two new **view-level** expectation keys, handled as special cases in
`evaluateCase` before the generic metric loop (they're per-pair, so they don't fit
the scalar `VIEW_METRICS` registry):

```js
verify: {
  expect: {
    _view: {
      contacts:  [["drum", "flange"]],      // gate: pair must touch (distance 0 or overlap)
      clearance: { "lid×body": ">=0.3" },   // gate: assertion DSL vs measured distance
    },
  },
}
```

- **`contacts`** — array of `[a, b]` pairs, order-insensitive. Looks up the pair in
  `facts.gaps`; fails (gate) when `distance > 0`. Check object:
  `{ scope:"view", metric:"contact", subpart:"a×b", kind:"gate", expr:"0",
  actual:<distance>, location:<at>, hint, pattern }`. Hint: "the faces should meet
  but are <d> mm apart — increase the joining feature's size or move the mating
  datum so the surfaces touch". A pair listed in `contacts` that also appears in
  `overlaps` **passes** (interpenetration is contact; the separate `overlaps` gate
  owns excessive interpenetration). Unknown sub-part name → throw (typo guard,
  matching the unknown-metric behavior).
- **`clearance`** — object keyed `"a×b"` (order-insensitive match; `×` is the
  house pair separator already used by `printMeasure` and the overlaps report),
  value = existing assertion DSL expression, evaluated against the pair's measured
  `distance` from `facts.gaps`. Kind: gate. `{ expr, hint }` object form supported
  like every other expectation. Hint default: "the pair's free-fit gap is out of
  the declared range — adjust the mating dimensions or the declared clearance".
- **Warnings for the undeclared:** every `facts.nearMisses` pair *not* named in
  `contacts` or `clearance` yields a `kind:"warn"` check
  (`metric:"nearMiss"`, `status:"warn"`) with the pair, distance, `location`, and
  hint "sub-parts nearly touch here — if they should meet, declare the pair in
  verify.expect._view.contacts and fix the gap; if a free fit is intended, declare
  it in clearance". Loud but non-blocking; disappears once the author declares
  intent either way.
- All check objects follow the #32 structured-diagnostics contract
  (status/hint/location/pattern), so `failures[]`/`warnings[]`, the CLI verify
  printer, and `--json` pick them up with no extra wiring.

## 5. Error pattern

New `ERROR-PATTERNS.md` entry `near-miss-gap` (symptom: a verify `contact` failure
/ near-miss warning; cause: failed union or mis-placed mating feature; fix:
increase the joining feature's dimension or fix the datum math in `derive()`), and
the `contact`/`nearMiss` checks carry `pattern: "near-miss-gap"`.

## 6. Tests

- **`test/bvh.test.js` additions** — `distanceTo`: two axis-aligned boxes 0.2 mm
  apart (distance ≈ 0.2, `at` between the facing faces); edge–edge closest
  configuration (crossed perpendicular edges — exercises `closestSegSeg`);
  touching boxes (0); interpenetrating boxes (0); brute-force all-pairs reference
  check on small meshes; works on indexed (OCCT-form) meshes.
- **New fixture `test/fixtures/gap-part.js`** — two boxes in one view, gap set by
  a `gap` parameter (0.2 default); a `contacts` variant and a `clearance` variant
  via `verify.expect` in test-local part clones.
- **`test/gaps.test.js`** — acceptance list: `assemblyGaps`/`measure.nearMisses`
  report the pair at ≈ 0.2 with a sensible `at`; gap = 5 → clean; gap = 0 (touch)
  → clean; overlap → in `overlaps`, not `nearMisses`.
- **`test/verify.test.js` additions** — `contacts` on a gapped pair → gate failure
  with distance/location/hint/pattern; on a touching pair → pass; `clearance`
  `">=0.3"` passes at 5 mm, fails at 0.2 mm; undeclared near miss → warning that
  clears when declared either way; unknown name in `contacts` → throw.
- **OCCT:** one case in `measure-occt.test.js` (own file — OCCT/Manifold must not
  share a process) proving `gaps`/`nearMisses` populate without `Solid.intersect`.
- **No-noise regression:** planter + demo `measure` reports have empty
  `nearMisses` (extends existing measure tests).

## 7. Documentation

`docs/AUTHORING-PARTS.md` verify section: document `contacts` / `clearance` /
near-miss warnings with the drum + flange example from the issue (flange floating
0.3 mm off the drum body → warning by default, gate once declared). Update the
`measure` report shape listing (`gaps`, `nearMisses`) and the CLI output example.
