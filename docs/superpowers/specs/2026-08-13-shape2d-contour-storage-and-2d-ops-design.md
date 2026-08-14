# Shape2D contour storage and the 2D editing ops — design

**Date:** 2026-08-13
**Status:** Approved design, pre-implementation
**Repo:** partforge (framework layer only; the partforge-cloud agent tools are a
follow-on spec that consumes this release)

## Motivation

LLM agents are reliably bad at editing bezier path data directly and reliably
good at calling named geometric operations against rendered/measured feedback.
Every SVG-editing benchmark from 2024–2026 (SVGEditBench V2, SVGenius,
Vector-Bench, VectorEdits) finds path/coordinate-level edits failing — often
below a do-nothing baseline, with collateral damage to untouched geometry —
while CAD-specific work (CAD-Assistant, CadVLM, Text2CAD) and industry practice
(Zoo KCL, Fusion/Onshape MCP servers, Figma MCP) converge on the same shape:
the model writes code or tool calls at *operation* granularity; the library
does the coordinate math.

partforge already has the right substrate — parts are code against a semantic
kernel, and the SVG importer emits exact curve-native contour modules — but the
2D layer cannot express manipulation. `Shape2D` has no transforms, no fillet,
no queries beyond `area`/`boundingBox`, and round-tripping through
`toRegions()` destroys curves (tessellation at LOD 64 on OCCT, at construction
LOD on Manifold). A user asking the agent to "round that corner" or "make the
notch wider" on an imported profile currently has no good path.

This spec closes that gap with two coupled changes:

1. **Refactor `Shape2D` to contour storage.** `Shape2D` becomes a pure holder
   of curve-native contour regions; backend geometry (Manifold `CrossSection`,
   replicad `Drawing`) is materialized lazily, at the kernel boundary, at the
   consumption LOD.
2. **Add the 2D editing surface.** Transforms, fillet/chamfer with semantic
   corner selection, curve-native readback, point/tangent/length queries,
   corner-preserving simplify, and a validation oracle — as pure contour
   functions plus `Shape2D` methods that delegate to them.

## Goals

- Curve-native, lossless decompose → edit → recompose for 2D profiles on both
  backends.
- An operation vocabulary rich enough that neither part authors nor the agent
  ever needs to hand-write control-point coordinates for an edit.
- Backend-identical 2D boolean results (parity by construction, not by
  tolerance).
- Errors that are themselves actionable feedback for an agent loop.

## Non-goals

- The partforge-cloud chat tools (`edit_svg_profile`, `describe_profile`) and
  2D pick chips — follow-on spec in that repo, after this ships.
- Curve-native offset. The true offset of a cubic is not a cubic; offset stays
  backend-delegated (see carve-outs).
- Changing `toRegions()`. It keeps its tessellating contract for backward
  compatibility; `toContours()` is the non-lossy sibling.
- A stateful curve-editor object. Named operations only.

## Architecture

### Shape2D becomes contour storage

`Shape2D`'s source of truth is a region list in the existing contour IR:

```
region  = { outer: contour, holes: contour[] }
contour = { start: [x,y], segments: [ {to} | {to,via} | {to,c1,c2} ] }
```

`{to}` is a line, `{to,via}` a true circular arc (three-point form),
`{to,c1,c2}` a cubic bezier — the same IR the SVG importer emits, `pathProfile`
builds, `text2d` produces, and OCCT consumes exactly.

Backend materialization happens lazily, only when a kernel op needs real
geometry, and is memoized on the instance:

- `toCrossSection(segs)` — Manifold; tessellates via `tessellateProfile` at the
  **consumption** LOD (`SEGS.preview` / `SEGS.print`), memoized per `segs`.
- `toDrawing()` — OCCT; builds a replicad `Drawing` via the existing
  `contourDrawing` mapping (`{to,c1,c2}` → `cubicBezierCurveTo`, `{to,via}` →
  `threePointsArcTo`), memoized.

Consequences:

- `toContours()` is trivial and **lossless on both backends** — it returns a
  deep copy of the stored regions.
- Tessellation LOD is decided at consumption, not construction. Today a
  Manifold `Shape2D` bakes at whatever LOD existed when it was built; after
  the refactor a preview build and a print/export build tessellate the same
  profile at their own resolutions.
