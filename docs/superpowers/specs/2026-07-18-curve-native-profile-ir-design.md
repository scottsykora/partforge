# Curve-native profile IR — cubic Béziers in 2-D profiles — design

Date: 2026-07-18
Status: approved design, pre-implementation
Branch: curve-native-profiles (off main@9993561)

## Problem

partforge's 2-D profiles already carry curves *symbolically* — but only circular
arcs. The `ArcContour` (`{ start:[x,y], segments:[{to}|{to,via}] }`, emitted by
`roundedProfile`) is consumed two ways: the OCCT backend maps `{to, via}` →
`threePointsArcTo` for a true B-rep arc edge (exact to STEP), while the Manifold
backend tessellates it via `sampleArc` at the mesh LOD (`segs`). Everything else
— free-form curved outlines, teardrops, ogees, lofted-looking profiles — has to
be pre-flattened by the author into a dense point list, which loses exactness on
the OCCT/STEP path and fixes the resolution regardless of preview quality.

This is the foundation feature of a three-part curve-native 2-D thread (see
`docs/superpowers/BACKLOG.md`): **F1 — curve-native profile IR** (this spec),
then **F2 — 2-D booleans** and **F3 — curve-native offset** built on top. F1
generalizes the existing arc mechanism to full cubic Béziers, so a profile can
carry free-form curves that go *exact* into OCCT and *faceted at mesh LOD* into
Manifold — exactly how arcs already behave.

## Verified premises (checked against `node_modules/replicad`)

- replicad's drawing pen accepts curves: `cubicBezierCurveTo(end, startControl,
  endControl)`, plus `quadraticBezierCurveTo`, `smoothSplineTo`, `ellipseTo` —
  so a cubic segment becomes an exact B-rep spline edge → exact STEP.
- Flattening already happens **inside** the Manifold backend:
  `manifold-backend.js` calls `tessellateProfile(profile, segs)` with
  `segs = SEGS[quality]`, the mesh LOD knob. F1 adds nothing structural to that
  flow; it only widens the segment vocabulary the tessellator understands.

## Decisions already made (with Scott)

- **Scope: cubic Béziers only** for this first pass. Quadratics elevate to
  cubics (later sugar); `smoothSplineTo`/`ellipse` slot into the same mechanism
  later. `arc` (exact circle) already covers circular cases.
- **Structural discrimination, no `kind` tag.** Segments stay terse:
  `{to}` = line, `{to, via}` = arc (unchanged), **`{to, c1, c2}` = cubic**. This
  keeps legacy point arrays and existing `ArcContour`s byte-for-byte identical —
  no cache-busting for non-curve parts.
- **LOD: adaptive curvature subdivision** (Option A), generalizing the arc rule.
- **Ship a minimal `pathProfile` builder** so curves are authorable; defer an
  SVG path-string parser to a later feature.
- **Parity noted, not waived.** Cubic is exact-on-OCCT / faceted-on-Manifold —
  the same posture arcs already hold; measure-parity holds within tolerance as
  facets converge.

## The IR

A path contour is the existing symbolic form with one new segment kind:

```js
{
  start: [x, y],
  segments: [
    { to: [x, y] },                     // line   (unchanged)
    { to: [x, y], via: [x, y] },        // arc    (unchanged, three-point)
    { to: [x, y], c1: [x, y], c2: [x, y] }, // cubic Bézier (new)
  ],
}
```

- Segment kind is discriminated by presence: `c1` ⇒ cubic, else `via` ⇒ arc,
  else line. A segment carrying both `via` and `c1`, or `c1` without `c2` (or
  vice versa), is invalid (see Validation).
- The control points `c1`, `c2` are the standard cubic controls between the
  previous point (`start` for the first segment, else the prior `to`) and `to`.
- `isArcContour` (predicate for "is this the symbolic non-array form") already
  accepts this — it only tests for a non-array object with a `segments` array.
  A clearer alias `isPathContour` is added; `isArcContour` stays re-exported for
  back-compat.

## OCCT path (exact)

Extend `contourDrawing` in `occt-backend.js` — the per-segment walk gains one
branch, ahead of the arc branch:

```js
seg.c1 ? pen.cubicBezierCurveTo(seg.to, seg.c1, seg.c2)
       : seg.via ? pen.threePointsArcTo(seg.to, seg.via)
                 : pen.lineTo(seg.to)
