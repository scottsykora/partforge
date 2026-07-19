# Backlog — JSCAD-inspired geometry ideas

Running summary of the JSCAD-inspired thread: what has shipped, and what remains
as candidate future work. Each remaining item becomes its own spec/plan under
`specs/` + `plans/` if pursued.

## Shipped

- **Options-object kernel API** (v0.13.0, PR #45) — named-argument calling
  convention for kernel ops; the JSCAD-style ergonomics baseline.
- **`offsetPolygon`** (v0.15.0, PR #48) — pure-JS 2-D profile offsetting
  (grow/inset) on point-lists and `{outer, holes}` regions, round/chamfer/sharp
  corners; "simple-in / simple-out or throw". Stays the `derive()`/main-thread
  clearance tool (no kernel boot).
- **F1 · Curve-native profile IR** (v0.17.0, PR #51 merged) — cubic Béziers in
  2-D profiles via `pathProfile`; exact B-rep on OCCT (→ STEP), faceted at mesh
  LOD on Manifold. Generalizes the arc mechanism.
- **F2 · 2-D booleans / `Shape2D`** (v0.18.0, PR #52) — `k.shape2d(profile)`
  with `.union/.cut/.cutAll/.intersect`, feeds extrude/revolve, materializes via
  `.toRegions()/.simple()/.area()/.boundingBox()`, content-hash cached,
  curve-preserving on OCCT. Uses each backend's native booleans (Manifold
  `CrossSection` / OCCT `Drawing`) — no dependency. Also added 3-D
  `Solid.union(other)`.
- **F3 · Curve-native offset** (v0.19.0, PR #53, stacked on F2) —
  `Shape2D.offset(delta, {corners, segs?})` via native offsets. round/chamfer/
  sharp. **chamfer is a true 45° bevel matching OCCT to float precision for
  convex corners with interior angle ≥ 90°** (Manifold uses a single-chord Round
  join; ~0.4% bulge only at acute <90° corners); round/sharp exact at every
  angle. Collapse throws immediately.

The curve thread (F1→F3) + offsetPolygon covers most of JSCAD's geom2 workflow:
booleans, offset/expand/contract, curved paths, linear/rotate extrude, and the
2-D primitives.

## JSCAD coverage map

| JSCAD `@jscad/modeling` | partforge | status |
|---|---|---|
| `union`/`subtract`/`intersect` (geom2) | `Shape2D` booleans | ✅ |
| `offset`/`expand`/`contract` | `Shape2D.offset` + `offsetPolygon` | ✅ |
| 2-D primitives | polygon helpers | ✅ |
| curved paths (`path2`) | `pathProfile` cubics | ✅ |
| `extrudeLinear`/`extrudeRotate` | `extrude`/`revolve` (accept `Shape2D`) | ✅ |
| `hull`/`hullChain` | — | ❌ |
| `vectorText`/`vectorChar` | — | ❌ |
| `scission` (split disjoint) | `.toRegions()` (materializes only) | ◑ |
| `align`/`center` | `.boundingBox()`; no align helper | ◑ |
| rounded 3-D primitives (`roundedCuboid`/`roundedCylinder`/`torus`) | — | ❌ |

## Candidates — ranked (re-evaluated now that `Shape2D` exists)

1. **`vectorText` → `Shape2D`** (high value, high effort) — **NEXT (in
   brainstorming).** Text becomes a `Shape2D` you can boolean into a plate
   (emboss/deboss), offset for print clearance, and extrude to raised letters —
   the practical payoff of the whole 2-D thread (labels, part numbers, logos).
   Cost: a font parser + a bundled font (outline font, e.g. opentype-style; or a
   single-line/Hershey font for engraving).
2. **`hull` / `hullChain` → `Shape2D`** (medium value, low-ish effort) — 2-D
   convex hull returning a `Shape2D`; `hullChain` (swept hull over a sequence)
   gives capsules, rounded slots, organic tapers. Pure-JS, robust. Good quick win.
3. **`align` / `center` helpers** (low/low) — position a `Shape2D`/`Solid` by
   its bbox (align edges/centers to another or to origin). Small ergonomic win.
4. **`.regions()` / scission** (low effort) — split a multi-region `Shape2D`
   into separate live `Shape2D`s (we already compute them in `.toRegions()`).
5. **Rounded 3-D primitives** (`roundedCuboid`/`roundedCylinder`/`torus`) —
   JSCAD staples; fast rounded boxes on Manifold without OCCT fillet. Independent
   of the 2-D thread.
6. **Slice/section a `Solid` → `Shape2D`** — NEW capability `Shape2D` unlocks
   (not from JSCAD): project a 3-D part's silhouette or take a cross-section as a
   2-D `Shape2D` (Manifold `slice`/`project`; replicad section) to boolean/offset/
   re-extrude "the outline of this part".

## Parked technical follow-ups (from F1–F3 reviews)

- `prism` + `Shape2D` (revolve already accepts it).
- Multi-level hole nesting in `assembleRegions` (island-in-hole surfaces as a
  spurious extra top-level region; net area stays correct — both backends).
- Empty-shape `boundingBox()` guard (both backends return a garbage/undefined
  sentinel on a fully-cancelled shape).
- F1: quadratic/spline/ellipse segments; SVG-path-string parser.
- `shape.extrude({h})` sugar method (currently `k.extrude({profile: shape, h})`).
- OCCT `Shape2D.boundingBox()` reads replicad-internal `innerShape`; a replicad
  upgrade renaming it would break collapse detection (guarded by a test).

## vectorText curve-resolver follow-ups (from final review, 2026-07-19)
- **Lazy-init the paper.js PaperScope** in `curve-fill.js` (currently a module-level `new
  PaperScope()` runs on every geometry-worker load, pulling paper-core ~193KB gz into the
  kernel-front chunk even for text-free parts). Initialize on first `resolveCurveFill` call.
- **Multi-level hole nesting** in `assembleRegions` (pre-existing, shared by both backends): an
  island-inside-a-counter surfaces as a spurious extra top-level region; net area stays correct,
  degrades safely. Rarely hit by Latin CAD labels. Fix if a glyph/shape needs true nesting.
- **CFF font coverage:** no `.otf` (CFF/CFF2) font is in-repo, so real CFF-glyph rendering is
  unexercised by tests. Add a small CFF test font if CFF support needs a regression guard.
