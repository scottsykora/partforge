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

## Before geometry: state the engineering intent

For a decorative or low-consequence part, a short dimensional description may be
enough. For anything that mates with another object, carries load, or could cause harm
if it fails, write down the engineering intent **before** writing `build`:

- the coordinate frame, origin, and named datums;
- the allowed envelope and the interfaces that must align (mating faces, axes, hole
  patterns, fits, clearances, and tolerances);
- the manufacturing process and material assumptions;
- load cases, support regions, intended load paths, and safety factors when structural
  behavior matters;
- numbered acceptance claims with units and thresholds; and
- unresolved assumptions that need the user or an engineer to answer.

This may live in the task/specification, a companion design note, or comments next to
the part — partforge does not prescribe a blueprint schema yet. Do not silently invent
missing loads, material properties, tolerances, or safety factors. Ask, or record the
property as unverified.

Treat user/specification acceptance claims as **higher authority** than agent-authored
geometry and checks. An agent may add conservative checks, but must not delete a claim
or loosen its threshold merely to make a failing design pass; changing the contract
requires explicit approval.

---

## The `PartDefinition` contract

A part is a default-exported object. Full shape (optional fields marked `?`):

```js
export default {
  meta: { title, units, background? },     // title string; units e.g. "mm"; background = 0xRRGGBB scene colour
  parameters,                              // the control-panel schema (array of sections — see below)
  defaults,                                // flat { paramKey: value } — seeds params + control values
  fonts?,                                  // { name: source } — fonts a part's k.text2d() needs; framework preloads before build (see below)
  derive?,                                 // (p) => d, or { group: (p, d) => {…}, … } — dependent values computed once per build
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
  **Any difference between the display and export pose must be a rigid motion** —
  `translate`/`rotate`/`rotateAbout`/`along`/`at` only. Never put a `mirror` or a
  non-identity `scale` on one purpose but not the other: the exported (printed) part is the
  same physical object you show in the assembly, and a reflection or resize there makes the
  two silently disagree — you print the mirror image of what the viewer showed
  ([place-not-rigid](ERROR-PATTERNS.md#place-not-rigid)). If a part genuinely needs a
  reflected or resized form (e.g. a block that seats flipped), bake that into `build` so
  both purposes share one canonical solid, then pose it rigidly.
- `enabled(p)` gates a conditional sub-part (e.g. only present when a feature is on).
- A view's sub-parts are derived, never hard-coded: those whose `views` include the view
  and whose `enabled(p)` is true.
- `fonts` declares the outline fonts a part's `k.text2d()` calls need, as `{ name: source
  }` — a source is inline bytes, a URL string, or a thunk (e.g. a Vite `import('./x.ttf')`,
  which resolves to `{ default: url }`). The framework resolves and parses these into
  `kernel._fonts` **before** the synchronous `build` runs, so `k.text2d(str, { font: name
  })` can look the font up by name. See `src/framework/fonts.js` (`resolveFonts`) and
  `k.text2d` in `docs/KERNEL-CONTRACT.md` for the full contract; fuller authoring guidance
  (recommended font sourcing, licensing notes) lands in a follow-up pass.

---

## Geometry: the kernel / `Solid` API

`build` receives a backend-agnostic `kernel` (`k`). It returns and combines `Solid`
handles. The same code runs on **Manifold** (fast meshes — preview + STL + 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Op lists live in
`src/framework/geometry/kernel.js`; the normative semantics (conventions, value
semantics, conformance classes, versioning) are in `docs/KERNEL-CONTRACT.md` — the
tables below are the authoring-side view of that contract.

**Calling convention.** Every multi-parameter op below takes a single **options
object** — this is the canonical, documented way to call them (`k.cylinder({ r, h
})`, not `k.cylinder(r, r, h)`); the object's keys are named the same across both
backends, so a call is self-describing and immune to the positional-argument
transposition mistake (swap two same-typed numbers, get a valid *wrong* solid).
Single-argument chaining ops (`translate`, `rotate*`, `cut`, `mirror`, `scale`, …)
already take one argument and are unaffected. Legacy positional calls (e.g.
`k.cylinder(rBottom, rTop, h)`) still work — they're accepted silently until a
future contract v2 — but are not shown here; see `docs/KERNEL-CONTRACT.md`
"Calling convention" for the full canonical/legacy table and the detection rule.

**Kernel — make solids:**

| Call | Result |
|---|---|
| `k.cylinder({ r\|d, h, center? })` · `k.cylinder({ r1, r2, h, center? })` \| `{ d1, d2, h }` | cylinder/cone along +Z (frustum for the cone form); straight takes exactly one of `r`/`d` |
| `k.box({ size, center? })` · `k.box({ min, max })` | `{size:[x,y,z]}` = centered X/Y, base at z=0 (`center:true` also centers Z); `{min,max}` = explicit `[x,y,z]` corners |
| `k.prism({ points, h, twist?, scaleTop? })` | extrude a 2-D polygon (or an **arc profile** from `roundedProfile`) from z=0; optional `twist` (degrees over the height) and `scaleTop` (uniform top taper: 1 straight, <1 taper in, 0 → point/cone) |
| `k.extrude({ profile, h, twist?, scaleTop? })` | extrude a **polygon-with-holes** region from z=0 in one op — `profile` is `{ outer, holes? }` where each contour is a points array **or an arc profile** (`roundedProfile`, for true STEP fillets), or a bare points array / arc profile for outer-only; same `twist`/`scaleTop` as `prism` (both backends) |
| `k.loft({ rings, ruled?, closed? })` | stack polygon cross-sections into a solid — ruled walls between consecutive rings, capped ends (both backends; `closed:true` capless loops are Manifold-only). `ruled:false` (smooth C2 blend) is honoured only by OCCT/STEP export; the Manifold preview always shows faceted straight walls |
| `k.sweep({ profile, path, cornerRadius?, closed?, ruled?, smooth? })` | sweep a fixed 2-D profile along a 3-D polyline path — sharp mitered corners (or `cornerRadius` fillets), capped ends (both backends). `closed:true` capless loops and `smooth:true` (OCCT-native swept B-rep, STEP-exact / preview-faceted) are backend-specific, like loft's `closed`/`ruled:false`. `closed:true` loops must be **planar** — RMF frame-transport holonomy can seam-twist a non-planar closed loop where the last station rejoins the first, so only planar closed loops are supported/tested |
| `k.sphere({ r\|d })` | sphere centred at the origin; bare `k.sphere(r)` also stays valid |
| `k.revolve({ profile, degrees? })` | revolve a lathe profile `[[r,z],…]` (r ≥ 0) around the Z axis (full or partial) |
| `k.helixSweptTube({ pathR, profileR, pitch, turns, z0, lefthand })` | circle swept along a helix (e.g. a rope groove) |
| `k.union(solids[])` | boolean union |

**`loft` rings** — each ring is `{ polygon:[[x,y],…] | sides+radius, z, rotate?, scale? }`
(all rings must share the same vertex count; `rotate` is degrees about Z, `scale` is a
number or `[sx,sy]`). Author rings CCW and ordered by ascending `z` (the `regularPolygon`
/ `polygon.js` helpers are already CCW); loft self-corrects a fully-inverted result so
CW-wound or descending-z rings still export a valid outward solid. (Arc profiles from
`roundedProfile` are **not** accepted as loft rings yet — a ring must be a point array;
use `prism`/`extrude` for true-arc STEP export.) **`sweep`** takes the same CCW
`polygon.js` outline as its `profile` and a plain `[[x,y,z],…]` point list as its
`path`; the profile stays perpendicular to the path (a rotation-minimizing frame), with
sharp mitered corners by default or `cornerRadius` fillets. Worked snippets:

```js
// a square tube (extrude a region with a hole) — one op, no boolean cut
k.extrude({ profile: { outer: roundedRectPolygon(40, 30, 4), holes: [circleProfile(6)] }, h: 10 });

