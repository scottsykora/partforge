# Native contour offset for Shape2D — design

**Date:** 2026-08-14
**Status:** Approved design, pre-implementation
**Owner:** Scott Sykora

## Motivation

`Shape2D` stores the curve-native contour IR and runs every operation on it in
pure JS — except `offset`, the single remaining backend hook. The Manifold
backend tessellates the IR and calls Clipper2 (`CrossSection.offset`), returning
faceted polylines; the OCCT backend fuses a replicad `Drawing`, calls
`BRepOffsetAPI_MakeOffset`, and reads the result back through SVG paths plus a
containment-depth reclassification pass. Consequences today:

- Offset output differs by backend (faceted vs. curve-exact; the documented
  acute-corner chamfer divergence in KERNEL-CONTRACT).
- Offset requires a booted WASM kernel, unlike every other Shape2D op.
- The OCCT readback (`toSVGPaths` → y-negate → containment classification) is
  the most fragile code in that backend.

This design replaces both hooks with one pure-JS engine on the contour IR.

## Decisions (locked with owner)

1. **Kernel paths become test oracles only.** The native engine is the sole
   runtime path. Kernel-based offsets survive only in the test suite as
   cross-check oracles; the runtime hook plumbing and OCCT readback machinery
   are deleted.
2. **The native engine defines new canonical semantics.** KERNEL-CONTRACT's
   offset section is rewritten (one exact semantics for both backends), its
   version bumped, and pinned test values re-baselined. Oracles must agree
   within stated tolerance, not bit-for-bit.
3. **API surface: `offset(delta, { corners })`.** `segs` is silently accepted
   and ignored (round joins are exact arcs; nothing is tessellated). No new
   knobs; the cubic-approximation tolerance is internal.

## Non-goals

- Open-path / stroke offsetting (`offsetStroke`). Shape2D regions are closed.
- Replacing `offsetPolygon` in `polygon.js` — that is a deliberately local,
  point-ring helper with no topology cleanup, used directly by parts. It keeps
  its semantics; the new engine is a separate module. (They may share corner
  math later if it falls out naturally; not a goal.)
- Variable-distance or single-sided offsets.

## Module layout

**New file: `src/framework/geometry/contour-offset.js`** — a pure leaf in the
worker graph (DOM-free, `three`-free, `node:`-free; `worker-layering.test.js`
enforces this). Exports:

```js
offsetRegions(regions, delta, { corners = "round" } = {}) -> regions
```

Same signature as today's backend hooks. Throws the existing pinned messages:

- `'Shape2D.offset: corners must be "round" | "chamfer" | "sharp"'`
- `"Shape2D.offset: delta must be a finite number"`
- `"Shape2D.offset: offset collapses the shape (reduce |delta|)"`

**`shape2d.js`**: imports `offsetRegions` directly (as it imports
`booleanRegions`); the `offsetRegions` dep is removed from
`makeShape2dFactory({ segs, extrude, revolve })`.

**Backends**: both stop passing the hook. `k._offsetRegions` remains published,
now pointing at the shared engine (its consumers keep working; the two backends
finally agree by construction).

**Deleted from runtime:**

- Manifold: `resolveOffsetJoin`, `offsetCS`, its `offsetRegions`.
- OCCT: `offsetDrawing`, its `offsetRegions`, `groupOffsetContours`,
  `negateContourY`, `OFFSET_CLASSIFY_SEGS`. (`drawingFromRegions` stays —
  extrude/revolve still use it. `svgPathToContours` stays if any non-offset
  caller remains; delete if orphaned.)

**`paper-bridge.js`**: gains one export for the cleanup stage (see below) —
a self-resolve of a single region set, reusing `regionsToCompound`,
`groupPaperPathsOriented`, and the existing scope lifecycle.

## Algorithm

Input regions carry the storage invariant (outer CCW, holes CW, rings
explicitly closed). Offsetting **every ring by the same signed rule** — each
point displaced `delta` along the normal to the **right of the direction of
travel**, which under the winding invariant always points away from the filled
interior — makes positive delta grow outers and shrink holes with no per-ring
casing.

