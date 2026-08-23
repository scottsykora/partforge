# Shape2D loft rings — design

**Goal:** `k.loft` accepts `Shape2D` values and curve contours (arc/bezier profiles) as
ring cross-sections, on both backends. The Manifold path tessellates the rings to
matching, vertex-aligned point rings so the existing quad stitcher composes them; the
OCCT path lofts the **original B-rep curve wires** whenever the rings are structurally
the same curve, and falls back to lofting the identical shared polygon rings only when
the rings are genuinely different curves.

## Ring forms accepted

`{ polygon, z, rotate?, scale? }` where `polygon` is any of:

| form | today | after |
|---|---|---|
| `[[x,y],…]` point list | works (equal N required) | works; unequal N auto-resamples |
| `sides`+`radius` shorthand | works | unchanged |
| curve contour `{start, segments}` (e.g. `roundedProfile`, `pathProfile`) | throws | works |
| `Shape2D` (single region, hole-free) | throws | works |

A `Shape2D` ring must hold exactly **one region with no holes**; multi-region or holed
shapes throw loud, specific errors (lofting hole tunnels is a separate feature).
Loosened validation is **additive** under the contract's versioning rules: contract
version stays 4, minor npm release.

## Three resolution modes

`resolveLoftRings(rings)` (shared, pure JS, in a new leaf `loft-rings.js`) lifts every
ring to the curve-contour IR, bakes the per-ring `scale`-then-`rotate` transform into
the contour (arcs under non-uniform scale become cubics via the existing
`transformContour` machinery), normalizes winding to CCW, and computes a **segment
signature** — the sequence of segment kinds, e.g. `"LALALALA"` for a rounded square.
The signatures pick one of three modes for the whole loft:

1. **`poly-exact`** — every ring signature is identical and all-line (plain point
   lists, `sides`+`radius`, all-line contours). Byte-for-byte today's behavior: legacy
   numeric transform bake, no winding rewrite, Manifold stitches / OCCT lofts polygon
   wires. Parity **by construction** (unchanged). All existing parts land here.

2. **`curve`** — every ring signature is identical and at least one segment is an arc
   or cubic (the "same curve, different placement/scale" case: one rounded-square
   Shape2D reused across rings with per-ring z/scale/rotate, or different shapes that
   share a segment structure). Manifold tessellates **per corresponding segment with a
   shared sample count** (the max of the two rings' natural counts per segment index),
   so vertex `i` on every ring lies at the same curve parameter — corners land exactly
   on segment endpoints, no resampling drift, and the seam is the contours' `start`
   points (which correspond by construction when one shape is reused). **OCCT lofts
   the original curve wires** — `contourDrawing(bakedContour)` emits true CIRCLE /
   B-spline edges, so STEP stays curve-exact. Parity **within tolerance** (the
   `hull`/`screwSweep` class): the mesh facets what the B-rep keeps exact.
   [Verified on OCCT: scaled curve-mode rings loft without wire re-matching — exact
   frustum volume and true CIRCLE STEP edges; no scale restriction needed.]

3. **`resample`** — signatures differ (a rounded square lofted to a circle, unequal-N
   point lists). Each ring is tessellated at a fixed pure-JS LOD (`LOFT_SEGS = 64`,
   the `hull.js` precedent), then arc-length-resampled to a common `N = max` ring
   count from a deterministic seam (the outermost crossing of the +X ray from the
   ring's own centroid; per-ring `rotate` remains the author's phase-tuning knob), with
   each ring's sharp corners snapped onto their nearest sample so square corners
   survive a square→circle morph. Both backends consume the **identical resolved point
   rings** — OCCT lofts them as polygon wires exactly as it does today — so parity is
   **by construction** (the sweep-elbow mechanism) and STEP is faceted at the sampling
   LOD (documented, same trade as `extrude` `bevel`).

Why not let OCCT loft native wires in `resample` mode too: `BRepOffsetAPI_ThruSections`
runs its own wire-compatibility pass on sections with differing edge counts, and its
correspondence heuristic can pick a different seam than our resampler — the two
backends could **twist differently**, not merely facet differently. Falling back to
the shared polygon rings removes that failure mode entirely.

## Manifold cap fix

`loftMesh` caps ends with a centroid fan, which is only valid for star-convex rings —
an L-shaped Shape2D ring would produce broken caps. Caps switch to
`wasm.triangulate([ring2d], 1e-9)` (present in manifold-3d ≥ 3.x; verified: an
L-hexagon yields 4 tris), oriented consistently with the ring's actual winding so the
existing whole-mesh inversion self-correction still works. `fanCap` remains for
helix-tube.

## Shading

`loftShadingPolicy` moves to the resolved form: any curved segment in any ring ⇒
`SMOOTH` (a rounded square's arcs read as smooth surface intent; the crease pass still
hard-shades its corner edges via the crease angle); otherwise the existing
`SMOOTH_SIDES_MIN` rule applied to resolved ring point counts.

## Hashing

Ring specs can now contain `Shape2D` values (whose serialized form includes methods).
Both backends key loft cache nodes via a shared `loftRingsKey(rings)` that substitutes
each Shape2D with its `_hash` before folding through `h()`.

## Out of scope (v1)

- Rings with holes / multi-region rings (loud errors instead).
- A curve-exact OCCT loft for structurally-different rings (`smooth`-style opt-in later).
- `ruled:false` semantics: unchanged (OCCT-only smooth blend, Manifold previews ruled).
- `closed:true`: unchanged (Manifold-only; works in all three modes).

## Parity & contract summary

| mode | Manifold | OCCT | parity class | STEP |
|---|---|---|---|---|
| poly-exact | quad stitch (unchanged) | polygon wires (unchanged) | by construction | faceted (unchanged) |
| curve | matched per-segment tessellation | **original curve wires** | within tolerance | **curve-exact** |
| resample | quad stitch of shared rings | the same shared rings as polygon wires | by construction | faceted |
