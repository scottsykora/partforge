# Authoring parts

This app is a small **framework** that turns a declarative **`PartDefinition`** into
a full parametric-CAD web app: a 3-D viewer, a control panel built from your
parameter schema, two geometry workers, and STL / STEP / 3MF export. To make a new
part you write **one script** — geometry build functions + a parameter schema — and
the framework does the rest.

- Reusable framework: `src/framework/` (knows nothing about any specific part).
- Parts: `src/parts/` — e.g. `planter.js` (full, rich) and `demo.js` (minimal).
- A part module is **plain data + pure functions**: no DOM, no side effects (it
  loads in both the main thread and a Web Worker).

Two worked examples to read alongside this guide: **`src/parts/demo.js`** (a
parametric spacer — the smallest complete part) and **`src/parts/planter.js`** (a
faceted planter — facets, taper, twist, even walls, an optional feature, a `derive`,
and a `verify` block). **`src/parts/filleted-box.js`** is the worked example for the
OCCT-only fillet/chamfer/shell ops.

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
      display?: { color?, opacity? },      // optional viewer-only override (0xRRGGBB / 0..1) — e.g. a reference/ghost part
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
| `k.prism(points2D, h, { twist?, scaleTop? })` | extrude a 2-D polygon (or an **arc profile** from `roundedProfile`) from z=0; optional `twist` (degrees over the height) and `scaleTop` (uniform top taper: 1 straight, <1 taper in, 0 → point/cone) |
| `k.extrude(profile, h, { twist?, scaleTop? })` | extrude a **polygon-with-holes** region from z=0 in one op — `profile` is `{ outer, holes? }` where each contour is a points array **or an arc profile** (`roundedProfile`, for true STEP fillets), or a bare points array / arc profile for outer-only; same `twist`/`scaleTop` as `prism` (both backends) |
| `k.loft(rings, { ruled?, closed? })` | stack polygon cross-sections into a solid — ruled walls between consecutive rings, capped ends (both backends; `closed:true` capless loops are Manifold-only). `ruled:false` (smooth C2 blend) is honoured only by OCCT/STEP export; the Manifold preview always shows faceted straight walls |
| `k.sphere(r)` | sphere centred at the origin |
| `k.revolve(points2D, { degrees })` | revolve a lathe profile `[[r,z],…]` (r ≥ 0) around the Z axis (full or partial) |
| `k.helixSweptTube({ pathR, profileR, pitch, turns, z0, lefthand })` | circle swept along a helix (e.g. a rope groove) |
| `k.union(solids[])` | boolean union |

**`loft` rings** — each ring is `{ polygon:[[x,y],…] | sides+radius, z, rotate?, scale? }`
(all rings must share the same vertex count; `rotate` is degrees about Z, `scale` is a
number or `[sx,sy]`). Author rings CCW and ordered by ascending `z` (the `regularPolygon`
/ `polygon.js` helpers are already CCW); loft self-corrects a fully-inverted result so
CW-wound or descending-z rings still export a valid outward solid. (Arc profiles from
`roundedProfile` are **not** accepted as loft rings yet — a ring must be a point array;
use `prism`/`extrude` for true-arc STEP export.) Worked snippets:

```js
// a square tube (extrude a region with a hole) — one op, no boolean cut
k.extrude({ outer: roundedRectPolygon(40, 30, 4), holes: [circleProfile(6)] }, 10);

// a tapered, twisting faceted vase wall (see src/parts/faceted-vase.js)
const rings = [];
for (let i = 0; i <= 24; i++) { const t = i / 24;
  rings.push({ sides: 6, radius: 30 - 8 * t, z: 120 * t, rotate: 90 * t }); }
k.loft(rings);                          // ruled walls, capped ends

// round every corner of any CCW outline, then extrude/loft/prism it
k.prism(filletPolygon(bracketOutline, 3), 4);       // tessellated corners (faceted in STEP)
k.prism(roundedProfile(bracketOutline, 3), 4);      // true CIRCLE corners in STEP export
```

