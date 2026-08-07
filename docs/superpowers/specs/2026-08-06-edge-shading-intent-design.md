# Kernel-authoritative shading intent: accurate edge lines and smooth shading

**Date:** 2026-08-06
**Status:** Approved (design), pending implementation plan

## Problem

Both backends decide "smooth vs. hard edge" purely by dihedral-angle heuristics
applied downstream of the geometry (35° for edge lines and Manifold shading
creases, 30° for the viewer's OCCT crease fallback). One global angle threshold
cannot distinguish two opposite situations:

- **Coarse tessellation of a mathematically smooth surface** (OCCT preview
  meshes spheres at `angularTolerance: 0.5` rad ≈ 28.6°; skinny pole triangles
  exceed the 35° threshold) → phantom hard-shaded patches and spurious edge
  lines on spheres. Observed on the filleted six-face bored-cube part.
- **Intentional flat facets shallower than the threshold** (the faceted vase at
  12 facets bends 30° per crease, under 35°) → genuinely flat printed facets
  get smooth-shaded away on screen. One loft even mixes intents: ring-to-ring
  edges tessellate a smooth vertical curve (should smooth) while facet corners
  are real creases (should stay hard).

The fix direction: the geometry layer communicates *intent* — this surface is
mathematically curved, this edge is a real feature — instead of consumers
guessing from angles.

## Decisions made during brainstorming

1. **Render goal:** intent-accurate single default rendering (not a
   CAD-vs-print toggle, not threshold tuning). Curved-by-construction surfaces
   render smooth with no phantom edges; genuinely flat geometry renders flat.
   Feature edge-line overlays are kept.
2. **Facet creases get flat shading only** — no edge lines on intentional
   facet creases at any sharpness. Lines stay reserved for feature boundaries
   (rims, bores, cut seams; boxes/brackets keep their corner lines).
3. **Authoring surface: infer + optional hint.** The kernel infers intent per
   primitive; ambiguous cases (high-side-count loft rings) get an inference
   rule plus an explicit per-primitive override. Existing parts render
   correctly with zero edits.

## Goal and acceptance criteria

The kernel is the single authority on shading normals and feature-edge lines;
the viewer and CLI renderer draw what they are handed.

- The bored-cube part's spheres shade perfectly smooth with **no** phantom
  edge lines anywhere on the spherical surface — only true bore/seam edges
  draw.
- The faceted vase shows flat facets at every facet count (3–12), with no edge
  lines on facet creases, matching what a print produces.
- CLI `partforge render` PNGs show the same shading/edges as the browser
  viewer (they already consume kernel normals/edges and inherit the fix).
- Existing parts that look correct today keep their current look.

## Design

### 1. OCCT backend: use what replicad already knows

`toMesh` in `src/framework/geometry/occt-backend.js` currently returns
`normals: new Float32Array(0)`, discarding replicad's analytic per-vertex
normals, and returns no edges — the viewer angle-guesses both. Changes:

- **Normals:** return `mesh().normals`. Posing must rotate normals by the
  rotation component of the pose steps (a positions-only transform is
  insufficient). B-rep faces duplicate boundary vertices, so cut seams stay
  hard automatically and spheres/fillets shade smooth by construction.
- **Edges:** return `meshEdges()` (true B-rep edge polylines, same
  tolerance/quality options as `mesh()`) as the `edges` segment array,
  filtered to drop **tangent** edges — where the two adjacent faces meet
  smoothly (fillet blend boundaries, closed-surface seam lines). Filter
  mechanism: a quantized-position map from face-boundary vertices to their
  per-face normals; an edge whose flanking normals agree within ~5° is tangent
  and dropped. This matches today's look (the 35° heuristic also skipped
  tangent boundaries) but derives it from ground truth.
- Both are computed and cached in `baseMesh` alongside positions, per quality,
  pose-free; edges are posed the same way positions are, normals via the
  rotation-only transform.
- **Supporting change:** preview `angularTolerance` 0.5 → 0.25 rad, so
  silhouette polygonalization is reasonable now that shading no longer hides
  tessellation choices. (`tolerance` unchanged; print quality unchanged.)

### 2. Manifold backend: per-surface shading intent

`creasedNormals` in `src/framework/geometry/manifold-backend.js` keeps its
originalID (OID) machinery. Each original surface now carries a **shading
policy** registered at primitive creation:

```
{ creaseAngle: degrees, sameSurfaceLines: boolean }
```

- **Defaults preserve today's behavior:** every primitive registers
  `{ creaseAngle: 35, sameSurfaceLines: true }`. Cubes, cylinders, brackets,
  hulls, sweeps, text all look exactly as they do now.