### Stage 1 — raw per-segment offset (exact where possible)

Walk each ring segment by segment:

- **Line** → the parallel line at distance `delta`. Exact.
- **Arc (`via`)** → the concentric arc: same center (recovered via
  `arcCenterAndSweep`), radius `r ± delta` by concavity side. Exact. If the
  new radius is ≤ 0 the arc inverts: emit the inverted concentric arc (radius
  `|r ± delta|`, reversed sweep) and flag the ring **dirty** — the inverted
  loop is exactly what stage-3 cleanup removes. A radius within epsilon of 0
  degenerates to a line between the offset endpoints, also flagged dirty.
- **Cubic (`c1`/`c2`)** → adaptive Tiller–Hanson, ported from paperjs-offset
  (MIT; attribution in the file header): offset both endpoints along their
  normals, displace the handle line by the mid-normal, then recursively
  subdivide at t=0.5 while the offset curve's midpoint deviates from
  `|delta|` by more than the tolerance or self-intersects, with a recursion
  depth cap. Output is one-or-more cubics per input cubic. A subdivision that
  hits the depth cap flags the ring dirty.

### Stage 2 — joins

Adjacent raw segments whose endpoints diverge (tangent-discontinuous corner,
gap on the convex side) are joined per `corners`:

- **round** → an exact arc segment (`via` through the mid-angle point) centered
  on the original corner, radius `|delta|`.
- **chamfer** → a straight chord between the two offset endpoints — a true
  bevel at **every** corner angle (this removes the documented acute-corner
  Manifold/OCCT divergence).