2-D polygon helpers for `prism`/`extrude`/`loft`: `import { piePolygon, hexPolygon,
regularPolygon, roundedRectPolygon, starPolygon, circleProfile, filletPolygon,
roundedProfile } from "partforge/geometry"`. `filletPolygon(points, r, { segs? })` rounds
every corner of a CCW polygon (per-corner radius clamped so neighbouring arcs never overlap)
and returns points usable by `prism`/`extrude`/`loft` on both backends — but it **bakes each
corner into line facets**, so STEP corners are faceted. `roundedProfile(points, r | r[])`
rounds corners the same way but keeps them **mathematically true** — it carries the arc
symbolically so STEP export gets real circular edges. Use it for `prism`/`extrude` (not yet
`loft` — arc rings are rejected there in v1). A scalar `r` rounds every corner; a per-corner
`r[]` (length = points) rounds selectively (a `0`, a zero-length edge, or a straight/180°
corner stays sharp).
**Import geometry helpers from `partforge/geometry`, never from `partforge`** — the main
entry pulls in the DOM viewer/controls, and your build functions run in a Web Worker
(importing the main entry there throws `document is not defined`).

**`Solid` — combine / transform / export:**

| Call | Result |
|---|---|
| `s.cut(tool)` / `s.cutAll(tools[])` | boolean subtract (one / batch) |
| `s.intersect(other)` | boolean intersection (Manifold; used by collision tests) |
| `s.translate([x,y,z])` | move |
| `s.rotate(deg, center, axis)` | **internal primitive** — prefer `rotateX/Y/Z` / `rotateAbout` |
| `s.rotateX(deg)` / `s.rotateY(deg)` / `s.rotateZ(deg)` | rotate about a world axis through the origin |
| `s.rotateAbout({ axis, deg, through? })` | general rotation: `axis` = `"X"｜"Y"｜"Z"` or `[x,y,z]`; `through` = centre (default origin) |
| `s.along(dir)` | orient the canonical **+Z** build axis to point along `dir` (`"+X"｜"-X"｜"+Y"｜"-Y"｜"+Z"｜"-Z"`) |
| `s.at([x,y,z])` | place an origin-built solid at a point (readable alias of `translate`) |
| `s.mirror("XY"\|"XZ"\|"YZ")` | mirror across a plane |
| `s.scale(factor, center?)` | uniform scale (single factor) about `center` (default origin) — scaling an off-origin part about the origin also moves it; pass a center (e.g. `s.boundingBox().center`) to resize in place |
| `s.clone()` | independent copy (replicad consumes solids on transform) |
| `s.label(name)` | name this solid's surface for hover/pick feature attribution; survives transforms + booleans; same name on several solids merges into one feature |
| `s.boundingBox()` | `{ min, max, center, size }` axis-aligned bounds (query) |
| `s.volume()` | volume in mm³ (Manifold) |
| `s.toMesh({ quality })` / `s.toSTL({ quality })` / `s.toIndexedMesh()` | meshes / STL / indexed mesh (3MF) — the framework calls these |
| `k.toSTEP(named[])` | STEP bytes (OCCT only) — the framework calls this |

You normally only call the *make/combine/transform* ops; the framework handles
`toMesh`/`toSTL`/`toIndexedMesh`/`toSTEP`. Units are millimetres.

### Build-step style: orient → place, and batch features

Write build steps so intent is legible — an LLM (and a human) should not have to decode
magic vectors. Three habits:

- **Orient then place.** Build a primitive along its canonical **+Z** axis, point it with
  `along(dir)`, then position it with `at([x,y,z])`:

  ```js
  // ✗ cryptic: which axis? what centre?
  k.cylinder(r, r, L).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([rp, y1, sz])
  // ✓ legible
  k.cylinder(r, r, L).along("+Y").at([rp, y1, sz])
  ```

- **Rotate about a point with `rotateAbout`** when the axis isn't through the origin
  (use `rotateX/Y/Z` for the common origin cases):

  ```js
  // ✗  .rotate(angle, [rp, 0, 0], [0, 0, 1])
  // ✓
  tool.rotateAbout({ axis: "Z", deg: angle, through: [rp, 0, 0] })
  ```

