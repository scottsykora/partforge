# Geometry backend strategy: fast Manifold preview + exact OCCT export

Status: **proposed** (Phase 0 spike done, see results below). Last updated 2026-06-19.

## Problem

Generating a drum is slow. It's dominated by **OpenCASCADE (OCCT) boolean
operations**, not meshing. OCCT is an exact BREP kernel, and boolean cost scales
with the solid's face count — so every cut after the helical grooves is
expensive, and the helical groove cut itself is intrinsically heavy.

Measured big-drum build (current code): ~7.4 s, e.g. groove cut + interior cuts
~3.4 s, end stops ~2 s, pockets ~1.4 s. Reordering cheap cuts before the grooves
only saved ~0.6 s, because the groove cut then inherits the feature complexity —
confirming the cost is structural to BREP, not fixable by reordering.

We want the interactive **preview** to feel instant, while still producing an
**exact STEP file** for CAD hand-off / editing.

## Strategy

Introduce a **geometry-backend abstraction** with two implementations, chosen
per job:

- **Manifold** (mesh CSG) for the live preview — extremely fast booleans.
- **OCCT** (via Replicad) for STEP export — exact BREP, the source of truth.

```
            ┌─────────────── drum.js (backend-agnostic) ───────────────┐
            │ buildSmallDrum(B) · buildBigDrum(B) · buildSubPart(B,...) │
            └───────────────────────────┬──────────────────────────────┘
                                         │ Backend interface
                   ┌─────────────────────┴─────────────────────┐
            manifoldBackend (preview)                  occtBackend (STEP)
            manifold-3d (WASM)                         replicad + opencascade.js
```

### Backend interface (minimal set drum.js needs)

```
primitives:  cylinder(r,h) · cone(r1,r2,h) · box(min,max) · prism(poly2D,h)
             helixSweptTube(pathR, profileR, pitch, turns, z0, lefthand)
booleans:    union(...) · difference(a,b) · intersection(...)
transforms:  translate · rotate · mirror
output:      toMesh()                  // both backends
             toSTEP()                  // OCCT only
```

### Worker wiring

- `generate` (preview): Manifold backend → display mesh per sub-part (the
  existing per-sub-part cache stays).
- `export-step` / `export-stl`: OCCT backend (exact STEP; STL can come from
  either, but OCCT keeps export identical to today).

## Phase 0 spike results (2026-06-19)

Validated head-to-head against OCCT, comparing **mesh volume** (kernel-agnostic
geometry equivalence) and build time:

| Test | Manifold | OCCT | Result |
|---|---:|---:|---|
| Big drum (grooves + bores + bolts) | 0.04 s | 2.82 s | 75× faster, **0.84%** volume match |
| Small drum groove via **twist-extrude** | 0.01 s | 15 s | fast but **15% wrong shape** |
| ⤷ twist-extrude at 4 resolutions | — | — | stuck at ~15% → **systematic, not faceting** |
| Small drum groove via **frenet swept-tube mesh** | 0.077 s | 15 s | **0.12% match**, ~195× faster |

### Key findings

1. **Manifold booleans are 75–1486× faster.** The speed win is real and large.
2. **The groove needs care.** The naive approach — twist-extrude a circular
   cross-section along Z — is geometrically wrong for the tight multi-turn coil
   (off ~15%, and resolution-independent, so it's a shape error). Fine only for
   shallow <1-turn grooves (big drum, 0.84%).
3. **The accurate approach works and stays fast.** Build the groove as an
   explicit **frenet swept-tube mesh** (circular profile carried along the helix
   in its own frame), fed to `Manifold.ofMesh` — matches OCCT to **0.12%**.

### Gotchas the spike surfaced

- The swept tube mesh must be **watertight with consistent outward winding**, or
  `Manifold.ofMesh` throws `NotManifold`, or (worse) imports inverted so a
  `subtract` *adds* material. Getting the winding + end caps right is the one
  genuinely fiddly piece; the spike has a working version.
- **Two WASM kernels** load (Manifold ~small, OCCT ~11 MB). Likely run in
  separate workers.
- **Preview ≠ export**: Manifold preview is a mesh approximation; the OCCT STEP
  is exact. Usually invisible, occasionally not.
- Anything OCCT-only (fillets, exact sweeps) can't live in the shared interface.

## Phased plan

- **Phase 0 — spike (done):** prove speed + accurate groove. ✅
- **Phase 1:** the `helixSweptTube()` mesh builder (tested standalone) + the
  backend interface + `manifoldBackend` + `occtBackend`.
- **Phase 2:** port `drum.js` to the interface (all features as backend ops).
- **Phase 3:** wire the worker (Manifold preview, OCCT export); keep the UI.

## Research & licensing (verified 2026-06-19)

### Prior art — is this already solved?

No off-the-shelf solution does what we need (fast mesh preview + exact BREP/STEP
export for browser parametric CAD), so the dual-backend wrapper is justified:

- **Manifold is the proven fast mesh-boolean kernel.** Blender, OpenSCAD, and
  BRL-CAD already use it for booleans (BRL-CAD reported ~7× faster + higher
  success after switching); FreeCAD has an open discussion about adopting it.
  This de-risks the choice — we're using the same kernel the CAD world trusts
  for fast booleans, not something exotic.
- **Replicad has no faster-preview path.** It's purely OCCT, so it does not
  already solve our speed problem — it *is* the slow path we're working around.
  (It stays our exact/STEP backend.)
- **No library gives the groove for free.** Manifold has no sweep-along-a-spine,
  which is exactly why the naive twist-extrude fails (spike finding #2). The
  `helixSweptTube()` mesh builder is ours to write — standard technique, no
  existing drop-in.

Conclusion: nothing to reuse wholesale; the plan stands.

### License compatibility — OK to build on

| Component | License | Notes |
|---|---|---|
| Replicad | **MIT** | permissive |
| three.js, Vite | **MIT** | permissive |
| manifold-3d | **Apache-2.0** | permissive (incl. patent grant) |
| opencascade.js / OCCT | **LGPL-2.1 + OCCT Exception 1.0** | copyleft, but fine for our use |

All compatible with building on top. The only copyleft piece is OCCT (via
opencascade.js), and our usage is the standard, accepted pattern:

- We consume it **unmodified, as a separate WASM module** (an npm dependency
  loaded as its own `.wasm` asset) — we don't fork or edit OCCT.
- LGPL obligations are then light: **retain OCCT's license/notice**, and keep the
  OCCT component **replaceable** (trivially true — it's a standalone `.wasm`).
  The OCCT Exception further relaxes the object-code/linking terms.
- This is exactly how Replicad (itself MIT) already builds on opencascade.js, so
  we're on well-trodden ground.
- Apache-2.0 (Manifold) and LGPL-2.1 (OCCT) **coexist** here because we ship them
  as separate modules used by our own code — we are not merging their sources,
  so the usual Apache-vs-GPLv2 source-combination friction doesn't arise.

Our own code can be licensed however we choose; the only hard requirement is to
**preserve the upstream license notices** (especially OCCT's) in any
distribution. (The Drum-Machine repo is private today, so nothing is distributed
yet — but worth doing now so a future public release is clean.)
