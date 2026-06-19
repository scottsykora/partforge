# Geometry backend design — Manifold preview + OCCT export

Date: 2026-06-19
Status: approved design (precursor: `docs/geometry-backend-strategy.md`, which holds the Phase 0 spike data and license review)

## Problem

Generating a drum is slow, dominated by **OpenCASCADE (OCCT) boolean operations**
(not meshing). OCCT is an exact BREP kernel and boolean cost scales with a
solid's face count, so the helical groove cut and every feature cut after it are
expensive. Measured big-drum build ≈ 7.4 s; reordering cheap cuts before the
grooves saved only ~0.6 s because the groove cut then inherits the complexity —
the cost is structural to BREP, not fixable by reordering.

We want the interactive **preview to feel instant** while still producing an
**exact STEP file** for CAD hand-off.

## Goal & key decisions

Build a **clean, swappable geometry-kernel abstraction** with two interchangeable
backends, chosen per job:

- **Manifold** (mesh CSG) for the live preview and STL — 75–1486× faster booleans
  in the spike.
- **OCCT** (via Replicad) for STEP export — exact BREP, the source of truth.

Decisions locked during brainstorming:

1. **Full abstraction:** one backend-agnostic `drum.js` talks to a `GeometryKernel`
   interface; two backends implement it. The parameter is named `kernel`.
2. **Two workers, OCCT lazy:** a preview worker loads only Manifold (boots fast);
   an export worker loads OCCT lazily on first STEP download.
3. **STL from Manifold** (high-res), **STEP from OCCT.** Most "just print it"
   users never trigger the 11 MB OCCT boot.
4. **Testing:** analytic unit tests for the swept-tube builder + cross-kernel
   volume-parity tests for small + big drums (block: Manifold-only checks).
5. **Dev toggle, default Manifold:** `?backend=occt` points the *preview* at the
   OCCT worker for A/B comparison and fallback.

### Non-goals (YAGNI)

- No data/IR "compiler" abstraction (over-engineered for one tool).
- No runtime user-facing backend switch beyond the dev toggle.
- No attempt to make the OCCT preview fast — OCCT stays the exact/export path.

## Architecture

```
src/
  geometry/
    kernel.js            # GeometryKernel contract (JSDoc types) + shared helpers
    occt-backend.js      # wraps Replicad/OCCT; the only backend with toSTEP()
    manifold-backend.js  # wraps manifold-3d
    helix-tube.js        # frenet swept-tube MESH builder (used by manifold-backend)
  drum.js                # backend-agnostic: buildSubPart(kernel, …), buildParts(kernel, …)
  params.js              # unchanged
  geometry-jobs.js       # handle(kernel, msg): generate / export-stl / export-step
  preview-worker.js      # manifold-backend → geometry-jobs (boots Manifold)
  export-worker.js       # occt-backend → geometry-jobs (boots OCCT lazily)
  main.js                # spawns both workers, routes jobs, dev backend toggle
  controls.js            # unchanged
```

- `drum.js` no longer imports Replicad; it builds geometry through `kernel`. One
  source of truth for the drum's shape.
- Today's `drum-worker.js` splits into `geometry-jobs.js` (shared handlers) + two
  thin worker entries. The per-sub-part mesh cache, tab/Generate UX, and
  `controls.js` are unchanged.

## The `GeometryKernel` contract

`drum.js` only ever touches this surface. Primitives return an opaque `Solid`
handle.

```
Primitives:
  kernel.cylinder(rBottom, rTop, h, {center})  // rBottom===rTop ⇒ cylinder, else cone/frustum
  kernel.box(min, max)
  kernel.prism(points2D, h)                     // extrude a 2-D polygon
  kernel.helixSweptTube(pathR, profileR, pitch, turns, z0, lefthand)

Combine:
  kernel.union(solids[])                        // real union (additive geom; merge overlapping tools)

Solid methods:
  solid.cut(tool)
  solid.cutAll(tools[])                         // batch subtract, backend-optimized
  solid.translate(v)
  solid.rotate(deg, center, axis)
  solid.mirror(plane)

Output:
  solid.toMesh({quality})  → { positions, normals, indices, triangles }
  solid.toSTL({quality})   → ArrayBuffer
  kernel.toSTEP(named[])   → ArrayBuffer        // OCCT only; Manifold throws "unsupported"
```

- `quality` is `"preview"` (coarse, ~current display) or `"print"` (fine, for
  STL). Manifold uses it to choose segment counts; OCCT uses it at mesh time.