// a tapered, twisting faceted vase wall (see src/parts/faceted-vase.js)
const rings = [];
for (let i = 0; i <= 24; i++) { const t = i / 24;
  rings.push({ sides: 6, radius: 30 - 8 * t, z: 120 * t, rotate: 90 * t }); }
k.loft({ rings });                      // ruled walls, capped ends

// a cable/hose: sweep a circle along a 3-D polyline, with rounded bends
k.sweep({ profile: circleProfile(3), path: [[0, 0, 0], [0, 0, 20], [15, 0, 20]], cornerRadius: 5 });

// round every corner of any CCW outline, then extrude/loft/prism it
k.prism({ points: filletPolygon(bracketOutline, 3), h: 4 });   // tessellated corners (faceted in STEP)
k.prism({ points: roundedProfile(bracketOutline, 3), h: 4 });  // true CIRCLE corners in STEP export

// print clearance on an arbitrary cut profile, or an inset wall
k.extrude({ profile: offsetPolygon(slotPolygon(20, 3), 0.2), h: 10 });   // slot cut 0.2 mm looser all around
offsetPolygon(outline, -wall, { corners: "sharp" });                     // inset a wall (see planter.js)

// A tab with one free-form curved side (exact on STEP, faceted at mesh LOD):
const tab = pathProfile([0, 0])
  .lineTo([20, 0]).lineTo([20, 8])
  .cubicTo([0, 8], [14, 16], [6, 16])   // curved top edge
  .close();
