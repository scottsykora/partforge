# `k.loftSmooth` — spline-interpolated loft of sparse control sections

Date: 2026-08-24
Status: for review

## Problem

An LLM agent asked for an organic shape — the motivating case was a boat
propeller — reaches for `k.loft`, hands it the 4–6 cross-sections it can
reason about, and gets a chunky polyhedron: the Manifold path is straight quad
stitching, and the smooth options (`loft` `ruled:false`, `sweep` `smooth:true`)
are honored only by the B-rep backend, on the export path the agent never sees.
The workaround (sample your own splines into dozens of dense rings in part JS)
works but is exactly the kind of numerical busywork agents get subtly wrong.

A true cross-backend NURBS *representation* is impossible — Manifold is a mesh
kernel — but the section-based subset of NURBS (loft/sweep through interpolated
sections) is watertight by construction and matches how agents actually think:
"here are 5 airfoil sections, make it smooth." `loftSmooth` is that op: sparse
control sections in, a smooth interpolated solid out, on both backends.

## What testing established

The spike (`spike(loft): k.loftSmooth` on this branch; propeller exerciser with
live A/B) and two follow-up probes fixed the architecture:

1. **Shared Catmull-Rom densification works.** Five sparse NACA-ish sections
   (24 points each) densified to 48 stations × 128 samples read as genuinely
   organic; the raw loft of the same sections shows hard faceted banding.
   Cross-backend volumes at defaults: Manifold 22.80 cm³, OCCT 22.90 cm³
   (**0.4% divergence**); both watertight, all verify gates pass.
2. **Centripetal (α=0.5), not uniform, parameterization around the ring.**
   Airfoil-style sections cluster points at the leading edge; uniform CR
   overshoots on the uneven chords, centripetal does not.
3. **Do not feed the densified station list to the B-rep backend.** OCCT's
   native loft through dense polygon wires took 23 s at 32×96 and hard-aborted
   the WASM (`2147467400`) at 48×128. Sparse control-station wires plus OCCT's
   own smooth skin (`ruled:false`) is ~10× faster (111–209 ms vs 1.1 s for one
   blade at moderate density) and robust at every density tried. This demotes
   parity from sweep's by-construction class to `screwSweep`'s within-tolerance
   class — accepted, and measured at 0.4% above.
4. **The curve-native B-rep upgrade is viable but blocked.** Probing #166's
   curve-mode loft with identical-signature cubic rings: correspondence is
   stable through 120° of twist (no re-seaming; bbox grows exactly as the twist
   demands), `ruled:false` runs in 15–25 ms, and STEP output is a compact
   26–34 kB of true spline faces. But OCCT curve-mode lofts of **cubic**
   contours come out negatively oriented (−3.548 cm³ where Manifold gives
   +3.547; arc contours are exact and positive) — an orientation bug in the
   cubic wire path, filed separately. Curve-native emission is therefore v2,
   gated on that fix (see Out of scope).
5. **Corner smearing is bounded by sample spacing.** The closed spline rounds
   authored corners (an airfoil trailing edge) at roughly perimeter/`samples`
   scale — sub-mm at defaults, invisible in the spike renders. Explicit sharp
   tags are v2.

## The op

```js
k.loftSmooth({ sections, stations?, samples?, shading? })   // options-only
```

| option | meaning | default | clamp |
|---|---|---|---|
| `sections` | ≥2 loft-style ring specs `{polygon\|sides+radius, z, rotate?, scale?}`; vertex counts **may differ** between sections | required | 2… |
| `stations` | output ring count along the spine (mesh path) | `(n−1)·8 + 1` | 2…1024 |
| `samples` | output vertex count around each ring | `max(64, largest section)` | 8…2048 |
| `shading` | forwarded to `loft` | `"smooth"` | — |

v1 sections are **point rings only** (point list or `sides`+`radius`); a curve
contour or `Shape2D` section throws the spike's loud error. Rationale: the
densifier interpolates *through* control points, and running it over a curve's
tessellation would silently replace the authored curve with a nearby spline —
curve sections should instead arrive with the v2 curve-native path, which can
keep them exact. All spike validation errors (non-finite z, <3 points, zero
perimeter, clamp violations) keep their exact strings.

Semantics: the surface **interpolates** every control section exactly (not
approximates — agents reason about sections they can measure), passes through
them in array order, and `rotate`/`scale`/`z` per section behave exactly as in
`loft`.

## Composition and routing

A compound default in `kernel-front.js` (the `screwSweep` pattern — no backend
override), composed over the wrapped `k.loft` so caching and validation apply:

- **Mesh path:** `loft({ rings: densified(stations × samples), shading })` —
  poly-exact mode, bit-for-bit the legacy single-surface loft path (no sector
  shading, no kink partitioning), smooth-shaded by default.
- **B-rep path:** `loft({ rings: controlStations(samples), ruled: false })` —
  one ring per control section, around-ring reconciled to `samples` vertices,
  skinned by the backend's native smooth loft.

B-rep detection is capability-honest: at composition time (before
`finishKernel` assigns the `toSTEP` stub) only a B-rep backend has `toSTEP` —
the same property the contract's conformance classes are defined by.

