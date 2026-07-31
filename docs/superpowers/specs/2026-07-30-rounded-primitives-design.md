# Rounded 3-D primitives — roundedBox / roundedCylinder / torus — design

Date: 2026-07-30
Status: approved design, pre-implementation
Branch: claude/partforge-feature-backlog-f229c7 (off main@e9247de)

## Problem

The only way to get rounded edges on a 3-D solid today is `fillet`, which is an
`OCCT_ONLY_OPS` member — the geometry-free probe routes the whole part to the
OCCT backend, whose booleans/ops are ~75–1400× slower than Manifold
(`docs/geometry-backend-strategy.md`). A plain rounded enclosure, puck, or foot
therefore pays the full B-rep tax for what is a closed-form shape. The 2-D side
is already solved (`roundedProfile` gives curve-exact rounded *vertical* edges
via `prism`/`extrude`); what's missing is rounding the top/bottom rims and
corners. This is BACKLOG.md candidate "Rounded 3-D primitives"
(`roundedCuboid`/`roundedCylinder`/`torus` — the last unshipped JSCAD-parity
row).

## Decisions already made (with Scott)

- **Scope: all three** — `roundedBox`, `roundedCylinder`, and `torus` (torus is
  promoted from the documented revolve idiom to a real op).
- **Full selective rounding**: per-edge-group radii on the box (vertical edges
  vs top rim vs bottom rim), per-rim radii on the cylinder.
- **Approach B — native per backend** for `roundedBox`: a direct parametric
  mesh generator on Manifold, native `fillet` on OCCT (exact B-rep → clean
  STEP). `roundedCylinder`/`torus` share a single revolve-based implementation.
- **The unmeshable middle regime clamps with a warning** rather than throwing
  (see §Semantics).

## API surface

Three new kernel ops, appended to `KERNEL_OPS` in `kernel.js`. Additive change:
contract version stays 1, minor npm release (0.37.0). Options-object canonical
form; no legacy positional form (new ops are options-only, like `boredCylinder`).

```js
k.roundedBox({ size: [w, d, h], center?, round: r | { side?, top?, bottom? } })
k.roundedCylinder({ r|d, h, center?, round: r | { top?, bottom? } })
k.torus({ rMajor, rMinor })
```