k.extrude({ profile: tab, h: 3 });
```

2-D polygon helpers for `prism`/`extrude`/`loft`: `import { piePolygon, hexPolygon,
regularPolygon, roundedRectPolygon, starPolygon, slotPolygon, circleProfile, filletPolygon,
roundedProfile, offsetPolygon, pathProfile } from "partforge/geometry"`. `filletPolygon(points, r, { segs? })` rounds
every corner of a CCW polygon (per-corner radius clamped so neighbouring arcs never overlap)
and returns points usable by `prism`/`extrude`/`loft` on both backends — but it **bakes each
corner into line facets**, so STEP corners are faceted. `roundedProfile(points, r | r[])`
rounds corners the same way but keeps them **mathematically true** — it carries the arc
symbolically so STEP export gets real circular edges. Use it for `prism`/`extrude` (not yet
`loft` — arc rings are rejected there in v1). A scalar `r` rounds every corner; a per-corner
`r[]` (length = points) rounds selectively (a `0`, a zero-length edge, or a straight/180°
corner stays sharp). `offsetPolygon(profile, delta, { corners?, segs? })` offsets a
point-list polygon or `{ outer, holes }` region by `delta` mm — positive grows material,
negative insets; regions offset material-wise (outer `+delta`, holes `−delta`, so a
clearance loosens the whole cut). `corners` picks the convex-corner style: `"round"`
(default; the true Minkowski clearance), `"chamfer"`, or `"sharp"` (miter, falling back to
chamfer past a miter length of 2·|delta|). It is **simple polygon in, simple polygon out**:
an offset whose true result would collapse or split into multiple contours (e.g. insetting a
dumbbell past its waist) **throws** a greppable error rather than returning degenerate
geometry. Being pure, it works in `derive()` as well as `build()` — the natural home for
clearance math.
`pathProfile(start)` is a fluent builder for a curve-native path contour (`lineTo` / `arcTo` / `cubicTo` / `close`); cubic segments become exact B-rep spline edges on the OCCT/STEP backend and facet at the mesh LOD on Manifold — the same exact-vs-faceted split as `roundedProfile` arcs.
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
  k.cylinder({ r, h: L }).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([rp, y1, sz])
  // ✓ legible
  k.cylinder({ r, h: L }).along("+Y").at([rp, y1, sz])
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

Label your part's features, and label them **thoroughly** — this is how a user points
at what they want changed. The viewer's hover tooltip, highlight, and pick selection
all show a feature's label, so you, the app user, and an agent editing on their behalf
share one vocabulary: "make the Drainage hole 10 mm", "raise the Motor upright". A
feature with no name can't be referred to — it reads as the whole part, so the request
has nowhere to land.

Treat comprehensive labeling as the default, not a finishing touch. Name every feature
a user could reasonably want to change: the base body, and each functional feature —
grooves, mounts, bores, pockets, distinct structural members.

```js
const body = k.prism({ points: d.outerPts, h: p.height, scaleTop: p.taper }).label("Faceted wall");
let s = body.cut(cavity.label("Cavity"));
if (p.drain > 0) s = s.cut(k.cylinder({ r: d.drainR, h: p.floor + 4 }).at([0, 0, -2]).label("Drainage hole"));
```

- **Aim for functional groups.** Label at the granularity a user would name a thing
  ("Rope groove", "Tensioner pockets", "Bearing seat"), grouping repeated or related
  faces under one name. Fine enough to reference any feature; coarse enough that
  near-identical surfaces don't fragment into dozens of near-duplicates.
- A label names the solid's **surface** wherever it survives into the final part —
  a cutting tool's label lands on the faces it leaves behind (the hole's wall).
- Label **after** shaping compound tools (e.g. after an `intersect` clip) and
  either before or after transforms — labels ride through `at`/`rotate`/etc.
- **Same label merges; distinct siblings need distinct names.** The same label on
  several solids merges into one feature — label a ring of four bolt holes
  `"Mounting holes"` and they hover/highlight as one. Conversely, when two similar
  features are things a user would tell apart, name them apart — two uprights as
  `"Drum upright"` and `"Motor upright"`, not both `"Upright"`.
- Unlabeled geometry falls back to the sub-part's `label`. Faces created by
  `fillet`/`chamfer`/`shell` are new surfaces, so they use the fallback too.
- Works on both backends. On OCCT each label keeps a geometry snapshot for
  mesh-time classification, so label meaningful features (functional groups — a
  handful to a couple dozen per part), not hundreds of individual faces.
- Names should describe intent ("Drainage hole", not "cylinder2"); make them
  unique per sub-part unless you specifically want the merge behavior.

### Caching & determinism

The preview kernel memoizes geometry by content hash, so editing a parameter only
re-runs the operations that parameter actually affects. For this to be sound, a
`build` must be a **pure function of `(k, p, d)`** — no `Math.random`, no clock, no
module-level mutable state. An impure build will silently return stale geometry.

Cache granularity follows the operations you call. Booleans and heavy primitives are
cached; cheap transforms are recomputed. To make a multi-step shape into a single
cache node, use (or add) a **compound op** like `k.boredCylinder({ od, h, bore })` —
it hashes from its own arguments and never exposes its internals to the cache. The heavy
primitives `loft`, `sweep`, `extrude`, `prism`, and `revolve` are cached this way too:
their hash folds every shape-affecting argument (each `loft` ring's points/`z`/`rotate`/`scale`,
`sweep`'s profile points/path points/`cornerRadius`/`closed`, `extrude`'s holes, an arc
profile's segment specs from `roundedProfile`, and the tessellation from `twist`), so
changing any of them is a fresh cache node while an identical rebuild is a hit.

---

## Parameters: the control-panel schema

`parameters` is an **array of sections**; the framework builds the panel from it and
binds each control to a key in `defaults`. Two section kinds:

**Preset + controls section:**

```js
{
  id: "body",
  title: "Body",
  presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } }, // name → param overrides
  advanced: [                                  // controls revealed under "Advanced"
    { key: "od",   label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 },
    { key: "bore", label: "Bore",           unit: "mm", min: 1, max: 30, step: 0.1, control: "number" },
    { key: "title", label: "Title", control: "text" },
    { key: "label", label: "Label", control: "textarea" },
  ],
}
```

Numeric slider/feature controls show an **editable number box** beside them — drag the
slider or type an exact value (finer than `step` is allowed; typed values clamp to
`[min, max]`). Optional `control` per parameter chooses the input:

- omit it (or use `"slider"`) for a slider + number box;
- `"number"` for a number box only (handy for precise or wide-range values);
- `"text"` for a single-line string field;
- `"textarea"` for a multiline string field whose line breaks are preserved.

Text fields update `params` live on every edit, so the existing rebuild loop previews
the new string immediately. Give every text key a string value in `defaults`; empty
strings are valid control values, while the part's build function decides whether its
geometry supports them. Editing any control in a preset section selects `Custom`, and
choosing a preset updates both numeric and text fields.

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
- **Grouped `derive` (recommended once it grows):** `derive` may instead be an object of
  named group functions, run in declaration order; each group receives `(p, d)` where `d`
  holds the merged outputs of the groups **before** it:

  ```js
  derive: {
    core:  (p) => ({ boreR: p.bore / 2 + 0.15 }),
    stand: (p, d) => ({ postH: d.boreR * 4 + p.base_t }),   // may read earlier groups
  }
  ```

  Builds see the same merged `d` either way. The point is the **control panel's
  relevance dimming** (and the rebuild cache): with a single function, a sub-part that
  reads *any* derived value is assumed to depend on *every* param `derive` touches, so
  e.g. stand-only controls stay lit in a drum-only view. With groups, each derived key
  is attributed to just its own group's inputs (plus, transitively, those of the groups
  it read), so unrelated controls dim correctly. Group along your sub-part seams:
  values only one sub-part family reads belong in their own group.

  Grouped-form rules: a group reading a key **no earlier group produced** throws
  immediately (misordered groups / typos would otherwise surface as silent NaN
  geometry) — this includes optional-chaining reads like `d.maybe?.x`, so probe for a
  conditionally-produced key with `"maybe" in d`, not `?.`. Prefer returning values
  over mutating `d` in place — mutation works and is tracked, but returned keys read
  clearer. Outside the part definition (helpers, tests), merge groups with
  `resolveDerived(part, p)` from **`partforge/derive`** — a lean, DOM-free entry safe
  to import from part modules; don't hand-roll the merge.
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
Compose it for round solids: `k.prism({ points: circleProfile(r), h })` is a cylinder, and
**a torus is `k.revolve({ profile: circleProfile(minorR, [majorR, 0]) })`** (with `majorR > minorR`) —
partforge has no `torus` primitive because it's just a revolved circle.

**Patterns** (return `Solid[]` — feed to `k.union(...)` for features or `s.cutAll(...)` for holes):
`linearPattern(solid, count, [dx,dy,dz])`, `circularPattern(solid, count, { center, axis, angle, rotateCopies })`.

```js
const hole = k.cylinder({ r: 2, h: 20 }).translate([20, 0, 0]);
body = body.cutAll(circularPattern(hole, 8, { axis: "Z" }));   // 8 bolt holes on a 40mm circle
```

## 2-D booleans

`k.shape2d(profile)` lifts a point list, arc profile, or region into a `Shape2D` — an opaque 2-D boolean value. You can then compose booleans, and feed the result directly to `extrude` or `revolve` without materializing intermediate regions. The same `content-hash caching` discipline applies: identical arguments produce identical geometry.

**Shape2D booleans are a build-time operation** (not `derive()`), and the curve semantics differ between backends: on OCCT the result carries exact circular arcs and Bézier curves into STEP export; on Manifold the curves facet to mesh LOD.

```js
// Keyhole plate: union a disc onto a rect, punch a slot, extrude.
const plate = k.shape2d(roundedRectPolygon(40, 24, 4))
  .union(circleProfile(8))
  .cut(slotPolygon(16, 3))
  .extrude({ h: 3 });   // sugar for k.extrude({ profile: …, h: 3 }); .revolve({ degrees }) too