- The composed helpers `frustum`, `annularSector`, `hexPrism` are **not** kernel
  primitives — `drum.js` builds them from `cylinder` / `prism` / `cut`.

### Two ops carry kernel-specific implementations behind a shared signature

- **`helixSweptTube`** — OCCT: `makeHelix` + frenet `genericSweep` of a circular
  profile. Manifold: `helix-tube.js` builds an explicit frenet swept-tube mesh
  (validated in the spike to match OCCT within 0.12% volume) → `Manifold.ofMesh`.
  *Naive twist-extrude is wrong (~15%, resolution-independent) and must not be
  used.*
- **`cutAll`** — OCCT: cut by a `makeCompound` of disjoint tools (the cheap batch
  trick already in use). Manifold: one batched subtract. Preserves today's
  "fuse overlapping per-anchor, then batch-cut disjoint" perf work.

## `helix-tube.js` (the critical piece)

Builds a watertight triangle mesh of a circular profile swept along a helix in
its frenet frame, then `Manifold.ofMesh`:

- Stations along φ ∈ [0, 2π·turns]; at each, centre on the helix and a ring of
  `ringSegs` points in the (N, B) frame where N = radial, B = T×N.
- Side quads between consecutive rings + end caps, **consistent outward winding**
  (the spike hit `NotManifold` and an inverted-solid bug here — orientation must
  be exact).
- Resolution from `quality`: ~16 stations/turn + 16 ring segs for preview, higher
  for print.
- Returns a `Manifold`.

## Data flow

`main.js` owns the per-sub-part mesh cache and routes jobs:

| Job | Worker | Notes |
|---|---|---|
| `generate` (preview) | preview (Manifold) | `quality:"preview"`; per-sub-part meshes → cache. `?backend=occt` reroutes to export worker for A/B. |
| `export-stl` | preview (Manifold) | `quality:"print"`, high-res mesh |
| `export-step` | export (OCCT) | lazy-boots OCCT on first use → exact STEP |

Both workers run the same `geometry-jobs.handle(kernel, msg)`; they differ only
in which kernel they instantiate and that STEP is OCCT-only.

## Error handling

- Worker exceptions → `postMessage({type:"error"})` → status line (as today).
- OCCT boots lazily; a load/boot failure surfaces on the first STEP download, not
  at startup.
- `helixSweptTube` validates watertightness (`Manifold.ofMesh` throws
  `NotManifold` on a bad mesh); caught, surfaced, and guarded by unit tests.
- `kernel.toSTEP` on Manifold throws a clear "unsupported" error (never routed
  there in practice).

## Testing

- **Unit tests — `helix-tube.js`:** watertight (`ofMesh` succeeds); correctly
  oriented (subtracting from a blank *removes* volume); volume ≈ analytic
  (≈ π·profileR²·helix-length) across param sets (turns, pitch, radius, lefthand).
- **Cross-kernel parity — small + big drums:** build via each backend, compare
  mesh volume within ~1.5%. Block excluded (OCCT can't mesh it headless) → gets
  Manifold-only watertight + volume-sanity checks.
- **Dual-kernel constraint:** Manifold + OCCT in one Node process crashes (spike
  finding). So a **fixture script** computes OCCT reference volumes in its own
  process and commits them; the **Vitest** suite boots only Manifold and asserts
  parity against the committed fixtures. Fixtures regenerate on intentional
  geometry changes.
- Adds **Vitest** (project has no test runner yet).

## Rollout & risks

- `manifold-3d` becomes a real dependency (Apache-2.0). Licenses all clear (see
  strategy doc): Replicad/three/Vite MIT, Manifold Apache-2.0, opencascade.js/
  OCCT LGPL-2.1 + OCCT Exception (used unmodified as a separate replaceable WASM
  module — preserve notices).
- **Accepted divergence:** preview (Manifold mesh) ≠ export (OCCT exact); STEP is
  the source of truth.
- **Needs porting + parity beyond the spike's coverage:** the small-drum
  rope-lock weave hole, the load-socket pin, and any sector (<360°) drum.
- Ships behind the dev toggle; OCCT preview is one query-param away for fallback.

## Suggested phasing (for the implementation plan)

1. `helix-tube.js` + `GeometryKernel` contract + `occt-backend` + `manifold-backend`
   + unit tests (helix-tube + a primitive smoke test).
2. Port `drum.js` to `kernel`; add cross-kernel parity tests + OCCT fixture script.
3. Split the worker into `geometry-jobs` + `preview-worker` + `export-worker`;
   wire `main.js` routing, lazy OCCT, STL-from-Manifold, and the `?backend=occt`
   toggle.
