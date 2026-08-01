# Cutaway Cut-Face Outline and Axis Snapping

## Goal

Two changes to the cutaway view:

1. **Cut-face outline.** Draw a line around the boundary of every cut face, in
   the same visual language as the viewer's feature edge lines.
2. **Axis-aligned plane.** On enable and on reset, align the section plane with
   the canonical axis nearest the camera (±X, ±Y, ±Z) instead of with the camera
   direction itself. While rotating the gizmo, snap the plane to a canonical
   axis when it comes within 7 degrees of one.

## Background

The cut face today is a `PlaneGeometry` quad drawn with a screen-space hatch
shader and masked to the solid's cross-section by the stencil buffer
(`cutaway-render.js`). Nothing in the scene describes the boundary of that
cross-section geometrically; the mask is a per-fragment stencil test with no
neighbour access, so no shader can derive the boundary on its own. The
`2026-07-19` screen-space hatch design explicitly deferred the outline.

The viewer's feature edge lines are not shader-derived either. Manifold supplies
seam-aware edge segments with each mesh, and OCCT meshes fall back to
`THREE.EdgesGeometry` at a 35 degree dihedral threshold (`viewer.js`
`buildGeometry`). `LineMaterial` only renders those precomputed segments,
expanding them into screen-space quads so they antialias at a constant pixel
width. The cut-face outline follows the same shape: compute segments on the CPU,
render them with `LineMaterial`.

Parts in this framework are faceted CAD solids, not scanned meshes. The planter
assembly is 692 triangles. A plane/triangle scan at that size is microseconds,
and it only reruns when something moves.

## Part 1: Cut-face outline

### New module: `src/framework/cutaway-outline.js`

Two exports.

**`sectionSegments(geometry, plane, target?)`** — pure. Walks the geometry's
triangles, classifies each vertex by `plane.distanceToPoint`, and emits one
segment per crossing triangle from its two edge crossings. Returns a
`Float32Array` of `x,y,z` pairs suitable for `LineSegmentsGeometry.setPositions`.

- Handles indexed (OCCT) and non-indexed (Manifold) geometry.
- Classification uses the same `>= 0` keep-rule as `pointSurvivesPlane`, so the
  outline lands exactly where the GPU-clipped surface ends.
- A triangle lying in the plane emits nothing; its neighbours supply the
  boundary. Vertices within `POINT_EPSILON` (1e-6, the value `cutaway-math.js`
  already uses) of the plane count as on-plane and are classified consistently,
  so a grazing plane produces neither duplicate nor degenerate segments.
- A plane that misses the geometry returns an empty array.

**`createSectionOutline({ mesh, plane, inkColor, now })`** — owns one
`LineSegments2` parented to `mesh`, the same trick the stencil meshes use, so it
inherits every present and future transform including the pose fast path.
Slicing happens in mesh-local space: the world plane is transformed by the
inverse of `mesh.matrixWorld`. Returns `{ object, refresh, setInk, setVisible,
setViewportSize, lastSliceCost, dispose }`.

### What gets outlined

All boundary loops, not just the outer silhouette. A bore through the cut face
gets its own ring, as in a drafted section. This falls out of the slice for
free; restricting to the outer loop would require loop assembly plus containment
tests for a worse result.

### Styling

One `LineMaterial` per outline at 1 px, colored from the cutaway's **hatch ink**
and re-colored through the existing `setHatchInk` path, so it stays coupled to
the hatch rather than to the viewer's feature-line color. (The two are the same
value today.)

- `polygonOffset` toward the viewer, plus a `renderOrder` above the cap, so the
  coincident-depth line wins cleanly against the cap it sits in. A new
  `OUTLINE_ORDER_BASE` of 2,500,000 sits between the existing `EDGE_ORDER_BASE`
  (2,000,000) and `CUTAWAY_OVERLAY_RENDER_ORDER` (3,000,000), with the subpart's
  `order` added as usual.
- **No clipping plane on this material.** The outline lies at distance ~0 from
  its own plane; clipping it would speckle.
- When a ghost part's cap is transparent, the outline goes transparent too,
  mirroring what `createSectionRenderSet` already does for edges, so it stays in
  the same sorted draw list.

### Invalidation

The section moves for four reasons: the plane pose changes, geometry is
replaced, `viewer.frameTo` recentres `partsGroup` (the plane is world-fixed, so
recentring slides the part through it), and `setSubPose` re-poses a subpart.
Only the first two notify the cutaway today.

Rather than thread invalidation through `frameTo` and `setSubPose` and depend on
no fifth path appearing, each outline keeps a signature — plane normal and
constant, the 16 `matrixWorld` elements, the geometry reference — and re-slices
when it differs. The check runs where `cutaway.updateForCamera()` already runs
every frame while enabled (`viewer.js` render loop). It is roughly 21 float
compares per subpart, with a re-slice only when something genuinely moved.
`updateForCamera` keeps its name and gains a documented second responsibility as
the per-frame maintenance hook.

Visibility ties to the existing `updateHelperVisibility()`, so an unselected or
hidden subpart shows no outline.

