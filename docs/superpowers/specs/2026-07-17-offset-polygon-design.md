# offsetPolygon — 2-D profile offsetting with corner styles — design

Date: 2026-07-17
Status: approved design, pre-implementation
Branch: offset-polygon (off main@694eeb5, after the options-object PR #45 merge)

## Problem

Printer-clearance offsets are the bread and butter of printed parts, but partforge
only supports them where someone hand-derived the math: demo.js pads a *radius*
(`boreR: (p.bore + 0.2) / 2`), and planter.js derives a regular-n-gon wall inset
from trigonometry (`an edge offset of wall shrinks the circumradius by …`). Any
non-trivial profile — an L-bracket outline, a star knob, a slot with islands —
has no way to say "this cut, 0.2 mm looser" or "this wall, 3 mm in". JSCAD's
`expand`/`offset` (corner styles round/chamfer/edge) is the prior art; this spec
adapts the idea to partforge's polygon-helper conventions.

## Decisions already made (with Scott)

- **Inputs: point lists + regions.** Bare CCW `[[x,y],…]` lists and
  `{outer, holes}` regions. Symbolic arc profiles (`roundedProfile` output) are
  **out of scope** for v1 (arc-arc joins are their own project).
- **Insets supported; collapse throws.** Negative deltas are first-class (the
  wall-inset use case). A degenerate result throws a greppable error — never
  silently clamps or returns garbage.
- **Corner styles: `"round" | "chamfer" | "sharp"`, default `"round"`.**
- **Implementation: pure JS in polygon.js** (approach A). No kernel op, no new
  dependency. Rationale: works everywhere the other helpers work — `build()` on
  both backends, `derive()` on the main thread (where AUTHORING-PARTS says
  clearance math belongs), the Node CLI, WASM-free tests — and is
  backend-identical by construction, so preview and STEP cannot drift.
  Performance is a non-issue at profile scale (tens–hundreds of points;
  construction O(n·segs), validation O(n²) ≈ microseconds; builds are
  content-hash memoized). The native offsets (Manifold `CrossSection.offset`,
  replicad `offset2D`) trade all of that for robustness on pathological inputs,
  which we instead handle by failing loudly (see envelope).

## API

```js
offsetPolygon(profile, delta, { corners = "round", segs = 8 } = {})
```

- **`profile`** — CCW `[[x,y],…]` point list, or `{outer, holes}` region.
  Input winding is normalized by signed area (either winding accepted); output
  contours are always CCW. Duplicate consecutive points (< 1e-9 apart) are
  dropped before processing.
- **`delta`** (mm, finite number) — positive offsets outward (grows material),
  negative insets. `delta === 0` returns a normalized copy.
- **`corners`** — join style where offset edges *diverge* (convex w.r.t. the
  offset direction):
  - `"round"` (default): circular arc centered on the original vertex, radius
    `|delta|`, tessellated with `segs` segments (default 8, matching
    `filletPolygon`). The geometrically true clearance (Minkowski with a disc).
  - `"chamfer"`: single straight segment across the wedge (the arc's chord).
  - `"sharp"`: extend both offset edges to their true intersection (miter).
    When the miter point would lie farther than `2·|delta|` from the original
    vertex (Clipper's default miter limit), that corner falls back to chamfer.
    No limit knob in v1 (YAGNI).
- **Return shape mirrors the input**: point list in → point list out; region in
  → `{outer, holes}` out.
- **Region semantics**: `outer` is offset by `+delta`, every hole by `−delta` —
  offsetting the *region as material*. A `+0.2` clearance on a cut-tool region
  grows the outer contour and shrinks its islands, so the whole cut gets looser.
- Corner style only affects diverging corners. Where consecutive offset edges
  *cross* (concave w.r.t. the offset direction), they are trimmed to their
  intersection regardless of style.

## Algorithm (per contour)

1. Normalize: drop duplicate consecutive points, enforce CCW by signed area,
   validate (≥ 3 points, finite coords, simple — no self-intersection).
2. Offset every edge along its outward normal by `delta` (CCW ⇒ outward normal
   of edge `p→q` is `(qy−py, px−qx)` normalized).
3. Join consecutive offset edges at each original vertex:
   - crossing (concave case): line-line intersection, take the trim point;
   - diverging (convex case): fill per `corners` as specified above.
4. Cleanup: drop degenerate/duplicate output points, re-enforce CCW.
5. Validate the result (below) and return.

Shares the *vocabulary* of `cornerArc` (tangent points, clamped arcs, short
sweeps) but not its code path — `cornerArc` rounds corners in place;
`offsetPolygon` fills gaps between displaced edges. No new imports; polygon.js
stays dependency-free.

## Validation & error taxonomy

All thrown strings are greppable contract surface; each gets an
ERROR-PATTERNS.md entry (IDs in parentheses):

| Thrown string | When | (entry id) |
|---|---|---|
| `offsetPolygon: need at least 3 points` | input contour too small (after dedup) | `offset-polygon-bad-input` — Symptom leads with this literal; the delta/corners variants below are listed in the entry's note paragraph (ERROR-PATTERNS allows notes after the three list lines) |
| `offsetPolygon: delta must be a finite number` | NaN/±Infinity/non-number delta | noted under `offset-polygon-bad-input` |
| `offsetPolygon: corners must be "round" \| "chamfer" \| "sharp"` | unknown style | noted under `offset-polygon-bad-input` |
| `offsetPolygon: input polygon self-intersects` | input fails the simplicity check — bad input is not blamed on the offset | `offset-polygon-input-self-intersects` |
| `offsetPolygon: inset collapses the polygon` | result area ≤ 0 or < 3 points after cleanup; also thrown for a hole that would vanish (remove the hole explicitly if that's intended — silent topology changes are how parts lie) | `offset-polygon-collapse` |
| `offsetPolygon: offset result self-intersects (reduce \|delta\| or simplify the profile)` | result fails the simplicity check | `offset-polygon-result-self-intersects` |

**Envelope (documented in AUTHORING-PARTS):** simple polygons in, simple
polygon out. Reflex corners are fine. Offsets whose true result would split
into multiple contours (e.g. insetting a dumbbell past its waist) are out of
scope and throw the result-self-intersects error rather than returning a
figure-eight. The self-intersection checks are O(n²) segment tests — trivial
at profile point counts.

## Testing (pure vitest, no WASM boot)

New `test/offset-polygon.test.js`:

1. **Exact areas on a square** (side s, offset d): `"sharp"` → `(s+2d)²`;
   `"chamfer"` → sharp minus 4 corner triangles (`2d²`); `"round"` →
   `s² + 4sd + πd²` within tessellation tolerance (and exact as segs → large).
   Inset: `(s−2d)²` for all styles (no diverging corners on inset squares).
2. **Planter regression pin**: `offsetPolygon(regularPolygon(n, R), −wall,
   {corners: "sharp"})` reproduces planter.js's hand-derived circumradius
   shrink `R − wall/cos(π/n)` exactly (vertices compared pairwise).
3. **Reflex case**: L-shape outset and inset — correct area deltas, output
   simple, concave corner trimmed (no style-dependent artifacts).
4. **Regions**: `{outer, holes}` with `+delta` grows outer, shrinks holes;
   hole-vanishing case throws collapse.
5. **Every error path** fires with its exact string (incl. CW input accepted
   and normalized, not thrown).
6. **Determinism/identity**: `delta 0` returns equal points; same input twice
   → deeply equal output (purity — the build memoizer depends on it).
7. **Miter limit**: a needle-spike corner with `"sharp"` falls back to chamfer
   (miter length > 2·|delta|).

One end-to-end line in an existing Manifold test file (`extrude` of an offset
L-profile; volume sanity) proves kernel compatibility without a new WASM file.

## Follow-on (in scope for the same PR, last task)

Switch planter.js's derive to `offsetPolygon(outerPts, −wall, {corners:
"sharp"})`, deleting the hand-derived trig. Geometry is identical (regular-n-gon
sharp inset ≡ the closed form — pinned by test #2), so the measure/verify gates
must pass unchanged; the exemplar then teaches the helper. **Caveat found in
the current code:** planter deliberately clamps `Rin` to ≥ 1 for out-of-bounds
API-driven walls (`Math.max(…, 1)`), whereas `offsetPolygon` throws on
collapse. The migration must preserve the clamp semantics by capping `wall` at
`(Rout − 1)·cos(π/facets)` *before* offsetting — behavior identical to today,
including for hostile inputs.

## Docs

- AUTHORING-PARTS.md "Profiles & patterns": helper row (signature + one-line
  semantics), a clearance example (`offsetPolygon(slotPolygon(20, 3), 0.2)`),
  and the envelope note.
- ERROR-PATTERNS.md: the four entries above.
- No kernel-contract changes; CONTRACT_VERSION untouched; no new exports beyond
  `offsetPolygon` from polygon.js (also re-exported wherever the other polygon
  helpers already surface, e.g. `partforge/geometry`).

## Out of scope (explicitly)

- Arc-profile (`roundedProfile`) offsetting — needs arc-arc join design.
- Multi-contour results (region splitting on deep insets) — clipper territory.
- A miter-limit knob, per-corner styles, or open-path (polyline) offsetting.
