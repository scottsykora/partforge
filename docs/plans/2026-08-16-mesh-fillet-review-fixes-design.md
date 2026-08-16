# Mesh Fillet Review Fixes Design

## Goal

Close the three correctness and contract gaps found in PR #133 without weakening
contract v3's promise that supported circular fillets and chamfers build on the
Manifold backend.

## Chosen approach

Keep small circular blends mesh-native. The revolve tool's seam guards must still
cross the faceted flank decisively, but their extra geometry must be bounded by the
requested feature magnitude so a fixed robustness allowance cannot dominate a tiny
fillet or chamfer. The result must preserve genus and stay within the documented
tessellation tolerance at both preview and print quality.

Evaluate `{ near }` selectors against a fitted circular chain's analytic geometry.
Straight and unsupported chains keep the existing segment-distance behavior. For an
arc, selection checks the query point's axial offset, radial distance, and whether its
azimuth lies within the fitted span, so a mathematically exact point does not depend
on the tessellation phase.

Synchronize every shipped description of Solid fillet/chamfer routing with contract
v3: source JSDoc, TypeScript declarations, README, the authoring-guide introduction,
and ERROR-PATTERNS entries.

## Alternatives rejected

- Route blends below a threshold to OCCT. Correct, but it makes backend selection
  depend on an arbitrary size cutoff and defeats the mesh-native contract.
- Treat tiny positive magnitudes as identity. Fast, but silently changes requested
  geometry and violates the zero-only identity rule.

## Verification

Add regression tests before implementation for:

- small circular fillets and chamfers retaining genus zero;
- small-feature volume staying near the analytic Pappus result;
- exact 30° and 45° `{ near }` points selecting a cylinder rim natively;
- shipped documentation no longer claiming that Solid fillet/chamfer are OCCT-only
  or probe-routed.

Run the focused geometry/contract tests, the complete Node 24 suite, and the browser
smoke check before pushing the PR branch.