- `area()` and `boundingBox()` become curve-exact (computed on the contours,
  via the paper bridge for area), no longer functions of tessellation density.
- Transforms are pure contour math.
- The editing ops below hang off `Shape2D` directly, because the instance owns
  the representation they operate on.
- `Shape2D` stays a value: every op returns a new instance; stored contours
  are never mutated. replicad's consume-on-transform behavior is contained
  inside `toDrawing()` materialization and never visible to authors.

### The two carve-outs

**Booleans go to paper.js.** `union` / `cut` / `cutAll` / `intersect` run
curve-native in paper.js (`unite` / `subtract` / `intersect` on
`CompoundPath`), shared by both backends — the same machinery `curve-fill.js`
already runs in production for every text glyph. This is what makes boolean
results backend-identical by construction.

- paper.js is cubic-only: `{to,via}` arcs entering a boolean return as cubics
  — the same ≤90°-arc→cubic conversion the SVG importer applies to every
  imported arc (relative error ~1e-6). Practical guidance, stated in the docs:
  **fillet after your booleans** if exact `CIRCLE` entities in STEP matter.
- paper.js booleans have known rough edges around coincident/shared edges —
  which is the *common* CAD case (`bracket.js` unions two overlapping bars).
  The test plan carries explicit coincident-edge and tangent-touch cases with
  `validateProfile` asserted on outputs.

**Offset stays backend-delegated.** `offset()` materializes, runs the backend
engine (Manifold `CrossSection.offset`, replicad `Drawing.offset`), and reads
the result back (curve-native on OCCT via the path parser below, polyline on
Manifold). Behavior and fidelity are unchanged from today, including the
documented cross-backend chamfer divergence.

### Curve-native readback from OCCT

The existing `svgPathToRings` (OCCT materialization) is generalized: the same
`toSVGPaths()` parse gains a contour-emitting mode — `C` stays cubic, `Q`
degree-elevates, `A` converts to cubics per the importer's math — used by
`offset()` readback. `toRegions()` continues to sample rings exactly as today.

## Module layout

| Module | Role |
|---|---|
| `src/framework/geometry/contour-ops.js` | **New.** All pure 2D editing ops. DOM-free, `three`-free, `node:`-free — worker-graph leaf, same rules as `polygon.js`. |
| `src/framework/geometry/paper-bridge.js` | **New.** The contour ↔ paper.js bridge, extracted from `curve-fill.js` (`toContour` / `toPaperPath`) and extended with arc conversion. Consumed by `curve-fill.js` (no behavior change to text) and `contour-ops.js`. |
| `src/framework/geometry/shape2d.js` | **New.** The backend-agnostic `Shape2D` class: contour storage, lazy materialization hooks, method delegation to `contour-ops`. Backends supply only `toCrossSection`/`toDrawing` consumers and the offset engine. |
| `src/framework/geometry/polygon.js` | Re-exports `contour-ops.js` so `partforge/geometry` remains the single import surface. |
| `types/geometry.d.ts` | Type declarations for the new surface. |

## API surface

### Polymorphic input contract

Every contour op accepts a point list, a `{start, segments}` contour, a
`{outer, holes}` region, or a region array — and returns the same shape it was
given. Exception: the arc-length queries (`profileLength`, `profilePointAt`,
`profileTangentAt`) are single-contour by nature; passing a region **throws**
with a message naming the contour accessor to use.

### Pure functions (`partforge/geometry`)

