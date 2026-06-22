# Authoring parts

This app is a small **framework** that turns a declarative **`PartDefinition`** into
a full parametric-CAD web app: a 3-D viewer, a control panel built from your
parameter schema, two geometry workers, and STL / STEP / 3MF export. To make a new
part you write **one script** — geometry build functions + a parameter schema — and
the framework does the rest.

- Reusable framework: `src/framework/` (knows nothing about any specific part).
- Parts: `src/parts/` — e.g. `drum.js` (full, complex) and `demo.js` (minimal).
- A part module is **plain data + pure functions**: no DOM, no side effects (it
  loads in both the main thread and a Web Worker).

Two worked examples to read alongside this guide: **`src/parts/demo.js`** (a
parametric spacer — the smallest complete part) and **`src/parts/drum.js`** (the
capstan drum — every feature in use).

---

## Quickstart

1. Copy `src/parts/demo.js` to `src/parts/<your-part>.js` and edit it.
2. Copy the three glue files, repointing them at your part:
   - `demo.html` → `<your-part>.html`
   - `src/app-demo.js` → `src/app-<your-part>.js`
   - `src/demo-worker.js` → `src/<your-part>-worker.js`
3. `nvm use && npm install` (Node 24), then `npm run dev` and open
   `http://localhost:5173/<your-part>.html`.

That's the whole loop. The chrome (panel, tabs, viewer, export buttons) is shared —
your HTML is ~30 lines of structural markup and carries no CSS (the framework
supplies it via `framework/app.css`, imported by `mount`).

---

## The `PartDefinition` contract

A part is a default-exported object. Full shape (optional fields marked `?`):

```js
export default {
  meta: { title, units, background? },     // title string; units e.g. "mm"; background = 0xRRGGBB scene colour
  parameters,                              // the control-panel schema (array of sections — see below)
  defaults,                                // flat { paramKey: value } — seeds params + control values
  derive?,                                 // (p) => d   optional dependent values computed once per build
  parts: {                                 // named sub-parts; each builds ONE solid
    <name>: {
      label?,                              // display name (tabs/progress); defaults to the key
      build: (k, p, d, onProgress?) => Solid,   // REQUIRED — see kernel API
      place?: (solid, { view, purpose, p, d }) => Solid,   // optional reposition; default identity
      views,                               // string[] — which views show this sub-part
      enabled?: (p) => boolean,            // optional — gate a conditional sub-part
      export?: { name },                   // filename/object name on export; defaults to the key
    },
  },
  views: { <name>: { label } },            // the view tabs (a view = a set of sub-parts)
};
```

**Rules:**

- `build(k, p, d, onProgress?)` returns the **canonical** solid (e.g. at the origin).
  It is the only required function per sub-part. `p` is `{ ...defaults, ...userParams }`;
  `d` is `derive(p)` (or `{}`). `onProgress?.("phase")` is optional per-feature progress
  shown during export — call it before expensive steps.
- `place(solid, ctx)` is an optional escape hatch for parts whose **display pose differs
  from their export pose** (e.g. positioning a sub-part in an assembly). `ctx.purpose` is
  `"display"` or `"export"`; `ctx.view` is the active view. Default is identity, so simple
  parts omit it. **Display placement must not depend on `view`** — display meshes are built
  once per sub-part and cached across views (the viewer re-centres per view).
- `enabled(p)` gates a conditional sub-part (e.g. only present when a feature is on).
- A view's sub-parts are derived, never hard-coded: those whose `views` include the view
  and whose `enabled(p)` is true.

---

## Geometry: the kernel / `Solid` API