Parity class: **within tolerance** (`screwSweep`/`hull`'s class) — the two
backends share the identical around-ring reconciliation but interpolate across
stations differently (shared-knot Catmull-Rom vs OCCT's B-spline skin).
Measured 0.4% by volume at spike defaults; the parity test gates at 2%.

## The densifier (`loft-smooth.js`, pure JS, backend-free)

1. **Resolve** sections like loft's legacy ring bake (scale-then-rotate,
   verbatim math), minus the equal-count rule.
2. **Around each ring:** closed periodic centripetal Catmull-Rom through the
   control points (Barry–Goldman evaluation; coincident-point ε 1e-6), sampled
   8× per control segment, then resampled to `samples` vertices uniformly by
   arc length **starting at vertex 0**. The seam is deliberately *authored
   correspondence*, not `resampleTessellation`'s geometric +X-ray seam: vertex
   `j` is the same material line on every section, so authored twist
   (`rotate`) sweeps correctly instead of being un-twisted by a re-seaming
   pass. (The geometric seam is right for `resample` mode's arbitrary rings;
   it is wrong for sections that correspond by construction.)
3. **Across stations:** Catmull-Rom per vertex index with **one shared knot
   vector** — chord length along the centroid spine (centroid-xy + z). Shared
   knots make every vertex's z-blend identical, so output rings stay planar
   (the `loft` ring format's requirement) — planarity by construction, not by
   tolerance. Ends are clamped with reflection phantoms. Stations are
   distributed **per knot span** (proportional to span length, minimum 1 per
   span) with every control knot always emitted, so the output mesh contains
   each control section as an actual ring — the interpolation guarantee is
   testable on the output, not just true of the underlying spline. (The spike
   sampled uniformly in knot space; this is the one behavioral refinement the
   spec adds, and the default `(n−1)·8 + 1` is exactly 8 per span plus the
   shared knots.)
4. The B-rep path short-circuits after step 2 (internal `stations: "controls"`
   mode — not a public option; the d.ts types `stations` as number).

Determinism: pure function of its arguments — no RNG, clock, or module state —
so the content-hash memoization and probe determinism checks hold.

Known accepted behavior: strongly non-monotonic section z can make the
cross-station spline overshoot (rings locally reverse). Not detected in v1;
the loft's existing inversion self-correction bounds the damage to a weird
shape, not a crash.

## Contract, docs, surfaces

- **Additive; `CONTRACT_VERSION` stays 4** (the `import`-op precedent).
  `loftSmooth` moves from the SPIKE note to a normative compound-op row in
  KERNEL-CONTRACT.md, including the backend-divergent composition and the
  parity table row: mesh = densified poly-exact stitch, B-rep = native smooth
  skin over control wires, class *within tolerance*, STEP smooth across
  stations / faceted around rings at the `samples` LOD (the documented
  `extrude`-`bevel`/`resample` trade).
- Already wired by the spike, kept: `KERNEL_OPS`, `KERNEL_OP_SPECS`
  (options-only passThrough), `types/kernel.d.ts` (`LoftSmoothOptions`), the
  op-options key pin in its test.
- AUTHORING-PARTS.md: op table row plus a "smooth organic lofts" recipe
  (sections-first framing, when to reach for `loftSmooth` vs `loft` vs
  `sweep`); ERROR-PATTERNS.md entries for the clamp/validation errors and for
  "loftSmooth looks faceted" (→ raise `samples`, it's the around-ring LOD in
  STEP too).
- The spike part graduates: `propeller-spike.js` → `src/parts/propeller.js`,
  the `loftSmooth` reference part (hub + airfoil blades; keep the smooth/raw
  A/B toggle — it is genuinely didactic — drop the "Spike"/THROWAWAY labels),
  with html/app/worker glue renamed and AGENTS.md's parts list updated. The
  spike's KERNEL-CONTRACT SPIKE blockquote is deleted by the normative row.

## Testing

- **Densifier unit tests** (`test/loft-smooth.test.js`, kernel-free): output
  rings planar and equal-count; every control section present as an output
  ring, its vertices on the section's spline (≤1e-9); centripetal no-overshoot on a
  clustered-spacing ring (uniform CR's overshoot as the contrast case);
  differing section counts reconciled; validation errors exact; determinism
  (two runs, deep-equal).
- **Backend tests:** Manifold — densified loft watertight, volume vs analytic
  frustum-of-splines tolerance, `shading:"smooth"` honored; OCCT (own file,
  `bootOcctKernel`) — control-wire `ruled:false` path builds, positive volume,
  STEP export succeeds, and the 48×128 default that killed the dense-wire path
  stays fast (regression guard ~<2 s single solid).
- **Parity test:** propeller reference part, both backends, |Δvol| ≤ 2%.
- **CLI/CI:** `measure` + `verify` on the reference part in both backends;
  `propeller.html` joins the smoke-check matrix.

## Out of scope (v2+)

- **Curve-native B-rep emission** — convert the around-ring CR to exact cubic
  Bézier contours (identical signatures → #166 curve mode → OCCT lofts
  original spline wires, STEP exact both directions). Probed viable (stable
  correspondence to 120° twist, 15–25 ms, 26–34 kB STEP); **gated on the
  cubic-contour orientation bug** filed from the probe (curve-mode cubic lofts
  come out inside-out on OCCT).
- **Sharp tags** — per-section `sharp: [vertexIndices]` splitting the closed
  CR into clamped arcs so corners (airfoil trailing edges) survive exactly and
  sweep as creases; requires matched sharp counts across sections.
- **Curve-contour / Shape2D input sections** — natural once curve-native
  emission exists; until then they would be silently re-splined (see The op).
- **Closed loops** (`closed:true` — periodic cross-station CR, torus-class
  shapes) and any auto-LOD (curvature-adaptive `stations`/`samples`).
