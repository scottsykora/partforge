# `measure()` — position facts + center of mass

Date: 2026-07-23. Status: design, pre-implementation.
Base: partforge 0.23.0 (`origin/main`); this ships as **0.24.0**.

## Motivation

`measure()` reports per-sub-part **size** (`bbox`) but no **position**: the axis-aligned
`bounds` `{min,max}` are computed (`measure.js`, kept in `subBounds`) yet never returned, and
there is no center of mass. Downstream, this blocks *functional* checks that depend on where
geometry sits, not just how big it is — e.g. "the part sits in the +octant", "this feature's
center of mass is low", "the assembly's mass is centered". The immediate driver is
partforge-cloud's planned single-part functional eval cases (center-of-mass over base,
span/placement checks), which read `measure()` facts directly; those facts don't exist today.
This change exposes them and adds matching `verify`/`expect` assertions.

## Goals

- Expose per-sub-part and aggregate **`bounds: {min,max}`** and **`centerOfMass`** from `measure()`.
- Add a backend-agnostic **`meshCentroid`** mesh utility (volume-weighted centroid).
- Add **`centerOfMass` / `boundsMin` / `boundsMax`** as componentwise-vector gate metrics to the
  `verify`/`expect` DSL, reusing the existing `bbox` vector machinery.
- Purely additive: no existing fact, metric, or behavior changes.

## Non-goals

- No new assertion syntax — the three new metrics reuse the existing `>=[x,y,z]` / `<=[x,y,z]`
  (with `*`-skip) vector form.
- No relative/derived predicates (e.g. a "CoM over its own base" stability gate). A static
  `verify` assertion compares a fact to fixed values, not to other facts; relative stability
  checks live in the consumer's own code (e.g. a cloud eval `fn(facts)`), not the DSL.
- No hole/feature **spacing** facts (holes are cuts, not sub-parts) — out of scope; bounds+CoM
  do not address it.
- No partforge-cloud changes — the cloud dep-floor bump and the new eval cases are a **separate
  follow-up** after this ships and publishes.

## Design

Three small, independent units. `measure.js` produces the facts; `mesh.js` owns the centroid
math; `verify.js` exposes the assertions.

### 1. New facts — `src/testing/measure.js`

Additive to the per-sub-part object and the aggregate. Existing `bbox` (size) is unchanged.

- **Per sub-part** (in the `subparts.map(...)` body, which already has `b = bounds(mesh.positions)`):
  - `bounds: { min: b.min, max: b.max }` — the already-computed axis-aligned bounds.
  - `centerOfMass: meshCentroid(mesh.positions, mesh.indices)` — `[x,y,z]`, or `null` when the
    mesh volume is ≈ 0 (degenerate).
- **Aggregate** (the `aggregate` object):
  - `bounds` — `{ min, max }` from the existing `unionBounds(subBounds)` (currently only its
    `size(...)` is used for `aggregate.bbox`).
  - `centerOfMass` — volume-weighted mean of the sub-parts' CoMs:
    `Σ(volᵢ · comᵢ) / Σ volᵢ`, skipping sub-parts whose `centerOfMass` is `null`; `null` when the
    total contributing volume is ≈ 0. Uses each sub-part's already-read `volume` (solid volume).

`bbox` (size) is retained on both sub-part and aggregate for backward compatibility; `bounds`
is the new positional companion.

### 2. `meshCentroid(positions, indices)` — `src/testing/mesh.js`

Mirrors the existing `meshVolume` tetrahedron/divergence loop (same `indices`-optional soup-vs-
indexed handling). Accumulates the **signed** volume `V` and the volume-weighted moment
`C += vᵢ · (a+b+c)/4` (tetrahedra from the origin; tet centroid is `(0+a+b+c)/4`). Returns
`[C₀/V, C₁/V, C₂/V]`, or `null` when `|V|` is below a small epsilon (e.g. `1e-9`). Signed `V`
(not `Math.abs`) is used so the sign cancels in the division; the result is the uniform-density
center of mass = solid centroid. Backend-agnostic like `meshVolume`/`meshArea`/`bounds`, so it
works unchanged on Manifold soup and OCCT indexed meshes.

Note the intentional mixed provenance, consistent with the existing code: the `volume` fact
comes from `solid.volume()` (exact kernel volume), while `centerOfMass` comes from the mesh
integral — the same "facts from the mesh" pattern `bbox`/`surfaceArea` already follow.

