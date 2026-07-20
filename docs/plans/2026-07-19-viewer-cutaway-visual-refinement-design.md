# Viewer Cutaway Visual Refinement Design

## Context

The viewer cutaway feature is complete and available on the
`codex/viewer-cutaway` branch. Interactive review identified four related visual
and interaction refinements:

- make the engineering hatch denser and finer;
- match hatch ink to the viewer's feature-edge color;
- show rotation controls only on the clipped-away side of the plane; and
- make all visible handles occlude one another according to depth while keeping
  the widget visible over part geometry.

The translucent plane also needs a small visual offset into empty space to avoid
z-fighting without moving the mathematical clipping plane.

## Decisions

### Hatch appearance

The hatch shader receives the same theme-dependent color used by the viewer's
feature edges: `0x1c232d` in dark mode and `0x33414f` in light mode. The viewer
remains the source of truth for these colors rather than duplicating a palette in
the cutaway renderer.

Hatch frequency increases fivefold. Because the stripe duty cycle stays the
same, both the physical stripe thickness and the physical gap become one-fifth
of their current size. The hatch remains plane-local, antialiased, procedural,
and anchored in millimetres.

### Empty-side half-arcs

Each visual rotation ring becomes a half torus whose vertices lie only on the
clipped-away side of the plane. Each invisible pointer proxy uses the same
half-torus arc, with its existing larger tube radius for touch tolerance. Hidden
arc halves therefore cannot intercept pointer input.

Flip moves both visual arcs and both hit proxies to the new clipped-away side.
The translation arrow stays centred on the true plane normal and retains its
existing hit priority near the projected widget centre.

### Depth-aware widget overlay

Visible handles render in a dedicated overlay scene after the main viewer scene.
The viewer clears depth once before rendering this overlay. The red arc, blue
arc, and green translation arrow then use ordinary depth testing and depth
writes, so whichever handle surface is closer to the camera covers the others.
Clearing only before the overlay preserves the current always-available widget
behavior over part geometry.

The translucent plane fill and border remain in the main scene. The controller
continues to own the overlay scene, its geometry, materials, pointer listeners,
and disposal. The overlay pass runs only while cutaway is enabled.

### Ghost-plane offset

Only the visible fill and border move slightly along the plane's local normal
into the clipped-away side. The offset scales with the plane size and is clamped
to a small millimetre range so it remains effective without looking detached.
Flip reverses the offset direction.

The `THREE.Plane`, stencil caps, hatch cap position, handle origin, visibility
predicate, and exports remain on the exact mathematical cut plane.

### Optional smoke compatibility

The smoke runner stays strict by default and continues to require Cutaway on the
three cutaway examples. It gains an explicit `--allow-no-cutaway` option for
legacy or purpose-built fixtures that intentionally omit optional cutaway
chrome. CI uses that option only for `text-smoke.html`.

## Data flow

Theme changes pass the viewer's current feature-edge color through the cutaway
controller to every cap material. Pose, size, and flip changes update the
mathematical plane, cap pose, empty-side arc orientation, and visual ghost offset
in one controller transaction. The normal render loop draws the main scene, then
asks the cutaway controller to render its overlay only when enabled.

No refinement sends geometry-worker messages or changes cached solid geometry.

## Failure handling and compatibility

- Unsupported stencil contexts keep Cutaway disabled and never render the
  overlay.
- Missing optional cutaway chrome remains supported.
- The overlay renderer is a no-op when disabled or disposed.
- All new resources are disposed idempotently with the existing controller.
- Existing pointer cancellation and OrbitControls restoration remain unchanged.
- Smoke checks without the explicit compatibility option still fail if Cutaway
  is absent, disabled, or visually inert.

## Testing and acceptance

Automated tests will verify:

- feature-edge hatch colors in both themes;
- fivefold hatch frequency with unchanged stripe duty cycle;
- half-arc visual and hit geometry restricted to the empty side before and after
  Flip;
- red, blue, and green handle depth-test/depth-write configuration;
- main-scene, depth-clear, and overlay render order;
- scale-aware ghost offset direction while the mathematical plane is unchanged;
- strict and `--allow-no-cutaway` smoke exit behavior; and
- disposal and inactive-render no-ops.

Final acceptance includes the full Node 24 suite, production build, all CI smoke
pages, and interactive Chromium inspection at multiple orientations, zooms,
themes, and flips.
