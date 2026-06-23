# Automatic backend selection + native fillet/chamfer — design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Repo:** `partforge`

## Goal

Give partforge parts **native CAD fillet and chamfer** (curve-following, variable-radius,
exact STEP) without slowing down the fast mesh path — by making the framework **choose the
geometry backend automatically, per part, based on the operations the part uses.**

A part that uses an OCCT-only op (`fillet`/`chamfer`) is built on **OCCT/replicad** (native,
exact, and fast because such parts aren't sweep-heavy). Every other part — including
sweep-heavy ones like the capstan drum — stays on **Manifold** (fast preview/STL/3MF, ~1 s
where OCCT would take ~40 s). The author writes geometry; the framework routes.

### Why this shape (the journey, recorded)

We spiked OCCT-only as a full re-platform. Simple parts mesh fast on OCCT (a filleted
bracket ~80 ms; native fillet ~20 ms), but the **drum's helical grooves take ~19 s for one
drum and ~42 s for the assembly** vs **~1.2 s on Manifold** — a ~35× gap that is fundamental
to exact B-rep sweeps, not a tuning bug. So Manifold must stay for sweep-heavy parts.
Constructive (mesh-buildable) rounding was considered but can't do curve-following or
variable-radius fillets. A mixed-kernel-within-one-part pipeline (OCCT→mesh→Manifold) is
feasible but sacrifices STEP exactness downstream and only helps a narrow case. **Per-part
backend selection, chosen automatically, is the best balance**: real CAD fillets where they
belong, fast preview everywhere, no author burden.

## Decisions (from brainstorming)

1. **Per-part backend**, selected **automatically** from the ops a part uses; manual override
   allowed via `meta.backend`.
2. **OCCT-only op set (v1):** `fillet`, `chamfer`. (`shell`, `offset` are reserved for the set
   but implemented as a fast-follow — see Out of scope.)
3. **Wrapper:** replicad as the OCCT wrapper (native `.fillet`/`.chamfer`), per the prior
   decision (raw-`OC` and trimmed-WASM escape hatches remain available, not used here).
4. **Detection = two layers:** an upfront geometry-free **probe** + a **capability-error
   backstop** in the Manifold backend.
5. **Manifold stays** for everything that doesn't use an OCCT-only op.

## Global constraints

- **Node 24** (`.nvmrc` = 24.16.0); default shell Node is too old.
- **Units are millimetres.**
- **Manifold and OCCT must never boot in the same process** — they remain in separate workers
  (and separate test processes).
- **Manifold WASM objects are freed via `cleanup()`.**
- **Part modules are DOM-free and side-effect-free**; `build(k,p,d)` is pure construction (it
  may be re-run by the probe — so it must not have side effects or depend on real geometry
  values it reads back mid-build).
- The existing `GeometryKernel`/`Solid` contract and the two-worker (`manifold`/`occt`) model
  are kept; this extends them, it doesn't replace them.

## Architecture

### The OCCT-only ops

New `Solid` methods, added to the contract:

| Method | Manifold backend | OCCT backend |
|---|---|---|
| `s.fillet(radius, selector?)` | throws `KernelCapabilityError` | `shape.fillet(radius, finder)` (native, exact) |
| `s.chamfer(distance, selector?)` | throws `KernelCapabilityError` | `shape.chamfer(distance, finder)` (native, exact) |

`radius`/`distance` is a number (uniform). The `selector` picks which edges:

- **omitted** → all edges.
- **declarative object** (LLM-friendly), mapped onto a replicad `EdgeFinder`:
  - `{ dir: "X"|"Y"|"Z"|[x,y,z] }` → `e.inDirection(vec)`
  - `{ inPlane: "XY"|"XZ"|"YZ", at?: number }` → `e.inPlane(plane, at)`
  - `{ near: [x,y,z] }` → `e.containsPoint(point)`
  - (criteria combine with AND when several are given)
- **raw function** `(edgeFinder) => edgeFinder` → passed straight through (power-user escape hatch).

`KernelCapabilityError` lives in a shared `src/framework/geometry/errors.js` (carries a
`.code = "NEEDS_OCCT"` for identification across the worker boundary).

### Detection — layer 1: the probe (upfront, main thread)

`src/framework/geometry/probe.js` exports:
- `createProbeKernel()` → `{ kernel, used }`, where `kernel` implements **every** kernel and
  `Solid` method (including `fillet`/`chamfer`) as a no-op that records its name into the
  `used` Set and returns a chainable recording proxy. Geometry-free: `volume()`→`1`,
  `toMesh()`→a trivial mesh, etc., so a normal `build()` runs to completion.
- `detectBackend(part, params)` → `"occt" | "manifold"`:
  1. If `part.meta?.backend` is set, return it (manual override).
  2. Else run `build(probeKernel, p, d)` for **every** sub-part (`p = {...defaults, ...params}`,
     `d = derive(p)`), each wrapped in try/catch (a throw is ignored — the backstop covers it).
  3. Return `"occt"` if `used` intersects `OCCT_ONLY = { "fillet", "chamfer" }`, else `"manifold"`.

It is geometry-free, so it runs in microseconds on the main thread. It uses the **current
params**, so a conditionally-applied fillet is detected for the params that enable it. Backend
is decided **per part, not per view** (probing all sub-parts), so a part has one backend.

### Detection — layer 2: the capability backstop (safety net)

If the probe ever misclassifies (e.g., a pathological `build()` that the recorder can't run
cleanly), the real Manifold build calls `s.fillet(...)`, which **throws
`KernelCapabilityError`**. The worker recognizes it and posts `{ type: "needs-occt" }` instead
of a generic error; the main thread re-dispatches the same job to the OCCT worker and caches
`occt` for this part. Belt and suspenders; rarely hit.

### Routing (app integration)

- `createGeometryService` keeps both workers. Outbound jobs gain a `backend` argument:
  `service.generate(msg, backend)`, `service.exportStl(msg, backend)`,
  `service.export3mf(msg, backend)` route to `workers[backend]`. **STEP is always OCCT.**
- `mount` computes `backend = detectBackend(part, params)` before each generate/export and
  passes it through. It caches the last decision and listens for `{ type: "needs-occt" }` to
  switch + re-dispatch (the backstop).
- The existing `?backend=occt` URL flag becomes a manual override that forces `occt`
  (equivalent to `meta.backend`).

A Manifold part still exports **STEP** via the OCCT worker (build on OCCT for export only), as
today. An OCCT part builds **everything** (preview/STL/3MF/STEP) on OCCT — its native fillet
is therefore exact in STEP and present in the printed STL.

### OCCT backend mesh completeness

The OCCT backend must support the full preview/STL/3MF path (so an OCCT part renders and
exports): `toMesh` and `toSTL` already exist; **add `toIndexedMesh`** (for 3MF) and
**`volume()`** (replicad exposes `shape.volume()` / `measureVolume`, used by `measure`) to
`occt-backend.js`. (`occtKernel()` in `worker.js` already loads the OCCT kernel on demand.)

## Harness / CLI (render + measure for OCCT parts)

The verification harness must not break on a fillet part:
- `buildView`, `renderViews`, and `measure` already take a kernel. Add `detectBackend`-driven
  kernel selection to the **CLI** (`bin/cli.js`): boot the OCCT kernel (via `bootOcctKernel`)
  when `detectBackend(part) === "occt"`, else the Manifold kernel. So `partforge render
  filletedPart.js` shows the rounded edges.
- `render` works for OCCT parts unchanged (it only needs a mesh). `measure`'s mesh-derived
  fields (`bbox`, `surfaceArea`, `triangleCount`) work on any mesh, and `volume` works on OCCT
  via the new `occt-backend` `volume()`. **`watertight` and `holes` (genus) are Manifold-only**
  (they read `isEmpty`/`genus`): `measure` guards those calls and reports `null` for OCCT parts
  in v1 (OCCT topology measures are a follow-up — see Out of scope).

## Example part

Add `src/parts/filleted-box.js` (+ its app/worker glue, like the demo): a box with a native
`fillet` on selected edges and a `chamfer` on a hole mouth. It auto-routes to OCCT, exercises
the selector vocabulary, and is the worked example in the docs and the render/measure test.

## Testing posture (TDD, Node 24)

- **Detection** (`probe`/`detectBackend`): a part using `fillet` → `"occt"`; the demo spacer →
  `"manifold"`; `meta.backend` override wins; a conditional fillet is detected when its param is
  on and not when off.
- **OCCT fillet/chamfer geometry**: filleting a box reduces its volume and rounds the selected
  edges (assert volume is between the sharp box and a fully-rounded bound; assert the result
  meshes with `triangles > 0`); the selector picks the intended edges (e.g. `{dir:"Z"}` fillets
  only the 4 vertical edges → a distinct volume from all-edges).
- **Capability backstop**: calling `s.fillet` on the Manifold kernel throws
  `KernelCapabilityError` with `.code === "NEEDS_OCCT"`.
- **Selector mapping**: declarative `{dir}`/`{near}`/`{inPlane}` produce the corresponding
  replicad finder calls; a raw function passes through.
- **Harness**: `partforge render` on the filleted example writes a non-blank PNG showing the
  rounded edge (OCCT kernel auto-selected); `measure` returns mesh fields + volume, with
  `watertight`/`holes` null.
- OCCT tests boot via `bootOcctKernel` and stay in their own files (no Manifold co-boot).
- A green app build + the full suite gate the browser-only routing seams.

## Out of scope / deferred

- **`shell` and `offset`** native ops (reserved in spirit; add to `OCCT_ONLY` when implemented).
- **OCCT topology measures** (`watertight`/`holes`/genus for OCCT parts) — null for now.
- **Mixed-kernel-within-a-part** (OCCT→mesh→Manifold) — kept as a future escape hatch.
- **Constructive rounding helpers** for Manifold parts (`roundedBox`, etc.) — not needed now
  that real fillets come from OCCT parts; revisit if a Manifold part wants designed-in rounds.
- **Broader selector vocabulary** (length/angle/distance finders) beyond `dir`/`inPlane`/`near`
  + the raw escape hatch.
- **`revolve` primitive** (was for constructive rounding) — not needed in this approach.

## Risks

- **Probe fidelity:** a `build()` that branches on geometry values it reads back mid-build could
  confuse the recorder. Mitigated by benign dummy returns + the capability backstop; documented
  as a `build()` constraint.
- **OCCT robustness:** native fillet can fail on awkward edge selections (OCCT throws). Surface
  the error clearly (the existing `{type:"error"}` path) rather than silently degrading.
- **Backend flips on param toggles:** enabling/disabling a conditional fillet flips a part's
  backend; routing follows per-build. Acceptable; the boot cost of the OCCT worker is one-time.
