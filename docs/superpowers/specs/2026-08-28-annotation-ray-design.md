# Annotation Ray Helpers — Design

**Date:** 2026-08-28
**Status:** Approved for planning
**Depends on:** the ANNOTATION_VERSION 3 payload as shipped in PR #178
(`summary`/`frames`/`id`/`rotDeg`/anchor `run`/rounded camera — this spec
extends that shape additively).

## Goal

Let an agent that receives a sketch annotation payload place geometry in
part-space millimetres without reimplementing camera projection math. Two
pieces:

1. **Embedded rays**: every anchor in the payload carries a precomputed
   pick ray in the parts frame, so the common case ("what does this anchor
   point at, on plane P?") needs only a trivial ray–plane intersection —
   even when the anchor's `hit` is `null` because the stroke was drawn over
   empty space.
2. **Reconstruction helpers** on `partforge/oracle`: `annotationRay` builds
   the same ray for *any* screen point (a circle's rim, a grid over a
   region — points that have no anchor), and `rayPlane` intersects a ray
   with a plane. Pure JS, importable from Node (CLI agents) and the browser
   worker alike.

## Non-goals (explicitly out of scope)

- No whole-element projection (`sketchFrame` / `elementToContour` — the
  "Tier 2" bridge). This spec is points and rays only.
- No new Shape2D surface. Existing primitives (`circleProfile`,
  `pathProfile`, booleans) compose with the returned mm points as-is.
- No payload version bump: everything here is additive within
  ANNOTATION_VERSION 3.

## Why this is correct: the frame guarantee

`raycastViewer`'s `pointLocal` is `parent.matrixWorld⁻¹ · worldPoint`
(worldToLocal through the mesh followed by re-applying `mesh.matrix`
cancels the mesh's own transform), and `cameraBlock()`'s `parts` frame maps
the camera through the same `parent.matrixWorld⁻¹`. Both therefore live in
the shared CAD frame that `build(k, p, d)` models in. A ray reconstructed
from `camera.parts` — or embedded at send time through the same inverse —
intersects planes in the same millimetre coordinates the agent builds
geometry in, and survives later rebuilds (the parts frame is pinned to the
CAD geometry, unlike `world`).

## Part 1: embedded per-anchor rays

### Payload shape

Each entry of `elements[].anchors[]` gains one field:

```jsonc
{
  "at": "mid",
  "run": 0,
  "screen": [0.3031, 0.55],
  "ray": { "origin": [54.6431, 6.8787, 47.7073], "dir": [-0.6041, -0.0761, -0.7933] },
  "hit": null
}
```

- `origin` is millimetres in the **parts frame**; `dir` is a unit vector in
  the same frame (unit within the 4-decimal rounding).
- Both arrays are rounded to 4 decimals, matching the camera block.
- **Omission rule:** `ray` is omitted entirely (key absent, not `null`)
  when `camera.parts` is `null` — the no-meshes case, the same condition
  under which no `hit` can exist. World-frame rays are deliberately not
  emitted as a fallback: a payload with no parts frame has no CAD frame to
  build in, and a consumer that needs the world ray can reconstruct it with
  `annotationRay(payload, screen, { frame: "world" })`.

### `frames` legend addition

One new key in `FRAME_LEGEND` (annotate-mode.js):

```
"elements[].anchors[].ray":
  "origin (mm) and unit dir in the parts frame — intersect with a plane
   (partforge/oracle's rayPlane) to place sketch geometry; present only
   when the model had meshes at send time"
```

### Implementation seam

In `annotate-mode.js`:

- Extract the parts-parent inverse lookup out of `cameraBlock()` into a
  local `partsInverse()` helper returning the `THREE.Matrix4` inverse of
  the shared parts parent's `matrixWorld`, or `null` when there are no sub
  meshes. `cameraBlock()` and the anchor loop both call it (once per send,
  cached in a local).
- For each anchor, build the ray from the **live camera** — not from the
  rounded payload numbers — via `THREE.Raycaster.setFromCamera(ndc,
  viewer.camera)` with `ndc = (2·sx − 1, 1 − 2·sy)`, the exact code path
  that produced `hit`.
- **Canonicalize the origin** before emitting: slide it to the point on the
  ray line nearest the camera position —
  `origin += dir · ((camPos − origin) · dir)`. For a perspective camera
  this is a no-op (the origin already is `camPos`); for an orthographic
  camera it moves the origin from three's near plane back to the plane
  through the camera position. This makes the embedded ray *definitionally
  identical* to `annotationRay`'s output (whose orthographic origin sits on
  that same plane), so the two can be compared directly in tests, and
  `rayPlane`'s behind-origin check means the same thing for both.
- Transform `origin` by the inverse matrix (`applyMatrix4`) and `dir` by
  `transformDirection` (the transform is rigid, so directions are exact),
  then round to 4 decimals.
- Embedded rays and hits are therefore consistent by construction (same
  camera, same matrices, same frame); origin canonicalization only moves
  the origin along the line, which no intersection result depends on.

## Part 2: oracle helpers

### Placement

New leaf module `src/framework/oracle/annotation-ray.js`. Constraints it
inherits from its folder (enforced by `test/worker-layering.test.js`):
DOM-free, `three`-free, `node:`-free, no eager heavy imports. It is pure
vector math on arrays — no dependencies at all.

Re-exports:
- `src/oracle.js` (the published `partforge/oracle` entry) adds
  `annotationRay` and `rayPlane`; `test/oracle-entry.test.js`'s surface
  pinning is updated to include them.
- `src/testing.js` inherits both via its wholesale oracle re-export —
  no edit needed there.

### `annotationRay(payload, screen, { frame = "parts" } = {})`

Returns `{ origin: [x, y, z], dir: [x, y, z] }` — `dir` unit length,
millimetres, in the requested frame.

**Inputs.**
- `payload` — an ANNOTATION_VERSION 3 payload (or any object carrying
  `camera` and `viewport` of that shape). Version is not checked; the shape
  is.
- `screen` — `[sx, sy]`, each in 0..1, y down (the anchors' screen frame),
  **or** any object with a `screen` array of that form, so
  `element.anchors[i]` can be passed directly.
- `frame` — `"parts"` (default) or `"world"`.

**Errors** (all thrown as `Error`, messages exact):
- `annotationRay: payload.camera.parts is null — the sketch was sent with no meshes (use { frame: "world" })`
  when `frame === "parts"` and `payload.camera.parts` is `null`.
- `annotationRay: frame must be "parts" or "world"` for any other frame value.
- `annotationRay: screen must be [x, y] with each in 0..1` when `screen`
  (after unwrapping `.screen`) is not a 2-array of finite numbers in
  [0, 1]. Exact 0 and 1 are legal (viewport edges).
- `annotationRay: payload has no camera/viewport block` when
  `payload.camera?.[frame]` (other than the null-parts case above) or
  `payload.viewport?.aspect` is missing.

**Math.** With `cam = payload.camera[frame]` and
`aspect = payload.viewport.aspect`:

1. Basis, orthonormalized exactly as three's `lookAt` does:
   `forward = normalize(cam.target − cam.pos)`;
   `right = normalize(forward × cam.up)`;
   `trueUp = right × forward`.
2. NDC: `nx = 2·sx − 1`, `ny = 1 − 2·sy`.
3. Perspective (`cam.projection === "perspective"`):
   `t = tan(cam.fov · π/360)` (fov is vertical, degrees);
   `origin = cam.pos`;
   `dir = normalize(forward + right·nx·t·aspect + trueUp·ny·t)`.
4. Orthographic (`cam.projection === "orthographic"`):
   `halfH = cam.orthoHeight / 2`; `halfW = halfH · aspect`;
   `origin = cam.pos + right·nx·halfW + trueUp·ny·halfH`;
   `dir = forward`.

**Stated caveats (documented in the module header and the docs section):**
- `orthoHeight` already folds camera zoom in (send() divides by zoom);
  perspective assumes zoom 1, which is what the viewer uses (orbit controls
  dolly a perspective camera, never zoom it).
- Payload numbers are rounded to 4 decimals, so a reconstructed ray agrees
  with the live raycaster (and with the embedded `ray`) to ~1e-4 relative —
  sub-micrometre at part scale, and the test tolerance (below) encodes it.

### `rayPlane(ray, plane)`

Returns `{ point: [x, y, z], t }` or `null`.

**Inputs.**
- `ray` — `{ origin, dir }` (either an embedded payload ray or an
  `annotationRay` result; `dir` need not be exactly unit — it is used as
  given, and `t` is in units of `|dir|`).
- `plane` — `{ point: [x, y, z], normal: [x, y, z] }` in the ray's frame,
  or a shorthand string for the origin planes:
  `"xy"` → `{ point: [0,0,0], normal: [0,0,1] }`,
  `"yz"` → `{ point: [0,0,0], normal: [1,0,0] }`,
  `"zx"` → `{ point: [0,0,0], normal: [0,1,0] }`.

**Semantics.**
- `denom = dir · normal`; if `|denom| < 1e-9` the ray is parallel →
  `null`.
- `t = ((plane.point − origin) · normal) / denom`; if `t ≤ 1e-6` the
  intersection is at or behind the ray origin → `null`. (For perspective
  rays "behind the camera" is meaningless to a sketch; for orthographic
  rays the origin sits on the camera plane far outside the model, so any
  legitimate model plane is in front.)
- Otherwise `point = origin + dir·t`.
- Misses return `null`, not throws — the same miss semantics as the
  payload's `hit: null`.

**Errors:** `rayPlane: plane must be {point, normal} or "xy"|"yz"|"zx"` for
any other plane value; `rayPlane: ray must be {origin, dir}` for a
malformed ray. A zero-length `normal` or `dir` falls out as parallel →
`null` (no special case).

## Testing

All in new file `test/framework/oracle/annotation-ray.test.js` except the
payload tests, which extend `test/framework/annotate/annotate-mode.test.js`.

1. **Hand-computed unit tests** — perspective and orthographic rays at the
   viewport center (`[0.5, 0.5]` → dir along `forward`, ortho origin at
   `pos`), at corners, and with a non-axis-aligned camera; `rayPlane`
   against each shorthand plane, a custom plane, a parallel miss, and a
   behind-origin miss.
2. **Parity with three** (this test file may import `three` — it lives
   under `test/`, not `src/framework/oracle/`): for both projection types,
   build a real `THREE.PerspectiveCamera` / `OrthographicCamera`, compare
   `annotationRay` on a synthetic payload (unrounded camera numbers)
   against `THREE.Raycaster.setFromCamera` across a grid of screen points.
   Directions within 1e-6; origins compared **as lines** — apply the same
   nearest-to-camera canonicalization to three's ray origin (a no-op for
   perspective, the near-plane→camera-plane slide for orthographic), then
   compare within 1e-6.
3. **Embedded-ray consistency** (annotate-mode.test.js): a sent payload's
   anchor `ray` matches `annotationRay(payload, anchor)` within 5e-4 per
   component (both sides rounded to 4 decimals); `ray` is absent when the
   fixture has no sub meshes; `frames` carries the new legend key.
4. **Round-trip** (annotate-mode.test.js): for an anchor with a non-null
   `hit`, `rayPlane(anchor.ray, { point: hit.pointLocal, normal:
   annotationRay(payload, anchor).dir })` returns a point within 1e-2 mm of
   `hit.pointLocal` — the embedded ray, the reconstruction, and the live
   raycast agree on where the anchor lands.
5. **Surface pinning**: `test/oracle-entry.test.js` gains the two new
   exports; `test/worker-layering.test.js` passes unchanged (the new module
   imports nothing).

## Documentation

- `docs/AUTHORING-PARTS.md`: extend the annotation-payload section with a
  "reconstructing rays from a sketch payload" subsection — the anchor `ray`
  field, the omission rule, and the end-to-end example:

  ```js
  import { annotationRay, rayPlane } from "partforge/oracle";
  const anchor = payload.elements.find((e) => e.id === "e3")
    .anchors.find((a) => a.at === "center");
  const hit = rayPlane(anchor.ray ?? annotationRay(payload, anchor), "xy");
  // → boss where the sketched circle's center points, on the z=0 plane:
  //   k.prism({ points: circleProfile(r_mm, [hit.point[0], hit.point[1]]), h })
  ```

- `AGENTS.md`: one line in the annotate section noting anchors carry
  parts-frame rays and `partforge/oracle` has the
  `annotationRay`/`rayPlane` pair.
- Not a kernel op — `docs/KERNEL-CONTRACT.md` is untouched.

## Release note

Additive within ANNOTATION_VERSION 3 and within the oracle surface;
downstream (partforge-cloud) can adopt anchor rays opportunistically. Ships
as a normal minor version bump on whatever branch implements it (PR #178's
0.88.0 must land first — this builds on its payload shape).
