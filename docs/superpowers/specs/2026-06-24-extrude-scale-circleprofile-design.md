# prism twist/taper, scale, circleProfile — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Scope:** Finish the geometry-vocabulary ops deferred from the 2026-06-23 batch,
kept to genuine primitives. Three additions: twist/taper options on `prism`, a
uniform `scale` transform, and a `circleProfile` 2-D helper. All backend-agnostic
(STEP export stays intact).

## Motivation

The original geometry-vocabulary spec (2026-06-23) deferred `twist`/`taper` extrude,
`torus`, non-uniform `scale`, and convex `hull`. Revisiting them under the project's
"few shared primitives, compose features" principle:

- **`scale`** is a fundamental affine transform missing from the kernel — a peer of
  `translate`/`rotate`/`mirror`. It belongs in the core.
- **`twist`/`taper`** are parameters the extrude primitive natively supports on both
  backends; exposing them makes an existing primitive fully expressive rather than adding
  a special case.
- **`torus`** is NOT added as a primitive: it is `revolve(circle)`, derivable from ops we
  already have (unlike `sphere`/`cylinder`, it maps to no native backend operation). It
  becomes a documented one-line composition, made ergonomic by a small `circleProfile`
  2-D helper.
- Non-uniform `scale` and `hull` stay out — both are Manifold-only and would break STEP.

## In scope

- `prism(points2D, h, { twist?, scaleTop? })` — twist + uniform taper on extrude.
- `s.scale(factor, center?)` — uniform scale (Solid transform).
- `circleProfile(r, center?, segs?)` — pure 2-D profile generator.

## Out of scope

- `torus` as a kernel op (documented as `revolve(circleProfile(...))` instead).
- Non-uniform scale, convex hull (Manifold-only; STEP-incompatible).
- Any OCCT-only / capability-routed op — all three additions work on both backends.

---

## Component 1 — `prism` twist/taper

Extend the existing make-op (in both backends) to accept an options object. Fully
backward-compatible: omitting the options reproduces today's straight extrude.

Signature: `k.prism(points2D, h, { twist = 0, scaleTop = 1 } = {})`

- `twist` — degrees of rotation applied progressively from the bottom face (0°) to the
  top face. Positive = CCW looking down +Z.
- `scaleTop` — uniform scale of the top profile relative to the bottom: `1` = straight,
  `<1` = taper inward (draft angle / tapered standoff), `0` = converge to a point (cone
  from the profile). Negative is rejected with a clear error.

Backends:
- **Manifold:** `crossSection.extrude(h, nDivisions, twistDegrees, scaleTop)`.
  `nDivisions` is derived from the twist so a twisted extrude meshes smoothly — e.g.
  `Math.max(1, Math.ceil(Math.abs(twist) / 5))` (≈1 division when untwisted, finer as the
  twist grows). `scaleTop` is passed as a scalar (uniform).
- **OCCT/replicad:** the sketched profile is extruded with a twist angle and an end-scale.
  Use replicad's extrude with `twistAngle: twist` and an `extrusionProfile` whose
  `endFactor` is `scaleTop` (linear profile), or the equivalent `twistExtrude`. The result
  is a Shape3D as today.

Both default to a plain extrude when `twist === 0 && scaleTop === 1` (preserve the exact
current code path to avoid perturbing existing parts).

## Component 2 — `s.scale(factor, center?)`

A uniform affine scale on `Solid`, peer of `translate`/`rotate`/`mirror`.

Signature: `s.scale(factor, center = [0, 0, 0]) => Solid`

- `factor` — a single positive number; the solid is scaled uniformly in X/Y/Z.
- `center` — the fixed point of the scaling; defaults to the world origin.
- **Non-uniform scaling is intentionally not supported** — replicad's scale is
  uniform-only and a non-uniform B-rep scale would break STEP. `factor` is a scalar.

Backends:
- **Manifold:** scales about the origin via `m.scale([f, f, f])`. For a non-origin
  `center`, compose: translate by `-center`, scale, translate by `+center` (all tracked
  like the existing `rotate` implementation, which already does center-offset compose).