- **Loft infers intent from its rings.** Max ring side count < 32 → *faceted*
  policy `{ creaseAngle: 10, sameSurfaceLines: false }`: same-surface bends
  past 10° shade hard (the 30° creases at 12 facets go flat), ring-to-ring
  bends along a smooth silhouette (a few degrees) stay smooth, and no
  same-surface edge lines draw regardless of sharpness — even the 72° creases
  of a 5-facet vase stay line-free per decision 2. Max side count ≥ 32 →
  smooth policy (the default above).
- **The hint:** `k.loft({ rings, smooth: true|false })` overrides the
  inference in either direction. `smooth: true` → default policy;
  `smooth: false` → faceted policy. The option name leaves room to adopt it on
  other primitives later.
- In `creasedNormals`, the per-OID policy replaces the single `sharpCos` for
  same-OID smoothing decisions and gates the same-OID branch of edge-segment
  emission. Cut-seam behavior is unchanged: different OIDs → hard shading,
  line emitted when bent more than the 5° coplanar threshold.

### 3. Module layout (modularity)

The new logic lands as small pure modules rather than growing the two backend
files; the backends shrink to wiring. All new modules are DOM-free,
`three`-free and `node:`-free (the worker-layering test keeps passing
unchanged).

- **`geometry/creased-normals.js`** — `creasedNormals` moves out of
  manifold-backend.js. Pure function over plain arrays (`vertProperties`,
  `triVerts`, run tables, merge maps) plus a per-OID policy map; returns
  `{ positions, normals, edges, featureIds?, features? }`. Unit-testable with
  tiny synthetic meshes, no Manifold WASM boot required.
- **`geometry/shading-policy.js`** — the policy shape, named defaults
  (`SMOOTH` = 35°/lines, `FACETED` = 10°/no lines), the coplanar-seam
  threshold, and the loft inference rule (max sides < 32 → faceted; `smooth`
  hint overrides). The single home for every shading threshold; backends and
  tests import it.
- **`geometry/brep-edges.js`** — the OCCT tangent-edge filter: input is
  replicad's `mesh()` output + `meshEdges()` output, output the filtered flat
  segment array (including polyline → segment-pair conversion). Pure
  array-in/array-out, so its edge cases are testable without booting OCCT —
  keeping OCCT-boot tests isolated per the repo invariant.
- **`geometry/pose.js`** — gains `rotateNormals` (rotation-only pose
  application) beside the existing `transformPositions`/`composePose`, rather
  than inlining that subtlety in occt-backend.js.

### 4. Viewer and CLI integration

`src/framework/viewer.js` already prefers kernel normals and kernel edge
segments when present; OCCT meshes now take that path too. The
`toCreasedNormals` / `EdgesGeometry` fallback remains as a last-ditch path for
meshes carrying no kernel data, with a comment marking it fallback-only. The
CLI renderer (`src/testing/render.js`) needs no changes. The cutaway outline
system is untouched (it derives its own cut-face outlines).

### 5. Contract, docs, versioning

- **KERNEL-CONTRACT.md:** new section on `toMesh` shading semantics — both
  backends return authoritative `normals` and `edges`; the loft `smooth` hint
  and its inference rule. Version header bumped; `test/kernel-contract.test.js`
  updated to hold coverage to the code.
- **AUTHORING-PARTS.md:** document the loft `smooth` option and a short "how
  shading intent works" note.
- **ERROR-PATTERNS.md:** new entry — "phantom edge lines / faceted shading on
  a curved surface" → cause (consumer-side angle heuristics / missing kernel
  normals) → fix, so future agents recognize regressions.
- `package.json` version bump on the branch per the release flow.

## Testing

- **Unit (pure, no WASM boot):** `creased-normals.js` against tiny synthetic
  meshes — policy application, seam hardness, per-OID line gating;
  `brep-edges.js` against hand-built fixtures — tangent drop, sharp keep,
  polyline conversion; `pose.js` `rotateNormals` — rotation applied,
  translation ignored; `shading-policy.js` loft inference rule and hint
  override.
- **Unit (OCCT, isolated file):** `toMesh` returns non-empty normals and
  edges; posed normals are rotated correctly; a sphere-bored box mesh has zero
  edge segments away from the bore seam; the tangent filter drops fillet
  boundaries but keeps chamfer boundaries.
- **Unit (Manifold):** faceted policy → facet-interior triangles share
  flat normals at 12 facets; `smooth: true` restores smoothing;
  ring-to-ring edges stay smooth under the faceted policy; no same-OID edge
  segments are emitted for faceted lofts.
- **Regression:** existing parts keep their look — cube/bracket corner lines
  still present; planter unchanged.
- **Visual:** `npm run check` smoke apps, plus `partforge render` on the
  bored-cube and faceted-vase parts, eyeballed once.

## Out of scope

- No print-preview toggle or second rendering mode.
- No changes to STL/3MF/STEP export tessellation.
- No `smooth` hint on primitives other than loft (the policy plumbing supports
  adding it later).
- Cutaway outline derivation unchanged.