```

The resulting `Drawing` flows unchanged through `sketchOnPlane` / `extrude` /
`revolve` / `cut`. A cubic segment becomes a true spline edge, exact to STEP.

## Manifold path (`sampleBezier` + LOD)

New pure function in `profile.js`, called from `tessellateContour` on the cubic
branch:

```js
sampleBezier(p0, c1, c2, p1, segs) → [ p1…pN ]   // EXCLUDES p0, last === p1
```

Contract mirrors `sampleArc` exactly: returns points after the start (the ring
already holds `p0`), pins the final point to `to` exactly, and is a pure
function of `(segment, segs)` so the content-hash cache stays stable.

**LOD — adaptive curvature subdivision (Option A).** Recursively split the cubic
(De Casteljau at t=½) until each emitted chord satisfies a stop test, then emit
the split points in order:

- **Primary criterion — tangent turn ≤ `2π / segs`.** This is the direct
  generalization of the arc rule: `sampleArc` emits a point every `2π/segs` of
  sweep, so a cubic that happens to trace a circular arc facets *identically* to
  the `arc` primitive and to `circleProfile` at the same radius. Unit-free — no
  mm tolerance to invent.
- **Flatness backstop.** Also subdivide while the perpendicular deviation of
  `c1`/`c2` from the `p0→p1` chord exceeds a small fraction of the chord length
  — catches S-curves whose endpoint tangents are near-parallel while the middle
  bulges (pure angular test would under-resolve these).
- **Depth cap.** A recursion-depth ceiling (e.g. 12) guarantees termination and
  bounds the point count on pathological inputs.
- **Near-straight fast path.** Controls collinear-ish with the chord ⇒ a single
  chord to `p1` (mirrors `sampleArc`'s collinear→straight fallback).

Exact split point counts and the flatness constant are an implementation detail
for the plan; the invariant that pins them is the arc-consistency test below.

## Authoring: the `pathProfile` builder

A small fluent builder in `polygon.js` (beside `roundedProfile`), emitting the
canonical contour object — the smallest thing that makes curves authorable and
gives tests a clean constructor:

```js
pathProfile([x, y])          // start pen
  .lineTo([x, y])            // → { to }
  .arcTo([x, y], [vx, vy])   // → { to, via }   (three-point, matches existing)
  .cubicTo([x, y], [c1x, c1y], [c2x, c2y]) // → { to, c1, c2 }
  .close()                   // → { start, segments }  (a path contour)
```

- `close()` returns the plain contour object (not a Solid) — it feeds
  `extrude`/`revolve`/`prism` and, later, F2/F3.
- Builder validates as it goes (finite points) and on `close()` (≥1 segment).
- SVG path-string parsing (`"M0,0 C…"`) is explicitly **deferred** to a later
  feature.

## Validation & error taxonomy

Extend `validateContour` in `profile.js`. Loud, greppable errors in partforge's
existing style (prefixed `extrude:` to match the current contour messages),
mirrored by ERROR-PATTERNS entries:

- cubic segment missing/!finite `c1`/`c2` → `extrude: <role> cubic segment needs
  c1 and c2 as finite [x,y]`
- segment carries both `via` and `c1` → `extrude: <role> segment cannot mix arc
  (via) and cubic (c1/c2)`
- half-specified cubic (`c1` xor `c2`) → covered by the "needs c1 and c2"
  message
- existing line/arc/point-count messages unchanged (test-pinned wording
  preserved).

## Back-compat, purity, cache

- Legacy point arrays and existing `ArcContour`s take the exact former path —
  additive branch, structural discrimination — so their tessellation and content
  hashes are unchanged (no silent re-mesh of existing parts).
- `sampleBezier` is pure; the contour is plain data → hashes stably; parts stay
  DOM-free and side-effect-free.
- Parity: document cubic's exact/faceted split in `KERNEL-CONTRACT.md` alongside
  the arc note — not a parity waiver; measure-parity holds within tolerance as
  facets converge.

## Testing

**Unit (pure vitest, no WASM):**
- `sampleBezier`: endpoint pinned to `to`; excludes `p0`; facet count rises with
  `segs` and with curvature; **a cubic tracing a known circular arc facets like
  `sampleArc`** at the same `segs` (the consistency invariant); near-collinear
  controls → single chord; purity (same input twice → deep-equal).
- Validation: each error literal throws as specified; mixed/half-specified
  segments rejected.
- `pathProfile`: emits the canonical `{ start, segments }`; segment kinds map
  correctly; `close()` on an empty path throws.

**Manifold integration (`createManifoldKernel`, no OCCT co-boot):**
- extrude a cubic profile → sane bbox/area, watertight cross-section;
- a cubic quarter-circle vs an `arc` quarter-circle extrude measure-close within
  tolerance (parity/consistency pin).

**OCCT integration (own file, `bootOcctKernel`, no Manifold co-boot):**
- extrude a cubic profile → watertight, sane volume (πR²h for the 4-Bézier
  circle, OCCT-exact);
- STEP export succeeds and contains a spline edge (`B_SPLINE`).
- **Note (found in planning):** `revolve` (and `prism`) do not accept the
  symbolic contour form today — `revolve`'s radius-check iterates the profile as
  `[[r,z],…]` point arrays, so a `{start, segments}` object throws before
  reaching the drawing. This predates F1 (arc contours hit it too); extending
  `revolve`/`prism` to curve contours is deferred follow-up. F1 proves the cubic
  B-rep through `extrude`.

## Docs

- `AUTHORING-PARTS.md`: add `pathProfile` to the import list and a short
  cubic-curve example; note the exact-STEP / faceted-preview behavior.
- `KERNEL-CONTRACT.md`: extend the arc exact/faceted note to cover cubics.
- `ERROR-PATTERNS.md`: entries for the new validation literals.
- Version bump (additive, no CONTRACT_VERSION change).

## Out of scope (explicitly)

- Quadratic Béziers, `smoothSplineTo` splines, `ellipse` segments — later
  additions that slot into the same mechanism.
- SVG path-string parsing.
- Extending `revolve` / `prism` to accept symbolic (arc/cubic) contours — their
  option-checks assume point arrays; a separate follow-up (see Testing note).
- F2 (2-D booleans) and F3 (curve-native offset) — separate specs built on this.