- **OCCT/replicad:** `shape.scale(factor, center)` (replicad takes a center point).

Documented behaviour: scaling an off-origin part about the default origin also moves it
(distance from origin scales too). Pass `center` (e.g. the part's `boundingBox().center`)
to resize in place.

## Component 3 — `circleProfile(r, center?, segs?)`

A pure 2-D profile generator exported from `partforge/geometry`
(`src/framework/geometry/polygon.js`), in the same family as `piePolygon`, `hexPolygon`,
`roundedRectPolygon`, `ellipsePolygon`.

Signature: `circleProfile(r, center = [0, 0], segs = 48) => number[][]`

- Returns a CCW closed polygon approximating a circle of radius `r` centered at
  `center = [cx, cy]`, with `segs` segments.
- Composes with the kernel make-ops that take a 2-D profile:
  - `k.revolve(circleProfile(minorR, [majorR, 0]))` → a torus (the documented recipe that
    replaces a torus primitive; `majorR > minorR` for a non-self-intersecting ring —
    revolve already rejects negative radii).
  - `k.prism(circleProfile(r), h)` → a cylinder; `k.prism(circleProfile(r), h, { scaleTop: 0 })`
    → a cone; etc.
- The center offset is the capability `ellipsePolygon` lacks; this is why a dedicated
  helper (rather than reusing `ellipsePolygon(r, r)`) earns its place.

## Probe / routing

- `scale` → add to the probe Solid proxy (returns the chainable proxy).
- `prism`'s new options need no probe change (the probe's `prism` already returns the
  proxy and ignores arguments).
- `circleProfile` is a pure helper (no kernel/probe involvement).
- None of the three is OCCT-only → no change to `OCCT_ONLY` / backend routing.

## Error handling

- `prism`: `scaleTop < 0` throws (`prism: scaleTop must be ≥ 0`). `scaleTop === 0` is
  valid (converges to a point).
- `scale`: `factor <= 0` throws (`scale: factor must be > 0`).
- `circleProfile`: `r <= 0` throws (`circleProfile: r must be > 0`).
- Torus self-intersection is the caller's responsibility via the recipe; `revolve`
  already rejects negative profile radii (a circle at `[majorR,0]` with `minorR > majorR`
  would cross the axis — documented as the `majorR > minorR` requirement).

## Testing

- **`circleProfile`** (pure, Node — extend `test/profiles.test.js`):
  - CCW (positive signed area); `segs` vertices; every point at distance `r` from
    `center`; bounding box spans `2r` centered on `center`; `r <= 0` throws.
- **`prism` twist/taper** (Manifold + OCCT, in their separate backend test files):
  - `scaleTop < 1` yields less volume than the straight extrude of the same profile/height;
    `scaleTop: 0` still meshes (a cone, positive volume); a twisted extrude has positive
    volume and a sane bounding box; `scaleTop < 0` throws.
- **`scale`** (Manifold + OCCT):
  - `scale(2)` multiplies volume by ~8 (uniform 3-D); `scale(2, center)` about the solid's
    own `boundingBox().center` leaves the bbox center unchanged (resize in place);
    `factor <= 0` throws.
- **Composition** (Manifold): `revolve(circleProfile(minorR, [majorR, 0]))` yields a torus
  whose volume ≈ Pappus `2·π²·majorR·minorR²` — verifying the torus recipe end-to-end
  without a torus primitive.

## Files touched (anticipated)

| File | Change |
|---|---|
| `src/framework/geometry/kernel.js` | typedef: `prism` opts, `scale` on Solid |
| `src/framework/geometry/manifold-backend.js` | `prism` twist/taper; `scale` |
| `src/framework/geometry/occt-backend.js` | `prism` twist/taper; `scale` |
| `src/framework/geometry/polygon.js` | `circleProfile` |
| `src/framework/geometry/probe.js` | `scale` proxy entry |
| `docs/AUTHORING-PARTS.md` | document `prism` opts, `scale`, `circleProfile`, torus recipe |
| `test/profiles.test.js` | `circleProfile` tests |
| `test/manifold-backend.test.js`, `test/occt-backend.test.js` | prism twist/taper + scale + torus-recipe tests |