- **`roundedBox`** mirrors `box`'s `{size, center}` convention: centered in
  X/Y, base at z=0, `center: true` centers Z too. No `{min, max}` form (YAGNI —
  `box` keeps it for legacy reasons; the new op shouldn't inherit it).
  `round` as a number rounds every edge; the object form is selective —
  `side` = the 4 vertical edges, `top`/`bottom` = the 4-edge rims. Omitted
  groups default to `0` (sharp). `round: 0` (or all-zero object) is valid and
  produces a plain box.
- **`roundedCylinder`** mirrors `cylinder` (`{r|d, h, center?}`). The rounding
  key is `round` (not `r` — that's the cylinder radius): a number rounds both
  rims, `{top?, bottom?}` is per-rim. Straight cylinders only (no `r1`/`r2`
  cone form in v1; a rounded frustum is a different lathe profile and can be
  added additively later).
- **`torus`** is centered at the origin with the tube centerline in the z=0
  plane (spans z ∈ [−rMinor, rMinor]) — identical geometry to the documented
  `k.revolve({ profile: circleProfile(minorR, [majorR, 0]) })` idiom, which it
  replaces.
- All three are **compound cache nodes** hashing their own arguments plus the
  mesh LOD (`segs`) on Manifold — the `boredCylinder` precedent. Internals
  (lathe profiles, fillet intermediates) never hit the solid cache.
- Canonical-at-origin, orient-then-place: all three compose with
  `.along(dir).at(v)` like every other primitive.

## Semantics — selective rounding (normative)

Defined as **sequential rolling-ball fillets**: vertical edges first (radius
`side`), then the top rim (`top`), then the bottom rim (`bottom`). This is what
OCCT's fillet computes natively, and it has closed-form corner surfaces in two
regimes, which are the supported parameter space:

1. **`side ≥ max(top, bottom)`** (includes all-equal): each top/bottom corner
   is an exact **torus patch** — tube radius `top` (resp. `bottom`), centered
   on the vertical corner-arc axis at radial offset `side − top`, degenerating
   to a **sphere octant** when the radii are equal.
2. **`side = 0`** (rim-only round-over on a sharp-sided box — the "rounded
   lid"): each rim edge's quarter-round runs the **full edge length**, and
   adjacent round-overs meet in their natural **intersection curve** at each
   corner (the top face keeps sharp corners, inset by the rim radius). This is
   the classic CSG round-over — closed-form and deterministic on both
   backends. (A rolling ball cannot physically reach into a sharp corner, and
   OCCT's native vertex blend there is a kernel-specific patch a mesh
   generator cannot reproduce — so we define and construct the corner
   explicitly rather than inherit either.) *Amended 2026-07-30: an earlier
   revision described this corner as a "sphere pivot patch", which does not
   survive the geometry.*

**The middle regime `0 < side < max(top, bottom)` clamps, with a warning.**
The rim radii clamp **down** to `side`; `side` itself is never changed. In
this regime the rolling rim ball overhangs the tighter vertical corner and
OCCT produces a nontrivial curvature blend that a mesh generator cannot
reproduce in closed form — allowing it would silently break cross-backend
measure parity. Clamp direction rationale: `side` defines the part's footprint
and mating surfaces, so it must not silently grow; shrinking a rim round-over
keeps the part inside its intended envelope (strictly more material, never
less). The clamp emits a `console.warn` naming the op and values:

```
roundedBox: round.top 3 clamped to round.side 1 (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)
```

The clamp lives in the shared kernel-front normalization, so both backends see
identical clamped values and parity holds by construction (a clamped call and
its explicitly-clamped equivalent normalize to the same arguments, hence the
same cache node). The normalizer runs before the cache, so the warning is
deduped by a small module-level set of already-warned messages — it fires once
per distinct parameter combination per worker session, not per preview frame. **Documented discontinuity** (inherent to
any clamp rule): `side: 0` with a large rim radius is the valid sphere-pivot
regime, but `side: ε` clamps that rim to ε — the docs state explicitly: *for a
rim-only round-over, use `side: 0` exactly*. The warning is what keeps an
author who lands in the gap from being confused.

The cylinder has no middle regime (the "side" is the circular wall itself; a
rim fillet on a circular rim is always a closed-form torus patch).

### Validation (plain `Error`, op-named, backend-identical)

- `roundedBox`: all radii ≥ 0; `2·side ≤ min(w, d)`; `2·top ≤ min(w, d)` and
  likewise `bottom` (the rim round-over inset must keep the cross-section
  nonempty); `top + bottom ≤ h`, **strict `<` when `side > 0`** — two rim
  fillets meeting tangentially at the equator is not reliably constructible
  on the B-rep backend (OCCT's fillet fails at exact fillet-to-fillet
  tangency), so the fillet-path regime requires a straight wall band;
  `side: 0` full-height round-overs (`top + bottom = h`) stay valid on both
  backends. *(Amended 2026-07-30 during implementation — Task 5 review found
  the OCCT boundary failure.)*
- `roundedCylinder`: `round.top/bottom ≥ 0`; `round.top ≤ r` and likewise
  `bottom`; `top + bottom ≤ h`.
- `torus`: `0 < rMinor < rMajor` (horn and self-intersecting tori rejected).
- Boundary values (`=`) are valid, not errors: `roundedBox({size:[20,20,10],
  round:{top:5, bottom:5}})` sits exactly at `top + bottom = h` (the straight
  wall vanishes); `roundedCylinder({r:5, h:10, round:5})` is a capsule. Both
  must build watertight.

## Backend implementations

### `roundedCylinder` and `torus` — one shared implementation

Registered at the kernel front (`??=` on both backends, like `boredCylinder`'s
default composition — no backend override needed). Each is a **single
`revolve` of a 2-D arc profile**, fed through `k.shape2d(...)` so arcs stay
symbolic:

- `roundedCylinder`: rectangle lathe profile `[[0,0],[r,0],[r,h],[0,h]]` with
  per-corner `roundedProfile` radii `[0, bottom, top, 0]`.
- `torus`: a circle of symbolic arcs (radius `rMinor`, centered `[rMajor, 0]`)
  — via `pathProfile(...).arcTo(...)`, not the faceted `circleProfile` point
  list.

Zero booleans. **Curve-exact on OCCT** — revolved arcs become real
cylinder/torus/sphere faces in STEP. Faceted at the `segs` LOD on Manifold —
the established exact-vs-faceted fidelity split (KERNEL-CONTRACT "arc profile"
clause); measure parity within facet tolerance, not a parity waiver.

### `roundedBox` — native per backend

- **Manifold**: a direct parametric **watertight mesh generator** (new
  `src/framework/geometry/rounded-box-mesh.js` beside `mesh-build.js`): a patch
  grid of 6 planar faces, 12 quarter-cylinder edge strips, and 8 corner patches
  (torus patch, sphere octant, or sphere pivot patch per the regime), sampled
  at the kernel's `segs` LOD with **shared boundary rings** — no T-junctions,
  no booleans, one atomic solid. Degenerate patches (zero-radius groups) drop
  out of the grid rather than emitting zero-area triangles.
- **OCCT**, split by regime (the part-facing op takes no selectors):
  - `side > 0`: extrude an **arc-exact rounded-rect profile** (real CIRCLE
    wall edges in STEP), then **one native `fillet` per rim** on its smooth
    rim edge loop (`{inPlane: "XY", at: zRim}` internally) — exact torus /
    sphere-octant corner patches matching the mesh semantics. Fillet failures
    fall under the existing OCCT repair policy, not a new error class.
  - `side = 0`: cut the box with **quarter-cylinder wedge cutters** (a strip
    box minus a cylinder per rim edge, full edge length) — the corners come
    out as the exact intersection of adjacent round-overs, matching the
    normative semantics deterministically; native fillet's vertex blend is
    deliberately not used. Still exact B-rep cylinders in STEP.
- The probe kernel picks all three ops up automatically from `KERNEL_OPS`; the
  ops are **not** in `OCCT_ONLY_OPS`, so — the entire point of the feature —
  **a part using `roundedBox` stays on the Manifold backend** for preview and
  STL/3MF, and only an explicit `meta.backend: "occt"` or a real
  `fillet`/`chamfer`/`shell` elsewhere routes it to OCCT.

### Purity / invariants checklist

- Pure functions of their arguments — safe for the content-hash cache.
- DOM-free, worker-safe; no new dependencies.
- OCCT consume-on-transform rules respected internally (clone before fillet
  chains where needed).
- Millimetres, degrees, Z-up, build-from-z=0 — all inherited conventions hold.

## Testing

- **Contract parity**: `test/kernel-contract.test.js` + the OCCT twin
  (`test/occt-backend.test.js`) auto-assert both backends expose the three ops
  (the op lists are data). New cases assert the clamp warning fires (spyable
  `console.warn`) and validation error texts match across backends.
- **Closed-form volume gates** (the real cross-backend parity check): a
  rounded box's volume is analytic — box minus edge/corner deficits, e.g.
  all-equal `r`: `V = wdh − (perimeter terms) + (12 quarter-cylinder edges) +
  (8 sphere-octant corners)`; equivalently the Minkowski form
  `V = w'd'h' + r·2(w'd' + w'h' + d'h') + πr²(w' + d' + h') + (4/3)πr³` with
  `w' = w − 2r` etc. Assert Manifold and OCCT both converge to the analytic
  value within facet tolerance for each regime: all-equal, `side > top`,
  `side = 0` (rim-only), mixed `top ≠ bottom`, and a clamped middle-regime
  call (asserting it equals the explicitly-clamped call bit-for-bit on
  Manifold / value-for-value on OCCT). Same treatment for
  `roundedCylinder` (lathe closed form) and `torus` (`2π²·rMajor·rMinor²`).
- **Mesh integrity**: watertight + `genus` 0 gates (torus: genus 1) via the
  existing `measure` helpers on the Manifold mesh generator across all
  regimes and boundary values (`2·top = min(w,d)`, `top + bottom = h`).
- **Routing**: a probe test asserting a `roundedBox`-using build does **not**
  route to OCCT.
- **STEP smoke**: OCCT `toSTEP` export of each primitive succeeds; spot-check
  the roundedCylinder/torus STEP contains curved (non-planar, non-faceted)
  surfaces.
- OCCT-booting tests stay in their own file per the boot-isolation invariant.

## Documentation updates

- `docs/KERNEL-CONTRACT.md`: op-list additions, `@typedef`-mirrored signatures,
  the regime semantics + clamp rule as normative prose (the "one radius
  vocabulary" of §Semantics above, condensed).
- `docs/AUTHORING-PARTS.md`: three usage-table rows, one worked snippet
  (selective rounded enclosure), replace the "partforge has no torus
  primitive" idiom note with the op (keep the revolve idiom as a "what it
  desugars to" aside).
- `docs/ERROR-PATTERNS.md`: one pattern for the clamp warning text (symptom:
  "my rim radius is smaller than I asked for" → cause: middle regime →
  fix: `side: 0` or `side ≥ rim`), plus the validation error texts.
- `docs/superpowers/BACKLOG.md`: move "Rounded 3-D primitives" to Shipped;
  JSCAD coverage map row → ✅.
- `package.json` version bump to 0.37.0 in the PR (tag-driven publish after
  merge, per AGENTS.md).

## Out of scope (v1)

- `{min, max}` box form; cone/frustum `roundedCylinder` (`r1`/`r2`).
- Per-edge (as opposed to per-group) box radii; elliptical/variable-radius
  blends.
- `roundedProfile`-style arc exactness for the Manifold `roundedBox` mesh in
  STEP (Manifold has no STEP path anyway).
- A shared kernel-front fallback composition of `roundedBox` for third-party
  core-class backends — they implement the op directly; the contract op lists
  are the conformance statement.