- **Batch features** instead of reassigning through a cut-chain:

  ```js
  // ✗  body = body.cut(a); body = body.cut(b); body = body.cut(c);
  // ✓
  body.cutAll([a, b, c])          // and k.union([base, f1, f2]) for additive batches
  ```

The bare `rotate(deg, center, axis)` remains available as the low-level primitive for
anything `rotateX/Y/Z`/`rotateAbout` can't express, but prefer the vocabulary above.

### Naming features (`.label()`)

Give build-step solids human-readable names — the viewer's hover tooltip, the
highlight, and pick selections all use them, so you, the app user, and an agent
share the same vocabulary ("Make the Drainage hole 10 mm").

```js
const body = k.prism(d.outerPts, p.height, { scaleTop: p.taper }).label("Faceted wall");
let s = body.cut(cavity.label("Cavity"));
if (p.drain > 0) s = s.cut(k.cylinder(d.drainR, d.drainR, p.floor + 4).at([0, 0, -2]).label("Drainage hole"));
```

- A label names the solid's **surface** wherever it survives into the final part —
  a cutting tool's label lands on the faces it leaves behind (the hole's wall).
- Label **after** shaping compound tools (e.g. after an `intersect` clip) and
  either before or after transforms — labels ride through `at`/`rotate`/etc.
- The **same label on several solids merges into one feature** — label a pattern
  of four holes `"Mounting holes"` and they hover/highlight as one.
- Unlabeled geometry falls back to the sub-part's `label`. Faces created by
  `fillet`/`chamfer`/`shell` are new surfaces, so they use the fallback too.
- Works on both backends. On OCCT each label keeps a geometry snapshot for
  mesh-time classification — label a handful of features, not hundreds.
- Names should describe intent ("Drainage hole", not "cylinder2"); keep them
  unique per sub-part unless you want the merge behavior.

### Caching & determinism

The preview kernel memoizes geometry by content hash, so editing a parameter only
re-runs the operations that parameter actually affects. For this to be sound, a
`build` must be a **pure function of `(k, p, d)`** — no `Math.random`, no clock, no
module-level mutable state. An impure build will silently return stale geometry.

Cache granularity follows the operations you call. Booleans and heavy primitives are
cached; cheap transforms are recomputed. To make a multi-step shape into a single
cache node, use (or add) a **compound op** like `k.boredCylinder({ od, h, bore })` —
it hashes from its own arguments and never exposes its internals to the cache. The heavy
primitives `loft`, `extrude`, `prism`, and `revolve` are cached this way too: their hash
folds every shape-affecting argument (each `loft` ring's points/`z`/`rotate`/`scale`,
`extrude`'s holes, an arc profile's segment specs from `roundedProfile`, and the
tessellation from `twist`), so changing any of them is a fresh cache node while an identical
rebuild is a hit.

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

Every `key` used must exist in `defaults`. `src/parts/demo.js` is the worked example for
everything below.

**Control metadata (optional — on any control def, feature, or section):**

- `description` — a CommonMark string shown in a click-open **ⓘ** popover beside the
  label. Supports **bold/italic**, lists, `code`, links, and images (for diagrams);
  links open in a new tab and the rendered HTML is sanitized. Write one for every
  control — see "A description for every control" below.
- `hidden: true` — omits the control/feature/section from the panel. Its `key` must still
  exist in `defaults` and still drives the geometry: use it for internal constants the
  end user shouldn't edit (it is *no UI*, not *no parameter*). A section left with no
  presets and no visible controls doesn't render at all.

```js
advanced: [
  { key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5,
    description: "Barrel OD. Keep it larger than the bore so a wall remains. See the [guide](https://example.com)." },
  { key: "wall_seg", min: 8, max: 256, step: 1, hidden: true,   // internal constant; no UI, still in defaults
    description: "Facet count — fixed by the design." },
],
```

---

## Designing the control panel

A good part exposes a **simple** interface — a handful of controls most users will
touch — while still giving deep, correct adjustability underneath. `src/parts/demo.js`
is the worked example for the patterns below.

