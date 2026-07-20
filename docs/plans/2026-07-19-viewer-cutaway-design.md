# Viewer cutaway mode — design

**Date:** 2026-07-19
**Status:** Approved
**Target branch:** `codex/viewer-cutaway`, based on `origin/main` at `ab88a1b`

## Summary

Add a viewer-only cutaway mode to partforge. A user can move and freely tilt one
plane across the current assembly. Geometry on one side is clipped in real time,
and the newly exposed section is rendered with a single 45-degree engineering
hatch so it cannot be mistaken for an original exterior face.

The effect is implemented entirely in the three.js viewer using local clipping,
stencil capping, and a procedural cap shader. It does not rebuild solids, send
worker jobs, invalidate geometry caches, or change STL, STEP, or 3MF exports.

## Goals

- Make internal geometry easy to inspect without changing the part definition.
- Keep plane manipulation immediate for both Manifold and OCCT-generated meshes.
- Clearly distinguish synthetic section faces from real exterior faces.
- Support one plane across every visible subpart in the active assembly.
- Provide a compact, discoverable, keyboard-accessible UI with direct manipulation.
- Keep the implementation modular and optional for embedded host applications.
- Preserve the existing inactive rendering path and viewer lifecycle.

## Non-goals

- Exporting cut geometry.
- Creating reusable cap triangles or changing the geometry-kernel contract.
- Selecting, labeling, or measuring the synthetic cap.
- Multiple simultaneous cut planes.
- Per-subpart cutaway inclusion controls.
- Persisting a cutaway pose between views, reloads, or mounts.
- Numeric plane-position or angle fields in the first version.

## Chosen approach

Use GPU local clipping plus per-subpart stencil caps. This follows the approach in
the official three.js `webgl_clipping_stencil` example and fits partforge's cached
mesh architecture.

Two alternatives were rejected:

1. CPU mesh slicing would create true cap meshes, but reconstructing robust loops,
   holes, nested shells, and coplanar cases on every drag is complex and can stall
   large meshes.
2. Worker-side CSG would produce a true cut solid, but would be too slow for direct
   manipulation—especially with OCCT—and would incorrectly couple an inspection
   feature to geometry generation and caching.

The cap is intentionally a render-time surface rather than part geometry.

## Architecture

Cutaway is a self-contained viewer capability with three layers.

### `src/framework/cutaway.js`

This module owns all three.js resources and interaction logic specific to the
feature:

- The stable world-space `THREE.Plane` used by clipped materials.
- Clipped material variants for part surfaces and feature lines.
- Per-subpart front/back stencil passes and cap meshes.
- The procedural hatch material.
- The translucent plane visualization and combined gizmo.
- Pointer capture, drag math, fade timing, and orbit-control coordination.
- Capability state, theme state, and full GPU/listener disposal.

It receives the renderer, scene, camera, orbit controls, visible subpart meshes,
and an assembly-bounds callback from `viewer.js`. It does not know about workers,
views, parameters, exports, or DOM chrome.

Its interface should remain small and semantic, along these lines:

```js
const cutaway = createCutaway({ renderer, scene, camera, orbitControls, getBounds });

cutaway.setSubpart(name, mesh, edgeLines);
cutaway.setVisible(names);
cutaway.setEnabled(on);
cutaway.reset();
cutaway.flip();
cutaway.setTheme(mode);
cutaway.isPointVisible(worldPoint);
cutaway.getClippingPlanes();
cutaway.dispose();
```

The exact names may change during implementation, but geometry ownership and
module boundaries should not.

### `src/framework/viewer.js`

The viewer remains the scene coordinator. It creates one cutaway controller,
notifies it when subpart geometry is installed, shown, hidden, or replaced, and
delegates a narrow public API:

- Enable/disable cutaway.
- Read whether cutaway is enabled and supported.
- Flip or reset the plane.
- Test whether a world point lies on the visible side.
- Return the active clipping planes for auxiliary viewer materials.

Cached `BufferGeometry` remains owned by the viewer cache. Stencil companions only
reference it and must never dispose it. When cached geometry is replaced, the
companions switch references before the old cache entry is released.

### `src/framework/cutaway-controls.js`

This module owns the optional DOM control. `mount.js` resolves
`elements.chrome.cutaway`, falling back to `#cutaway`, just as it resolves pause,
reframe, and theme. If the primary button exists, the controller creates a compact
adjacent action group for Flip and Reset while the mode is active. On detach it
removes its listeners and the generated action group.

The controller is responsible for `aria-pressed`, accessible labels, tooltips,
focus behavior, unsupported-state messaging, and Escape-to-exit. It does not
touch three.js objects directly.

Host pages that omit the cutaway element retain today's behavior. No new required
mount option is introduced.