| Group | Function | Notes |
|---|---|---|
| Transforms | `translateProfile(input, [dx,dy])` | exact on all segment types |
| | `rotateProfile(input, deg, center = [0,0])` | arcs stay arcs |
| | `scaleProfile(input, s \| [sx,sy], center = [0,0])` | non-uniform scale converts `{to,via}` arcs → cubics (an ellipse is not a circular arc) |
| | `mirrorProfile(input, axis)` | `axis: "x" \| "y" \| {point:[x,y], dir:[dx,dy]}` |
| Corners | `filletProfile(input, r, opts?)` | `r`: number, or array matched per corner with `{indices}` |
| | `chamferProfile(input, dist, opts?)` | symmetric setback, straight connector |
| | `profileCorners(input)` | `[{index, point, interiorAngleDeg, convex, segTypes}]` |
| Queries | `profileLength(contour)` | mm |
| | `profilePointAt(contour, {t} \| {length})` | `t` ∈ [0,1], normalized arc length |
| | `profileTangentAt(contour, {t} \| {length})` | unit vector |
| | `profileNearestPoint(input, [x,y])` | `{point, distance, contourIndex, segmentIndex, t}` — accepts regions; the pick-resolution primitive |
| | `profileBounds(input)` | curve-exact `{min, max}` |
| | `profileArea(input)` | outers − holes, curve-exact |
| | `profileContains(input, [x,y])` | paper.js curve-aware containment |
| Cleanup | `simplifyProfile(input, tolerance)` | corner-preserving; see below |
| Validation | `validateProfile(input)` | `{ok, issues}`; never throws |

Winding invariant: **mirror and negative scale re-normalize winding** (outer
CCW, holes CW) before returning, so no op can hand the kernel inverted
regions.

### Shape2D methods

Existing: `union`, `cut`, `cutAll`, `intersect`, `offset`, `area`,
`boundingBox`, `toRegions`, `simple`, `regions`, `clone`, `extrude`,
`revolve` — signatures unchanged.

New (all delegating to the pure functions over stored contours):
`translate([dx,dy])`, `rotate(deg, center?)`, `scale(s | [sx,sy], center?)`,
`mirror(axis)`, `toContours()`, `fillet(r, opts?)`, `chamfer(dist, opts?)`,
`simplify(tolerance)`, `corners()`, `contains([x,y])`.

`SHAPE2D_OPS` in `kernel.js` grows accordingly; the transform signatures
mirror the `Solid` family so the API reads as one system.

## Fillet / chamfer semantics

**Corner model.** A corner is a tangent-discontinuous joint between adjacent
segments, indexed by vertex: corner *i* is the joint entering segment *i*;
corner 0 is the closing joint at `start`. Joints whose tangents differ by less
than `SMOOTH_JOINT_DEG` (~1°, a named constant) are smooth — invisible to
selectors and `profileCorners` — so a curve split into two cubics at import
presents no phantom corner. Indices are stable for a given input and are
exactly what `profileCorners` reports.

**Selectors** (`opts.corners`, default `"all"`):

- `"all"` · `"convex"` · `"concave"`
- `{indices: [...]}` — from a prior `profileCorners` call; radius may be an
  array matched per corner (the `roundedProfile` pattern)
- `{near: [x,y], count: 1}` — nearest-corner selection; the hook for human
  picks and for the agent resolving "the top-left corner" from bbox reasoning

**Geometry.** Line–line corners use the existing `cornerArc` math directly —
exact, no paper.js. Corners involving a curved segment go through the paper
bridge: offset the two adjacent segments by `r`, intersect for the arc center,
project tangency points, trim. Trimming is exact for every segment type (de
Casteljau subdivision of a cubic yields exact cubics; a trimmed circular arc
is still a circular arc). The fillet itself is always emitted as a true
`{to,via}` arc — circular by construction — so on OCCT it reaches STEP as a
real `CIRCLE` entity. Chamfers set back `dist` along each adjacent segment and
connect with a straight `{to}`.

**Failure behavior: throw, precisely.** If a radius doesn't fit — tangency
point past a segment end, or two adjacent fillets consuming the same segment —
the op throws naming the corner index, its coordinates, and the maximum radius
that would fit there (e.g. `corner 3 at (41.2, 8.0): r=5 does not fit; max ≈
2.7`). The error is agent-actionable feedback. No silent partial application;
a lenient skip-and-report mode is deferred until usage demands it.

**Not checked here:** global self-intersection (a large radius can produce
arcs crossing the far side of a narrow profile). That is `validateProfile`'s
job, and validate-after-mutate is the documented standard step.

## Simplify — corner-preserving by construction

paper.js's native `simplify()` fits one smooth curve through everything, which
would erase corners. `simplifyProfile` therefore splits each contour at its
corners (same `SMOOTH_JOINT_DEG` threshold), simplifies each smooth run
independently, and rejoins: corners survive exactly, smooth runs are refit as
fewer cubics, collinear line runs merge. Arcs entering simplify return as
cubics (documented, same as booleans).

