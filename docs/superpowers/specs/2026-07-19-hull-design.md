# hull / hullChain — 2-D convex hull → `Shape2D` — design

Date: 2026-07-19
Status: approved design, pre-implementation
Branch: hull (off main)

## Problem

partforge can compose 2-D shapes (booleans, offset, curves, text) but has no
**convex hull** — the last real gap in JSCAD's `geom2` coverage. Hull is the clean
way to wrap a set of points/shapes in a convex outline, and its swept form
(`hullChain`) is how you get **capsules, rounded slots, and organic tapers** —
shapes that are otherwise tedious to build. Both return a `Shape2D`, so they
compose with the booleans/offset/extrude machinery already in place.

## Decision: faceted (point-sampled), not curve-exact

The convex hull is computed on **points**. Inputs are reduced to points, and the
result is a convex **polygon** `Shape2D`. Hull of polygon inputs is exact; curved
inputs (circles, arcs, beziers) facet at the kernel's mesh LOD — the same
exact-vs-faceted split as everywhere else in the framework.

This was a deliberate choice over curve-exact hull (true stadiums with exact arcs).
Curve-exact hull has **no backend or library support** — Manifold's
`CrossSection.hull()` is polygon-only, OCCT/replicad exposes no 2-D hull, and there
is no JS library for it — so it would be a large from-scratch computational-geometry
build (convex hull of disks/arcs: tangent lines + arc segments), and our
`circleProfile` is faceted today anyway. Faceted hull is a small, robust, pure-JS
win that matches JSCAD. Curve-exact hull is logged as a possible future project.

## Architecture — pure-JS, backend-agnostic

The hull is computed in plain JS (Andrew's monotone-chain algorithm) and the
resulting convex polygon is lifted with `k.shape2d(...)`. Nothing backend-specific:
Manifold and OCCT receive the identical polygon, so hull output is **bit-identical
across backends** (a strong parity property — the pure-JS stage removes any
backend divergence). `hull`/`hullChain` are **kernel factory ops** (they need
`k.shape2d`), living alongside `shape2d`/`text2d`.

## API

```js
k.hull(inputs)      => Shape2D   // inputs: HullInput[]
k.hullChain(inputs) => Shape2D   // inputs: HullInput[] (length >= 2)
```

Both take a **single array** argument (matching `k.union([...])`), not variadic.

### `HullInput` — what can be hulled

Each element of `inputs` contributes points to the hull:

- **`Shape2D`** — its boundary sample points (all region outlines; holes are
  interior to a convex hull, so they contribute nothing distinct but are harmless).
- **A curve/arc contour** (`{start, segments}`, e.g. from `pathProfile` /
  `roundedProfile`) — tessellated to points at the kernel's mesh LOD.
- **A point list** `[[x,y], …]` — used directly, any length ≥ 1 (so a bare point
  cloud is just a list; `circleProfile(r, c)` — a 48-gon point list — works here).

Detection is by shape: `_shape2d` → Shape2D; an object with `segments` → curve
contour; an array of `[x,y]` pairs → point list. A `Solid` (3-D) or other input is
a clear throw — this op is 2-D only.

### `hull(inputs)`

Convex hull of the union of all inputs' points → a single convex-polygon `Shape2D`.

- A single input is allowed (its own convex hull).
- **Degenerate → throw** (a clear message, matching `offsetPolygon`'s "clean result
  or explain why not" stance): an empty `inputs`, or fewer than 3 **non-collinear**
  points total, cannot form a 2-D region.

### `hullChain(inputs)`

Swept hull over the ordered sequence: the **union** of the hull of each consecutive
pair —

```
hull([in₀, in₁]) ∪ hull([in₁, in₂]) ∪ … ∪ hull([in_{n-2}, in_{n-1}])
```

- **Requires ≥ 2 inputs** — fewer is a usage error and throws (it is defined by
  pairwise sweeps; a 1-element chain is meaningless).
- Order matters (it is a chain, not a set). Built on `Shape2D.union`.

## Algorithm

Andrew's monotone chain, O(n log n):

1. Collect all points from all inputs (via the sampling above).
2. Deduplicate, sort by (x, then y).
3. Build lower and upper hulls; concatenate (dropping the shared endpoints).
4. The result is the convex polygon in CCW order → `k.shape2d(polygon)`.

Collinearity: points on a hull edge are dropped (strict turns only), so a truly
collinear input set yields < 3 hull vertices → the degenerate throw.

## Cross-backend parity

The hull computation itself is pure JS and backend-independent. Parity therefore
depends only on whether the *input point sampling* is backend-independent:

- **Point-list and curve-contour inputs** are sampled in pure JS at a fixed LOD, so
  the hull polygon is **bit-identical across backends**.
- **`Shape2D` inputs** get their boundary points from the backend's own
  materialization (`toRegions()`), which tessellates curved boundaries at slightly
  different densities on Manifold vs OCCT. The hull of a `Shape2D` input therefore
  agrees across backends **within the tessellation tolerance**, not bit-identically
  (only the extreme boundary points affect a convex hull, so the difference is
  small). This is normal measure-parity, not a waiver.

## Scope (v1)

**In:** `k.hull(inputs[])` and `k.hullChain(inputs[])` → `Shape2D`; inputs =
`Shape2D` / curve contour / point list (mixed); pure-JS monotone-chain hull; faceted
result (curved inputs at mesh LOD); degenerate/`<2`-chain throws; kernel-contract
entries + docs.

**Deferred / out:** curve-exact hull (exact arcs / stadiums — its own future
project); 3-D convex hull of `Solid`s; `hull` as a `Shape2D` *method* (kept a kernel
op for now, since it is n-ary over heterogeneous inputs).

## Testing

**Pure-ish unit (no kernel):**
- monotone-chain hull of a known point set (square-with-interior-points → the 4
  corners; a concave "L" point set → its convex wrap; collinear points → throws);
- input sampling: a `Shape2D`, a curve contour, and a point list each reduce to the
  expected points; mixed inputs combine.

**Manifold + OCCT integration (each in its own file, no co-boot):**
- `k.hull([SQ_A, SQ_B])` of two separated squares → the expected convex hull area;
- `k.hull([circleProfile(...)])` → area ≈ the circle (faceted);
- `k.hullChain([c0, c1, c2])` of three circles in a row → one connected region
  (`toRegions().length === 1`) whose area exceeds any single pairwise hull (the
  sweeps genuinely union);
- `hullChain` with `< 2` inputs throws; `hull([])` / degenerate throws;
- **cross-backend parity:** a point-list/curve-contour `hull` input → the hull
  *polygon* is identical on both backends; a `Shape2D` input → hull area agrees
  within tessellation tolerance.

## Out of scope (explicitly)

- Curve-exact / arc-preserving hull.
- 3-D hull.
- Any change to the existing `Shape2D` boolean/offset ops.