### `src/framework/mount.js`

Mount wires the optional cutaway control to the viewer. On every view-tab change,
it turns cutaway off and discards the prior pose. The next activation computes a
new pose from the newly visible assembly.

Workers, backend detection, mesh validity, generation, and export remain unchanged.

## Interaction and UX

### Activation

The viewbar gains a section-view button. Enabling cutaway temporarily suspends
auto-rotation without changing the user's saved rotation preference. Disabling
cutaway restores the rotation state that existed at activation.

The initial plane:

- Passes through the current visible assembly's world-space bounding-box center.
- Faces approximately toward the camera so the first section is immediately legible.
- Extends beyond the assembly bounds by a modest margin.
- Uses a translucent themed tint and a crisp border.

If no visible geometry has bounds, activation is refused without throwing.

### Combined gizmo

The user selected one purpose-built combined gizmo rather than separate Move and
Rotate modes. It contains:

- One handle along the plane normal for forward/backward movement.
- Two rotation arcs around the plane's in-plane axes for arbitrary tilt.
- Larger invisible pointer targets around the visible handles for touch and
  trackpad usability.

Tangential translation is omitted because it does not change an infinite plane.
Rotation about the plane normal is also omitted because it does not change the
cut and would only rotate the decorative hatch.

The custom control uses pointer capture. Normal translation is solved from the
pointer ray and the normal axis; rotation is a signed angle on the appropriate
interaction plane. Starting a handle drag disables OrbitControls, and ending or
cancelling the drag restores them. Pointer gestures away from the gizmo continue
to orbit the camera normally.

### Plane visibility

The translucent plane is prominent during activation, hover, focus, and dragging.
After a short idle delay, its fill fades away while the border and subdued gizmo
remain. Hover or a new drag restores the fill. The cut and hatch remain visible
throughout.

### Secondary actions

While active, the viewbar reveals:

- **Flip:** invert the plane normal and constant together so the opposite half is
  removed without changing the geometric plane.
- **Reset:** return to the centered, camera-facing pose for the current assembly.

Escape exits cutaway while viewer interaction has focus. The main button exposes
`aria-pressed`; all actions are keyboard-operable and use the existing focus-ring,
theme, spacing, and touch-target language.

Changing the active view turns cutaway off. Reloading or remounting also starts
with cutaway off. Persistence can be reconsidered later without changing the
rendering core.

## Rendering design

### Clipped surfaces and lines

The renderer explicitly requests a stencil buffer and enables local clipping only
when needed. While active, each visible part mesh uses a material variant whose
`clippingPlanes` contains the one stable cut plane. The original material is
restored when the mode turns off.

Feature-edge `LineMaterial` instances and the hover-highlight material receive the
same clipping plane so they cannot draw over the removed half. Cutaway must preserve
per-subpart color and opacity overrides.

### Per-subpart stencil caps

Each visible subpart gets two colorless stencil meshes that share its geometry and
transform:

1. A back-face pass increments the stencil value.
2. A front-face pass decrements the stencil value.

A plane-aligned cap is drawn where that subpart leaves a nonzero stencil value.
The cap pass clears its stencil region before the next subpart, so separate solids
cannot cancel one another's winding counts. Render orders are explicit and keep
the sequence stable:

```text
stencil back/front passes
        -> hatched cap inside stencil
        -> clipped exterior surfaces
        -> clipped feature edges and hover overlay
        -> plane visualization and gizmo
```

Overlapping subparts are capped independently. Their normal depth relationship
determines which cap is visible, matching the assembly's visual layering.

### Procedural hatch

The cap uses a small shader material rather than a bitmap texture. Plane-local
coordinates generate one set of 45-degree diagonal lines. Shader derivatives
antialias the stripe edges.

Hatch spacing is calculated from the active assembly diagonal and clamped to a
reasonable millimetre range, producing roughly the same visual density across
small and large parts while remaining anchored to the plane. The cap base tint
follows the source subpart color; line contrast follows the active light/dark
theme. Transparent display overrides remain visually transparent rather than
becoming opaque at the cut.

The cap is not added to `_subMeshes`, so it is neither selection geometry nor an
exportable part.

### Geometry updates and lifecycle

Gizmo movement updates the same clipping plane and cap transform in place. It
never sends a worker message.

When `setSubGeometry` replaces a cached geometry, cutaway companions switch to the
new reference. Cutaway disposes only resources it creates: cloned materials,
stencil materials and meshes, cap geometry/materials, plane visualization, gizmo
resources, listeners, and timers. Cached part geometry remains solely under the
existing viewer cache's ownership.

Inactive cutaway has no extra draw passes. Active cutaway adds approximately three
draws per visible subpart: two stencil passes and one cap pass.

## Raycasting and hover