## Validation

`validateProfile(input)` never throws. It returns
`{ok, issues: [{type, contourIndex, segmentIndex?, point?, message}]}` with
issue types:

- `self-intersection` — within a contour or between contours of a region
- `winding` — outer not CCW / hole not CW
- `nesting` — hole outside its outer; overlapping regions
- `degenerate` — zero-length segment; collapsed contour

Implementation ports the SVG importer's proven approach — sampled rings with
grid-bucketed crossing detection at a documented samples-per-segment
resolution — rather than exact curve-curve intersection. The partforge-cloud
importer can later replace its private gates with this shared implementation
(the upstreaming item its own spec wishlists).

**Error policy, everywhere in this surface: mutating ops throw actionable
errors; `validateProfile` reports.**

## Testing

- **Contour ops:** transform exactness on every segment type; winding
  re-normalization after mirror/negative scale; fillet G1 tangency (numeric
  tangent-mismatch check below a pinned tolerance); the max-radius error
  message; corner-preserving simplify; lossless `toContours` round-trips.
- **Shape2D refactor:** boolean parity assertions *strengthened* from
  cross-backend tolerance to backend-identical (shared pure implementation);
  explicit coincident-edge and tangent-touch boolean cases (bracket-style
  overlapping unions) with `validateProfile` asserted on outputs; lazy
  materialization memoized per LOD; preview vs print tessellation of the same
  instance.
- **STEP fidelity:** fillet then export; assert `CIRCLE` entities present.
- **Paper bridge:** arc ↔ cubic round-trip tolerance test pinning the
  conversion error.
- **Regression:** all ten parts through `measure`/`verify` in CI (the net for
  the expected small numeric drift from curve-exact area and curve-native
  booleans). `worker-layering.test.js` covers the new modules automatically.
- **Contract:** `kernel-contract.test.js` op-coverage assertions extended to
  the new ops; every new `polygon.js` export documented in
  `KERNEL-CONTRACT.md` (existing assertion style).

## Documentation

- `docs/AUTHORING-PARTS.md`: new "Editing profiles" section — op tables, the
  fillet-after-boolean STEP note, validate-after-mutate guidance, and the
  agent-facing framing (numbers as parameters, never hand-written control
  points).
- `docs/KERNEL-CONTRACT.md`: minor version bump; Shape2D storage semantics and
  lazy materialization; boolean conformance upgraded to backend-identical;
  the offset carve-out and its unchanged per-backend fidelity; `toContours`
  contract.
- `docs/ERROR-PATTERNS.md`: entries for each throw site (fillet radius does
  not fit; adjacent fillets overlap; region passed to a single-contour query)
  and for paper-boolean degeneracies surfaced by `validateProfile`.

## Reference part

New `src/parts/gasket.js`: builds a curvy outline with `pathProfile`, unions
bolt tabs (a coincident-edge boolean in a real part), fillets the convex
corners, offsets for clearance, extrudes; uses `toContours` and
`profileCorners` in its `verify` block. Standard three glue files as a
dev-only page; the CI smoke list stays at four apps.

## Release

Minor version bump in the implementation PR itself (new API, no breaking
changes); publish is automatic on merge. The partforge-cloud follow-on spec
(`edit_svg_profile` / `describe_profile`, 2D pick chips) starts only after
`npm view partforge version` confirms the release, per the downstream pinning
rule.

## Compatibility

No breaking changes. `toRegions()`, `simple()`, `regions()` keep their
tessellating contracts; all current op signatures are unchanged. Expected
observable drift: `area()`/`boundingBox()` become curve-exact and boolean
results are computed on curves rather than pre-tessellated polygons — small
numeric shifts toward *more* accurate values, caught by verify tolerances and
CI if any part's assertions are too tight.

## Future work (out of scope, recorded for the follow-on spec)

- partforge-cloud `edit_svg_profile` (consolidated mutation tool re-running
  importer gates, returning raster preview + structured readback) and
  `describe_profile` (stable corner/segment IDs) wrapping this surface.
- 2D pick chips for profile corners/segments (selection-as-context).
- Lenient fillet mode (`skip-and-report`).
- Upstreaming the cloud importer's gates onto `validateProfile`.