```

A `Shape2D` also carries `.extrude({ h, twist?, scaleTop? })` and `.revolve({ degrees? })`
sugar (equivalent to the `k.extrude`/`k.revolve` forms), and `.regions()` — scission, which
returns each disjoint region as its own live `Shape2D` (vs `.toRegions()`, which returns raw
`{outer, holes}` data).

```js
// A 0.2 mm printer clearance around a bore, then a 2 mm wall inset:
const bore  = k.shape2d(circleProfile(3)).offset(0.2);            // looser
const wall  = k.shape2d(outer).offset(-2, { corners: "sharp" });  // inset, mitered
```

(This achieves the same geometry as building the profiles separately and using `k.extrude({ profile: { outer, holes }, h })`, but the Shape2D path is more idiomatic for complex 2-D operations.)

`Shape2D.offset(delta, {corners})` grows (`delta>0`) or insets (`delta<0`) a shape with round/chamfer/sharp corners — curve-preserving on OCCT, faceted at mesh LOD on Manifold; it throws if the offset collapses the shape. (For `derive()`/main-thread clearance math on plain point lists, use the pure `offsetPolygon` helper instead.)

## Convex hull

`k.hull([a, b, …])` wraps its inputs (Shape2Ds, curve contours, or point lists) in a
convex `Shape2D`. `k.hullChain([a, b, c, …])` sweeps the hull along an ordered sequence
(≥2 inputs) — the union of `hull([a,b])`, `hull([b,c])`, … — for capsules, rounded slots,
and organic tapers. Faceted (curved inputs facet at mesh LOD): the hull is a pure-JS
monotone-chain computation, never a native backend op.

```js
const capsule = k.hull([circleProfile(4, [0, 0]), circleProfile(4, [20, 0])]);   // a stadium
const slot = k.hullChain([circleProfile(3, [0, 0]), circleProfile(3, [15, 0]), circleProfile(2, [25, 5])]);
```

## Text (`text2d`)

`k.text2d(string, { size, font?, align?, valign?, lineHeight?, tracking?, kerning? })` renders outline-font text as a `Shape2D` — a 2-D boolean you can compose with other shapes (union / cut / offset) and extrude into 3-D geometry.

**Parameters:**

- `string` — the text to render
- `size` — **cap height in mm** (the design-height of capital letters like "H"); the layout engine scales the font to this height
- `font` — optional font name (declared in the part's `fonts` field, below); omit it to use the bundled default (Roboto)
- `align` — horizontal alignment: `"center"` (default), `"left"`, or `"right"`
- `valign` — vertical alignment: `"middle"` (default), `"baseline"`, `"top"`, or `"bottom"`. The defaults (`center`/`middle`) place the text block's centre at the origin, so `.at([x, y])` / `plate.cut(text)` compose without extra translation
- `lineHeight` — distance between baselines in **mm** for multi-line text; omit for a font-metrics default (≈ `(ascender − descender)/em × size`)
- `tracking` — letter spacing in mm (default 0); positive widens, negative tightens
- `kerning` — boolean, enable pair-wise kerning (default true)

**Shape2D composition:**

Like any `Shape2D`, the result composes with booleans and offset — you can union it onto a face, cut it out as a depression, expand it with `offset()`, or combine multiple text shapes:

```js
// Emboss text onto a plate
const baseplate = k.extrude({ profile: roundedRectPolygon(100, 60, 4), h: 5 });
const emboss = k.text2d("v2.0", { size: 8 }).offset(0.2);  // 0.2 mm relief
const part = baseplate.cut(k.extrude({ profile: emboss, h: 1 }));

