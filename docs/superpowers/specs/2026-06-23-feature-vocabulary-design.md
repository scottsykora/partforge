# Feature vocabulary expansion — design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Scope:** Add semantically meaningful geometry operations to the partforge kernel so
LLMs authoring parts can express intent directly (revolve a profile, pattern N holes,
hollow a wall) instead of hand-rolling unions of transformed primitives.

## Motivation

The kernel today exposes `cylinder`, `box`, `prism`, `helixSweptTube`, `union`,
boolean/transform ops, and OCCT-routed `fillet`/`chamfer`. That covers a lot, but an
LLM still has to hand-build common shapes (turned parts, rounded rectangles, bolt
circles, hollow housings) out of low-level primitives — error-prone and verbose.

This change adds a focused batch of higher-level, intent-revealing operations. The
governing constraint is the dual-backend contract: an op must work on **both** Manifold
(fast meshes — preview, STL, 3MF) and OCCT/replicad (exact B-rep — STEP), **or** route
to OCCT through the existing capability probe the way `fillet`/`chamfer` do. Keeping ops
backend-agnostic preserves STEP export for parts that use them.

## In scope

- `sphere` primitive
- `revolve` (lathe profile around Z)
- `clone()` on `Solid`
- `boundingBox()` query on `Solid`
- `shell` (OCCT-routed) on `Solid`
- 2D profile helpers: `roundedRectPolygon`, `regularPolygon`, `ellipsePolygon`,
  `slotPolygon`, `starPolygon`, `ringSectorPolygon`
- pattern helpers: `linearPattern`, `circularPattern`

## Out of scope (deferred)

- `twist`/`taper` extrude options on `prism`
- `torus` primitive (derivable from `revolve` once it lands)
- non-uniform `scale` (Manifold-only; would break STEP)
- convex `hull` (Manifold-only; would break STEP)

These are noted for a possible later batch; they are not part of this plan.

---

## Section 1 — Kernel contract changes

Documented in `src/framework/geometry/kernel.js` (the `@typedef` contract).

### New `GeometryKernel` make-ops (both backends)

| Call | Result |
|---|---|
| `k.sphere(r)` | sphere centred at the origin |
| `k.revolve(points2D, { degrees = 360 })` | revolve a lathe profile `[[r, z], …]` (r ≥ 0) around the Z axis |

### New `Solid` methods

| Call | Backends | Result |
|---|---|---|
| `s.clone()` | both | independent copy of the solid |
| `s.boundingBox()` | both | `{ min:[x,y,z], max:[x,y,z], center:[x,y,z], size:[x,y,z] }` — query only, no geometry change |
| `s.shell(thickness, openFaces)` | **OCCT-routed** | hollow inward (wall = `thickness`, outer dimensions preserved); `openFaces` selector chooses which face(s) to open. **`openFaces` is required** — replicad's `shell` removes faces and exposes no clean 3D solid-offset, so a fully-closed hollow void is **deferred** (out of scope for this batch). |

**`boundingBox` return shape:** returns all four of `min`/`max`/`center`/`size`.
`center` and `size` are derived from `min`/`max` but returned pre-computed because the
LLM-facing use case ("place a feature at the top-face centre") wants them directly, and
deriving them at every call site is exactly the kind of arithmetic that drifts out of
sync.

**`clone()`:** added primarily so the pattern helpers can make N independent copies
despite replicad consuming a solid on transform. It is also independently useful and the
OCCT backend already clones internally (`safeOp`, `validChamfer`).

**`shell` capability routing:** `shell` joins `fillet`/`chamfer` as an OCCT-only op. The
Manifold backend's `shell` throws `KernelCapabilityError("shell requires the OCCT
backend")`; the probe (Section 5) detects the call and routes the whole part to OCCT.

**`shell` open-face requirement (refined during planning):** replicad's `shell` is the
open-shell (`MakeThickSolidByJoin`) variety — it requires at least one face to remove and
exposes no clean 3D solid-offset. So `openFaces` is **required**, and a fully-closed
hollow void is **deferred** (not part of this batch). Calling `shell` without `openFaces`
throws a clear error.

