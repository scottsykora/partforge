# Backlog — JSCAD-inspired geometry ideas

Running summary of the JSCAD-inspired research thread: what has shipped, and
what remains as candidate future work. Each remaining item becomes its own
spec/plan under `specs/` + `plans/` if pursued.

## Shipped

- **Options-object kernel API** (v0.13.0, PR #45) — named-argument calling
  convention for kernel ops; the JSCAD-style ergonomics baseline. See
  `specs/2026-07-17-options-object-kernel-api-design.md`.
- **`offsetPolygon`** (v0.15.0, PR #48) — pure-JS 2-D profile offsetting
  (grow/inset) on point-lists and `{outer, holes}` regions, with round /
  chamfer / sharp corner styles; "simple-in / simple-out or throw". Planter
  migrated onto it. See `specs/2026-07-17-offset-polygon-design.md`.

## Active roadmap: curve-native 2-D (three features)

The 2-D thread has crystallized into a **curve-native profile** direction, split
into three features. F1 is the foundation; F2 and F3 are siblings built on it.
Sequencing: **F1 first**, then F2 / F3.

Verified premises (checked against `node_modules/replicad`):
- OCCT/replicad accepts curves as sketch input — `bezierCurveTo`,
  `cubicBezierCurveTo`, `quadraticBezierCurveTo`, `smoothSplineTo`, `ellipseTo`
  on its drawing pen → exact B-rep → exact STEP.
- replicad Drawings do 2-D booleans directly — `fuse` / `cut` / `intersect`,
  curve-preserving (OCCT backend already uses `.cut()` for holes).
- replicad Drawings offset curves directly — `.offset(distance, {kind})`, exact.
- partforge already runs this exact dual-path pattern **for circular arcs**: the
  symbolic `ArcContour` is consumed directly by OCCT (`threePointsArcTo` → arc
  B-rep) and tessellated by Manifold (`sampleArc` at the kernel `segs` LOD). The
  three features generalize that arc mechanism to full curves.

**F1 — Curve-native profile IR** (foundation). Generalize `ArcContour` → a path
contour carrying `line | arc | bezier | spline` segments. OCCT maps each segment
to its pen method (exact); Manifold flattens at the shared mesh LOD (add
`sampleBezier` beside `sampleArc`). Independently valuable — curved profiles for
`extrude`/`revolve`/`sweep` with exact STEP — regardless of booleans.
**Implemented (v0.16.0, PR pending): cubic Béziers + `pathProfile` builder;**
**exact on OCCT, faceted at mesh LOD on Manifold. F1-follow-ups: (a) teach**
**`revolve`/`prism` the symbolic contour form — their option-checks assume**
**`[[r,z],…]` point arrays and throw an opaque "not iterable" on a contour**
**object; (b) quadratic/spline/ellipse segments; (c) SVG path-string parser.**

**F2 — 2-D booleans** — SHIPPED (v0.18.0, PR #52) as the `Shape2D` value:
`k.shape2d(profile).union/.cut/.cutAll/.intersect(...)`, feeds extrude/revolve,
materializes via `.toRegions()/.simple()/.area()/.boundingBox()`, content-hash
cached, curve-preserving on OCCT. Also aligned 3-D `Solid.union(other)`. Built on
the native backend booleans (Manifold `CrossSection` / OCCT `Drawing`) — no
dependency (martinez unnecessary). Follow-ups: multi-level hole nesting in
`assembleRegions`; empty-shape `boundingBox()` guard; `prism`+Shape2D.

_(original plan, on top
of F1. Backend-split like the rest of the kernel:_
- OCCT: replicad Drawing `fuse`/`cut`/`intersect` → exact, curve-preserving.
- Manifold: a polyline clipper (martinez-polygon-clipping — pure JS, maintained,
  emits multipolygons-with-holes) on flattened polylines at LOD.
- Parity-waived op (exact vs faceted) — established pattern (`sweep` already is).
- Output type (decided): always `[{outer, holes}, ...]` + a `simple()`
  unwrap-or-throw helper.
- Open: martinez dependency stance (depend / vendor / hand-roll) — now scoped to
  the Manifold path only; OCCT gets booleans free from replicad. Lean: vendor.

**F3 — Curve-native offset** — evolve `offsetPolygon` to curves, backend-split:
- OCCT: replicad Drawing `.offset()` → exact curve offset.
- Manifold: flatten + today's polyline `offsetPolygon` at LOD.
- Subtlety: `offsetPolygon` is currently a *pure main-thread helper* (planter's
  `derive()` uses it with no kernel boot). Curve-exact offset needs OCCT, so keep
  the pure polyline helper for `derive()`/main-thread use and *add* a curve path
  rather than replacing it.

## Later / separable (not part of the curve thread)

- **`hull` / `hullChain`** — convex hull + chained swept-hull. Pure-JS, low
  effort; convenience more than a gap. Good quick win if wanted out-of-band.
- **bbox `align` / `center` helpers** — 2-D profile alignment. Small payoff.
- **Mesh-native rounded primitives (`roundedCuboid` / `roundedCylinder`)** —
  fast rounded boxes on Manifold without OCCT fillet. Overlaps the fillet path.
- **`vectorText`** — extrudable text outlines. Useful but heavy (font parsing +
  bundled font). Pursue only if labeling parts becomes a real need.