// Deboss text into a lid
const lid = k.extrude({ profile: circleProfile(40), h: 3 });
const deboss = k.text2d("PART-042", { size: 6 });
const carved = lid.cut(k.extrude({ profile: deboss, h: 0.5 }));

// Extrude text as a solid letters
const raised = k.extrude({ profile: k.text2d("LOGO", { size: 10, align: "center" }), h: 2 });

// Multi-line label with tight tracking
const label = k.text2d("YEAR 2025\nSERIES A", { size: 4, align: "center", tracking: -0.1 });
```

**Font sourcing (the `fonts` PartDefinition field):**

Declare fonts in your part definition's optional `fonts` object — a map of font names to sources. The framework resolves and parses these before `build()` runs, so `k.text2d(str, { font: name })` can look them up synchronously:

```js
fonts: {
  heading: () => import("./fonts/Raleway-Bold.ttf"),    // bundle via Vite dynamic import
  label: "https://cdn.example.com/fonts/Courier-Prime.ttf",  // URL fetch
  default: new Uint8Array([...])                             // inline bytes (rare)
},
```

- **Dynamic import:** `() => import("./path/to/font.ttf")` — Vite bundles the font; resolves to `{ default: url }` at runtime
- **URL:** a string — the framework fetches it (CORS must allow it)
- **Inline bytes:** an `ArrayBuffer` or `Uint8Array` — useful for generated or embedded fonts

Reference a font by name: `k.text2d("text", { font: "heading" })`. Omit the `font` option to use the bundled **Roboto** (Regular, SIL OFL 1.1) default.

**Build-time & curve semantics:**

`text2d` is a **build-time operation** (not `derive()`), and **the curve representation differs by backend:**

- **OCCT (B-rep):** text outlines carry **exact cubic Bézier curves** into STEP export (not tessellated)
- **Manifold (mesh):** text outlines **facet at the mesh level-of-detail** (same as other curves in preview)

Both backends produce watertight emboss/deboss geometry; the difference is export fidelity. As with any `Shape2D`, composition with booleans and offset is backend-agnostic — the same code works on both.

**Overlapping / self-intersecting glyph outlines:** real font outlines aren't always simple, correctly-nested contours — counters can overlap or self-intersect. Before glyphs become curve regions, the framework resolves each glyph's raw contours with the nonzero winding rule (how all OpenType outlines — TrueType and CFF alike — are filled), so composite/overlapping outlines still produce a single correct `{outer, holes}` shape per glyph. This resolution stays curve-exact — it never flattens beziers to polygons — so the OCCT/Manifold split above still holds.

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
| `#viewbar` with `#pause` / `#reframe` / `#cutaway` / `#theme` | optional viewer controls (omit any you don't want) |

