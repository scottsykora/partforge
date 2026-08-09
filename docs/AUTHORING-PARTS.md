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
your HTML is structural markup only and carries no CSS (the framework supplies it via
`framework/app.css`, imported by `mount`). See "Wiring a part into a runnable app"
below for what that markup must contain.

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
  views: { <name>: { label, default? } },  // the view tabs (a view = a set of sub-parts)
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
- **Which view the viewer opens on** is resolved in this order: the first view flagged
  `default: true`; else the view placing the most sub-parts at `defaults` (counting
  `enabled(defaults)`), which for a multi-view part is normally the assembly; else the
  first key in `views`. So flag the assembly view `default: true` when you want it to
  open but sit last in the tab bar. The chosen tab then persists per part for the rest
  of the browser session. The headless tools are deliberately different: `measure`,
  `verify` and `render` all default to the **first key** in `views`, ignoring
  `default: true`, so a CI gate can't move because a sub-part was added to a view.
- `fonts` declares the outline fonts a part's `k.text2d()` calls need, as `{ name: source
  }` — a source is inline bytes, a URL string, or a thunk (e.g. a Vite `import('./x.ttf')`,
  which resolves to `{ default: url }`). The framework resolves and parses these into
  `kernel._fonts` **before** the synchronous `build` runs, so `k.text2d(str, { font: name
  })` can look the font up by name. See `src/framework/fonts.js` (`resolveFonts`) and
  `k.text2d` in `docs/KERNEL-CONTRACT.md` for the full contract; fuller authoring guidance
  (recommended font sourcing, licensing notes) lands in a follow-up pass.

---

## Animations

A part may declare named animations — pure keyframe data that drives **existing
params** over time. The viewer shows a transport bar (play/scrub, with ‹ ›
pagers between animations); hosts drive the same engine via
`runtime.animation`; `partforge render` can render stills at any position. The
reference part is `src/parts/hinged-box.js`.

Step labels surface on the scrubber rather than in a readout: hovering or
dragging along the timeline names the chapter under the pointer, and with the
scrubber focused **PageUp / PageDown jump whole chapters** (PageUp forward,
matching the key's native slider direction). Screen readers get the same
information from the scrubber's `aria-valuetext`, which reads
`"<step label> — <percent>"`.

```js
animations: {
  open: {
    label: "Open lid",
    description: "Optional **CommonMark**, shown behind the ⓘ glyph.",
    camera: "front",          // optional: intro angle, cue list, or per-step (below)
    duration: 1.2,            // seconds
    loop: false,              // true = wraps continuously (single-step only)
    easing: "ease-in-out",    // linear | ease-in | ease-out | ease-in-out
    tracks: { lidAngle: [[0, 0], [1, 110]] },   // param -> [t, value] keyframes
  },
  assemble: {
    label: "Assemble",
    steps: [                  // steps play in order; named on the scrubber as you hover/drag
      { label: "Lower the lid", camera: "left", duration: 1.0,
        tracks: { lidLift: [[0, 40], [1, 0]] } },
      { label: "Open", camera: "iso", duration: 1.0,
        tracks: { lidAngle: [[0, 0], [1, 110]] } },
    ],
  },
}
```

Rules (all lint-enforced):

- An animation has **either** `tracks` (a single anonymous step) **or** `steps`.
- Tracks reference numeric params from `defaults`. Keyframe `t` is normalized
  per step, strictly ascending from exactly 0 to exactly 1; values must sit
  inside the owning control's min/max (the engine applies them unclamped).
- Params not tracked anywhere keep their current values; a param tracked in
  one step holds its nearest keyframe value while other steps play.
- A step may declare a `camera` and **no** `tracks` — an establishing shot that
  swings the view while the model holds still. At least one step still has to
  carry tracks, or the animation animates nothing. Note the holding value is the
  nearest keyframe, not whatever the user last set: a leading camera-only step
  shows the animation's opening pose, the same one `t = 0` would show.
- `loop` and `autoplay` must be literal booleans. Anything else is reported by
  lint and treated as `false` at runtime, so `loop: "false"` never means "loop".
- Couple motions through `derive` (animate one master param; derive the rest),
  not by tracking dependent params separately.
- `camera` cues use the seven canonical angles (`iso front back top bottom
  left right`). One mechanism per animation: an animation-level name (an intro
  cue at t=0), an animation-level `[[t, angle], …]` list, or per-step names.
  Cues fire during play only — scrubbing never moves the camera — and a user
  orbit disarms the remaining cues for that run.
- Playback drives params through the real param pipeline: a **pose-only**
  param (feeds only rigid placement — see "Caching & determinism" below) plays
  at frame rate; anything else rebuilds best-effort at worker cadence. `lint`
  prints a note per track that can't take the fast path.
- Playback pauses when the user edits any control; Reset restores the values
  the animation found. Because animated values are real params, exporting
  while paused exports the posed state — by design.
- `autoplay: true` (optional, one animation at most) starts that animation on
  first show and again on each view switch, until the user touches the
  transport — or anything writes params (`runtime.setParams` included) or
  calls a `runtime.animation` method; any of those disarms auto-start for the
  session. Lint: `animation-autoplay-invalid`. It is not armed when the
  browser reports `prefers-reduced-motion: reduce` — self-starting motion is
  exactly what that setting asks a page not to do. An autoplay animation that
  declares a `camera` cue will sweep the camera away from the user's
  persisted framing on every page load, so choose cues for autoplay
  deliberately — the shipped example's `cycle` animation has none.

Headless: `partforge render <part> --animation open --at 0,0.5,1` renders
tagged stills (`--at` is normalized over the animation's total duration, like
the scrubber); `--step <index|label>` renders a step's end state; stills
default to the governing camera cue's angle.

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
| `k.loft({ rings, ruled?, closed?, shading? })` | stack polygon cross-sections into a solid — ruled walls between consecutive rings, capped ends (both backends; `closed:true` capless loops are Manifold-only). `ruled:false` (smooth C2 blend) is honoured only by OCCT/STEP export; the Manifold preview always shows faceted straight walls. `shading?: "smooth" \| "faceted"` overrides facet/smooth shading inference (default: <32-side rings shade as flat facets, drawing no same-surface lines at all — not even their own cap rims — though cut seams against other solids still draw; ≥32 sides shade smooth) |
| `k.sweep({ profile, path, cornerRadius?, closed?, ruled?, smooth? })` | sweep a fixed 2-D profile along a 3-D polyline path — sharp mitered corners (or `cornerRadius` fillets), capped ends (both backends). `closed:true` capless loops and `smooth:true` (OCCT-native swept B-rep, STEP-exact / preview-faceted) are backend-specific, like loft's `closed`/`ruled:false`. `closed:true` loops must be **planar** — RMF frame-transport holonomy can seam-twist a non-planar closed loop where the last station rejoins the first, so only planar closed loops are supported/tested |
| `k.sphere({ r\|d })` | sphere centred at the origin; bare `k.sphere(r)` also stays valid |
| `k.roundedBox({ size, center?, round })` | box with rounded edges — `round` = number (all edges) or `{ side?, top?, bottom? }` (vertical edges / rims); stays on Manifold (no OCCT routing, unlike `fillet`); `side` must be 0 or ≥ the rim radii (between clamps with a warning); with `side > 0`, `top + bottom` must be strictly `< h` |
| `k.roundedCylinder({ r\|d, h, center?, round })` | cylinder with rounded rims — `round` = number (both) or `{ top?, bottom? }`; `round: r` with `top+bottom = h` gives a sphere (capsule when `h > 2r`); one lathe revolve, curve-exact in STEP |
| `k.torus({ rMajor, rMinor })` | torus centered at the origin (tube centerline in z=0); `0 < rMinor < rMajor` |
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

// Rounded enclosure: soft vertical edges, a softer lid, a flat base.
const shell = k.roundedBox({ size: [60, 40, 22], round: { side: 4, top: 2, bottom: 0 } });
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
  Labeling a compound collapses it to ONE shading surface — the majority
  policy of its registered surfaces (by triangle count) applies to the whole
  solid, so a faceted policy also suppresses line-drawing on the compound's
  internal seams.
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

This holds on **both backends** — and on OCCT, `translate`/`rotate` are additionally
*pose-lazy*: the backend re-poses the cached solid's cached tessellation instead of
re-running any B-rep work. A parameter that only feeds a final placement rotation (a
lid's open angle, an exploded-view offset) therefore re-drags in ~0 ms even on the
slow exact kernel — keep such transforms as the last ops in `build` (or in `place`)
rather than baking them into the geometry earlier. In the app, such pose-only edits
skip the worker entirely — the viewer re-poses the cached mesh — so they stay smooth
even at animation rates (see `runtime.setParams`).

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

A feature's `on` is **required and must be greater than 0** — it is the real value the
parameter takes when the box is ticked (a diameter, a count), and the panel reads
`> 0` as "enabled", so there is nothing sensible to fall back to. `partforge lint`
reports a missing or non-positive one as `features-requires-on`. A `toggles` entry is
the exception: its `on` is just a flag and defaults to 1.

**Standalone toggles** (a plain on/off checkbox, no accompanying sliders): add a
`toggles` array to a preset section — shown below the preset picker, outside the
Advanced fold, so it stays visible:

```js
{
  id: "shape",
  title: "Shape ops",
  toggles: [
    { key: "clip", label: "Clip arms to a disc (intersect)", on: 1,
      description: "**Intersect** the cross with a circle so the four arm tips are rounded off to a common radius." },
  ],
}
```

Each entry is `{ key, label, on?, hidden?, description? }`: checked sets `key` to `on`
(default `1`); unchecked sets it to `0`. This is the correct home for a bare boolean —
a `features` entry *requires* a `sliders` array (the panel reads `feat.sliders.filter(...)`
unguarded and throws if it's missing), so a feature with nothing to reveal belongs in
`toggles` instead. `src/parts/bracket.js`'s `clip` toggle (shown above) is the worked
example.

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

**Collapsing.** Each section is a disclosure. A panel with **three or fewer
sections opens every section and every Advanced fold on load**; beyond that they
all start closed, because the rail is a fixed-height column and a long part
otherwise scrolls forever. Set `collapsed: true` or `collapsed: false` on a
section to override the rule in either direction.

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
**use `k.torus({ rMajor, rMinor })` for a torus** — it desugars to a revolve of
an arc-exact circle profile (`k.revolve({ profile: circleProfile(minorR,
[majorR, 0]) })` is the faceted hand-rolled equivalent; the primitive keeps
real TORUS faces in STEP).

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
| `#part` | view-tab bar — leave the div **empty**; `mount` generates one button per entry in `part.views` and opens the resolved default (see the "Which view the viewer opens on" rule above) |
| `#download-step` / `#download` / `#download-3mf` | STEP / STL / 3MF export buttons |
| `#status`, `#busy`, `#phase` | status line + busy overlay |
| `#viewbar` with `#reframe` / `#cutaway` / `#theme` | optional viewer controls (omit any you don't want) |
| `#panel` | the full-height controls rail (`class="pf-rail"`); programmatic hosts pass `elements.rail` instead |
| `#rail-toggle` | optional — collapses/restores the rail; resolved the same way as `#reframe`/`#theme` |

Copy `demo.html` and change the title, the panel heading, and the `<script src>`. Two
workers are spawned from your one worker entry (`name` = `"manifold"` for preview/STL/3MF,
`"occt"` for STEP — handled for you).

**View control (the mount handle).** For an embedder driving the view tabs from its own UI
instead of (or in addition to) the built-in `#part` bar:

- `runtime.getView() → string` — the active view name; never null once the runtime is ready
  (mount resolves a default before first build — see "Which view the viewer opens on" above).
- `runtime.setView(name) → boolean` — switch tabs programmatically, the same path as clicking
  a tab. Returns `false` (and leaves the active tab untouched) for a name the part doesn't
  declare in `views`; `true` otherwise, including when `name` is already active.
- `await runtime.captureView(viewName?, opts?) → Promise<string | null>` — a JPEG data URL of
  `viewName` rendered offscreen (falling back to the resolved default view — see
  `resolveDefaultView` / `default-view.js` — when `viewName` is omitted or names a view the
  part doesn't declare). Never disturbs the active tab, the live camera, or the on-screen
  scene; `opts` forwards to the underlying render (size, quality, angle). Resolves `null` on
  failure rather than throwing (a build error, a part with no sub-parts in that view, a
  disposed runtime).

Pass `onViewChange(name)` to `mount()` to be told the active view: it fires once
synchronously during mount with the initial resolved view (before `runtime.ready` settles),
then again on every subsequent change — a tab click or a `setView` call — always with the
new view name.

**Headless export (the mount handle).** The `#download*` buttons above are the built-in,
view-bound export UI. An embedder that wants its own export UI (e.g. a "pick which parts,
pick a format" modal) can skip those buttons and drive export off the handle `mount()`
returns instead:

- `runtime.listExportableParts() → [{ name, label }]` — every exportable sub-part
  (excludes any `exportable: false` part, respects each part's `enabled(params)`),
  **independent of the active view**. Use it to populate an export checklist.
- `runtime.exportParts({ parts, format, quality?, onProgress }) → Promise<void>` — build
  the given `parts` (sub-part names) in `format` (`"stl" | "step" | "3mf"`), streaming
  phase strings to `onProgress(phase)`. Resolves once the file is written (handed to your
  `onDownload` sink, or downloaded directly if you don't supply one); rejects on
  build/export failure or an empty selection. Placement uses the current
  view. STEP is routed to OCCT automatically.

Pass `onDownload({ data, filename, mime })` to `mount()` to receive the exported bytes
yourself (e.g. to download from a different origin) instead of partforge's own DOM download.

**Showcase capture (the mount handle).** The handle can also render the user's *current*
framing offscreen at a resolution independent of the window size and devicePixelRatio —
for gallery/preview images, where grabbing the live canvas would be capped at the viewer
pane's pixel size:

- `runtime.captureCurrent({ size = 2048, hideGrid = true, quality = 0.9 } = {}) → string | null` —
  one offscreen render from the live camera's pose (position, up, and orbit target — not a
  canonical pose) with the live viewport's aspect ratio, `size` px on the long edge
  (clamped into `[256, maxTextureSize]`). Renders with 4× MSAA and the same
  camera-relative capture lighting as `captureViews`, so the result is print-quality even
  from a small window on a 1× display. Returns a `data:image/jpeg;base64,…` string, or
  `null` when the runtime is disposed or nothing is built/visible yet — it never throws.
  `hideGrid: false` keeps the floor grid so the capture matches the on-screen look
  exactly. The live view is untouched: the camera never moves, and lights/grid/render
  target are restored after the render.
- `runtime.captureViews(viewNames) → [{ view, dataUrl }]` — the canonical-angle
  counterpart (fixed poses, framed to the visible assembly, 1024², grid hidden). Sized
  for feeding a vision model, not for display; use `captureCurrent` for showcase images.

**The markup convention (`demo.html` is the canonical copy-me page):** `<body>` carries
`class="pf-shell"`, the flex row that lays the viewer column next to the rail. `#app`
(`class="pf-stage"`) *is* that viewer column, and now contains the floating chrome
(`#topbar`, `#viewbar`, `#busy`) as absolutely-positioned siblings of the canvas, not
page-level overlays. `#panel` (`class="pf-rail"`) is a full-height rail docked to the
right edge, split into three children — `.pf-rail-head` / `.pf-rail-body` /
`.pf-rail-foot` — of which head and foot are flex-fixed and only the body scrolls: put
your heading in the head and the download row in the foot so the export buttons never
scroll out of reach. The rail's drag/collapse seam is created by `rail.js` itself; don't
add markup for it. This isn't decorative — get the head/body/foot split wrong and either
the export buttons scroll away or a tall parameter list pushes them off-screen. See
`docs/superpowers/specs/2026-07-26-controls-rail-layout-design.md` for why the rail is
shaped this way (resize/collapse behavior, breakpoints, the design rationale).

**Keyboard (the seam is `role="separator"`, focusable, `tabIndex=0`):**

| Key | Action |
|---|---|
| ← | widen the rail 16px (64px with Shift). No-op while collapsed. |
| → | narrow the rail 16px (64px with Shift), clamped at the 240px minimum — never collapses. No-op while collapsed. |
| Home | jump to the 240px minimum, animated. Reopens even while collapsed. |
| End | jump to the clamped maximum (half the shell, capped at 560px), animated. Reopens even while collapsed. |
| Enter / Space | toggle collapse — collapses if open; reopens at the remembered width if collapsed. |
| double-click (on the seam) | reset to the 288px default, animated, and opens if collapsed. |

Arrow keys move the **separator**, not the pane — standard `role="separator"`
semantics, and why ← *widens* a right-hand rail. `Cmd`/`Ctrl`/`Alt` held with an
arrow key passes through untouched (those are OS/browser-reserved combos, e.g.
back navigation or window-switching); `Shift` alone still applies the larger
step. Collapsed, the two arrow keys are deliberate no-ops rather than a reopen
gesture — reopening would otherwise silently discard the remembered width and
clamp to the minimum, and "press an arrow, get narrower" reads backwards for a
rail that's already shut. Home/End and Enter/Space/double-click are exempt from
that rule and always reopen, since jumping to an explicit width or toggling is
an unambiguous, deliberate gesture either way. A held arrow-key repeat
suppresses the 150ms width transition for the whole repeat window (not just one
keydown), matching what happens during a drag.

Legacy id-only markup (predating this class scheme) still renders: `app.css` keeps
`:not(.pf-*)` fallbacks (`#app:not(.pf-stage)`, `#panel:not(.pf-rail)`, and
placement-only ones for `#topbar`/`#viewbar`) that reproduce the old floating-card
look — `:not()` rather than a plain id rule because an id selector outranks a class. New
apps should still use the classed markup above; the fallback exists for pages that
predate it, not as a second supported style.

A host that builds its own DOM instead of using `mount`'s markup (e.g. an editor
embedding the viewer/rail inside a larger UI) can adopt the same layout by importing
**`partforge/chrome.css`** directly — it's deliberately class-based and id-free for that
reason. It expects `partforge/tokens.css` to already be loaded for its `--pf-*` custom
properties, and expects the host to size `.pf-shell` itself (`mount`'s own `app.css`,
which `@import`s both, does both of these for you already).

`#cutaway` is optional viewer chrome. When present, it toggles an interactive
section plane whose exposed faces are hatched; changing views resets it. Cutaway
is viewer-only and never changes STL, STEP, or 3MF exports. Hosts that omit the
button get no cutaway UI.

Programmatic hosts can provide the same optional controls, including the rail toggle,
without relying on an ID by passing them beside the other chrome references — and can
pass the rail itself as `elements.rail` instead of relying on `#panel`:

```js
mount(part, {
  createWorker,
  elements: {
    rail,
    chrome: {
      reframe,
      cutaway,
      theme,
      railToggle,
    },
  },
});
```

`rail`/`chrome.railToggle` are both optional; a host with no rail markup gets a
no-op (the resize/collapse behavior below simply doesn't attach). **Constraint:**
the rail element must be a direct child of the positioned `.pf-shell` — the
resize seam is created and positioned against `rail.parentElement` by default,
so an extra wrapper div between them (common in a React layout) puts the seam
against the wrong ancestor and silently breaks `[data-pf-dragging] .pf-stage`.
A host that can't make the rail a direct child of `.pf-shell` must also pass
`elements.shell` pointing at the real positioned ancestor:

```js
mount(part, {
  createWorker,
  elements: { rail, shell, chrome: { railToggle } },
});
```

> Production deploy compiles only the pages listed in `build.rollupOptions.input`
> (currently the landing gallery + the demo part pages). Other root `*.html` files are
> **dev-only** (Vite serves any root HTML in `npm run dev`) unless added there. To also
> ship one, add it to `build.rollupOptions.input` in `vite.config.js`.

**Styling hooks:** the rail/stage layout and palette are both plain `--pf-*` custom
properties from `partforge/tokens.css`, overridable on `:root` (or
`:root[data-theme="light"]`) without touching `chrome.css`. Layout/shape tokens added
alongside the rail: `--pf-sans`, `--pf-rail-w`, `--pf-rail-pad`, `--pf-radius-control`,
`--pf-radius-pill`, `--pf-shadow-float`, `--pf-shadow-rail`. The dev demos self-host
Geist and Geist Mono (`@fontsource-variable/geist(-mono)`, a `devDependency`, imported
from each `app-<part>.js` — see `src/app-demo.js`) so a standalone forge looks like the
finished product; the published library ships no font files, and a consumer that loads
none falls through `--pf-sans`/`--pf-mono` to system stacks by design.

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

## Linting

`partforge lint` statically validates a PartDefinition without booting a geometry
kernel. It runs in milliseconds and catches the authoring mistakes that otherwise
surface only at runtime — or, worse, not at all.

```bash
npx partforge lint src/parts/<part>.js [--params '{"h":40}'] [--json] [--out f] [--strict]
```

Exit 0 when clean, 1 when any **error** finding is present; `--strict` also fails on
warnings. `partforge measure` runs the error tier automatically before booting a
kernel — pass `--no-lint` to skip it.

The same check is available programmatically and in the browser:

```js
import { lintPart } from "partforge/lint";
const { ok, errors, warnings } = lintPart(part, { params });
```

`partforge/lint` has **zero runtime dependencies** and never imports a geometry
kernel or the DOM viewer, so it runs unchanged in Node, a Web Worker, a sandboxed
iframe, and Deno. A worker also answers `{ type: "lint", params }` with
`{ type: "lint-report", report }` without booting its kernel.

**Findings** carry the same guarantees as verify's checks — a self-contained `hint`
on every one, and a stable `pattern` id where an ERROR-PATTERNS.md entry applies:

```js
{ rule: "features-requires-sliders", severity: "error",
  message: "section \"flange\" feature 0 has no `sliders` array",
  hint: "A `features` entry must carry a `sliders` array …",
  path: "parameters[1].features[0]", pattern: "features-missing-sliders" }
```

`path` is a JS accessor path rooted at the PartDefinition — `parameters[1].features[0]`,
`defaults.bore`, `parts.spacer.views[0]`, `parameters[0].presets["M3"].od`. Findings
about the definition as a whole use `""`.

**Severity.** A finding is an `error` when the part is *provably broken* — it cannot
behave as authored — whether or not that shows up as a thrown exception. Some error
findings do correspond to a runtime throw (`build-throws`, `verify-expect-throws`),
but others catch **silent** wrongness: `missing-meta-title`, `part-view-unknown`,
`control-key-not-in-defaults`, `preset-key-not-in-defaults`, and
`verify-unknown-subpart` all fire on parts that build, measure, and verify cleanly —
a dead control that's silently unreachable, a view that renders nothing, or a
`verify` expectation that's silently dropped so its gate never runs. That's still an
error: the part doesn't do what its author wrote, the failure is just quiet instead
of loud. Everything speculative or stylistic — lossy but not broken — is a `warning`
and never blocks anything. Because `measure` runs the error tier as a gate (see
below), a part with one of these silent defects now exits non-zero where it
previously didn't; that's the fix working as intended, not a regression.

### Rule catalog

**Definition shape** — `missing-meta-title`, `missing-defaults`, `no-buildable-parts`,
`missing-views`, `part-view-unknown` (all errors); `view-unused`,
`default-view-ambiguous` (warnings).

**Parameter schema** — `features-requires-sliders`, `features-requires-on`,
`control-key-not-in-defaults`, `preset-key-not-in-defaults` (errors);
`slider-range-excludes-default`, `unknown-control-field`, `duplicate-control-key`,
`default-not-exposed` (warnings).

**Kernel API**, found by executing `build()` against a geometry-free probe —
`unknown-kernel-op`, `unknown-solid-op`, `invalid-op-options`, `build-throws`,
`derive-throws`, `manifold-backend-uses-occt-op`, `build-runaway` (errors);
`nondeterministic-build` (warning, from diffing two probe runs).

**Verify block** — `verify-unknown-metric`, `verify-unknown-subpart`,
`verify-bad-expr`, `verify-bad-pair-check`, `verify-unknown-process`,
`verify-expect-throws` (all errors). Note `_view` also accepts the pair-wise
`contacts` / `clearance` keys, which are not scalar view metrics; they are
validated by `verify-bad-pair-check`, matching `verify.js`'s own handling.

**Animations block** — static validation of `animations`, without executing
`build`: `animations-not-object`, `animation-tracks-or-steps`,
`animation-unknown-param`, `animation-param-not-numeric`,
`animation-keyframes-invalid`, `animation-value-out-of-range`,
`animation-duration-invalid`, `animation-loop-invalid`,
`animation-step-label-duplicate`, `animation-easing-unknown`,
`animation-camera-invalid`, `animation-description-invalid`,
`animation-autoplay-invalid` (all errors). One
more rule does execute `build`, geometry-free: `animation-track-rebuilds` probes
each track's endpoint values and emits a **note** when the animated param feeds
real geometry (or the probe can't be trusted), because such a track plays
best-effort rather than at frame rate. Notes are informational — they never
affect `ok`, `measure`, or `--strict`.

**Place invariants**, found by running the geometry-free pose probe (the same
one animation's `animation-track-rebuilds` uses) against each sub-part's
`place()` — `view-dependent-display-place` (display placement must not depend
on the active view, since display meshes are cached across views) and
`place-not-rigid` (display vs. export placement may differ only by a rigid
motion — translate/rotate — never a reshape) (both errors). An untrusted probe
(a query op or function selector reached during `build`/`place`) proves
nothing either way and stays silent, matching `animation-track-rebuilds`'s own
trust handling.

A rule that itself throws yields an `internal-rule-error` **warning** and the run
continues: `lintPart` never throws and never blocks a part because of a linter bug.

### The diagnostics contract (for agents)

`partforge measure <part> --json` / `--out <file>` emits the machine-readable
report. Every `fail`/`warn` check in `verify.failures` / `verify.warnings`
carries:

- `hint` — one self-contained corrective sentence (always present),
- `pattern` — a stable [ERROR-PATTERNS.md](ERROR-PATTERNS.md) entry ID when one
  applies (follow it with `ERROR-PATTERNS.md#<id>`),
- `note` — an optional caveat about *how* the value was measured, attached
  whatever the verdict. Today only `minWall` sets one, when the reading came
  from a sample rather than every triangle (see below),
- `location` — `[x, y, z]` in mm where the metric has one: `minWall` (thinnest
  sample point) and `overlaps` (the center of the first offending intersection's
  *bounding box* — a nearby indicator, not an exact point: when a pair overlaps in
  more than one place the bbox center can fall in the empty space between regions)
  and the pair checks `contact` / `clearance` / `nearMiss` (the midpoint between
  the pair's closest surface points). Whole-solid metrics (bbox, volume, …) have
  none.

Subpart facts include `minWall` (number or `null` — null exactly when no reading
exists, e.g. the OCCT backend or min-wall measurement turned off, matching
`minWallAt`'s null) and `minWallAt` (`[x,y,z]` or `null`). Min wall casts one ray
per triangle, which is unbounded work on a dense mesh, so past 50,000 triangles
it casts from a spread, deterministic subset instead — `minWallSampled` (boolean)
and `minWallSamples` (`{ sampled, total }` or `null`) say whether that happened.
`sampled` is how many triangles the walk *selected*, not how many rays were
cast: a degenerate (zero-area) triangle has no normal to cast along and is
skipped. A sampled reading is an **upper bound**: it can miss a thin spot, never
invent one — and a sampled run that found no wall at all still reports its
`minWallSamples`, so a null `minWall` there is "we looked and found nothing",
not "nobody looked". Everything in `src/parts/` is far below the budget and
reads exactly. The report's top-level `measuredMinWall` says whether this run
cast min-wall rays at all — the difference between a null `minWall` that means
"no wall found" and one that means "not measured".
Overlap entries are
`{ a, b, volume, location }`. Pair-distance facts are `gaps` (every sub-part
pair: `{ a, b, distance, at }`, distance 0 = touching or overlapping) and
`nearMisses` (the pairs with an unintended-looking gap under 0.5 mm).

A **thrown** error (bad part module, kernel failure) with `--json` prints pure
JSON to stdout and exits 1:

```json
{ "ok": false, "error": { "message": "…", "pattern": "<id>", "hint": "…" } }
```

`pattern`/`hint` appear when the message matches an ERROR-PATTERNS.md symptom
string. Exit codes: 0 pass, 1 gate failure or crash — unchanged. `measure`'s
automatic lint pass (see "Linting" above) now catches most of the defects that
used to surface this way statically, before the kernel boots, so they fail with
pure JSON up front instead. The caveat narrows but doesn't disappear: lint
resolves `verify.expect` once against the part's *defaults*, while `verify()`
itself expands every `verify.cases` entry and re-resolves `expect(p, d)` per
case — so an expectation that only names a bad metric/subpart for a non-default
case (see `test/fixtures/unknown-metric-in-case-part.js`) still passes lint
clean and then throws at runtime, after measure output has printed. That throw
appends crash JSON after the human lines, so stdout is no longer pure JSON;
prefer `--out` (or parse the trailing JSON object — the crash JSON is
pretty-printed across multiple lines) for robust machine parsing. With `--out`
the measure report is written to the file as soon as `measure` succeeds, so
even if a later `verify` throw crashes the run the file is there — it just
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
`surfaceArea`, `triangleCount`, `bbox`, `watertight`, `minWall`, `boundsMin` / `boundsMax`
(the axis-aligned `{min,max}` corner positions — where the geometry sits, vs
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

**Shading intent.** The kernel decides what shades smooth and where edge lines
draw — spheres, cylinders and fillets are smooth by construction; boolean cut
seams always shade hard and draw a line; a loft's facets shade flat when its
rings have fewer than 32 sides (`shading: "smooth"|"faceted"` on `k.loft`
overrides the inference either way). If your part previews smooth but would
print faceted — or the reverse — set the hint rather than changing facet counts.

> Trade-off: OCCT is much slower on heavy swept geometry (helical grooves), so don't reach for
> `fillet`/`chamfer` on a sweep-heavy part — design those edges in, or keep the part on Manifold.

> `partforge measure` reports `watertight`/`holes` as `n/a` for OCCT parts (Manifold-only
> topology); `render` works on both.

### Cost: fillet/chamfer scale with edge count — and order matters

OCCT fillet/chamfer cost is **per selected edge**, on top of the OCCT boolean tax the
routing already imposes on the rest of the part. Two habits keep it tolerable:

- **Fillet/chamfer as early as possible, on the simplest solid.** A fillet on a bare
  primitive is ~15× cheaper than the same fillet after a dozen boolean cuts have
  multiplied the face count — and because the solid cache keys each op by its input's
  content hash, an early fillet is a cache **hit** when a downstream parameter changes,
  while a fillet-last build re-pays the whole op on every slider step of every parameter.
- **Never point a rim selector at a many-point extruded profile.** `edges: {inPlane}` on
  a gear-like extrusion selects *every* polygon edge (hundreds); one chamfer call then
  costs seconds — and if the distance doesn't fit the tooth lands, the failure-rescue
  bisection re-runs it ~8× (`ERROR-PATTERNS.md#chamfer-rescue-bisection`). Use the loft
  bevel below instead.

### Beveling profile rims: extrude's bevel option

For an **extruded profile** (gear, star, bracket outline — any `k.extrude` of a polygon),
a top/bottom rim bevel doesn't need `chamfer` at all — it's built into `extrude`:

```js
k.extrude({ profile: prof, h: 5, bevel: 0.6 });                 // 45° bevel, both rims
k.extrude({ profile: prof, h: 5, bevel: { top: 0.6 } });        // one rim only
```

Same 45° bevel a rim `chamfer` would cut, but it desugars into extrude + loft +
intersect at the shared kernel front, so the part **stays on the fast Manifold
backend** (no CAD-only op for the probe to find) and costs one boolean regardless of
profile point count. Measured on a 24-tooth involute gear: ~0.1 s on Manifold vs
~40 s for the equivalent OCCT `chamfer` (576-edge rim × the rescue bisection).

Every profile form works: point arrays, arc profiles, `{outer, holes}` regions
(hole rims flare outward — the opening is larger at the face, as a chamfer would
cut it), and `Shape2D` (multi-region shapes bevel each region and union). One
fidelity caveat: curved profiles are **materialized to point rings** first — the
loft envelope needs matched points — so a beveled extrusion is faceted at the
sampling LOD even in STEP export. Arc contours sample at a fixed LOD identically
on both backends; a `Shape2D` materializes at its own backend's LOD. If you need
arc-exact STEP walls, that's the one case native `chamfer` still buys you (at
its OCCT cost).

Rules (throws otherwise — `ERROR-PATTERNS.md#extrude-bevel-invalid`): no
`twist`/`scaleTop`, and `bottom + top < h` — clamp from your height parameter, e.g.
`bevel: Math.min(p.chamfer, p.thickness / 2 - 0.2)`. A bevel that would pinch a
narrow feature shut (a gear's tooth land) is deterministically reduced to the
largest offset the rim can take, with a console warning
(`ERROR-PATTERNS.md#extrude-bevel-reduced`).

Under the hood it insets the profile with `offsetPolygon(prof, -c, { corners:
"sharp" })` and intersects with a loft envelope extended past both faces (so the
envelope's own end caps never coincide with the extrusion's faces — coincident caps
leave sliver-triangle shading artifacts). The same construction works by hand when
you need a variant the option doesn't cover. This bevels a **whole rim**; for
selective edges on a solid that's already OCCT-routed, plain `chamfer` with a tight
selector is still the right tool.

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

- Serve your app with **`?pickserver&picktoken=<token>`** (or
  `?pickserver=http://127.0.0.1:4518&picktoken=<token>`) to enable it. While idle
  nothing changes; when the local pick-server requests a click, a banner appears
  ("🤖 Claude needs you to click …") and the picker arms for one click.
- The agent side runs `partforge pick-serve` once — it prints the token and the exact
  URL to open — then `partforge pick "<prompt>" …` for one or more clicks (collected in
  order, returned together). The CLI blocks until the user clicks, then prints the
  `Selection`(s) as JSON.
- **The token is required.** Every route on the pick-server (including the SSE stream)
  is gated by a random per-process token, requests from non-loopback origins are
  refused, and the server never reflects an arbitrary `Origin`. Without that, any site
  the user browsed to while the server was running could read the agent's prompts,
  inject text into the agent's output, or harvest the user's live parameter values.
  A `?pickserver=` pointing anywhere but loopback is ignored with a console warning.
  `partforge pick` finds the token automatically via `~/.partforge/pick-<port>.token`;
  `--token` and `PARTFORGE_PICK_TOKEN` override it.

See the bundled skill `skills/partforge/SKILL.md` for the agent workflow. This is plain
click-routing — no LLM logic lives in partforge.