`build` receives a backend-agnostic `kernel` (`k`). It returns and combines `Solid`
handles. The same code runs on **Manifold** (fast meshes — preview + STL + 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Contract lives in
`src/framework/geometry/kernel.js`.

**Kernel — make solids:**

| Call | Result |
|---|---|
| `k.cylinder(rBottom, rTop, h, { center? })` | cylinder/cone along +Z (frustum if radii differ) |
| `k.box(min, max)` | axis-aligned box from `[x,y,z]` min/max |
| `k.prism(points2D, h)` | extrude a 2-D polygon (CCW `[[x,y],…]`) from z=0 |
| `k.helixSweptTube({ pathR, profileR, pitch, turns, z0, lefthand })` | circle swept along a helix (e.g. a rope groove) |
| `k.union(solids[])` | boolean union |

2-D polygon helpers for `prism`: `import { piePolygon, hexPolygon } from "partforge/geometry"`.
**Import geometry helpers from `partforge/geometry`, never from `partforge`** — the main
entry pulls in the DOM viewer/controls, and your build functions run in a Web Worker
(importing the main entry there throws `document is not defined`).

**`Solid` — combine / transform / export:**

| Call | Result |
|---|---|
| `s.cut(tool)` / `s.cutAll(tools[])` | boolean subtract (one / batch) |
| `s.intersect(other)` | boolean intersection (Manifold; used by collision tests) |
| `s.translate([x,y,z])` | move |
| `s.rotate(deg, center, axis)` | rotate `deg` about `axis` through `center` |
| `s.mirror("XY"\|"XZ"\|"YZ")` | mirror across a plane |
| `s.volume()` | volume in mm³ (Manifold) |
| `s.toMesh({ quality })` / `s.toSTL({ quality })` / `s.toIndexedMesh()` | meshes / STL / indexed mesh (3MF) — the framework calls these |
| `k.toSTEP(named[])` | STEP bytes (OCCT only) — the framework calls this |

You normally only call the *make/combine/transform* ops; the framework handles
`toMesh`/`toSTL`/`toIndexedMesh`/`toSTEP`. Units are millimetres.

---

## Parameters: the control-panel schema

`parameters` is an **array of sections**; the framework builds the panel from it and
binds each control to a key in `defaults`. Two section kinds:

**Preset + sliders section:**

```js
{
  id: "body",
  title: "Body",
  presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } }, // name → param overrides
  advanced: [                                  // sliders revealed under "Advanced"
    { key: "od",   label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 },
    { key: "bore", label: "Bore",           unit: "mm", min: 1, max: 30, step: 0.1, control: "number" },
  ],
}
```

Each slider/feature control shows an **editable number box** beside it — drag the
slider or type an exact value (finer than `step` is allowed; typed values clamp to
`[min, max]`). Optional `control` per parameter: omit it (or `"slider"`) for a slider
+ box; `"number"` for a box only (no slider — handy for precise or wide-range values).

**Feature-toggle section** (checkbox enables a feature + reveals its sliders; `0` = off):

```js
{
  id: "flange",
  title: "Flange",
  features: [
    { label: "Base flange", key: "flange_d", on: 16,    // checked → set key to `on`; unchecked → 0
      sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1 }] },
  ],
}
```

Every `key` used must exist in `defaults`. (The drum's schema is exported as `SECTIONS`
in `src/parts/drum/params.js` if you want a large reference.)

---

## Wiring a part into a runnable app

Three tiny glue files per part (copy from the demo). The worker statically imports
your part, so it can't be injected at runtime — hence the per-part entries.

`src/app-<part>.js`:

```js
import part from "./parts/<part>.js";
import { mount } from "partforge";
mount(part, {
  // NB: the `new Worker(new URL(...))` MUST stay inline here or Vite won't bundle the worker.
  createWorker: (name) => new Worker(new URL("./<part>-worker.js", import.meta.url), { type: "module", name }),
});
```

`src/<part>-worker.js`:

```js
import part from "./parts/<part>.js";
import { runWorker } from "partforge/worker";
runWorker(part);
```

`<part>.html` — structural markup only (no CSS; `mount` pulls in partforge's
stylesheet). `mount` looks up these element IDs:

| ID | Purpose |
|---|---|
| `#app` | viewer canvas mounts here |
| `#controls` | control panel is built into this |
| `#part` | view-tab bar: one `<button data-part="<view>">` per view, the active one with `class="on"` |
| `#download-step` / `#download` / `#download-3mf` | STEP / STL / 3MF export buttons |
| `#status`, `#busy`, `#phase` | status line + busy overlay |
| `#viewbar` with `#pause` / `#reframe` / `#theme` | optional viewer controls (omit any you don't want) |

Copy `demo.html` and change the title, the `#part` buttons (one per view), the panel
heading, and the `<script src>`. Two workers are spawned from your one worker entry
(`name` = `"manifold"` for preview/STL/3MF, `"occt"` for STEP — handled for you).

> Production deploy builds `index.html` only. Extra `*.html` files are **dev-only**
> (Vite serves any root HTML in `npm run dev`). To also ship one, add it to
> `build.rollupOptions.input` in `vite.config.js`.

### Developing against a local (linked) partforge

A normal `npm install partforge` needs no extra config. But if you `npm link` a local
partforge checkout (to co-develop the framework), it lives **outside your project root**,
so Vite refuses to serve its files — including the Manifold/OCCT WASM, which fails with a
403 and the kernel never boots. Allow-list it in your `vite.config.js`:

```js
server: { fs: { allow: ["./", "../partforge"] } } // path to your linked checkout
```

(Geometry/asset imports are already worker-safe; this is purely Vite's dev-server file
access. It's harmless to leave in when partforge is a normal install.)

---

## Testing a part

Tests run under **Node 24** (`nvm use` first; the default shell Node is too old) via
`npx vitest run`. Build geometry directly off your part with a Manifold kernel:

```js
import Module from "manifold-3d";
import { createManifoldKernel } from "../../src/framework/geometry/manifold-backend.js";
import part from "../../src/parts/<part>.js";

const w = await Module(); w.setup();
const k = createManifoldKernel(w, { quality: "preview" });
const solid = part.parts.<name>.build(k, part.defaults, part.derive?.(part.defaults) ?? {});
expect(solid.toMesh().triangles).toBeGreaterThan(0);
```

**Collision check (assemblies).** `assemblyOverlaps` builds every sub-part of a view in
its assembly pose and returns any interpenetrating pair with its overlap volume —
parts meant to fit (e.g. seated in a pocket) read ~0 and don't trip it:

```js
import { assemblyOverlaps } from "../../src/framework/assembly.js";
test("assembly has no interpenetrating parts", () => {
  expect(assemblyOverlaps(k, part, "<view>", {})).toEqual([]); // [{a,b,volume}] on failure
});
```

See `test/parts/drum-assembly.test.js` for a real example, and `test/framework/jobs.test.js`
for exporting through the job loop.

**OCCT tests** (STEP / B-rep parity) boot via `bootOcctKernel()` in `test/occt-kernel.js`.
**OCCT and Manifold must not boot in the same process** — keep OCCT-booting tests in their
own files (vitest isolates files). For Manifold↔OCCT volume parity, see `test/parity.test.js`
+ the `test/fixtures/occt-volumes.json` fixture (regenerate with
`node scripts/gen-occt-fixtures.mjs` after a geometry change).

---

## Conventions & gotchas

- **replicad (OCCT) transforms consume their input.** `s.translate/.rotate/.mirror/.cut`
  delete the operand and return a new solid; never reuse a solid after transforming it.
  The framework rebuilds each sub-part fresh per job and applies `place` once, which
  avoids this — follow the same pattern in your own code.
- **Part modules are DOM-free and side-effect-free** — they import into both the main
  thread (schema → controls) and the worker (build → kernel).
- **Units are millimetres** throughout.
- **Preview vs print quality.** Manifold bakes segment counts in at primitive creation,
  so the export path uses a separate high-res "print" kernel — your `build` is quality-
  agnostic; just build the geometry.
- **Display placement is view-independent** (so meshes cache across views); only
  `place(..., { purpose: "export" })` may depend on `view`.
- Keep geometry backend-agnostic (kernel calls only) so it works in both backends; only
  STEP requires OCCT.