---

## Section 2 — `revolve` backend mapping

Convention: profile is 2D `[[r, z], …]` (r = radius ≥ 0, z = height), revolved around
the Z axis. This matches partforge's Z-up convention (`cylinder` along +Z, `prism` from
z=0). `degrees` defaults to `360`.

- **Manifold:** profile points become a `CrossSection` (`x = r`, `y = z`);
  `Manifold.revolve(cs, segs, degrees)` spins around the Y axis, so the result is then
  reoriented Y-up → Z-up. Segment count follows the existing `SEGS[quality]` used by
  `cylinder`.
- **replicad/OCCT:** draw the profile on the XZ plane, sketch it, and revolve around the
  Z axis (`revolution` with center `[0,0,0]`, direction `[0,0,1]`, `angle = degrees`).

Partial revolves (`degrees < 360`) produce a wedge with flat end-caps on both backends.

**Validation:** the profile is expected to be a valid closed loop in the r/z half-plane.
Negative `r` is **rejected** with a clear error (`revolve: profile radius must be ≥ 0`)
rather than silently clamped, since a negative radius almost always indicates an authoring
mistake.

---

## Section 3 — 2D profile helpers

Pure JS, exported from `partforge/geometry` (alongside `piePolygon`/`hexPolygon` in
`src/framework/geometry/polygon.js`). Each returns a CCW `[[x,y], …]` array suitable for
`k.prism` or `k.revolve`. Zero backend dependency — identical on both kernels.

| Helper | Signature | Notes |
|---|---|---|
| `roundedRectPolygon(w, h, r, segs?)` | rectangle `w × h` centred at origin, radius-`r` corners | `r` clamped to `min(w,h)/2` |
| `regularPolygon(n, r, { flat? })` | n-gon, circumradius `r` | `flat: true` = flat side up; default vertex up |
| `ellipsePolygon(rx, ry, segs?)` | ellipse with semi-axes `rx`, `ry` | |
| `slotPolygon(length, r, segs?)` | stadium/obround: two `r` semicircles `length` apart | overall length = `length + 2r` |
| `starPolygon(points, outerR, innerR)` | star with `points` tips | alternates outer/inner radius |
| `ringSectorPolygon(innerR, outerR, arcDeg, segs?)` | annular sector as one closed contour | **arcDeg < 360 only** |

**`ringSectorPolygon` limitation:** it covers arcs strictly less than 360°. A full
annulus is a contour-with-hole, which `prism` does not accept — for a full ring, cut an
inner cylinder from an outer one. This is documented explicitly so an LLM does not reach
for a 360° ring sector.

`segs` parameters default consistently with `piePolygon` (32) where applicable.

---

## Section 4 — Pattern helpers

Pure JS, exported from `partforge/geometry`. Both take a `Solid`, call `clone()`
internally for each copy, and **return `Solid[]`**. The caller composes the result —
`k.union(...)` for additive features, `s.cutAll(...)` for holes — so the helpers are
orthogonal to whether you are adding or subtracting material.

| Helper | Signature |
|---|---|
| `linearPattern(solid, count, step)` | copies at `0, step, 2·step, …`; `step` is `[dx,dy,dz]` |
| `circularPattern(solid, count, opts)` | `count` copies evenly around an axis |

`circularPattern` options:

```js
circularPattern(solid, count, {
  center = [0, 0, 0],   // axis passes through this point
  axis = "Z",           // "X" | "Y" | "Z"
  angle = 360,          // total sweep; copies spaced angle/count apart
  rotateCopies = true,  // re-orient each copy (true) or translate to positions only (false)
})
```

- **`angle` default `360`:** copies are spaced `angle / count` apart, so the last copy is
  **not** coincident with the first (a full circle of `count` distinct copies).
