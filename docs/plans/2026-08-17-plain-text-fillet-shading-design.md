# Plain-Text Fillet Shading Design

## Goal

Remove the dark groove that runs down 0.3 mm Manifold fillets on the unbolded
Roboto `t` in the Scott label fixture, while preserving real corner creases,
fillet boundary lines, exported geometry, and mesh-backend performance.

## Root cause

The tangent-tool boolean produces long fan triangles only a few tens of microns
wide where fillet tools cross at glyph corners. Their surface relief is below the
rendering threshold, so PR #144 correctly suppresses their feature lines, but
`creasedNormals` still gives every sliver its own tilted face normal and gives
that normal full weight in adjacent vertex averages. The result is a prominent
unlined lighting stripe even when edge rendering is disabled. Bold text avoids
most of the symptom because its 0.4 mm outline offset changes the small terminal
radii and tool intersections.

## Chosen approach

Repair only the render normals. For a face below `MIN_FACE`, resolve each corner
against trustworthy non-thin faces incident at that vertex. Choose the compatible
smoothing surface whose supporting plane best fits the sliver, and use that
surface as the corner's crease reference and normal contribution. Thin faces do
not contribute their noisy normals to healthy neighbors. Resolution is per corner,
not one anchor for the whole triangle, so a sliver crossing a real mitre can follow
the correct surface on either side instead of smearing the crease.

Do not alter the indexed mesh or the STL/3MF geometry. Keep the existing feature-
edge topology and `MIN_FACE` line gate independent from shading.

## Alternatives rejected

- Repair or retriangulate the CSG output. This changes exported geometry and risks
  breaking original-surface IDs that fillet boundary lines depend on.
- Route small glyph corners to OCCT. This is substantially slower and weakens the
  mesh-native planar-rim contract.
- Reapply the reverted triangle-wide anchor. A single surface choice for all three
  corners is too coarse at genuine seams and was deliberately removed from the PR.

## Regression coverage

- A synthetic sliver must shade with its healthy neighbor without changing the
  neighbor's normal.
- A thin bridge at a genuine crease must retain two distinct smoothing sides.
- The real unbolded Roboto `t` must have no long, hard normal stripe through the
  fillet band, while its intended mitre edges remain present.
- Existing boundary-line, roundAll, corner, and performance tests must remain green.

## PR cleanup

Add the `scott-label` app harness to the PR, retarget PR #144 from its merged stack
branch to `main`, and bump the package patch version to `0.67.1`. Run the complete
suite, production build, and browser smoke check, then serve `scott-label.html` for
manual inspection with bold disabled.
