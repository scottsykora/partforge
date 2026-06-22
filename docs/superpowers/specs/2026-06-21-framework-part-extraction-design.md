# Framework / Part extraction — design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Scope:** In-repo refactor only (no packaging, no website-generation tooling)

## Goal

Separate the reusable rendering/export machinery from the drum-specific geometry so
that the app is generated from a single declarative **`PartDefinition`** script. A
new part becomes a new script dropped into `parts/`; everything else (3-D viewer,
control panel, geometry workers, STL/STEP export) is shared framework code.

This is the enabling foundation for later, out-of-scope goals: packaging the
framework for reuse across projects, LLM-authoring ergonomics, and scaffolding a
deployable website from a part script. The contract here is designed so those
remain possible, but none of them are built now.

**Non-goals (explicitly deferred):** reusable npm package/template, LLM-authoring
docs/tooling, website scaffolding/hosting, any change to the geometry vocabulary
(the kernel op set stays as-is), any user-visible behavior change.

## Key decisions

1. **Authoring model:** procedural JavaScript `build(kernel, params, derived)`
   functions per sub-part, plus a *declarative* parameter schema. Geometry is
   code (full procedural power: loops for bolt circles, helix fields); parameters
   are data.
2. **Scope:** in-repo split into `framework/` and `parts/`. A new part = a new
   script. No packaging.
3. **Framework API:** a single `mount(part, opts)` entry. Internal pieces are not
   exported yet (YAGNI); they can be later if a bespoke UI needs them.
4. **`fuzzyCut`** is a framework-level OCCT-backend implementation detail, not a
   part concern.

## The `PartDefinition` contract

The entire surface an author (or LLM) writes — one default-exported object. It is
**DOM-free and side-effect-free**, so the same module loads in both the main
thread (schema → controls, view tabs) and the geometry worker (build → kernel).

```js
// parts/drum.js
export default {
  meta: { title: "Capstan Drum", units: "mm", background: 0x15181d },

  // Declarative parameter schema — drives the control panel AND seeds values.
  // Today's SECTIONS (groups, presets, sliders, feature toggles) + flat DEFAULTS.
  parameters: SECTIONS,
  defaults:   DEFAULTS,

  // Optional dependent values, computed once per build (today's derive()).
  derive: (p) => ({ /* d */ }),

  // Named sub-parts. Each build() returns ONE canonical solid via the kernel.
  parts: {
    small: {
      label: "Small drum",
      build: (k, p, d) => k.cylinder(/*...*/).cut(/*...*/),   // canonical pose
      views: ["both", "small"],
      export: { name: "small_drum" },
    },
    big: {
      label: "Big drum",
      build: (k, p, d) => /* ... */,
      views: ["both", "big"],
      export: { name: "big_drum" },
    },
    block: {
      label: "Tensioner block",
      build: (k, p, d) => /* flat / standalone canonical solid */,
      enabled: (p) => p.tensioner_pocket_depth > 0,           // conditional sub-part
      views: ["both"],
      export: { name: "tensioner_block" },
      // Optional: reposition per view + purpose. Default = identity (most parts
      // never need this). The drum uses it for the small-drum assembly offset and
      // for seating the block in its pocket for the *display* only.
      place: (solid, { view, purpose, p, d }) =>
        purpose === "display" ? seatInPocket(solid, p, d) : solid,
    },
  },

  // Named views (tabs). A view is a set of sub-parts shown together.
  views: { both: { label: "Assembly" }, small: { label: "Small" }, big: { label: "Big" } },
};
```

**Rules of the contract**

- `build(k, p, d)` returns the **canonical** solid (drum at origin, block laid
  flat). It is the only required function per sub-part. Simple parts stop here.
- `place(solid, ctx)` is an optional escape hatch for parts whose display pose
  differs from their export pose. `ctx = { view, purpose, p, d }` with
  `purpose ∈ { "display", "export" }`. Default is identity. Because each job
  rebuilds via `build()` fresh and poses once, this structurally avoids the
  shape-reuse "object has been deleted" class of bug (replicad transforms consume
  their input).
- `enabled(p)` gates conditional sub-parts (replaces the hardcoded
  "block only when pockets > 0" logic).
- A view's sub-parts are derived, never enumerated by hand:
  `viewSubParts(part, view, params)` = sub-parts whose `views` include `view` and
  whose `enabled(params)` is true.

## Module architecture

```
src/
  framework/                 # reusable; knows nothing about drums
    index.js                 # public API: export { mount }
    mount.js                 # wires viewer + controls + geometry service + the
                             #   view/cache loop + export buttons, all driven by `part`
    viewer.js                # three.js scene from today's main.js (scene, camera,
                             #   lights, grid, per-sub-part mesh/line groups, crease
                             #   normals, framing); slots created from Object.keys(part.parts)
    controls.js              # today's file; takes part.parameters (not imported SECTIONS)
    geometry-service.js      # main-thread worker side: spawns the two workers,
                             #   postMessage/onmessage, progress + error routing
    worker.js                # runWorker(part): worker runtime; backend by self.name
    jobs.js                  # handle(kernel, part, msg, post): generalized job loop
                             #   (generate / export-stl / export-step) + progress
    geometry/
      kernel.js              # GeometryKernel/Solid contract (doc)
      manifold-backend.js    # moved as-is
      occt-backend.js        # moved as-is; uses fuzzy-cut.js internally
      helix-tube.js          # moved as-is
      fuzzy-cut.js           # OCCT robust-boolean helper (framework-internal)
      polygon.js             # piePolygon / hexPolygon (generic 2-D helpers)

  parts/
    drum.js                  # the PartDefinition (meta, parameters, defaults,
                             #   derive, parts{small,big,block}, views)
    drum/                    # drum geometry split for readability
      small.js, big.js, block.js

  app.js                     # import part; mount(part, { worker: new URL("./part-worker.js", …) })
  part-worker.js             # import part; runWorker(part)
  index.html                 # loads app.js
```