### 3. verify/expect DSL — `src/testing/verify.js`

Add three entries to **both** `SUBPART_METRICS` and `VIEW_METRICS`, each a
`{ kind: "gate", extract, hint }` — no new machinery:

- `centerOfMass` — sub-part `extract: (s) => s.centerOfMass`; view `extract: (r) => r.aggregate.centerOfMass`.
- `boundsMin` — sub-part `(s) => s.bounds?.min`; view `(r) => r.aggregate.bounds?.min`.
- `boundsMax` — sub-part `(s) => s.bounds?.max`; view `(r) => r.aggregate.bounds?.max`.

The assertion values use the existing vector form parsed by `parseAssertion`
(`reVec = /^(>=|<=)\s*\[...\]$/` → `vle`/`vge`, `*` → `null` skip) and evaluated componentwise
by `evaluateAssertion`. `check()` already returns **`skip`** ("unavailable") when `extract`
yields `null`/`undefined`, so a degenerate `centerOfMass` (or a `bounds` that somehow reads
null) is skipped, not failed — no special-casing needed. Give each a short `hint` in the same
voice as the existing metrics (e.g. centerOfMass: "center of mass is outside the expected region
— mass is distributed differently than intended; check feature placement or a mis-scaled
sub-part").

Example author usage:

```js
verify: { expect: {
  stand: { boundsMin: ">=[0,0,0]", centerOfMass: "<=[*,*,25]" },   // in +octant, mass low
  _view: { boundsMax: "<=[220,220,250]" },                          // whole assembly fits the bed
} }
```

## Edge cases

- **Zero-volume sub-part** → `centerOfMass: null` → any `centerOfMass` assertion on it `skip`s
  with "unavailable". The aggregate CoM ignores null-CoM sub-parts.
- **Non-watertight mesh** → CoM is still computed from the mesh integral; like `volume`, it is
  only physically meaningful for a closed surface. No new gating on watertightness (unchanged
  behavior).
- **Single sub-part / empty view** → aggregate `bounds` uses `unionBounds` as today; aggregate
  CoM equals the single sub-part's CoM (or `null` if that is null / no sub-parts).

## Backward compatibility & versioning

Purely additive — every existing fact, metric, DSL expression, and `ok` computation is
unchanged; `bbox` (size) stays. Base is 0.23.0 (`origin/main`); bump partforge to **0.24.0**.
After publish, partforge-cloud bumps its dep floor and adds the single-part functional eval
cases (separate work).

## Docs

Update the docs that enumerate `measure` facts and the `verify` metric list so the surface is
discoverable (and so partforge-cloud's generated authoring prompt picks it up on regeneration):
`docs/AUTHORING-PARTS.md` (the `verify` block's fact/metric list) and `docs/KERNEL-CONTRACT.md`
if it enumerates measure facts. Add `centerOfMass`, `bounds`/`boundsMin`/`boundsMax` with the
size-vs-position distinction and one worked assertion. (The recently-merged "state the
engineering intent" section is elsewhere in `AUTHORING-PARTS.md`; these edits target the
`verify`-metric list and do not touch it.)

## Testing

- **`meshCentroid` unit tests** (`test/`): analytic solids with known CoM — a box centered at
  the origin (`[0,0,0]`), a box translated to a known center (CoM = that center), an L-shaped or
  asymmetric composite (CoM off the bbox center), and a degenerate/zero-volume input (`null`).
  Assert within a tight epsilon.
- **`measure` + `measure-occt` tests**: for a known-placed part, assert per-sub-part `bounds.min`
  /`bounds.max` and `centerOfMass`, and the aggregate `bounds` + volume-weighted `centerOfMass`
  (a two-sub-part case where the weighting is checkable by hand). Confirm parity across backends.
- **verify-DSL tests**: a part whose `verify.expect` uses `centerOfMass`/`boundsMin`/`boundsMax`
  — one passing and one failing vector assertion each (including a `*`-skip axis), plus a
  zero-volume sub-part asserting `centerOfMass` → a `skip` result.
- Full suite + build green before the PR.

## Acceptance

- `measure()` returns `bounds:{min,max}` + `centerOfMass` on every sub-part and the aggregate,
  correct on both backends.
- `verify`/`expect` accepts `centerOfMass`/`boundsMin`/`boundsMax` componentwise vector
  assertions (pass/fail/`*`-skip/null-skip) with no new syntax.
- No existing test changes behavior; version is 0.24.0.