### Procedural & parametric parts

Drive many features from a few controls, so tweaking one control reshapes the part
coherently:

- **`derive(p) => d`** computes shared/dependent values once per build; sub-part `build`
  functions read `d`. Put the "design intent" math here — clearances, ratios, wall
  thicknesses — so a single input feeds everything downstream. In the demo, `derive`
  turns the nominal `bore` into `boreR` (with a fixed print clearance) and `h` into the
  cut-tool height `cutH`; `build(k, p, d)` reads those.
- **Reuse a param `key`** across sub-parts/features so one slider moves all of them.
- **`enabled(p)`** gates a whole sub-part on a toggle param (the part appears/disappears
  with the control).

### Progressive disclosure (simple, but deep)

Tier the controls so the default view is uncluttered:

1. **Presets** for the common cases — the first thing most users pick.
2. A **few primary sliders** for the dimensions users change most.
3. **`Advanced`** (the collapsible block) for the rest.
4. **`hidden`** for internal constants the end user shouldn't edit.

Aim for a panel with a few visible controls that still exposes the full design when
someone opens Advanced.

### A description for every control

Give every section and control a `description`. Keep each one short and make it cover:

- **what** the control does,
- its **units**,
- a **sensible range** (and what's typical),
- **when it matters** (what it interacts with).

Use Markdown links or images for diagrams and deeper reference. These are the popovers
end users rely on — treat writing them as part of authoring the control, not an
afterthought.

### The relevance-aware panel

The panel updates itself to match what's on screen: a **section is hidden** when none of
its controls affect the active view's visible parts, and a **control is dimmed** (but
still usable) when it doesn't currently affect them — recomputed as the view and the
parameters change. You don't wire this up; it's automatic. To get the most from it:

- Group controls into **sections by the sub-parts they affect**, so whole sections drop
  away in views that don't use them.
- Scope a parameter to the **views/sub-parts that read it** — a control read by no
  on-screen part shows dimmed, which is a useful signal that it's vestigial or
  misplaced.

---

## Profiles & patterns

Pure helpers from `partforge/geometry` (no backend dependency):

**2-D profiles** (CCW point arrays for `k.prism` / `k.revolve`):
`roundedRectPolygon(w,h,r)`, `regularPolygon(n,r,{flat})`, `ellipsePolygon(rx,ry)`,
`slotPolygon(length,r)` (overall length = `length + 2r`), `starPolygon(points,outerR,innerR)`,
`ringSectorPolygon(innerR,outerR,arcDeg)` (**arcDeg < 360** — a full ring is a contour-with-hole;
cut an inner cylinder from an outer one instead).
`circleProfile(r, center?)` — a circle of radius `r` centered at `[cx,cy]` (default origin).
Compose it for round solids: `k.prism(circleProfile(r), h)` is a cylinder, and
**a torus is `k.revolve(circleProfile(minorR, [majorR, 0]))`** (with `majorR > minorR`) —
partforge has no `torus` primitive because it's just a revolved circle.

**Patterns** (return `Solid[]` — feed to `k.union(...)` for features or `s.cutAll(...)` for holes):
`linearPattern(solid, count, [dx,dy,dz])`, `circularPattern(solid, count, { center, axis, angle, rotateCopies })`.