Copy `demo.html` and change the title, the panel heading, and the `<script src>`. Two workers are spawned from your one worker entry
(`name` = `"manifold"` for preview/STL/3MF, `"occt"` for STEP — handled for you).

`#cutaway` is optional viewer chrome. When present, it toggles an interactive
section plane whose exposed faces are hatched; changing views resets it. Cutaway
is viewer-only and never changes STL, STEP, or 3MF exports. Hosts that omit the
button get no cutaway UI.

Programmatic hosts can provide the same optional control without relying on an
ID by passing it beside the other chrome references:

```js
mount(part, {
  createWorker,
  elements: {
    chrome: {
      pause,
      reframe,
      cutaway,
      theme,
    },
  },
});
```

> Production deploy compiles only the pages listed in `build.rollupOptions.input`
> (currently the landing gallery + the demo part pages). Other root `*.html` files are
> **dev-only** (Vite serves any root HTML in `npm run dev`) unless added there. To also
> ship one, add it to `build.rollupOptions.input` in `vite.config.js`.

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
import { bootManifoldKernel, resolveDerived } from "partforge/testing";
import part from "../src/parts/<part>.js";

const k = await bootManifoldKernel();
const solid = part.parts.<name>.build(k, part.defaults, resolveDerived(part, part.defaults));
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
number of through-holes (genus), plus an assembly overlap check, and a
**near-miss** check — sub-part pairs whose surfaces come closer than 0.5 mm
without touching (`near-misses:` in the output; reported for judgment, never an
exit-code gate by itself). It exits non-zero
if any sub-part isn't watertight or any parts interpenetrate — so it doubles as a
CI/agent gate. Add `--json` to also dump the report as JSON on stdout, or
`--out report.json` to write it to a file (nothing is written otherwise). (Manifold output is
manifold by construction, so `watertight` is mainly a build-sanity check for
empty/degenerate results; `holes` is the informative topology number.)

`render` writes one PNG per angle (`iso`, `front`, `top` by default; choose with
`--views iso,front`, output dir with `--out`) to `render/`. The view defaults to
the part's first declared view. Treat renders as complementary evidence, not a ruler:
use several views for complex parts and the interactive viewer's cutaway for hidden
interfaces, but rely on `measure` / `verify` for dimensions, contact, and clearance.

The `measure` function is also exported for vitest (boot a Manifold kernel as in
"Testing a part", then `measure(kernel, part, "<view>")`):

    import { measure } from "partforge/testing";
    test("part is sound", () => {
      const r = measure(kernel, part, "<view>");
      expect(r.ok).toBe(true);
      expect(r.subparts[0].holes).toBe(1);   // e.g. expects one bore
    });

### The diagnostics contract (for agents)

`partforge measure <part> --json` / `--out <file>` emits the machine-readable
report. Every `fail`/`warn` check in `verify.failures` / `verify.warnings`
carries:

- `hint` — one self-contained corrective sentence (always present),
- `pattern` — a stable [ERROR-PATTERNS.md](ERROR-PATTERNS.md) entry ID when one
  applies (follow it with `ERROR-PATTERNS.md#<id>`),