Flipping does not change the intersection — same plane, opposite normal — so
flip costs nothing. Offscreen captures pick the outline up automatically because
it is an ordinary scene object.

### Suppression during drag

`createCutawayGizmo` gains an `onDragChange(active)` callback alongside
`onPoseChange` / `onActivity` / `onHandleHoverChange`. It fires `true` in
`onPointerDown` and `false` from `endDrag()`, the single funnel every
termination path already goes through (pointerup, pointercancel, lost pointer
capture, window blur, pointer leave), so an outline cannot be stranded hidden.

Each outline times its own slice with an injected `now` (default
`performance.now`), the dependency-injection style `createCutaway` already uses
for `schedule`, which makes the policy deterministic under test.

Policy:

- On drag start, sum the last measured slice cost across visible sections.
- If the total exceeds **2 ms** (~12% of a 60 fps frame; conservative because
  slicing rides on top of everything else that frame), hide all outlines for the
  duration of that drag.
- On drag end, re-slice and show.
- All-or-nothing, decided once at drag start from costs already measured, so the
  drag never pays a spike to discover it is too expensive and never shows some
  parts outlined and others not.
- Below budget — where every current demo part sits by a wide margin — outlines
  track the plane live.

## Part 2: Axis alignment and snapping

### `nearestCanonicalAxis(direction, target)`

New export in `src/framework/cutaway-math.js`. Returns the signed unit axis
(±X, ±Y, ±Z) nearest the given direction.

- Axes are scanned in X, Y, Z order and replaced only on a **strictly** greater
  `|dot|`, so ties resolve to the earlier axis. The default isometric framing
  (camera at 18, 12, 18) is an exact tie between -X and -Z and resolves to -X.
- A zero-length or non-finite direction returns +Z.

One definition of "nearest canonical axis" serves both the initial pose and the
rotation snapping.

### Initial pose

`initialCutawayPose` passes the camera's world direction through
`nearestCanonicalAxis` and uses the result as the plane normal. Position stays
the bbox centre; size stays diagonal × 1.25. The normal continues to point away
from the camera, so the near half is what gets cut away.

The plane pose is not persisted anywhere, so this applies to every enable and
every reset. Because `setFromUnitVectors` between two axis vectors is a 90 or
180 degree rotation, the plane's in-plane axes come out axis-aligned too, so the
gizmo reads square from the start.

### Rotation snapping

Both rotate paths in the gizmo's `onPointerMove` (`plane-rotate` and
`screen-rotate`) already compute a candidate quaternion before committing it.
Snapping inserts one step there:

1. Derive the candidate plane normal from the candidate quaternion.
2. Find the nearest canonical axis.
3. If the angle is within **7 degrees**, apply the minimal correction rotation
   carrying the normal onto that axis.

Minimal correction rather than rebuilding the quaternion from
`setFromUnitVectors` — that preserves the plane's in-plane roll, so the gizmo
rings do not visibly spin about the normal at the moment of snapping. Roll does
not affect the clip.

Holding **Shift** disables snapping, read from `event.shiftKey` on each move
rather than latched at pointer-down, so it can be pressed and released
mid-drag. Shift is unbound during a gizmo drag — `orbitControls.enabled` is
already false — so there is no conflict.

Translation is untouched. Only rotation snaps.

## Non-goals

- No GPU screen-space outline pass. It would need render-target plumbing
  mirrored into the offscreen capture path (where a missing `stencilBuffer`
  silently broke captures once already), it cannot be unit-tested headlessly, it
  aliases worse than fat lines, and screen-space edges do not occlude correctly
  behind nearer parts without carrying depth.
- No persistence of the cutaway plane pose.
- No translation snapping.
- No change to the hatch shader, exports, or geometry workers.

## Verification

Pure-function tests:

- `sectionSegments`: a box cut by an axis plane yields four segments forming the
  square; a box with a through-hole yields outer plus inner ring; indexed and
  non-indexed geometry agree; a plane grazing a vertex yields no duplicate or
  degenerate segment; a plane missing the geometry yields empty; the keep-rule
  agrees with `pointSurvivesPlane`.
- `nearestCanonicalAxis`: all six exact directions; near-axis directions; the
  isometric tie resolving to -X; zero and non-finite input falling back to +Z.
- `initialCutawayPose`: an isometric camera produces an axis-aligned normal and
  axis-aligned in-plane axes; the existing +Z-camera test still passes
  unchanged.

Controller and render-set tests:

- Outline visibility follows cap visibility and subpart selection.
- Ink color follows `setHatchInk`; viewport size reaches the outline's line
  material.
- Disposal releases the outline's geometry and material.
- The dirty check re-slices after a mesh transform change with no plane change.
- Flip leaves segments unchanged.
- Budget suppression hides outlines on drag start when the injected clock
  reports costs over budget, and restores them on drag end.

Gizmo tests:

- A rotate drag landing within 7 degrees of an axis snaps exactly onto it; at 8
  degrees it does not.
- Shift held during a move suppresses the snap.
- In-plane roll survives a snap.
- `onDragChange` fires on every termination path.

Then `npm test`, `npm run build`, and the Chromium smoke check.