GPU clipping does not alter `THREE.Raycaster` intersections. `raycastViewer` will
therefore filter candidate hits through an optional viewer predicate such as
`isWorldPointVisible(point)`.

While cutaway is active, hits on the removed side are skipped and the next retained
surface along the ray may be selected. When cutaway is inactive or the predicate
is absent, raycasting behaves exactly as it does today.

The synthetic cap is deliberately not raycastable. Hover-highlight geometry is
clipped with the same plane so a retained feature cannot highlight triangles on
the removed side.

## Failure handling and edge cases

- Request and verify a stencil-capable WebGL context. If unavailable, leave the
  control disabled with a concise explanatory tooltip. Do not fall back to a
  hollow cut that would misrepresent solid interiors.
- A plane beyond the assembly, a plane that intersects nothing, and a plane that
  removes the entire assembly are valid states. Reset provides recovery.
- Pointer cancellation, lost pointer capture, window blur, and disposal all end
  an active drag and restore OrbitControls.
- Cutaway assumes closed, consistently wound solids, as partforge normally emits.
  Non-watertight custom meshes may produce incomplete caps; clipping should still
  fail safely without throwing.
- Theme changes update plane, border, handle, and hatch colors in place.
- Geometry regeneration during an active cutaway keeps the current pose but swaps
  the stencil geometry references. A view change is the event that disables and
  resets cutaway.

## Testing strategy

### Pure unit tests

Extract pose and interaction math so it can be tested without WebGL:

- Initial camera-facing pose at the assembly center.
- Normal-axis translation.
- Two-axis rotations and normalized plane equations.
- Flip preserving the geometric plane while reversing the retained half.
- Reset.
- Assembly-relative hatch spacing and clamps.
- Visible-side point classification with tolerance at the plane.

### Three.js object tests without a GPU

Test construction and ownership of the render graph:

- Stencil functions, face sides, color/depth write flags, and render orders.
- One isolated stencil/cap set per subpart.
- Shared geometry references and safe geometry replacement.
- Surface, line, and auxiliary clipping material updates.
- Per-subpart color/opacity and theme propagation.
- Idempotent disposal without disposing cached geometry.

### DOM and mount tests

Using the existing happy-dom setup, cover:

- Toggle state and `aria-pressed`.
- Flip/Reset action visibility and dispatch.
- Escape behavior and keyboard activation.
- Auto-rotation suspension and restoration.
- Missing optional controls and unsupported stencil state.
- Listener and generated-DOM cleanup.
- `elements.chrome.cutaway` and `#cutaway` fallback resolution.
- Cutaway disable/reset on view change.
- Viewer and control disposal through `mount().dispose()`.

### Selection tests

Extend raycast tests with multiple ordered intersections to prove removed-side hits
are skipped and retained hits remain selectable. Verify that behavior is unchanged
when no cutaway predicate exists.

### Browser smoke and manual visual acceptance

Exercise `demo.html`, `planter.html`, and `filleted-box.html` in real Chromium:

- Toggle, move, rotate, flip, reset, and exit without console or WebGL errors.
- Confirm no geometry-worker jobs occur during manipulation.
- Inspect caps through bores, shells, fillets, and multiple subparts.
- Confirm hatch clarity and edge clipping in light and dark themes.
- Confirm hover/picking ignores the removed half.
- Confirm resize behavior and touch-sized hit regions.
- Confirm a view change turns cutaway off.

## Documentation and host-page changes

- Add an optional `#cutaway` button to all three example viewbars.
- Add shared viewbar/action/gizmo styling to `src/framework/app.css` using existing
  `--pf-*` tokens.
- Extend the embedding section of `docs/AUTHORING-PARTS.md` with
  `elements.chrome.cutaway` and the `#cutaway` fallback.
- Keep structural HTML free of page-specific CSS.

No `PartDefinition`, geometry backend, kernel contract, worker message, cache key,
or export documentation changes are required.

## Acceptance criteria

1. A user can enable one assembly-wide cut plane, translate it along its normal,
   and freely tilt it using one combined direct-manipulation gizmo.
2. Geometry on one side disappears immediately during dragging without worker
   requests or mesh regeneration.
3. Every closed-solid cross-section is capped with a clean single 45-degree hatch,
   including sections containing holes.
4. Exterior feature edges, hover highlights, and raycast results respect the cut.
5. Flip and Reset work; Escape exits; view changes turn the mode off.
6. The plane fades from translucent fill to a subtle outline after interaction.
7. Light/dark themes and per-subpart display colors/opacities remain legible.
8. Omitting the optional cutaway element preserves current host behavior.
9. STL, STEP, and 3MF output are byte-for-byte unaffected by cutaway state.
10. Disposal leaves no listeners, timers, generated controls, or GPU resources.
