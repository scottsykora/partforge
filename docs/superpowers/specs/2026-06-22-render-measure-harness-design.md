# Render + measure harness for partforge — design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Repo:** `partforge` (sibling to `Drum Machine/`)

## Goal

Close the **blind-authoring loop**: an LLM (or human) building a part with partforge
can't see the geometry it produces, and today's only headless check (`check-app.mjs`)
proves the app *boots*, not that the part is the right size, solid, or non-overlapping.

This adds two shipped CLI tools so any consumer of the `partforge` package can verify a
part headlessly:

- **`measure`** — print/return cheap, mesh-derived geometric facts about a part view.
- **`render`** — produce PNG images of a part view from canonical angles, so a
  multimodal agent (or a human) can *look* at the result.

Both run in pure Node (no dev server, no browser, no HTML entry), driven by the Manifold
kernel the framework already uses for previews.

This is foundational: it's the verification substrate a later authoring **skill** (a
separate, future item) will lean on. That skill is out of scope here.

## Decisions (from brainstorming)

1. **Invocation:** CLI commands are the primary interface (`npx partforge measure …`,
   `npx partforge render …`); the `measure` function is *also* exported for use in vitest.
2. **Render path:** Node offscreen (no browser / dev server / HTML entry).
3. **Render engine:** real WebGL via the `gl` (headless-gl) native module + three.js.
   Risk: `gl` is native and has historically lagged on new Node / Apple Silicon, and the
   target machine is Node 24 / macOS. Mitigated by a spike gate (below) with a documented
   pure-JS-rasterizer fallback.