- **sharp** → extend to the miter point; when the miter ratio exceeds the
  limit (2, matching today's Clipper2 default), fall back to the chamfer
  chord.

On the concave side the raw segments cross rather than gap; insert the chord
join and flag the ring dirty (the crossing is cleanup's job — same approach as
paperjs-offset and Clipper).

### Stage 3 — conditional topology cleanup

**Fast path.** After stages 1–2, validate the result cheaply on sampled
polylines (the `tessellateContour`-at-low-LOD machinery the OCCT readback uses
today): no ring self-intersections, no ring–ring crossings, no orientation
flips (area sign per ring unchanged), no dirty flags. If all pass, the raw
result **is** the result — exact arcs and all. Circles, convex shapes, and
modest offsets of well-behaved shapes land here.

**Cleanup path.** Otherwise, route the raw regions through paper.js via the
bridge: self-unite (`unite` with itself) + resolve crossings, then re-nest and
re-orient through `groupPaperPathsOriented`. This is the same recipe
paperjs-offset uses, on the boolean engine partforge already ships. Cost:
paper.js has no arc primitive, so arcs on this path come back as cubic
approximations (`arcToCubicSegments`, ≤90° pieces) — precisely the degradation
every Shape2D boolean already applies today, so offset is no worse than
`.union()`. Winding filter: keep loops whose orientation matches their
containment-depth parity; drop inverted loops.

**Collapse.** If no regions survive (fast-path result empty, or cleanup
returns `[]`), throw the pinned collapse message.

`shape2d.js` continues to apply `closeContourGap` to every returned ring, so
the storage invariant holds regardless of path taken.

### Tolerances

- Cubic offset approximation: max deviation `OFFSET_TOL = 1e-3` mm (units are
  mm throughout partforge), recursion depth cap 12. Internal constants, not
  API.
- Fast-path validation sampling: 32 segments/contour (matches today's
  `OFFSET_CLASSIFY_SEGS` precedent).
- Oracle agreement in tests: area within 0.5%, sampled boundary distance
  within 5e-3 mm (loose enough to absorb Clipper2's own faceting; see
  Testing).

## Contract & docs changes

- **KERNEL-CONTRACT.md**: offset section rewritten as a single semantics —
  curve-preserving (lines/arcs exact on the fast path, cubics
  tolerance-approximated), true bevel at all angles, round joins as exact
  arcs, miter limit 2, cleanup semantics as above. The Manifold-vs-OCCT
  divergence note is deleted. Contract version bumped;
  `kernel-contract.test.js`'s version header updated.
- **AUTHORING-PARTS.md**: `offset` documented as `offset(delta, { corners })`;
  `segs` removed from docs (still accepted, ignored).
- **ERROR-PATTERNS.md**: entries referencing backend-specific offset failure
  modes (e.g. replicad `innerShape` collapse detection) updated or removed;
  add a pattern for the collapse error if not already present.
- Comments in `manifold-backend.js` / `occt-backend.js` describing the old
  divergence are removed with the code.

## Testing

**Unit tests (new `test/contour-offset.test.js`, pure — no WASM):**

| Case | Checks |
|---|---|
| Square ± delta, all three corner modes | exact areas (closed forms: sharp `(s+2d)²`, chamfer `−2d²`, round `+πd²` exactly — not the polygonized fan approximation) |
| Circle (two arcs) ± delta | result is **exact arcs** (segment kind preserved), radius r±delta |
| Rounded rectangle | fast path; arcs exact, lines exact |
| Concave L-shape inward | cleanup path engages; result simple, correct area |
| Acute-corner star, chamfer | true bevel at acute corners (the old divergence case) |
| Region with hole, ± delta | hole shrinks/grows opposite the outer; hole-collapse absorbed |
| Inward offset collapsing the shape | pinned collapse message |
| Cusp-producing cubic inward offset | output simple (no self-intersections) |
| Multi-region input | regions merge when offsets overlap (cleanup unions them) |
| Validation errors | pinned messages for bad `corners` / non-finite delta |

**Invariant assertions** (ported from paperjs-offset's quality scorer, applied
across the unit corpus): output has no self-intersections; outward offsets
contain the input, inward offsets are contained by it; sampled output-boundary
points sit at distance `|delta|` from the input boundary within tolerance.

**Oracle tests:** native vs. Manifold Clipper2 in the Manifold test file;
native vs. OCCT `BRepOffsetAPI` in an OCCT-booting test file (OCCT and
Manifold never boot in the same process). The oracle calls reconstruct the old
backend routes as *test-local helpers* against the raw kernels — this is where
the deleted runtime paths live on. Compared by area and sampled boundary
distance within the tolerances above.

**Re-baselines of existing tests:**

- `shape2d-occt.test.js` "offset of a curved Shape2D stays exact → STEP has a
  B_SPLINE": a circle offset now yields exact arcs, so STEP will contain
  `CIRCLE` instead of `B_SPLINE` — update the assertion (this is an upgrade).
- Area-based expectations in `shape2d-manifold.test.js` mostly stand; round
  corners become exact quarter-circles (areas move *toward* the closed form —
  `toBeCloseTo` precisions may tighten).
- `kernel-contract.test.js` offset rows re-baselined to the new single
  semantics (chamfer 142.0000 square case now holds on both backends at all
  angles).

## Licensing & attribution

partforge is MIT. The cubic offset subdivision logic is ported from
[glenzli/paperjs-offset](https://github.com/glenzli/paperjs-offset) (MIT);
`contour-offset.js` carries an attribution notice in its header comment. No
new runtime dependencies.

## Risks & mitigations

- **Robustness tail** (cusps, near-tangent joins, tolerance stacking) is the
  known hard part; paperjs-offset's history proves both feasibility and where
  it bites. Mitigation: the kernel-oracle test layer holds the engine to two
  independent battle-tested implementations across the corpus; the invariant
  assertions catch silent misbehavior oracles might share.
- **paper.js cleanup limits**: self-`unite` + resolve-crossings can misbehave
  on pathological self-intersections. Mitigation: dirty-flagging keeps most
  real offsets off that path entirely; failures throw rather than silently
  return wrong geometry (grep ERROR-PATTERNS first, per repo rule).
- **Downstream expectation drift** (partforge-cloud prompt corpus regenerates
  against the installed package): the contract version bump plus changelog
  entry is the signal; ship as a normal minor version with the bump done in
  the feature PR per the release process.
