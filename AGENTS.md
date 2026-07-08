# partforge

This file provides guidance to coding agents when working with code in this
repository.

## What this is

`partforge` is an npm framework that turns a declarative **`PartDefinition`**
(geometry build functions + a parameter schema) into a full parametric-CAD web
app: a three.js viewer, a control panel generated from the schema, geometry Web
Workers, and STL / STEP / 3MF export. The framework knows nothing about any
specific part; a part is plain data + pure functions. It ships as **plain ESM
source** and relies on a consuming app using **Vite** for worker / WASM / CSS
import handling.

This directory is its **own git repo** (`scottsykora/partforge`), independent of
the surrounding Robot KB wiki. The retired `drum.js` example now lives in the
separate Drum-Machine repo; the parts here are `demo.js` (minimal spacer),
`planter.js` (rich - facets/taper/twist/verify block), and `filleted-box.js`
(OCCT fillet/chamfer).

## Node version

**Requires Node 24** - `.nvmrc` pins it and the default shell Node is too old.
Run `nvm use` before `npm install`, tests, or the CLI, or geometry/tests fail
confusingly.

## Commands

```bash
npm run dev        # Vite dev server; open /demo.html, /planter.html, /filleted-box.html
npm run build      # production build (pages in rollupOptions.input - other *.html are dev-only)
npm test           # vitest run (whole suite)
npm run test:watch # vitest in watch mode
npx vitest run test/measure.test.js          # a single test file
npx vitest run -t "assembly has no interpenetrating"   # a single test by name
npm run check      # headless smoke test: boots an app in real Chromium (needs Playwright)
node scripts/check-app.mjs demo.html         # smoke-test a specific app entry
```

The CLI (also the agent-facing surface) builds parts in pure Node - no browser:

```bash
npx partforge measure src/parts/<part>.js [view]   # bbox/volume/holes/watertight + verify gate; exits non-zero on failure
npx partforge render  src/parts/<part>.js [view]   # canonical-angle PNGs -> render/
npx partforge pick-serve                           # request-a-pick: agent asks user to click geometry
```

CI (`.github/workflows/ci.yml`) runs `npm test` then the smoke check against all
three demo apps. Playwright's Chromium is required for the smoke check only:
`npm i -D playwright && npx playwright install chromium`.

## Architecture

- **`src/framework/`** - the reusable engine (part-agnostic): `mount.js` (app
  entry), `controls.js` + `param-deps.js` (relevance-aware control panel),
  `viewer.js` (three.js), `worker.js` / `jobs.js` / `geometry-service.js` (job
  loop across workers), `assembly.js` (collision checking), and `geometry/` (the
  kernel).
- **`src/parts/`** - one file per part, default-exporting a `PartDefinition`.
- **`src/testing.js`** + **`src/testing/`** - headless helpers
  (`createManifoldKernel`, `measure`, `verify`, `assemblyOverlaps`,
  `bootOcctKernel`, `renderViews`, ...).
- **`bin/cli.js`** - the `partforge` CLI dispatch.

**`docs/AUTHORING-PARTS.md` is the authoritative guide** - read it before
writing or editing a part. It has the full `PartDefinition` contract, the
kernel/`Solid` API tables, the parameter-schema format, app wiring, the `verify`
block, and gotchas. Do not duplicate that here; go read it. Its normative twin
for the kernel itself is **`docs/KERNEL-CONTRACT.md`** (conformance classes,
cross-backend semantics, versioning) - read that one before changing
kernel/backend behavior; `test/kernel-contract.test.js` holds its version header
and op coverage to the code.

### Two geometry backends, auto-selected

A part's `build(k, p, d)` is written against a **backend-agnostic kernel** (`k`)
and runs on either backend unchanged:

- **Manifold** (mesh CSG, WASM) - fast preview + STL + 3MF. Default for most
  parts.
- **OCCT / replicad** (OpenCASCADE WASM) - exact B-rep for STEP export and
  native fillet/chamfer/shell.

Before building, the framework runs a **geometry-free probe** of `build` to
detect CAD-only ops (`fillet`/`chamfer`/`shell`); if present it routes the whole
part to OCCT, otherwise Manifold. Override with `meta.backend: "occt" |
"manifold"`. The two WASM kernels run in **separate Web Workers** (`name` =
`"manifold"` / `"occt"`). See `docs/geometry-backend-strategy.md` for the why
(OCCT booleans are about 75-1400x slower).

### Non-obvious invariants

**On any build, test, `measure`, or `verify` failure, grep
`docs/ERROR-PATTERNS.md` for the symptom first** - it maps literal error text /
misbehavior -> cause -> fix, one `##` per pattern. Its preamble is the canonical
statement of this rule.

- **`build` must be a pure function of `(k, p, d)`** - no `Math.random`, clock,
  or module-level mutable state. The preview kernel memoizes geometry by content
  hash; an impure build silently returns stale geometry.
- **Part modules are DOM-free and side-effect-free** - they load in both the main
  thread (schema -> controls) and the worker (build -> kernel).
- **Import geometry helpers from `partforge/geometry`, never `partforge`.** The
  main entry pulls in the DOM viewer/controls; importing it inside a worker build
  throws `document is not defined`.
- **replicad (OCCT) transforms consume their operand** -
  `translate`/`rotate`/`cut`/etc. delete the input and return a new solid. Never
  reuse a solid after transforming it; use `.clone()`.
- **OCCT and Manifold must not boot in the same process.** Keep OCCT-booting
  tests in their own files (vitest isolates per file); boot OCCT via
  `bootOcctKernel()`.
- **Units are millimetres** throughout. **Display placement must not depend on
  the active view** (display meshes cache across views); only
  `place(..., {purpose:"export"})` may.

### Wiring a part into an app

Three small glue files per part (copy from the demo), because the worker
statically imports its part and cannot be injected at runtime: `<part>.html`
(structural markup, no CSS), `src/app-<part>.js` (`mount(part, {createWorker})`),
`src/<part>-worker.js` (`runWorker(part)`). The
`new Worker(new URL(...))` call **must stay inline** in the app file or Vite will
not bundle the worker.