4. **Measure scope (v1):** whole-solid facts (bbox, volume, surface area, triangle count,
   watertight, holes/genus) per sub-part and per view, plus the existing assembly overlap
   check. Named-feature metrology (e.g. "bore = 5 mm") and full printability linting are
   explicitly out of scope (later items #2/#3 on the roadmap).
5. **Distribution:** shipped in the npm package as a single `partforge` bin with
   `measure`/`render` subcommands; measure/render functions exported from
   `partforge/testing`.

## Global constraints

- **Node 24** (`.nvmrc` = 24.16.0); the default shell Node is too old and will fail.
- **Units are millimetres** throughout (display may show cm³ for volume).
- **Manifold and OCCT must not boot in the same process** — these tools are Manifold-only,
  so they never touch OCCT. Keep it that way.
- **Manifold WASM objects are not GC'd** — every op must be freed via the kernel's
  `cleanup()` (the framework's existing discipline; `assembly.js` is the reference).
- Part modules are **DOM-free and side-effect-free**; these tools import them directly.
- Geometry helpers come from `partforge/geometry`, never the `partforge` main barrel
  (the barrel pulls in the DOM viewer and crashes outside a browser).

## Architecture

A shared Node "build a view" core feeds both tools, so "how a view is built headlessly"
has exactly one definition.

```
buildView(kernel, part, view, params)
  → [{ name, solid, mesh }]      // posed in DISPLAY pose; mesh = solid.toMesh()
```

- Reuses `viewSubParts(part, view, p)` for which sub-parts are in the view, and the same
  `build(k,p,d)` + `place(solid,{view,purpose:"display",p,d})` sequence already used by
  `assembly.js` and `jobs.js` (the `generate` branch).
- Caller supplies the kernel (a Manifold kernel) and is responsible for `cleanup()` timing;
  `buildView` copies meshes out (they're JS-owned arrays) before the caller frees WASM.

```
                       ┌────────────────────┐
   part module ──────► │  buildView (core)  │ ──► posed solids + meshes
                       └─────────┬──────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
            measure.js                       render.js
        (facts from solids/mesh)        (three.js + gl → PNGs)
                 │                               │
                 └──────────► bin/cli.js ◄───────┘
                         (partforge measure|render)
```

### File layout (in `partforge`)

- `src/testing/build.js` — `buildView` (the shared core).
- `src/testing/measure.js` — `measure(part, view, params?)`.
- `src/testing/render.js` — `renderViews(part, view, { views, out, edges })`.
- `bin/cli.js` — the `partforge` CLI (subcommand dispatch + arg parsing + part loading).
- Manifold backend (`src/framework/geometry/manifold-backend.js`) gains three read methods
  on the `Solid` wrap: `surfaceArea()`, `genus()`, `isEmpty()`.
- `src/testing.js` re-exports `buildView`, `measure`, `renderViews`.
- Tests under `test/` (see Testing).
- Docs section appended to `docs/AUTHORING-PARTS.md`.

## Component: measure

`measure(part, view = firstView, params = {})` builds the view via `buildView` and returns:

```js
{
  part: <meta.title or module name>,
  view: "<view>",
  subparts: [
    { name, bbox: [x,y,z], volume, surfaceArea, triangleCount, watertight, holes }
  ],
  aggregate: { bbox: [x,y,z], volume, surfaceArea, triangleCount },  // whole view (union of bboxes; summed vol/area/tris)
  overlaps: [ { a, b, volume } ],   // from assemblyOverlaps; [] = none
  ok: <boolean>                     // true iff every subpart watertight AND overlaps empty
}
```

Field sources:
- `bbox` — min/max of mesh positions (the `bboxSize`-style scan, but returning extents).
- `volume` — `solid.volume()` (existing).
- `surfaceArea` — summed triangle areas from the mesh (backend-agnostic; matches the
  tessellation actually produced). Alternatively the new `solid.surfaceArea()`; the design
  uses the mesh sum so the number corresponds to the rendered/exported tessellation.
- `triangleCount` — `mesh.triangles` (existing field).
- `watertight` — `!solid.isEmpty()` and the solid is a valid Manifold (Manifold output is
  2-manifold by construction; this is a build-sanity check that catches empty/degenerate
  builds, not a general mesh-repair check).
- `holes` — `solid.genus()` (number of through-holes/handles).

The aggregate `bbox` is the union of sub-part bboxes; `volume`/`surfaceArea`/
`triangleCount` are sums (sub-parts are distinct solids in a view, not boolean-combined).

New `Solid` methods on the Manifold backend (thin pass-throughs to `_m`):
- `surfaceArea: () => m.surfaceArea()` (or computed from mesh if the API differs; the
  measure module uses the mesh sum regardless, so this method is optional — include only
  if trivially available).
- `genus: () => m.genus()`
- `isEmpty: () => m.isEmpty()`

> Implementation note: confirm the exact Manifold method names (`genus`, `isEmpty`,
> `surfaceArea`, `status`) against the installed `manifold-3d` build during Task 2 and
> adjust the pass-throughs to match. The measure *contract* above is fixed; only the
> kernel call names may need tweaking.

## Component: render

`renderViews(part, view = firstView, { views = ["iso","front","top"], out = "render/", edges = true })`:

1. `buildView` → posed meshes.
2. three.js scene: one non-indexed `BufferGeometry` per sub-part from `mesh.positions` +
   `mesh.normals` (already creased by the backend); `MeshStandardMaterial` (matte). If
   `edges`, add `LineSegments` from `mesh.edges`. Lighting mirrors `viewer.js` (key + fill
   + ambient) so the look roughly matches the in-app viewer.
3. Frame an `OrthographicCamera` to the scene bounding box (orthographic so proportions
   read true with no perspective distortion); for each requested angle set the camera
   direction:
   - `iso` — from `(+1,+1,+1)` direction.
   - `front` — looking down −Y.
   - `top` — looking down −Z.
4. Render each angle into a `gl` framebuffer at a fixed size (default 800×600), `readPixels`,
   flip rows, encode PNG via `pngjs`, write `<out>/<part>-<view>-<angle>.png`.

Returns the list of written file paths.

### Spike gate (FIRST task, blocking)

Before any render implementation: a throwaway spike that `npm i gl pngjs`, creates a `gl`
context, renders one lit triangle, and writes a valid non-empty PNG on the target machine.

- **Green** (PNG written, valid header, non-zero size) → proceed with `render.js`.
- **Red** (`gl` won't build/run on Node 24 / macOS) → STOP and escalate. Documented
  fallback: a pure-JS software rasterizer behind the *same* `render.js` interface (project
  triangles → z-buffer → Lambert shade from the mesh normals → PNG), swappable without
  changing `measure`, the CLI, or the exports. Do not start fallback work without
  confirming the decision.

## Component: CLI (`bin/cli.js`)

```
partforge measure <part-module> [view] [--json]
partforge render  <part-module> [view] [--views iso,front,top] [--out render/]
```

- `<part-module>`: a path (relative to cwd) to a JS module whose default export is the
  `PartDefinition`. Loaded via dynamic `import(pathToFileURL(resolve(cwd, arg)))`.
- `[view]`: optional; defaults to the part's first declared view (`Object.keys(part.views)[0]`).
- Boots a Manifold kernel once (`manifold-3d` WASM, preview quality), runs the subcommand,
  calls `kernel.cleanup()`.
- **measure:** prints a human-readable table to stdout; always writes
  `measure-<part>-<view>.json` (the full report). `--json` also dumps JSON to stdout.
  Exit code: `0` if `report.ok`, else `1` (unwatertight or overlaps present).
- **render:** writes PNGs, prints the written paths. Exit `0` on success, `1` if a build
  throws.
- Shebang `#!/usr/bin/env node`; file is `chmod +x` (committed executable).
- Errors (bad path, no default export, build throw) print a one-line message and exit `1`.

## Packaging (`partforge/package.json`)

- `"bin": { "partforge": "./bin/cli.js" }`
- `"files"`: add `"bin"` (the `src` entry already covers `src/testing/**`).
- Dependencies: add `"gl"` and `"pngjs"`. `three` and `manifold-3d` are already deps.
- `"exports"`: `partforge/testing` already maps to `./src/testing.js`; the new functions
  ride along through that file (no new subpath).

## Testing posture (TDD)

Node 24, `npx vitest run`. Manifold-only (no OCCT in these files).

- **`buildView`** — for the demo part's `spacer` view, returns one entry with a `solid`
  and a `mesh` whose `triangles > 0`; respects `enabled`/`views` filtering (reuses
  `viewSubParts`, already tested).
- **`measure`** — known solids with known answers:
  - A box part → `holes: 0`, `watertight: true`, `volume` ≈ l·w·h, `bbox` ≈ dimensions.
  - A part with a through-bore → `holes: 1`.
  - `overlaps` reuses `assemblyOverlaps` (already tested) — assert a non-overlapping demo
    view returns `[]` and `ok: true`.
  - `surfaceArea` and `triangleCount` are positive and finite.
- **`render`** — for the demo part: writes a PNG per requested angle; the file exists, is
  non-empty, has a valid PNG signature, and decodes to the expected width/height. `--views`
  count controls file count. Pixel content is **not** asserted (too brittle); "a real image
  of the right size" is the regression that matters.
- **CLI** — a smoke test invoking `bin/cli.js` on the demo part for both subcommands and
  asserting exit code + that the expected output files appear. (Run via `node`, parsing
  argv; keep it a thin integration test.)
- Existing `check-app.mjs` is unchanged and orthogonal (it tests the browser app boots).

The `gl` spike (Task 1) is verified by hand/observation, not a committed test (it's
throwaway); the committed `render` tests assume the spike passed.

## Docs

Append a "Verifying a part (render + measure)" section to `docs/AUTHORING-PARTS.md`:
the two commands, what `measure` reports, how `ok`/exit codes work for CI/agents, and the
vitest `import { measure } from "partforge/testing"` usage. Keep it short; it's the hook a
future authoring skill points at.

## Out of scope (explicitly)

- Named-feature metrology (declared `measures`, ray/section queries) — roadmap #2.
- Printability linting (min wall thickness, overhangs, trapped volume) — roadmap #3.
- The authoring **skill** and its plugin packaging — separate future item.
- Browser-based rendering / matching the viewer's exact materials — Node offscreen chosen.
- OCCT/STEP-based measurement or rendering.
```