- **`rotateCopies` default `true`:** each copy is rotated to face along the circle.
  `false` translates copies to their positions without re-orienting them — for radially
  symmetric tools (e.g. round holes) you do not want spun.

Worked example (docs):

```js
const hole = k.cylinder(2, 2, 20).translate([20, 0, 0]);
body = body.cutAll(circularPattern(hole, 8, { axis: "Z" }));   // 8 bolt holes on a 40mm circle
```

---

## Section 5 — Routing, face-selector, testing

### Face selector

New module `src/framework/geometry/face-selector.js`, mirroring `edge-selector.js`. Maps
the declarative selector `{ inPlane, at } / { dir } / { near }` (and a raw finder escape
hatch) to a replicad `FaceFinder`. Only OCCT needs it, since `shell` is the only
face-selecting op and it is OCCT-only.

### Probe routing (`probe.js`)

- Add `shell` to the `OCCT_ONLY` set.
- Add proxy/kernel entries so the probe records the new ops without error: `sphere`,
  `revolve` (kernel make-ops → return the chainable proxy), and `clone`, `boundingBox`,
  `shell` (Solid ops). `clone` returns the proxy; `boundingBox` returns a dummy box
  (`{ min:[0,0,0], max:[1,1,1], center:[0.5,0.5,0.5], size:[1,1,1] }`); `shell` returns
  the proxy. Only `shell` forces OCCT.

### Shell OCCT implementation

`shell` hollows inward (wall = `thickness`, outer dimensions preserved). It validates the
result with the existing `isClosedSolid`/`measureVolume` guards and falls back gracefully
(feature skipped with a console warning) like `chamfer`, rather than letting the whole
part vanish on an out-of-range thickness or awkward face interaction.

### Docs

Extend `docs/AUTHORING-PARTS.md`:
- Add `sphere`/`revolve` to the "make solids" table and `clone`/`boundingBox` to the
  `Solid` table.
- Add `shell` to the OCCT-routed op table next to `fillet`/`chamfer`, with the same
  "forces OCCT" caveat.
- Add a short "profiles & patterns" subsection covering the new `partforge/geometry`
  helpers, including the `ringSectorPolygon` full-ring caveat.

### Tests

Following the existing Manifold/OCCT split (separate files — the two kernels must not boot
in the same process):

- **`sphere`** — Manifold mesh sanity + volume ≈ `4/3·π·r³`.
- **`revolve`** — mesh sanity; volume parity against an equivalent `cylinder` (e.g. a
  rectangular r/z profile revolves to a known cylinder volume); a Pappus-style check on a
  non-trivial profile.
- **`boundingBox`** — against known dimensions of a box/cylinder; `center`/`size`
  consistency with `min`/`max`.
- **profile helpers** — point arrays are CCW, closed, expected vertex counts; a revolved
  or extruded profile meshes to positive volume.
- **pattern helpers** — `Solid[]` length = `count`; placement/spacing correct;
  `rotateCopies` true vs false differ as expected.
- **`shell`** — produces the expected wall (volume drop matches a thickness-`t` hollow);
  closed void vs open-face cases; routes to OCCT via the probe; Manifold `shell` throws
  `KernelCapabilityError`.

---

## Files touched (anticipated)

| File | Change |
|---|---|
| `src/framework/geometry/kernel.js` | contract typedef: new make-ops + Solid methods |
| `src/framework/geometry/manifold-backend.js` | `sphere`, `revolve`, `clone`, `boundingBox`; `shell` throws capability error |
| `src/framework/geometry/occt-backend.js` | `sphere`, `revolve`, `clone`, `boundingBox`, `shell` |
| `src/framework/geometry/face-selector.js` | **new** — selector → replicad `FaceFinder` |
| `src/framework/geometry/polygon.js` | new profile + pattern helpers |
| `src/framework/geometry/probe.js` | record new ops; `shell` ∈ `OCCT_ONLY` |
| `docs/AUTHORING-PARTS.md` | document new vocabulary |
| `test/…` | new Manifold + OCCT test files per the testing plan |
