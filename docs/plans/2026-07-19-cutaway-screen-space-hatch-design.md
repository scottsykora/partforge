# Cutaway Screen-Space Hatch Design

## Goal

Keep the cutaway hatch visually stable while the user zooms, orbits, translates,
or rotates the section plane. The hatch should remain fixed at 45 degrees in
screen space, repeat every 5 CSS logical pixels, and use an approximately 1
CSS-logical-pixel line. These are macOS point-like units normalized by
`devicePixelRatio`. Its ink continues to match the viewer's theme-specific
feature-edge color.

An explicit cut-face outline is not part of this change.

## Rendering architecture

The cap shader will derive its hatch coordinate from `gl_FragCoord` instead of
the cap plane's UVs. It will normalize framebuffer coordinates by the renderer's
pixel ratio before projecting them onto a normalized 45-degree axis. This makes
the period and line width CSS-pixel values on both standard and high-density
displays.

The shader will use a fixed 5-CSS-logical-pixel period and
1-CSS-logical-pixel line-width uniforms or constants and derivative-based
antialiasing. Zoom, camera orientation, cut-plane pose, model size, and cap size
will not participate in hatch sizing or phase.

The existing theme flow remains responsible for the hatch ink. Dark and light
themes continue to use the same colors as the viewer's feature edges.

## Data flow

`viewer.resize()` will pass the renderer's current pixel ratio through the
existing cutaway viewport update. The cutaway controller retains the latest
viewport and pixel-ratio state and forwards it to every current section render
set. Newly added and replacement subparts receive the retained state
immediately.

The old model-space density path will be removed:

- cap UVs will no longer drive the hatch shader;
- `uScale` and model-size/spacing updates will be removed;
- diagonal-derived `hatchSpacing` will be removed from cutaway poses;
- cap size will control only the physical cap plane geometry.

Invalid or non-positive pixel-ratio values fall back to `1`.

## Lifecycle and compatibility

The change remains viewer-only and does not invoke geometry workers or alter
exports. Theme changes update hatch ink without replacing materials. Resizing or
changing display density updates the retained pixel ratio without rebuilding
part geometry. Disabled and disposed cutaway behavior remains unchanged.

## Verification

Automated tests will prove that:

- the shader uses `gl_FragCoord` and no longer depends on cap UV/model scale;
- the hatch period is 5 CSS logical pixels and the line width is approximately
  1 CSS logical pixel;
- renderer pixel ratio is normalized and can update in place;
- existing, future, and replacement render sets receive retained screen-space
  settings;
- zoom and cut-plane pose changes do not mutate hatch sizing;
- theme changes still update hatch ink;
- invalid pixel ratios fall back to `1`;
- disposal and disabled-cutaway behavior do not regress.

Final verification includes the focused cutaway tests, the full Vitest suite, a
production build, sequential Chromium smokes, and interactive zoom checks in
both light and dark themes.