- `location` — `[x, y, z]` in mm where the metric has one: `minWall` (thinnest
  sample point) and `overlaps` (the center of the first offending intersection's
  *bounding box* — a nearby indicator, not an exact point: when a pair overlaps in
  more than one place the bbox center can fall in the empty space between regions)
  and the pair checks `contact` / `clearance` / `nearMiss` (the midpoint between
  the pair's closest surface points). Whole-solid metrics (bbox, volume, …) have
  none.

Subpart facts include `minWall` (number or `null` — null exactly when no reading
exists, e.g. the OCCT backend or min-wall measurement turned off, matching
`minWallAt`'s null) and `minWallAt` (`[x,y,z]` or `null`); overlap entries are
`{ a, b, volume, location }`. Pair-distance facts are `gaps` (every sub-part
pair: `{ a, b, distance, at }`, distance 0 = touching or overlapping) and
`nearMisses` (the pairs with an unintended-looking gap under 0.5 mm).

A **thrown** error (bad part module, kernel failure) with `--json` prints pure
JSON to stdout and exits 1:

```json
{ "ok": false, "error": { "message": "…", "pattern": "<id>", "hint": "…" } }
```

`pattern`/`hint` appear when the message matches an ERROR-PATTERNS.md symptom
string. Exit codes: 0 pass, 1 gate failure or crash — unchanged. Caveat: a throw
*after* measure output has printed (e.g. an unknown metric in `verify.expect`, or
a per-case build crash) appends this JSON after the human lines, so stdout is no
longer pure JSON; prefer `--out` (or parse the trailing JSON object — the crash
JSON is pretty-printed across multiple lines) for robust machine parsing. With
`--out` the measure report is written to the file as soon as `measure` succeeds,
so even if a later `verify` throw crashes the run the file is there — it just
lacks the `verify` key.

**Fresh-evidence rule.** A passing report is evidence only for the source, parameters,
view, backend, and framework version that produced it. Any relevant edit makes the old
result stale. Before reporting a part complete, run `measure` / `verify` again on the
current source and inspect current renders where visual requirements remain. Do not cite
a command that ran before the last geometry or expectation change as evidence.

**Part-authored hints.** Any `verify.expect` metric accepts `{ expr, hint }` in
place of a bare expression — use it to name the governing parameter:

```js
verify: {
  expect: {
    body: { minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" } },
  },
}
```

---

## Self-verification (the `verify` block)

A part can declare how it should be checked, co-located with its schema, so
`partforge measure` (and vitest) can enforce selected **geometric**, **assembly**, and
**DFM** properties. Add an optional top-level `verify` block:

```js
verify: {
  process: "fdm-pla",            // a DFM profile: fdm-pla | fdm-petg | resin, or an
                                  // inline { bed:[x,y,z], minWall, clearance } object
  cases: ["defaults", "M3"],     // optional; default = defaults + every preset
  expect: {                      // design intent, by sub-part name (+ "_view")
    spacer: { holes: 1, bbox: "<=[60,60,60]", volume: "0.4..0.6cm3" },
    _view:  { overlaps: 0,
              contacts:  [["drum", "flange"]],       // these pairs must touch
              clearance: { "lid×body": ">=0.3" } },  // intended free fits
  },
}
```

**What the profile gives you:** a hard **bed-fit** gate (the view bbox must fit `bed`)
and a **min-wall** warning. **What `expect` gives you:** per-sub-part assertions on the
facts `measure` already reports — `holes` (through-bores / genus), `volume`,
`surfaceArea`, `triangleCount`, `bbox`, `watertight`, `minWall`, `bounds` (per-sub-part
and aggregate axis-aligned `{min,max}` corner positions — where the geometry sits, vs
`bbox` which is only its size) and `centerOfMass` (`[x,y,z]`, the volume-weighted
centroid; `null` for a degenerate/zero-volume sub-part); and `_view` assertions `bbox`,
`volume`, `overlaps`, `centerOfMass`, `boundsMin`, `boundsMax`, plus the pair-wise
`contacts` / `clearance` below.

Passing these checks does **not** prove structural strength, fatigue life, stability,
manufacturing tolerance stack-up, regulatory compliance, or safe real-world use.
Load-bearing or safety-relevant parts need appropriate analytical/simulation evidence
(for example FEA with declared materials, loads, supports, and safety factors) plus
qualified human review. If no such evidence exists, say that physical performance is
unverified.

**Assertion DSL:** a bare number means equality (`holes: 1`); `">=n"`, `"<=n"`, `">n"`,
`"<n"`, or a range `"a..b"`; an optional unit suffix `mm`/`cm`/`mm3`/`cm3`; and for
`bbox`, `centerOfMass`, `boundsMin`, `boundsMax`, a componentwise vector `"<=[x,y,z]"` /
`">=[x,y,z]"` where `*` skips an axis. The parser is strict — a malformed assertion
fails loudly.

```js
verify: { expect: {
  stand: { boundsMin: ">=[0,0,0]", centerOfMass: "<=[*,*,25]" },   // sits in +octant, mass kept low
  _view: { boundsMax: "<=[220,220,250]" },                          // whole assembly fits the bed
} }
```

**Gates vs. warnings:** exact facts are **gates** (a failure sets a non-zero exit code);
`minWall` is computed (a ray/shot wall-thickness measurement) and reported as a
**warning** — it flags walls below the profile's minimum but never fails the build.
`holes`/`watertight` are Manifold-only, so those assertions **skip** on OCCT parts
rather than fail.

**Per-case expectations.** Checks run across defaults **and every preset**, so a
static `expect` breaks the moment a preset legitimately changes an asserted fact —
a "cup" preset that turns the drainage hole off flips the genus from 1 to 0.
For that, declare `expect` as a **pure function of the case's resolved params**,
`(p, d) => ({ … })` (same `p`/`d` your `build` sees, `d` from `derive`):

```js
verify: {
  process: "fdm-pla",
  expect: (p) => ({
    planter: { holes: p.drain > 0 ? 1 : 0, bbox: "<=[220,220,250]" },
    _view: { overlaps: 0 },
  }),
}
```

`src/parts/planter.js` is the worked example — its "Pen cup" and "Vase" presets
disable the drain, so the hole count is pinned per case. Keep the function pure
(no clock/randomness), like every other part function.

**Contacts & clearance (near-miss gaps).** Volume, bbox, and render checks all miss
sub-parts that *almost* touch — a flange floating 0.3 mm off its drum body passes
every one of them. `measure` therefore reports `nearMisses` (pairs with a
surface-to-surface gap under 0.5 mm), and `_view` accepts two pair-wise gates:

- `contacts: [["drum", "flange"]]` — each listed pair must touch. The gate fails
  with the measured gap and the closest-point location when the surfaces don't
  meet. Interpenetration counts as contact — the separate `overlaps` gate owns
  *excessive* interpenetration. A pair naming an `enabled()`-gated sub-part
  **skips** in cases where that sub-part is off; a name that exists nowhere in
  the part still throws.
- `clearance: { "lid×body": ">=0.3" }` — an intended free fit. Keys are `"a×b"`
  (order doesn't matter); values take the same assertion DSL as any metric (and
  the `{ expr, hint }` form), evaluated against the pair's minimum surface
  distance in mm.

Any pair *not* declared either way that sits closer than 0.5 mm becomes a
**warning** — the "did you mean these to touch?" signal. Declare the pair to
silence it. Distances are measured mesh-to-mesh (exact triangle distance, so it
works on both backends with no kernel booleans); contact tolerates ~1 µm, so a
tessellation-limited curved contact (e.g. equal-radius cylinder-in-bore built with
different facet counts) may read a few hundredths of a millimetre — prefer a tight
`clearance` bound like `"<=0.05"` over `contacts` for those. One OCCT caveat: with
no overlap detection there (`Solid.intersect` is Manifold-only), a sub-part
*fully contained* inside another reads as its surface-to-surface distance, so it
can surface as a near miss — check containment cases on Manifold.

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

When an agent authors both geometry and `verify`, the check is useful feedback but not
an independent oracle. Preserve externally supplied acceptance claims verbatim (ideally
with stable IDs in the surrounding specification), and test boundary/tolerance cases in
addition to friendly defaults and presets. A repair should change the design, not relax
the requirement that exposed the failure.

---

## Fillet & chamfer (automatic OCCT backend)

Two backends build your part: **Manifold** (fast meshes — preview, STL, 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Most parts run on Manifold. But Manifold has no
fillet, so if your `build` calls a **CAD-only op** the framework automatically routes the
whole part to OCCT — no declaration needed:

| Op | Meaning |
|---|---|
| `s.fillet(radius)` · `s.fillet({ r, edges? })` | round edges (curve-following, exact); the bare-number scalar shorthand fillets **all** edges, the options form adds a selector |
| `s.chamfer(distance)` · `s.chamfer({ d, edges? })` | bevel edges; same scalar-shorthand-or-options-with-selector shape as `fillet` |
| `s.shell({ t, open })` | hollow inward, wall = `t`; `open` selector (`{inPlane,at}`/`{dir}`/`{near}`) chooses which face(s) to open. Closed (no-open-face) hollows are not supported. |

`edges` (fillet/chamfer) / `open` (shell) chooses which edges/faces (omit `edges` for **all** edges — `shell` always requires `open`):

- `{ dir: "X"｜"Y"｜"Z" }` — edges running along an axis (e.g. `{dir:"Z"}` = the vertical edges)
- `{ inPlane: "XY"｜"XZ"｜"YZ", at }` — edges lying in a plane (e.g. base edges: `{inPlane:"XY", at:0}`)
- `{ near: [x,y,z] }` — edges passing through a point
- a raw `(edgeFinder) => edgeFinder` replicad finder, for anything fancier — **OCCT-only
  escape hatch**: fine for a part that's happy to stay in this repo, but non-portable
  (parts meant to travel must use the object forms — see `KERNEL-CONTRACT.md`)

```js
let s = k.box({ min: [0, 0, 0], max: [40, 30, 16] });
s = s.fillet({ r: 3, edges: { dir: "Z" } });            // round the 4 vertical edges
s = s.chamfer({ d: 1, edges: { inPlane: "XY", at: 0 } }); // bevel the base
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

When something fails confusingly, **grep [ERROR-PATTERNS.md](ERROR-PATTERNS.md) for the
symptom first** — it maps error text → cause → fix. The invariants, one line each:

- **replicad (OCCT) transforms consume their input** — never reuse a transformed solid;
  `.clone()` first ([replicad-consumed-operand](ERROR-PATTERNS.md#replicad-consumed-operand)).
- **Part modules are DOM-free and side-effect-free** — they load in both the main thread
  and the worker ([worker-imports-main-entry](ERROR-PATTERNS.md#worker-imports-main-entry)).
- **`build` is a pure function of `(k, p, d)`** — impurity silently defeats the geometry
  cache ([impure-build-stale-preview](ERROR-PATTERNS.md#impure-build-stale-preview)).
- **Units are millimetres** throughout.
- **Preview vs print quality:** Manifold bakes segment counts in at primitive creation,
  so builds are quality-agnostic; the export path uses a separate high-res "print" kernel.
- **Display placement is view-independent**; only `place(..., { purpose: "export" })` may
  depend on `view` ([view-dependent-display-place](ERROR-PATTERNS.md#view-dependent-display-place)).
- **Keep geometry backend-agnostic** (kernel calls only); only STEP requires OCCT
  ([probe-routed-to-occt](ERROR-PATTERNS.md#probe-routed-to-occt),
  [occt-holes-watertight-na](ERROR-PATTERNS.md#occt-holes-watertight-na)).

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
