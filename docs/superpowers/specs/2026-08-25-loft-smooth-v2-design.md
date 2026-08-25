# loftSmooth v2 — curve-native emission

**Date:** 2026-08-25
**Status:** Approved design
**Predecessor:** `docs/superpowers/specs/2026-08-24-loft-smooth-design.md` (v1, shipped as PR #168 / 0.84.0)
**Branch:** `claude/loft-smooth-v2-curve-native`, stacked on the v1 branch (PR #168 still open at design time; this work rebases if #168 lands first). Version target **0.85.0**.

## Problem

v1's B-rep path lofts *point* wires at the control stations — a `samples`-gon
polygon per ring — because dense point wires broke OCCT (23 s at 32×96, WASM
abort at 48×128). STEP output is therefore faceted around each ring, and sharp
features (an airfoil trailing edge) are smeared by the closed Catmull-Rom fit
with no way to opt out. Curve input sections are rejected outright
(`"…control sections must be point arrays (for now)"`), and closed loft loops
are unreachable through `loftSmooth` even though `k.loft` supports them on
Manifold.

PR #166 gave `k.loft` a curve mode — structurally identical curve contours loft
as exact wires on OCCT and matched per-segment samples on Manifold — and
PR #167 fixed the negative-orientation latch for all-cubic wires. That is the
machinery v2 emits into.

## What testing established (probe, 2026-08-25)

Throwaway probe: v1's `stations:"controls"` resampled rings, closed centripetal
CR fitted through them, each span converted exactly to a cubic Bézier (a CR
span *is* a cubic; 4-point inversion at u = 0, 1/3, 2/3, 1 has no approximation
error), emitted as contour IR and lofted through today's `k.loft` curve mode on
OCCT with `ruled:false`. Propeller-class blade, 5 control sections:

| Around-ring spans | Volume | Loft time | STEP size |
|---|---|---|---|
| 24 | 3.666 cm³ | 74 ms | 162 KB |
| 48 | 3.664 cm³ | 83 ms | 324 KB |
| 96 | 3.682 cm³ | 168 ms | 648 KB |
| 128 | 3.679 cm³ | 261 ms | 870 KB |

Manifold dense-mesh reference for the same blade: 3.605 cm³ (48×128 stations ×
samples), 3.610 cm³ (96×256, converging upward).

Established:

- OCCT `ThruSections` handles many-span cubic-Bézier wires robustly and in
  milliseconds — the dense *point* wires that forced v1's compromise are not a
  constraint on curve wires. PR #167's volume latch held (all results positive).
- Volume plateaus by ~24–48 spans (0.4% band 24→128). STEP size scales
  linearly with span count.
- Blade-only mesh/B-rep divergence is ~1.9%, mesh systematically smaller (mesh
  rings are inscribed polygons of the same curve; the B-rep skin and the
  cross-station CR also genuinely differ between sparse stations). On the whole
  propeller reference part (hub-dominated) this lands within the existing 2%
  parity gate. Parity class unchanged: **within tolerance** (screwSweep/hull
  class).

## Design

### 1. Section input forms

A control section is `{ …outline…, z }` where the outline is one of:

- **Point array** — `polygon: [[x,y],…]` (≥3 points), v1 unchanged.
- **`sides` + `radius` shorthand** — v1 unchanged.
- **Curve contour** — `polygon:` a contour IR (`{start, segments:[{to}|{to,via}|{to,c1,c2}]}`)
  or a Shape2D, under `k.loft`'s existing ring rules: single region, hole-free
  (same errors, `loftSmooth:`-prefixed). **New in v2** — the v1 error
  `loftSmooth: section ${i} is an arc profile — control sections must be point
  arrays (for now)` is retired.

Point sections may add **`sharp: [indices]`** — control-point indices that are
true corners. Curve sections get corners implicitly from their non-smooth
joints (`profileCorners`' existing geometric definition); passing `sharp` on a
curve section is an error.

`sharp` validation: indices must be integers in `0…points.length-1` (frozen
error below); the list is normalized (sorted ascending, deduplicated)
silently.

### 2. Around-ring model and reconciliation

Each section resolves internally to **a point list plus a set of corner
indices**:

- Point sections: the points; corners = the `sharp` list (possibly empty).
- Curve sections: the contour tessellated by the shared pure-JS sampler
  (`tessellateContour` at the loft-rings LOD, `LOFT_SEGS = 64`); corners = the
  tessellated indices of `profileCorners` joints.

The section's smooth outline is the closed centripetal (α = 0.5) Catmull-Rom
through its points — **split at corners into clamped open arcs**. Each arc is
clamped with reflection phantoms at its two corner endpoints (the same
clamping rule the cross-station direction uses), so corners are interpolated
exactly with a genuine tangent break. With zero corners the outline is the
v1 closed periodic CR, unchanged.

**Correspondence across sections.** All sections must have the same corner
count `m` (frozen error otherwise). Corner `k` of every section corresponds;
arc `k` (from corner `k` to corner `k+1`, cyclically) of every section
corresponds. Corner 0 is each section's first corner in ring order — the
lowest `sharp` index for point sections, the first `profileCorners` joint from
the contour start for curve sections — and with `m ≥ 1` it replaces vertex 0
as the seam anchor. With `m = 0`, the v1 rule holds verbatim: correspondence starts
at vertex 0 (point sections) / contour start (curve sections).

**Resampling.** The `samples` span budget is apportioned among the `m` arcs by
each arc's **mean arc-length fraction across all sections**, largest-remainder,
ties to the lower arc index, minimum 1 span per arc — the v1 station
apportionment idiom applied around the ring. `samples` below `m` is raised to
`m`. Each section's arc `k` is then resampled uniformly by arc length to its
shared span count. Total ring vertex count = `samples` (corners included),
identical across sections — exactly v1's invariant, now corner-anchored. With
`m = 0` the whole ring is resampled to `samples` from the start vertex — v1
verbatim.

### 3. Emission — curve rings on both backends

The cross-station machinery is **v1 verbatim**: shared centroid-spine knots,
per-vertex CR, reflection phantoms at the ends (or periodic — §4),
knot-aligned station apportionment. Corners interpolate as ordinary vertices;
their corner-ness is constant across stations, so corners form columns.

What changes is the output: every emitted station — the dense mesh list and
the sparse `stations:"controls"` list alike — is fitted back to a
**cubic-Bézier contour**:

- Per arc, the clamped open CR through the station's resampled vertices is
  converted span-by-span to cubic Béziers by exact 4-point inversion
  (`B1 = (−5S₀ + 18S₁ − 9S₂ + 2S₃)/6`, `B2 = (2S₀ − 9S₁ + 18S₂ − 5S₃)/6` with
  S sampled at u = 0, 1/3, 2/3, 1 — exact because a CR span is a cubic).
- Arcs join at corner vertices; adjacent arcs' clamped end tangents differ, so
  the joint is a genuine tangency break that `profileCorners` detects
  geometrically. (A corner whose interpolated angle flattens toward 180° at
  some station sheds its crease there under loft's geometric corner policy —
  which is visually correct.)
- `smoothLoftRings` returns `[{polygon: contourIR, z}, …]` — structurally
  identical all-cubic contours (same span count, same segment types), which is
  precisely `k.loft` curve mode's precondition.

Both backends then simply call `k.loft`:

- **B-rep**: `stations:"controls"` rings, `ruled:false` — OCCT lofts the exact
  Bézier wires (probe: 74–261 ms). STEP is curve-exact around each ring;
  cross-station remains ThruSections' native skin. STEP size scales with
  `samples` (≈870 KB per blade-class sub-part at the default 128; lower
  `samples` if size matters — volume plateaus by 24–48).
- **Mesh**: densified stations, curve-mode matched per-segment sampling
  (~one vertex per span for many-span rings, so around-ring resolution stays
  ≈ `samples`), and loft's corner-sector shading creases sharp columns.

The explicit `shading:"smooth"` default in the composition is **dropped**: the
curve shading policy decides (smooth for curve sectors, creased at corners).
A caller-supplied `shading` still passes through as the hint it already is.
v1's point-ring emission path is deleted, not kept alongside.

Composition (kernel-front, normative):

```js
const brepLoft = typeof k.toSTEP === "function";
k.loftSmooth ??= ({ sections, stations, samples, shading, closed = false }) => {
  if (brepLoft && closed) throw new Error("loftSmooth: closed:true loops are only supported on the Manifold backend");
  return brepLoft
    ? k.loft({ rings: smoothLoftRings(sections, { stations: "controls", samples }), ruled: false })
    : k.loft({ rings: smoothLoftRings(sections, { stations, samples, closed }), shading, closed });
};
```

### 4. Closed loops

New `closed: true` option (default false):

- Requires **≥3 control sections** (frozen error).
- Cross-station CR goes **periodic**: no reflection phantoms; the knot vector
  wraps through the closing chord (last ring back to ring 0); every control
  knot is emitted once; interior stations are apportioned over all `n` spans
  (including the closing span) by the same largest-remainder rule;
  `stations` below `n` is raised to `n`; the default station count becomes
  `n * 8` (open default stays `(n−1) * 8 + 1`).
- The emitted ring list does **not** repeat ring 0; `closed:true` passes
  through to `k.loft`, whose Manifold path stitches the closing band and skips
  caps (existing semantics).
- Manifold-only, same as `k.loft`: the B-rep branch throws the frozen error in
  the composition above *before* building rings. `closed:true` combined with
  `stations:"controls"` is rejected inside `smoothLoftRings` as a defensive
  invariant (unreachable through the composition).

### 5. API surface and frozen errors

Op options: `loftSmooth: { sections, stations?, samples?, shading?, closed? }`
(`closed` is the one new key; `sections` remains the only required key).
`types/kernel.d.ts` gains `closed?: boolean` and widens the section type to
accept contour/Shape2D outlines plus `sharp?: number[]`.

New frozen error strings (exact):

- `` `loftSmooth: every section must have the same corner count — section ${i} has ${mi}, section 0 has ${m0}` ``
- `` `loftSmooth: section ${i} is a curve contour — its corners are implicit; sharp is only for point sections` ``
- `` `loftSmooth: section ${i} sharp indices must be integers in 0…${n - 1}` ``
- `"loftSmooth: closed:true loops are only supported on the Manifold backend"`
- `"loftSmooth: closed:true needs at least 3 control sections"`
- `'loftSmooth: closed:true cannot combine with stations:"controls"'`

Retired: `` `loftSmooth: section ${i} is an arc profile — control sections must be point arrays (for now)` `` (curve sections are now accepted). Curve-section
structural errors (multi-region Shape2D, holes) reuse `k.loft`'s wording with
the `loftSmooth:` prefix and section index.

All other v1 errors and clamps survive verbatim (sections ≥2, stations
2…1024 or `"controls"`, samples 8…2048, zero-perimeter).

### 6. Contract, docs, versioning

- **KERNEL-CONTRACT.md**: the loftSmooth row's normative statement (smooth
  interpolating loft; within-tolerance parity class) survives; the row gains
  curve-input sections, `sharp`, `closed` (Manifold-only), and the
  curve-emission note (B-rep around-ring exact Bézier wires; mesh via curve-
  mode sampling). **CONTRACT_VERSION stays 4** — additive options plus a
  refinement inside the op's stated tolerance class.
- **AUTHORING-PARTS.md**: op-table row updated; the "Smooth organic lofts"
  recipe gains sharp-trailing-edge and curve-section examples.
- **ERROR-PATTERNS.md**: `loftsmooth-sections-point-arrays` is replaced by an
  entry for the corner-count-mismatch error (the new most-likely authoring
  trip); add an entry for `closed` on the OCCT/STEP path.
- **package.json**: bump to **0.85.0** in the v2 PR (v1's 0.84.0 publishes
  when #168 merges; if #168 is still open when v2 is ready, v2 stacks and the
  bump stands).
- Memory/AGENTS.md: propeller entry mention of the A/B toggle stays accurate;
  no part-count change.

### 7. Testing

Pure (`test/loft-smooth.test.js`, kernel-free):

- Bézier emission is exact: dense samples of each emitted cubic match
  `crPoint` dense samples of the same span (≤1e-9).
- Corners are preserved: a tagged vertex appears exactly at a contour joint in
  every emitted station, and adjacent-arc end tangents differ there.
- Arc apportionment: deterministic, sums to `samples`, min 1 span/arc,
  `samples < m` raised.
- `m = 0` emission is v1-compatible: vertices of the emitted contours equal
  v1's resampled rings (the fit interpolates them).
- Closed: periodic station list (no ring-0 repeat, `n*8` default, knots wrap);
  each new frozen error string.

Manifold (`test/loft-smooth-manifold.test.js`):

- Propeller parity anchor unchanged: `PARITY_CM3 = 22.85` ± 2%.
- Sharp TE: the propeller with `sharpTE` on has a creased trailing-edge column
  (mesh normals split / sector count reflects the corner) and remains
  watertight.
- Closed loop: a 4-section closed loop is watertight with volume in a
  hand-computable band.

OCCT (`test/loft-smooth-occt.test.js`):

- Curve-wire loft at reference density (5 controls × 128 spans) under 1 s
  (probe: 261 ms; keep the existing 5 s contract as the hard gate, assert 1 s
  as the regression tripwire).
- STEP export non-trivial (byteLength > 10 000 — probe: 162 KB+).
- `closed:true` throws the frozen error.
- Parity anchor: propeller volume within 2% of `PARITY_CM3`.

Smoke: propeller stays in the CI app list (no change).

### 8. Reference part

`src/parts/propeller.js` gains a **`sharpTE`** toggle (default **on**) that
tags the trailing-edge vertex of each airfoil section `sharp` — the exact
defect from the original agent story (smeared trailing edges). The
smooth/raw A/B toggle and the Surface panel survive; `sharpTE` joins them.

## Out of scope (v3 candidates)

- **Cross-station exactness in STEP** — around-ring wires are now exact, but
  the skin between stations is ThruSections' fit, not the shared CR. Emitting
  the cross-station spline exactly needs a native B-spline surface writer.
- **Per-station corner-count variation** (a corner that exists on some
  sections only — corner birth/death along the loft).
- **Open (non-ring) profiles** — lofting sheets, not solids.
- **Non-planar / oriented sections** — rings are planar at scalar z, v1 rule.