```js
const hole = k.cylinder(2, 2, 20).translate([20, 0, 0]);
body = body.cutAll(circularPattern(hole, 8, { axis: "Z" }));   // 8 bolt holes on a 40mm circle
```

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
| `#part` | view-tab bar — leave the div **empty**; `mount` generates one button per entry in `part.views` |
| `#download-step` / `#download` / `#download-3mf` | STEP / STL / 3MF export buttons |
| `#status`, `#busy`, `#phase` | status line + busy overlay |
| `#viewbar` with `#pause` / `#reframe` / `#theme` | optional viewer controls (omit any you don't want) |

Copy `demo.html` and change the title, the panel heading, and the `<script src>`. Two workers are spawned from your one worker entry
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
import { bootManifoldKernel } from "partforge/testing";
import part from "../src/parts/<part>.js";

const k = await bootManifoldKernel();
const solid = part.parts.<name>.build(k, part.defaults, part.derive?.(part.defaults) ?? {});
expect(solid.toMesh().triangles).toBeGreaterThan(0);
```

**Collision check (assemblies).** `assemblyOverlaps` builds every sub-part of a view in
its assembly pose and returns any interpenetrating pair with its overlap volume —
parts meant to fit (e.g. seated in a pocket) read ~0 and don't trip it:

```js
import { assemblyOverlaps } from "partforge/testing";
test("assembly has no interpenetrating parts", () => {
  expect(assemblyOverlaps(k, part, "<view>", {})).toEqual([]); // [{a,b,volume}] on failure
});
```

See `test/framework/assembly.test.js` for a real example, and `test/framework/jobs.test.js`
for exporting through the job loop.

**OCCT tests** (STEP / B-rep) boot the OCCT kernel with `bootOcctKernel()` from
`partforge/testing` (in a `beforeAll`) — see `test/occt-backend.test.js`.
**OCCT and Manifold must not boot in the same process** — keep OCCT-booting tests in their
own files (vitest isolates files).

---

## Verifying a part headlessly (render + measure)

Once the package is installed you get two CLI commands that build your part in
pure Node (no dev server, no browser) so you — or an LLM authoring the part — can
check it without opening the app:

    npx partforge measure src/parts/<part>.js [view]      # geometric facts
    npx partforge render  src/parts/<part>.js [view]       # canonical-angle PNGs

`measure` prints a report: per sub-part and per view it reports bounding box,
volume, surface area, triangle count, whether the solid is watertight, and the
number of through-holes (genus), plus an assembly overlap check. It exits non-zero
if any sub-part isn't watertight or any parts interpenetrate — so it doubles as a
CI/agent gate. Add `--json` to also dump the report as JSON on stdout, or
`--out report.json` to write it to a file (nothing is written otherwise). (Manifold output is
manifold by construction, so `watertight` is mainly a build-sanity check for
empty/degenerate results; `holes` is the informative topology number.)

`render` writes one PNG per angle (`iso`, `front`, `top` by default; choose with
`--views iso,front`, output dir with `--out`) to `render/`. The view defaults to
the part's first declared view.

The `measure` function is also exported for vitest (boot a Manifold kernel as in
"Testing a part", then `measure(kernel, part, "<view>")`):

    import { measure } from "partforge/testing";
    test("part is sound", () => {
      const r = measure(kernel, part, "<view>");
      expect(r.ok).toBe(true);
      expect(r.subparts[0].holes).toBe(1);   // e.g. expects one bore
    });

---

## Self-verification (the `verify` block)

A part can declare how it should be checked, co-located with its schema, so
`partforge measure` (and vitest) can prove it is both **printable** and **correct**.
Add an optional top-level `verify` block:

```js
verify: {
  process: "fdm-pla",            // a DFM profile: fdm-pla | fdm-petg | resin, or an
                                  // inline { bed:[x,y,z], minWall, clearance } object
  cases: ["defaults", "M3"],     // optional; default = defaults + every preset
  expect: {                      // design intent, by sub-part name (+ "_view")
    spacer: { holes: 1, bbox: "<=[60,60,60]", volume: "0.4..0.6cm3" },
    _view:  { overlaps: 0 },
  },
}
```

**What the profile gives you:** a hard **bed-fit** gate (the view bbox must fit `bed`)
and a **min-wall** warning. **What `expect` gives you:** per-sub-part assertions on the
facts `measure` already reports — `holes` (through-bores / genus), `volume`,
`surfaceArea`, `triangleCount`, `bbox`, `watertight`, `minWall`; and `_view` assertions
`bbox`, `volume`, `overlaps`.

**Assertion DSL:** a bare number means equality (`holes: 1`); `">=n"`, `"<=n"`, `">n"`,
`"<n"`, or a range `"a..b"`; an optional unit suffix `mm`/`cm`/`mm3`/`cm3`; and for
`bbox`, a componentwise vector `"<=[x,y,z]"` / `">=[x,y,z]"` where `*` skips an axis.
The parser is strict — a malformed assertion fails loudly.

**Gates vs. warnings:** exact facts are **gates** (a failure sets a non-zero exit code);
`minWall` is computed (a ray/shot wall-thickness measurement) and reported as a
**warning** — it flags walls below the profile's minimum but never fails the build.
`holes`/`watertight` are Manifold-only, so those assertions **skip** on OCCT parts
rather than fail.

**Running it:**

```bash
npx partforge measure src/parts/<part>.js          # auto-runs verify if a block exists
npx partforge measure src/parts/<part>.js --process resin   # force/override a profile
npx partforge measure src/parts/<part>.js --no-verify       # facts only
```

…and in vitest:

```js
import { verify } from "partforge/testing";
test("part is printable and correct", () => {
  expect(verify(kernel, part).ok).toBe(true);
});
```

Checks run across the **default config plus every preset** (or your `cases` list); a
preset that changes only parameters no on-screen sub-part reads is deduplicated, so
coverage is cheap.

---

## Fillet & chamfer (automatic OCCT backend)

Two backends build your part: **Manifold** (fast meshes — preview, STL, 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Most parts run on Manifold. But Manifold has no
fillet, so if your `build` calls a **CAD-only op** the framework automatically routes the
whole part to OCCT — no declaration needed:

| Op | Meaning |
|---|---|
| `s.fillet(radius, selector?)` | round edges (curve-following, exact) |
| `s.chamfer(distance, selector?)` | bevel edges |
| `s.shell(thickness, openFaces)` | hollow inward, wall = `thickness`; `openFaces` selector (`{inPlane,at}`/`{dir}`/`{near}`) chooses which face(s) to open. Closed (no-open-face) hollows are not supported. |

`selector` chooses which edges (omit it for **all** edges):

- `{ dir: "X"｜"Y"｜"Z" }` — edges running along an axis (e.g. `{dir:"Z"}` = the vertical edges)
- `{ inPlane: "XY"｜"XZ"｜"YZ", at }` — edges lying in a plane (e.g. base edges: `{inPlane:"XY", at:0}`)
- `{ near: [x,y,z] }` — edges passing through a point
- a raw `(edgeFinder) => edgeFinder` replicad finder, for anything fancier

```js
let s = k.box([0,0,0],[40,30,16]);
s = s.fillet(3, { dir: "Z" });            // round the 4 vertical edges
s = s.chamfer(1, { inPlane: "XY", at: 0 }); // bevel the base
```

See `src/parts/filleted-box.js` for the worked example.

**Automatic backend selection.** Before building, the framework runs a geometry-free *probe*
of your `build` to see whether it uses a CAD-only op, and routes accordingly — Manifold for
everything else (so sweep-heavy parts, e.g. helical grooves, stay fast). Force it with
`meta.backend: "occt" | "manifold"` if you ever need to. Because an OCCT part is built
entirely on OCCT, its fillets are exact in the STEP **and** present in the printed STL.

> Trade-off: OCCT is much slower on heavy swept geometry (helical grooves), so don't reach for
> `fillet`/`chamfer` on a sweep-heavy part — design those edges in, or keep the part on Manifold.

> `partforge measure` reports `watertight`/`holes` as `n/a` for OCCT parts (Manifold-only
> topology); `render` works on both.

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

---

## Interactive clarification: request-a-pick

An external tool (e.g. an AI agent editing your part) can ask the *user* to click
geometry and receive the `Selection` back, closing the loop in the other direction
from `?pick`.

- Serve your app with **`?pickserver`** (or `?pickserver=http://host:port`) to enable
  it. While idle nothing changes; when the local pick-server requests a click, a banner
  appears ("🤖 Claude needs you to click …") and the picker arms for one click.
- The agent side runs `partforge pick-serve` once, then `partforge pick "<prompt>" …`
  for one or more clicks (collected in order, returned together). The CLI blocks until
  the user clicks, then prints the `Selection`(s) as JSON.

See the bundled skill `skills/partforge/SKILL.md` for the agent workflow. This is plain
click-routing — no LLM logic lives in partforge.