**Two workers, one glue entry.** Keep today's deliberate split: Manifold (preview,
fast) and OCCT (export, lazy 11 MB) so previews stay responsive during a ~40 s STEP
export. `geometry-service` spawns **two instances of the same `part-worker.js`**,
tagged via the Worker `name` option (`"manifold"` / `"occt"`); `runWorker(part)`
reads `self.name` and dynamically imports only that backend. Per-app glue is just
two tiny files (`app.js`, `part-worker.js`), and OCCT still loads only on STEP.

**Drum-knowledge that leaves the framework:** the `viewParts` small/big/block logic
and the hardcoded sub-part names in `main.js` are gone — views derive generically
from `part.parts[*].views` + `enabled(p)`. `piePolygon`/`hexPolygon` become generic
framework helpers; `fuzzyCut` becomes an OCCT-backend internal.

## Data flow

**Boot** (`app.js` → `mount(part, { worker })`):
1. `params = { ...part.defaults }`
2. build viewer, one mesh+line slot per `Object.keys(part.parts)`
3. build controls from `part.parameters` (edits → bump version, debounce, regenerate)
4. build view tabs from `part.views`
5. geometry-service spawns the two named workers; each imports only its backend

**Preview loop** (generalized from today's `main.js` + `geometry-jobs.js`):
```
edit → paramsVersion++ → debounce → maybeGenerate
  missing = viewSubParts(part, view, params).filter(notCachedAtThisVersion)
  → manifold worker { type:"generate", subparts: missing, params }
      jobs.handle: for each name →
        solid = part.parts[name].build(k, p, d)
        posed = place(solid, { view, purpose:"display", p, d })
        mesh  = posed.toMesh({ quality:"preview" })
      → post meshes
  → cache mesh per (name, version); viewer.show(viewSubParts); status
```

**Export** (same build, different purpose + sink):
```
STL  → manifold worker { type:"export-stl",  view, params }
STEP → occt     worker { type:"export-step", view, params }
  jobs.handle: for each view sub-part →
     build → place(purpose:"export") → collect { name: export.name, solid }
  → toSTL(print) / toSTEP → download   (+ per-feature & per-sub-part progress)
```

`purpose: "display" | "export"` is the only difference between a sub-part's preview
build and its export build.

## Migration plan

Incremental; **tests green after every step**. Behavior is identical to today until
the end (pure refactor, no user-visible change).

1. **Move geometry into the framework (pure file moves).** `src/geometry/*` +
   `src/fuzzy-cut.js` → `src/framework/geometry/*` (add `polygon.js` for pie/hex).
   Update imports only. Suite → green.
2. **Introduce the `PartDefinition`, drum unchanged underneath.** Add
   `src/parts/drum.js` referencing the existing build/derive/params functions; split
   drum bodies into `src/parts/drum/{small,big,block}.js`. Add `viewSubParts` and a
   minimal fixture part. Suite → green.
3. **Generalize the job loop.** `geometry-jobs.js` → `framework/jobs.js` taking
   `(kernel, part, msg, post)`, driven by `part.parts`/`viewSubParts` and the
   `build`/`place` contract. Port `test/geometry-jobs.test.js` to run against both
   the drum part and the fixture. Suite → green.
4. **Generalize the workers.** Replace `preview-worker.js`/`export-worker.js` with
   `framework/worker.js` (`runWorker(part)`, backend by `self.name`) + thin
   `src/part-worker.js`. `geometry-service` spawns the two named workers. Suite → green.
5. **Extract the viewer and `mount`.** Pull the three.js scene out of `main.js` into
   `framework/viewer.js`; move cache/view/export wiring into `framework/mount.js` +
   `framework/geometry-service.js`, keyed off `part`. `controls.js` →
   `framework/controls.js` taking `part.parameters`. Suite → green.
6. **Collapse the entry points.** `main.js` → `src/app.js`
   (`import part; mount(part, { worker })`). Delete dead drum glue. `index.html`
   points at `app.js`. Build + suite → green; manual smoke (preview, STL, STEP).
7. **Prove reuse (payoff + guardrail).** Keep the fixture part as `parts/demo.js`
   (a couple of primitives + params) with its own app/worker entry and a headless
   mount/build test. Living proof that a new part = a new script, and a guard
   against drum-knowledge leaking back into the framework.

## Testing posture

- Pure logic stays unit-tested: `viewSubParts`, `jobs.handle`, the build functions,
  the kernels. The current 27 tests largely carry over, retargeted at `part`.
- The thin DOM/three.js/worker-spawn seams (`viewer`, `mount`, `geometry-service`)
  are kept deliberately small and covered by the Step 6 manual smoke plus the Step 7
  fixture, since three.js-in-jsdom is not worth the fight.
- Node test harness runs under Node 24 (`nvm use`); OCCT and Manifold must not boot
  in the same process (existing constraint).
```
