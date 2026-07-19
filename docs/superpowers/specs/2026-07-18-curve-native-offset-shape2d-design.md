# Curve-native offset — `Shape2D.offset` — design

Date: 2026-07-18
Status: approved design, pre-implementation
Branch: shape2d-offset (stacked on shape2d-booleans / F2, which is unmerged PR #52;
rebase onto main once F2 lands)

## Problem

partforge has a pure-JS `offsetPolygon` helper (v0.15.0) that grows/insets a
**point-list** profile — great for `derive()`/main-thread clearance math (planter
uses it with no kernel boot). But it flattens curves and is hand-rolled. With F2's
`Shape2D` value in place, an offset that (a) preserves curves exactly on the
OCCT/STEP path, (b) uses each backend's robust native offset, and (c) composes
with 2-D booleans, is a natural one-method addition.

This is **F3** of the curve-native 2-D thread: F1 (curve profiles, 0.17.0), F2
(2-D booleans / `Shape2D`, PR #52), F3 (this — curve-native offset). It builds
directly on F2.

## Key finding

**Both backends have a native 2-D offset with a full round/chamfer/sharp corner
vocabulary** — no dependency, no gap, and it maps cleanly onto `offsetPolygon`'s
existing style names:

- **Manifold `CrossSection.offset(delta, joinType, miterLimit, circularSegments)`**
  — `joinType` ∈ `Round` | `Square` | `Miter` (Clipper2), `circularSegments` sets
  round-corner facets.
- **replicad `Drawing.offset(distance, { lineJoinType })`** — `lineJoinType` ∈
  `"round"` | `"bevel"` | `"miter"`. Curve-preserving.

## Decisions already made (with Scott)

- **F3 is one new `Shape2D` method** — `.offset(delta, opts)` → `Shape2D` — using
  each backend's **native** offset (not the flatten-then-`offsetPolygon` path the
  pre-F2 backlog note assumed; that predates F2 and the native-offset finding).
  Mirrors F2's boolean methods exactly.
- **The pure `offsetPolygon` helper is untouched** — it stays as the polyline,
  derive()/main-thread tool. F3 only *adds* the kernel-value method. Two distinct
  tools; the "keep the pure helper" subtlety is satisfied by not touching it.
- **Corner styles reuse `offsetPolygon`'s `"round" | "chamfer" | "sharp"`**, mapped
  to native join types (both backends support all three).
- **Caching mirrors F2** (content-hash on Manifold, plain-wrap+clone on OCCT).

## API

```js
const clearance = k.shape2d(boreProfile).offset(0.2);   // 0.2 mm looser (round)
const wall      = k.shape2d(outerProfile).offset(-3);   // 3 mm inset
k.extrude({ profile: clearance, h: 5 });                // composes with extrude/revolve/booleans
```

- **`Shape2D.offset(delta, { corners = "round", segs? }) → Shape2D`.**
- Positive `delta` grows, negative insets — same sign convention as `offsetPolygon`.
- Corner-style mapping (both backends support all three):

  | `corners` | Manifold `JoinType` | OCCT `lineJoinType` |
  |-----------|--------------------|--------------------|
  | `round` (default) | `Round` (+ `circularSegments = segs`) | `round` |
  | `chamfer` | `Square` | `bevel` |
  | `sharp` | `Miter` (+ miter limit) | `miter` |

- **`segs`** affects only Manifold's round-corner faceting (OCCT round is exact);
  defaults to the kernel mesh LOD, overridable — same as `offsetPolygon`.

## Backend representation & caching

Reuses F2's `Shape2D` machinery entirely:

- **Manifold:** `offset` routes through the content-hash cache —
  `cachedCS(h("offset2d", hash, delta, corners, segs), () => T(cs.offset(delta, joinType, miterLimit, segs)))`.
  Every `CrossSection` `T()`-tracked and cache-`dispose`d.
- **OCCT:** plain-wrap; `wrapShape2d(drawing.clone().offset(delta, { lineJoinType }))`
  (`.clone()` — replicad offset consumes its operand). No cache (matches OCCT `Solid`/`Shape2D`).
- Hash folds the operand by `_hash` plus `delta`, `corners`, `segs`.

## Curves (the payoff)

- **OCCT:** offsetting a curved `Drawing` (from an F1 `pathProfile`/`roundedProfile`
  operand, or a booleaned `Shape2D`) keeps true curves → exact STEP `B_SPLINE`.
- **Manifold:** offsets the faceted `CrossSection` at mesh LOD.

## Validation & errors

- `delta` must be a finite number; `corners` must be `"round" | "chamfer" |
  "sharp"` — reuse `offsetPolygon`'s exact message wording for the corner error.
- **Collapse throws immediately.** An inset (or otherwise) that offsets the shape
  away to nothing throws a clear, greppable error at the `.offset()` call —
  `Shape2D.offset: offset collapses the shape (reduce |delta|)` — rather than
  returning an empty `Shape2D` that fails later. Rationale (Scott): an
  agent/LLM debugging a build gets the cause at the offending call, not a
  downstream "empty shape" symptom. Detection of the empty native result:
  - **Manifold:** after `cs.offset(...)`, `result.numContour() === 0` (or
    `area() === 0`) → throw.
  - **OCCT:** after `drawing.offset(...)`, detect the empty `Drawing` and throw.
    **Verify at impl time** what replicad returns for a collapsing offset — an
    empty `Drawing` (`blueprints.length === 0` / null `innerShape`), a throw, or
    a degenerate shape — and gate on whichever it is. This is the one integration
    unknown; the implementer confirms it against a real collapse fixture.
- Loud, greppable messages; add an ERROR-PATTERNS entry for the new
  `Shape2D.offset: offset collapses the shape` literal (the corner-style error
  reuses `offsetPolygon`'s existing entry).

## Lint / surface

- `"offset"` added to `SHAPE2D_OPS` (kernel.js) and named in `KERNEL-CONTRACT.md`
  (the Shape2D public-surface lint + the "names every op" lint require both).
- No new kernel op; no standalone `k.offset2d(...)` (redundant with
  `k.shape2d(p).offset(d)`).

## Testing

**Manifold integration (`bootManifoldKernel`, own file, no OCCT co-boot):**
- offset a square by +1 (round) → area = 100 + perimeter·1 + round-corner area;
  by −1 → shrinks;
- `round` vs `chamfer` vs `sharp` give different convex-corner areas (round >
  chamfer, sharp ≥ round at right-angle corners);
- offset a `circleProfile` by +d → area ≈ π(r+d)²;
- inset-to-empty (e.g. a 10 mm square offset by −6) → `.offset()` throws
  `Shape2D.offset: offset collapses the shape`;
- cache hit on a repeated offset (stats).

**OCCT integration (`bootOcctKernel`, own file, no Manifold co-boot):**
- offset → `extrude` → volume within tolerance of Manifold;
- curve operand: offset a cubic-circle `Shape2D` → STEP contains `B_SPLINE`;
- corner styles produce valid solids.

**Pure unit tests (no WASM):**
- `h("offset2d", …)` composition stable / operand- & param-sensitive;
- corner-style + non-finite-`delta` validation throw the expected literals.

**Cross-backend parity:** an offset+extrude volume pin close across backends
(tolerance — parity-relevant op, like F2).

## Out of scope (explicitly)

- Any change to the pure `offsetPolygon` helper (stays the derive()/polyline tool).
- A standalone kernel `offset2d` op.
- Variable-distance / per-edge offsets.
- Open-path (non-closed) offsetting.
