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
portable Solid fillet/chamfer API and the OCCT-only shell op.

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
  fonts?,                                  // { name: source } — or (p) => ({ name: source }) when a control drives the typeface
  imports?,                                // { name: source } — STEP/STL/3MF files a part's k.import() needs; same preload timing as fonts (see below)
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
      reference?: string,                  // name of a declared import — measure() computes a deviation fact against it (see below)
    },
  },
  views: { <name>: { label, default?, animations? } },  // view tabs; a view may own animations (below)
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
- `imports` declares the STEP/STL/3MF files a part's `k.import()` calls need, same source
  grammar and preload timing as `fonts` above. See "Importing geometry (STEP/STL/3MF)"
  below for the full contract — backend matrix, units, the `reference` field + the
  deviation gate, and caching.

---

## Animations

A **view** may declare named animations — pure keyframe data that drives
**existing params** over time and fades the view's own sub-parts in and out.
Animations belong to the view that declares them: they live under
`views.<name>.animations`, never at the top level of the part (a top-level
`animations` key is a lint error — `animation-not-in-view` — and is ignored at
runtime: no bar, no crash).

The viewer shows a transport bar (play/scrub, with ‹ › pagers between
animations) **only while the active view declares animations**, listing exactly
that view's set; views without animations render no bar at all. Switching views
resets playback: the running animation stops, its param snapshot is restored,
all opacity overrides are cleared, and the incoming view's transport starts
fresh at its first animation, position 0 — no animation state survives a view
switch. Hosts drive the same engine via `runtime.animation`, scoped to the
active view (call `setView` first to reach another view's animations);
`partforge render` can render stills at any position. The reference part is
`src/parts/hinged-box.js`.

Step labels surface on the scrubber rather than in a readout: hovering or
dragging along the timeline names the chapter under the pointer, and with the
scrubber focused **PageUp / PageDown jump whole chapters** (PageUp forward,
matching the key's native slider direction). Screen readers get the same
information from the scrubber's `aria-valuetext`, which reads
`"<step label> — <percent>"`.

This is the shipped reference part's own block — `views.box` owns all three
animations, and `assemble` opens with a fade rather than a motion:

```js
views: {
  box: {
    label: "Box",
    animations: {
      open: {
        label: "Open lid",
        description: "Swings the lid to **110°** about the rear hinge line.\n\nPose-only: playback runs at frame rate with no geometry rebuild.",
        camera: "front",        // optional: intro angle, cue list, or per-step (below)
        duration: 1.2,          // seconds
        tracks: { lidAngle: [[0, 0], [1, 110]] },   // param -> [t, value] keyframes
      },
      cycle: {
        label: "Open / close",
        duration: 2.4,
        loop: true,             // wraps continuously (single-step only)
        easing: "linear",       // linear | ease-in | ease-out | ease-in-out
        autoplay: true,         // at most one per view
        tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] },
      },
      assemble: {
        label: "Assemble",
        description: "How the parts come together: the lid fades in above the base, drops on, then swings open to check hinge clearance.",
        steps: [                // steps play in order; named on the scrubber as you hover/drag
          { label: "Lid appears", camera: "iso", duration: 0.8,
            opacity: { lid: [[0, 0], [1, 1]] },        // sub-part -> [t, 0..1] keyframes
            tracks: { lidLift: [[0, 40], [1, 40]] } }, // hold the lift while it fades in
          { label: "Lower the lid", camera: "left", duration: 1.0,
            tracks: { lidLift: [[0, 40], [1, 0]] } },
          { label: "Open to check clearance", camera: "iso", duration: 1.0,
            tracks: { lidAngle: [[0, 0], [1, 110]] } },
        ],
      },
    },
  },
},
```

Rules (all lint-enforced):

- Animations are declared under `views.<name>.animations` — one map per view,
  each name unique within its view. Two views may reuse a name; each owns its
  own animation.
- An animation has **either** `tracks`/`opacity` (a single anonymous step)
  **or** `steps`. Never both forms, never neither.
- Tracks reference numeric params from `defaults`. Keyframe `t` is normalized
  per step, strictly ascending from exactly 0 to exactly 1; values must sit
  inside the owning control's min/max (the engine applies them unclamped).
- Params not tracked anywhere keep their current values; a param tracked in
  one step holds its nearest keyframe value while other steps play.
- `opacity` sits beside `tracks` and fades sub-parts instead of moving them.
  It is keyed by **sub-part name**, and the sub-part must belong to the owning
  view (`animation-opacity-unknown-part` otherwise); values run 0 (hidden) to 1
  (normal) and are lint-checked against that range
  (`animation-opacity-range`). Keyframes follow exactly the same rules as param
  tracks — per-step normalized `t`, strictly ascending from 0 to 1 — including
  the hold rule: a sub-part faded in step 3 holds its step-3 opening value
  (0, hidden) through steps 1–2, so "absent until its moment" needs no extra
  declaration. Sub-parts never mentioned render normally.
- Opacity 0 hides the mesh **and its edge lines** entirely — it is absence, not
  a ghost. Values in between multiply any static `display.opacity`: a ghost
  part at `display.opacity: 0.5` faded to 1 shows at 0.5.
- **Opacity is display-only, always** — it never touches params, export,
  `measure`, or `verify`, and Reset restores normal visibility. This is a
  deliberate asymmetry with param `tracks`, where exporting while paused
  exports the posed state (below): a pose is real param state, a fade is not.
  Because it bypasses the param pipeline, a fade runs at frame rate even when
  param tracks force worker-cadence rebuilds.
- Fades compose with the cutaway: a half-faded surface is still sectioned by the
  cut plane, though its hatch cap keeps full-strength opacity for the moment the
  part is mid-fade.
- A step may declare a `camera` and **no** `tracks`/`opacity` — an establishing
  shot that swings the view while the model holds still. At least one step still
  has to carry `tracks` or `opacity`, or the animation animates nothing; a
  **pure-fade** animation, carrying only `opacity`, is perfectly legal. Note the
  holding value is the nearest keyframe, not whatever the user last set: a
  leading camera-only step shows the animation's opening pose, the same one
  `t = 0` would show.
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
- `autoplay: true` (optional, at most one animation **per view**) starts that
  animation on first show and again on each view switch, until the user touches the
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
default to the governing camera cue's angle, and apply opacity at the rendered
`t`, so a faded frame renders faded. `--animation` searches every view: a name
unique across the part implies its owning view and renders there, overriding
the usual first-view default. If two views declare the same name the CLI stops
and asks for the existing positional view argument
(`partforge render <part> <view> --animation shared`) — there is no compound
"view/name" syntax, and `--views` already means camera angles.

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
future breaking contract version removes them (contract v2, partforge 0.59, did
not — it only changed `offset` semantics) — but are not shown here; see
`docs/KERNEL-CONTRACT.md` "Calling convention" for the full canonical/legacy table
and the detection rule.

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
| `k.roundedBox({ size, center?, round })` | box with rounded edges — `round` = number (all edges) or `{ side?, top?, bottom? }` (vertical edges / rims); built as one hand-meshed ring stack (no booleans at all, cheaper than `fillet`'s cutters); `side` must be 0 or ≥ the rim radii (between clamps with a warning); with `side > 0`, `top + bottom` must be strictly `< h` |
| `k.roundedCylinder({ r\|d, h, center?, round })` | cylinder with rounded rims — `round` = number (both) or `{ top?, bottom? }`; `round: r` with `top+bottom = h` gives a sphere (capsule when `h > 2r`); one lathe revolve, curve-exact in STEP |
| `k.torus({ rMajor, rMinor })` | torus centered at the origin (tube centerline in z=0); `0 < rMinor < rMajor` |
| `k.revolve({ profile, degrees? })` | revolve a lathe profile `[[r,z],…]` (r ≥ 0) around the Z axis (full or partial) |
| `k.helixSweptTube({ pathR, profileR, pitch, turns, z0, lefthand })` | circle swept along a helix (e.g. a rope groove). **Not for threads** — the profile is always circular and rides a frenet frame that rolls with the helix, tilting a tooth off-axis. For threads use `k.screwSweep` |
| `k.screwSweep({ profile, pitch, turns, lefthand? })` | screw-motion sweep of an **axial** lathe profile `[[r, z], …]` (same convention as `k.revolve`) — threads, worms, helical ridges. `h = pitch · turns`. The profile's axial extent must not exceed `pitch`; a profile spanning exactly `pitch` must be **periodic** (first radius == last radius) and yields a complete threaded body with no boolean (both backends) |
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

Labels do double duty in the viewer: the hover tooltip names the feature, and
**measurement mode** (the ruler button in the viewbar) measures it — a labeled
hole reads ⌀ + depth, a labeled face reads its extents, and a click pins that
dimension so it tracks parameter changes live. Label the features a user would
want to measure; unlabeled geometry still measures as its bounding box.

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

`src/parts/planter.js`'s "Body" section is a live in-repo example of the full node
shape — a preset, headline sliders, and a nested `"Wall"` group holding a
`recommended` band and an `innerDia` readout. `src/parts/bracket.js`'s "Shape ops"
section shows a `"radio"` control, and mixes it with two sections left on the legacy
shape — proof the two coexist in one part.

`parameters` is an **array of sections**. Each section is a node with a `controls`
array, and **authored order is render order** — what you write top-to-bottom is what
the user reads top-to-bottom:

```js
{
  id: "body",              // optional; also the node id (see "Ids" below)
  title: "Body",
  description: "...",      // CommonMark, behind the section's ⓘ glyph
  collapsed: "auto",       // true | false | "auto" (default)
  when: { ... },           // optional condition — see "Conditions" below
  controls: [ /* entries, in render order */ ],
}
```

Every entry in `controls` is one of four things, told apart by its `type`:

- a **control** — bound to one key in `defaults` (`type` defaults to `"slider"`,
  so a plain `{ key, label, min, max, step }` is a slider);
- **`type: "group"`** — a nested container with its own `controls` array;
- **`type: "preset"`** — a picker that writes a bundle of parameters at once;
- **`type: "readout"`** — a read-only display of a `derive()` output.

Groups nest, but **two levels is the limit** — a section plus one fold inside it is
as deep as a 300 px rail stays readable, and `partforge lint` warns (`group-depth`)
past that. Flatten by promoting the inner group to its own section.

A complete section, exercising most of the model:

```js
defaults: { profile: "round", facets: 6, dia: 80, wall: 2, feet: 0 },
derive: (p) => ({ innerDia: p.dia - 2 * p.wall }),

parameters: [
  {
    id: "body",
    title: "Body",
    description: "Silhouette and size of the vessel.",
    controls: [
      { type: "preset", presets: {
          "Pen cup": { dia: 80,  wall: 2,   profile: "round" },
          Vase:      { dia: 120, wall: 2.4, profile: "faceted", facets: 8 },
      } },

      { key: "profile", type: "radio", label: "Profile",
        options: [{ value: "round", label: "Round" }, { value: "faceted", label: "Faceted" }],
        description: "**Round** revolves the silhouette; **faceted** prisms it." },

      { key: "facets", type: "slider", label: "Facets", min: 3, max: 12, step: 1,
        when: { profile: "faceted" },              // only shown on a faceted profile
        description: "Sides of the prism. 6–8 reads as faceted without looking coarse." },

      { key: "dia", type: "slider", label: "Diameter", unit: "mm", min: 30, max: 150, step: 1,
        description: "Outer diameter at the widest point; 60–100 mm suits a pen cup." },

      { type: "group", title: "Wall", collapsed: "auto", controls: [
        { key: "wall", type: "slider", label: "Thickness", unit: "mm",
          min: 0.8, max: 4, step: 0.1, recommended: [1.2, 4],
          description: "Wall thickness. Under 1.2 mm an FDM print gets fragile." },

        { type: "readout", label: "Inner diameter", derivedKey: "innerDia", unit: "mm",
          description: "Diameter minus both walls — the space something actually has to fit into." },

        { key: "feet", type: "checkbox", label: "Raised feet", on: 3,
          description: "Lift the base on four 3 mm feet so it drains and de-moulds cleanly." },
      ] },
    ],
  },
]
```

Every control `key` must exist in `defaults`, or the control is silently dead —
`control-key-not-in-defaults` is an error for exactly that reason.

**Ids.** A section, a group and a preset may carry an `id`; the renderer keys its
element, state and disclosure maps on ids, so they must be unique across the whole
panel (`duplicate-node-id`). A **control** entry's `id` is ignored — controls get
positional ids — and lint reports it as an unknown field. Leave `id` off unless you
need a stable handle.

### Control types

Every control accepts `key`, `type`, `label`, `description`, `hidden`, `when` and
`whenFalse`. Beyond those:

| `type` | Renders as | Extra fields |
|---|---|---|
| `"slider"` (default) | a range track plus an editable number box | `unit`, `min`, `max`, `step`, and the refinements below |
| `"number"` | the number box alone — for precise or very wide ranges | `unit`, `min`, `max`, `step`, `recommended` (see below) |
| `"text"` | a single-line string field | — |
| `"textarea"` | a multiline string field; line breaks are preserved | — |
| `"checkbox"` | an on/off box: ticked writes `on`, cleared writes `0` | `on` (default `1`) |
| `"select"` | a dropdown | `options` |
| `"radio"` | a segmented button row | `options` |
| `"font"` | a typeface picker, or a URL field with no catalog | `allow`, `preview` |

Numeric controls always show the number box: drag the slider *or* type an exact
value. Typed values may be finer than `step` and clamp to `[min, max]` on commit.
Text fields write `params` on every keystroke, so the rebuild loop previews the new
string immediately; give every text key a string default (empty strings are valid,
and the build decides whether its geometry tolerates one).

**`options`** (select/radio) takes either the shorthand `["round", "faceted"]` —
each entry is both value and label — or the long form
`[{ value, label, description? }]`. Values may be strings or numbers, and
`defaults[key]` **must be one of them** (`select-default-not-in-options`; watch
types, `12` is not `"12"`). An option's `description` surfaces as a hover tooltip
on that one option, not as a ⓘ popover.

**`allow` and `preview`** (font) configure the typeface control. `allow` lists the
source kinds a **param-supplied** value may use — what the picker writes, or what
arrives in a share link:

| value | accepts |
|---|---|
| `"https"` | any `https:` URL. **The default** — omitting `allow` means `["https"]` |
| `"gstatic"` | `https://fonts.gstatic.com` only (hostname-exact: a lookalike host is refused) |
| `"asset"` | a `pfc-asset://` token — a font the host has stored for this part |

Name as many as apply (`allow: ["gstatic", "asset"]`); anything unnamed is refused,
which is how `http:`, `file:`, `data:` and `blob:` are closed off. The check is
deliberately narrow — **it applies only to values that arrive as params.** A source
you write into `fonts` yourself is code, not user input, and stays unrestricted:
`fonts: { label: "https://cdn.example.com/Courier-Prime.ttf" }` keeps working
whatever `allow` says. A refused param falls back to `defaults[key]`, and the build
carries a warning naming the key rather than failing (lint's `font-source-scheme`
catches the case where that default is itself refused). `allow` gates what the
**picker fetches** too: a family whose files it refuses is dropped from the list
rather than offered, and neither that family's name-preview face nor its weight
samples are ever requested.

`preview` is the sample string the picker's weight list renders each face in — set
it when the generic sample shows the wrong glyphs (`preview: "0123456789"` for a
part that letters digits). Defaults to `Hamburgefonstiv 0123`.

**`"readout"` is not a control.** It has no `key`, never writes `params`, and can
never be a preset target. It displays one output of `derive()`, named by
`derivedKey`, refreshed on every parameter change; `unit` is appended to numeric
values. A `derivedKey` no `derive` group returns shows an em-dash forever, which
`readout-unknown-derived-key` warns about. Readouts are how a panel closes the loop
on design intent — show the user the clearance, the inner diameter, the resulting
wall — without adding a parameter nobody should edit.

**A `group`** takes `type`, `id`, `title`, `collapsed`, `bare`, `controls`,
`hidden`, `when` and `whenFalse`. It deliberately takes **no `description`**: the
fold's title is itself a button, and there is nowhere to hang an ⓘ glyph beside it.
Put the explanation on the section or on the controls inside. `bare: true` drops the
title and the disclosure entirely, leaving an indented block — useful for a run of
controls that appear and disappear together under one `when`.

### Control metadata

- `description` — a CommonMark string shown in a click-open **ⓘ** popover beside the
  label. Supports **bold/italic**, lists, `code`, links and images (for diagrams);
  links open in a new tab and the rendered HTML is sanitized. Write one for every
  control — see "A description for every control" below.
- `hidden: true` — omits the node from the panel. Its `key` must still exist in
  `defaults` and still drives the geometry: this is *no UI*, not *no parameter*. Use
  it for internal constants the end user shouldn't edit. A group left with no visible
  children doesn't render at all, and neither does an empty section.

### Slider refinements

Three optional fields shape how a numeric track behaves. All three are worth reaching
for when a raw linear slider misrepresents the parameter.

- **`scale: "log"`** — the thumb travels geometrically, so a 0.1–100 range gives each
  decade equal width instead of burying everything below 10 in the first pixel. The
  number box stays linear and exact, so typing `0.5` still works. `min` **must be
  greater than 0** (`log(0)` is `-Infinity` and the mapping breaks); lint reports
  `log-scale-needs-positive-min`.
- **`ticks: [...]`** — marked values on the track (a native `datalist`). Every tick
  must sit inside `[min, max]`. Add **`snap: true`** to quantize *slider drags* to the
  nearest tick; the number box stays free, so an off-tick value is always still
  typeable. Use it for stock sizes: M3/M4/M5, 3 mm / 6 mm plate.
- **`recommended: [lo, hi]`** — tints that span of the track and puts a warning border
  on the number box when the value sits outside it. This is the **visual companion to
  the DFM checks**: the band is where the process the part targets is comfortable
  (minimum wall, nozzle multiples, sane clearances), and `verify`'s `minWall` /
  process checks are the same judgement enforced at measure time. It is advisory —
  outside values remain selectable, because a user who knows their printer should not
  be blocked by a default profile.

`ticks`, `snap` and `recommended` render on a **linear track only**; combined with
`scale: "log"` they are ignored, and `slider-refinement-invalid` warns. On a
`"number"` control there is no track at all: `recommended` still tints the box on an
out-of-band value, while `scale`, `ticks` and `snap` do nothing.

### Conditions: `when` and `whenFalse`

`when` is valid on **any** node — a control, a group, a preset, a readout, or a
section itself. It is a plain data condition evaluated against raw parameters:

```js
when: { profile: "faceted" }                            // equality
when: { wall: { gte: 1.2 } }                            // gt | gte | lt | lte | ne
when: { style: { in: ["cup", "vase"] } }                // membership
when: { drain: { gt: 0 }, mode: "planter" }             // multiple keys are ANDed
when: { allOf: [{ drain: { gt: 0 } }, { mode: "planter" }] }
when: { anyOf: [{ style: "cup" }, { style: "vase" }] }
when: { not: { style: "plain" } }
```

The operators are `gt`, `gte`, `lt`, `lte`, `ne` and `in`; the combinators are
`allOf`, `anyOf` and `not`. Two rules make conditions statically checkable, and both
are enforced as **errors** because either failure is silent at runtime:

- **Raw parameter keys only.** A `when` reads keys from `defaults`, never derived
  values — that is what lets lint check every referenced key against `defaults`
  (`when-key-not-in-defaults`), which no predicate function could support. Readouts
  reach derived values through their own `derivedKey`, so there is never any doubt
  which namespace a name is in.
- **Known operators only.** `evalWhen` treats an unrecognised operator as false, so a
  typo would hide the node forever; `when-unknown-operator` catches it first.

A malformed condition evaluates to `false` rather than throwing — a control that
hides is better than a panel that crashes.

When the condition is false the node is **removed from the layout**, taking its
subtree with it if it is a group. Set **`whenFalse: "disable"`** to grey it in place
instead, for the case where the user should see that an option exists but needs
something else switched on first. Disabling propagates through the whole subtree and
sets real `disabled` attributes, so a disabled control cannot be focused or dragged.

**`when` is not relevance dimming.** The panel also dims controls automatically, and
the two are different mechanisms that must stay visually distinct:

| | Relevance dimming | `when` |
|---|---|---|
| Answers | "does the geometry on screen actually read this parameter?" | "did the author say this applies right now?" |
| Comes from | probing the build — automatic, nothing to write | your `when` condition |
| Looks like | faded but fully usable, with a "doesn't affect the parts in the current view" tooltip | gone from the layout, or genuinely disabled |

A control can be relevant but conditioned away, or conditioned in but irrelevant.
Both recompute on the same tick as any parameter change. Don't reach for `when` to
reproduce dimming — you'd be hand-maintaining something the framework already knows.

### Collapsing

Every section and every titled group is a disclosure, controlled by `collapsed`:
`true` (start closed), `false` (start open), or `"auto"` (the default). `"auto"`
defers to one rule:

> A panel with **three or fewer visible top-level sections** opens every `"auto"`
> section and fold on load. Beyond that, they all start closed.

The rail is a fixed-height column, and a long part otherwise scrolls forever; three
sections is a panel the user can take in at a glance. The count is over the sections
in the built tree — `hidden: true` sections and sections left with nothing in them are
gone before counting, but a section that a false `when` or relevance merely hides from
view still counts, since it can come back without rebuilding the panel.
Only the **first** render applies it — after that the user's own clicks own the folds,
and a slider drag never snaps a section they opened back shut. A `bare: true` group
has no disclosure at all and is never collapsed.

### Presets

A preset picker is a node like any other:

```js
{ type: "preset", label: "Size", presets: {
    M3: { od: 8,  bore: 3.4, h: 10 },
    M5: { od: 12, bore: 5.4, h: 16 },
} }
```

Each key of `presets` is a name, each value a bundle of parameter overrides (every
key of which must exist in `defaults` — `preset-key-not-in-defaults`). The picker
lists the names plus **Custom**, and opens on the first name. Choosing a preset
assigns its overrides over `params` and refreshes that section's controls; editing
any control in the section afterwards drops the picker to **Custom**.

Because it is a node, a picker can sit **anywhere** in `controls` — among the
controls it affects, not necessarily at the top — and a section may carry more than
one. Note that Custom-marking tracks the section's **first** picker only, so if two
pickers in one section both need to show divergence, give each its own section.

**Preset names are global to the part**, not to the section: `verify()` expands one
case per preset name (so every preset gets measured), and a repeated name throws
there. `duplicate-preset-name` catches it at lint time instead.

### Legacy section shapes (still supported)

Everything above is what a **new part should write**. The original array-based shapes
predate the node model, still work exactly as they always did, and are not going
away — most of the in-repo parts are deliberately left on them as live proof.
`desugar()` normalizes them into the very same nodes, so the **runtime** is uniform:
one renderer, one state pass, one set of lint walkers, whichever shape you wrote.

The **authorable surface is not** uniform, and deliberately so — the legacy
descriptors are frozen at the fields they always had. `when`, `whenFalse` and
`collapsed`, and the `"checkbox"`, `"select"`, `"radio"` and `"readout"` types, exist
in the `controls` shape **only**. Written on a legacy descriptor they are dropped and
reported as `unknown-control-field`; a legacy section's `collapsed` is ignored
silently. Reach for any of them and you are writing a `controls` section.

| Legacy | Normalizes to |
|---|---|
| `presets: {...}` | a `{ type: "preset" }` node, first child of the section |
| `toggles: [{ key, label, on }]` | `"checkbox"` controls placed directly in the section, after the picker and before the Advanced fold |
| `advanced: [...]` | a nested group titled **Advanced**, `collapsed: "auto"` |
| `features: [{ key, on, sliders }]` | per feature: a `"checkbox"`, followed by a `bare` group of its sliders carrying `when: { [key]: { gt: 0 } }` — both inside the Advanced group |
| `control: "number"` | `type: "number"` |
| `hidden: true` | kept through desugaring (lint needs it), dropped when the render tree is built |

**Preset + controls section** — a picker, standalone toggles, and an Advanced fold:

```js
{
  id: "body",
  title: "Body",
  presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } },
  toggles: [
    { key: "clip", label: "Clip arms to a disc (intersect)", on: 1,
      description: "**Intersect** the cross with a circle so the arm tips round off." },
  ],
  advanced: [                                  // controls revealed under "Advanced"
    { key: "od",   label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 },
    { key: "bore", label: "Bore", unit: "mm", min: 1, max: 30, step: 0.1, control: "number" },
    { key: "title", label: "Title", control: "text" },
  ],
}
```

`control` is the legacy spelling of `type` and takes `"slider"` (the default),
`"number"`, `"text"` or `"textarea"` — the newer `"checkbox"`, `"select"`, `"radio"`
and `"readout"` types exist only in the `controls` shape. A `toggles` entry is
`{ key, label, on?, hidden?, description? }`: checked writes `on` (default `1`),
unchecked writes `0`. It is the right home for a bare boolean in this shape —
`src/parts/hull-sweep.js`'s `wrap` toggle is the in-repo example.

**Feature-toggle section** — a checkbox that enables a feature *and* reveals its own
sliders (`0` = off):

```js
{
  id: "flange",
  title: "Flange",
  features: [
    { label: "Base flange", key: "flange_d", on: 16,
      sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1 }] },
  ],
}
```

A feature's `on` is **required and must be greater than 0** — it is the real value the
parameter takes when the box is ticked (a diameter, a count), and the panel reads
`> 0` as "enabled", so there is nothing sensible to fall back to
(`features-requires-on`). `sliders` is required too (`features-requires-sliders`) — it
is what the checkbox reveals, and a feature with nothing to reveal belongs in
`toggles` instead. A section carrying `features` renders *only* its features — its
`presets`, `toggles` and `advanced` are ignored. `src/parts/demo.js`'s `flange` is the
in-repo example (`planter.js` has a second one).

Three behaviours differ between the shapes, and they are frozen that way on purpose:

- A legacy **feature** checkbox restores the magnitude the user had dialled in when
  re-ticked; an authored `"checkbox"` always writes `on`. The node-model way to get a
  feature is a checkbox plus a group gated on `when: { key: { gt: 0 } }` — which is
  exactly what `features` desugars to.
- **Every** control in a `controls` section marks the section's picker Custom when
  edited. In the legacy shapes, feature sliders and toggles do not.
- Collapse state is not authorable here, per the surface note above: a legacy section
  and the "Advanced" fold it desugars to are both always `"auto"`, so they follow the
  three-section rule and nothing else.

**A section is one shape or the other.** Mixing `controls` with `advanced`,
`toggles`, `features` or `presets` is the error `mixed-section-shape` — the render
order of the mixture would be arbitrary. (`controls` wins if you do it anyway.) A
single *part* may mix freely, one shape per section, so migration can go section by
section.

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
2. A **few primary controls** for the dimensions users change most, sitting loose in
   the section.
3. **A nested group** (`{ type: "group", title: "...", collapsed: "auto" }`) for the
   rest — one per idea, titled for what it is (`Wall`, `Lid`, `Mounting`), not
   "Advanced". Two levels is the ceiling.
4. **`hidden: true`** for internal constants the end user shouldn't edit.

Keep a section to **12 visible controls or fewer** — past that `section-too-many-controls`
warns, because more than a dozen in one column reads as a wall rather than a set of
choices. If a section is over budget, the fix is almost always that two ideas are
sharing it: split the section, or hide internals (`hidden: true`) — grouping
organizes but does not reduce the count.

Aim for a panel whose first screen is a handful of controls, and whose full design is
one click away in a fold.

### Choosing a control

The type carries meaning, so pick the one that matches the parameter rather than
defaulting everything to a slider:

- **A continuous dimension** → `"slider"`. Add `recommended` when there's a
  manufacturable band, `ticks` + `snap` when real-world stock sizes exist, and
  `scale: "log"` when the range spans decades.
- **A precise or very wide number** (a count, a tolerance, a coordinate) →
  `"number"`, so the user types rather than hunts.
- **A discrete choice** → `"select"` when the values are a list, or `"radio"` when
  there are **2–4** of them and seeing all the options at once is part of the
  decision. Never fake either one with a slider over magic integers.
- **A boolean** → `"checkbox"`. Ticked writes `on`, cleared writes `0`; there is no
  reason for a two-position slider to exist.
- **A computed value the user should see but not set** → `"readout"`. It costs no
  parameter and answers the "so what did that do?" question in place.

Then gate what doesn't always apply. A control that is meaningless in the current mode
should carry a **`when`** rather than sit there inert — hide it by default, or use
`whenFalse: "disable"` when its existence is itself the information ("Lid hinge:
enable a lid first"). Conditions are also the cheapest way to keep a section under
budget: three mode-specific controls that are never all relevant at once cost the
reader one.

Finally, **every control gets a `description`** — see below.

### Ordering and naming

Authored order is render order, so spend it deliberately: put the control a user
reaches for first at the **top** — usually the primary dimension the presets don't
settle — and order the rest by how a user thinks about the part, not by the order
the build consumes them. A user scans the rail top-to-bottom once; the control they
need should sit where that scan expects it, with fine-tuning below it and
housekeeping last.

Labels are for reading, not for the build: a short noun phrase (**"Wall
thickness"**, **"Bolt hole ø"**), with units in `unit:` rather than in the label
text, and never a parameter key or build-internal jargon — `flange_d` is a key,
"Flange diameter" is a label. Every label must make sense on its own with its
neighbours folded away; if a label only reads correctly next to another control
("Diameter" … "Diameter" in two groups), rename until each stands alone or regroup
until they are one idea.

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

This is a separate mechanism from `when`, and stays visually distinct from it on
purpose — see "Conditions: `when` and `whenFalse`" above for the split.

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

**Helical & threaded features** (screws, threads, bolts, worms, helical ridges):

Use `k.screwSweep({ profile, pitch, turns })`. The profile is an **axial**
`[[r, z]]` contour — the shape you would see slicing the thread down its axis —
exactly `k.revolve`'s convention, with an axial rise added.

The strongly preferred form is **periodic**: span exactly one `pitch`, start and
end at the same radius. That makes the cross-section enclose the axis, so one op
gives you the whole threaded body — no union with a core cylinder, which is both
faster and avoids a boolean the B-rep backend handles badly
([screw-thread-vanishes-on-occt](ERROR-PATTERNS.md#screw-thread-vanishes-on-occt)).

```js
// an ISO-ish M10x1.5 external thread: 60° flanks, crest flat P/8, root flat P/4
const pitch = 1.5, majorR = 5;
const rootR = majorR - (5 / 8) * (Math.sqrt(3) / 2) * pitch;
const crest = pitch / 8, root = pitch / 4;
const rise = (pitch - crest - root) / 2;
const rod = k.screwSweep({
  profile: [
    [rootR,  0],
    [rootR,  root],                    // root flat
    [majorR, root + rise],             // up the flank
    [majorR, root + rise + crest],     // crest flat
    [rootR,  pitch],                   // down the flank, back to the start radius
  ],
  pitch, turns: 6,
});
```

The ends are flat z-planes, which is what a threaded rod wants; intersect a cone
for a lead-in chamfer. For a bolt, build the head as its own solid — that is what
**`src/parts/screw.js`** does, the worked example for this recipe: an ISO-style
metric bolt, periodic thread plus a hex head, presets and all.

Cost scales with `turns` (= `length / pitch`), and steeply: the section is
resampled every 5° of the twist, so an M10×1.5 shank costs ~10.5k triangles per
turn. A 30 mm shank is 20 turns and about half a second on Manifold; hundreds of
turns is millions of triangles and minutes behind the STEP button. Bound the
`length` and `pitch` your schema exposes accordingly.

The hand-rolled equivalent, for the record: `screwSweep` is
`k.extrude({ profile, h, twist })` with the axial profile remapped to polar
(`ψ = −360·z/pitch`) and `twist = 360 · turns` — one full turn of twist per pitch
of height *is* screw motion. The op exists because that identity is easy to
want and hard to find, and because the remap must be densified (see
`geometry/screw-profile.js`) or the chords between profile points cut deep into
the tooth.

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

`Shape2D.offset(delta, { corners: "round" | "chamfer" | "sharp" })` grows (`delta>0`) or insets (`delta<0`) a shape. It runs backend-independently on the shared contour engine — lines and arcs offset exactly (arcs stay arcs), so results are backend-identical by construction, like every other `Shape2D` op; it throws if the offset collapses the shape. A region with holes offsets material-wise: the outer grows/shrinks by `delta`, holes by `-delta`, so a positive `delta` always adds material. (For `derive()`/main-thread clearance math on plain point lists, use the pure `offsetPolygon` helper instead.)

## Editing profiles

Once a profile exists — imported SVG, `pathProfile`, or the result of a boolean — the
**2-D editing ops** let you reshape it with named operations instead of hand-editing
control points: round or bevel a corner, nudge/rotate/mirror it, measure it, simplify
it, or validate it. This is deliberately the same vocabulary an LLM agent calls: pick a
corner, name a radius, get back a profile — never coordinate math. Every op is
available two ways — as a `Shape2D` method (`plate.fillet(2)`) and as a free function
over plain contour data (`filletProfile(outline, 2)`) — both run the same
`contour-ops.js`/paper.js machinery.

**Polymorphic input contract.** Every op below accepts a point list, a `{start,
segments}` contour, a `{outer, holes}` region, or a region array, and returns the
**same shape it was given** — a bare point list stays a point list, upgrading to a
`{start, segments}` contour only if the op introduces curves (e.g. a fillet, or a
non-uniform scale on an arc). The exception is the three arc-length queries
(`profileLength`, `profilePointAt`, `profileTangentAt`): they are single-contour by
nature, so passing a region throws, naming the accessor to use —
`profilePointAt: pass a single contour (use region.outer / region.holes[i])`.

**Transforms** — exact on every segment type (line, arc, cubic); mirror and
non-uniform scale re-normalize winding (outer CCW, holes CW) afterward, so no op can
hand the kernel an inverted region:

| Function | Notes |
|---|---|
| `translateProfile(input, [dx,dy])` | exact on all segment types |
| `rotateProfile(input, deg, center = [0,0])` | arcs stay arcs |
| `scaleProfile(input, s \| [sx,sy], center = [0,0])` | non-uniform scale converts `{to,via}` arcs to cubics (an ellipse is not a circular arc) |
| `mirrorProfile(input, axis)` | `axis: "x" \| "y" \| {point:[x,y], dir:[dx,dy]}` |

**Corners** — fillet inserts a true `{to,via}` arc (a real STEP `CIRCLE` on OCCT);
chamfer sets back `dist` along each adjacent segment and connects with a straight
`{to}`. Both throw, precisely, when a radius/distance doesn't fit — naming the corner,
its coordinates, and the max that would work — rather than silently clamping:

| Function | Notes |
|---|---|
| `filletProfile(input, r, opts?)` | `r`: number, or an array matched positionally with `opts.corners.indices` |
| `chamferProfile(input, dist, opts?)` | symmetric setback, straight connector |
| `profileCorners(input)` | `[{index, point, interiorAngleDeg, convex, segTypes}]` |

`opts.corners` selects which corners an op touches (default `"all"`):

- `"all"` · `"convex"` · `"concave"`
- `{indices: [...]}` — positions into `profileCorners(input)`'s own return order; pair
  with an array `r`/`dist` for per-corner radii (the `roundedProfile` pattern)
- `{near: [x,y], count?: 1}` — nearest-corner selection; the hook for a human pick or
  an agent resolving "the top-left corner" from bbox reasoning

```js
// Fillet only the two corners nearest the profile's top edge, 3mm and 1.5mm:
const corners = profileCorners(outline);
const top = corners.filter((c) => c.point[1] > 20).map((c) => c.index);
const rounded = filletProfile(outline, [3, 1.5], { corners: { indices: top } });

// Fillet every convex corner of a Shape2D by the same amount:
plate = plate.fillet(p.cornerR, { corners: "convex" });
```

**Queries, cleanup and validation:**

| Function | Notes |
|---|---|
| `profileLength(contour)` | mm; single contour only |
| `profilePointAt(contour, {t} \| {length})` | `t` ∈ [0,1] normalized arc length; single contour only |
| `profileTangentAt(contour, {t} \| {length})` | unit vector; single contour only |
| `profileNearestPoint(input, [x,y])` | `{point, distance, contourIndex, segmentIndex, t}` — accepts regions; the pick-resolution primitive |
| `profileBounds(input)` | curve-exact `{min, max}` |
| `profileArea(input)` | outers − holes, curve-exact |
| `profileContains(input, [x,y])` | curve-aware containment (inside an outer, not inside a hole) |
| `simplifyProfile(input, tolerance)` | corner-preserving: splits at corners, refits each smooth run within `tolerance` mm, rejoins — corners survive exactly, arcs entering it return as cubics |
| `validateProfile(input)` | `{ok, issues: [{type, contourIndex, segmentIndex?, point?, message}]}`; never throws — `type` is `self-intersection`, `winding`, `nesting`, or `degenerate` |

Three rules worth internalizing before reaching for any of this:

- **Fillet after booleans if STEP `CIRCLE` fidelity matters.** Booleans run through
  paper.js, which is cubic-only — an arc entering a boolean returns as a cubic
  approximation (relative error ~1e-6). `union`/`cut` first, `fillet` last keeps the
  rounded corners true circular arcs all the way to STEP export.
- **A radius that doesn't fit is CLAMPED, not refused.** `fillet`/`chamfer` reduce any
  corner whose magnitude its edges cannot hold down to the largest that they can, and
  report each clamp on the build's warnings — so a slider that used to kill the part at
  r=3.1 now rounds at whatever fits. Two ceilings apply: the corner's own edges, and
  the edge it shares with a neighbouring selected corner (both back off together there).
  It still throws when there is no feasible magnitude at all. **If an exact radius is
  functionally required** — a bearing seat, a mating fit — do not trust the request:
  clamp it yourself from the geometry that limits it, or assert it in `verify`.
- **Run `validateProfile` after mutations.** `fillet`/`chamfer` check only their own
  corner's local fit — not whether the result self-intersects globally (a large radius
  on a narrow profile can produce arcs that cross the far side). `validateProfile`
  never throws, so it's cheap to call after any edit and inspect `issues` before
  committing to the result.
- **Guard vanishing features with `isEmpty()`.** A boolean chain can legitimately
  produce an *empty* shape (an `intersect` of shapes a parameter drove apart, a `cut`
  that removed everything). The empty shape is a fine 2-D value — further booleans,
  transforms and `offset` all work — but `extrude`/`revolve` throw on it, identically
  on both backends. If a parameter can drive a feature to nothing, write the guard
  explicitly: `if (!pocket.isEmpty()) body = body.cut(pocket.extrude({ h }))`.
  (Symptom-keyed: `ERROR-PATTERNS.md#extrude-empty-shape2d`.)

A practical trap with the broad selectors: `"all"`/`"convex"`/`"concave"` match **every**
matching corner, including ones you didn't mean to touch. Union a curve-native outline
with a *tessellated* point-list shape (e.g. `circleProfile`, still a faceted polygon —
see "Profiles & patterns") and every one of that polygon's facet vertices becomes its
own small convex corner in the result; a `corners: "convex"` fillet then tries to round
all of them, including the tiny ones whose neighboring facet is too short to hold any
useful radius. `profileCorners(input)` reports each corner's `interiorAngleDeg`, which
cleanly tells a facet artifact (close to 180°, barely bent) from a real corner (well
away from 180°) — filter on that, or pass a coarser `segs` to the tessellated shape
before unioning, rather than fighting the selector after the fact.

**`Shape2D` methods.** Existing: `union`, `cut`, `cutAll`, `intersect`, `offset`,
`area`, `boundingBox`, `toRegions`, `simple`, `regions`, `clone`, `extrude`, `revolve`.
New, all delegating to the pure functions above over the shape's stored contours:
`translate([dx,dy])`, `rotate(deg, center?)`, `scale(s | [sx,sy], center?)`,
`mirror(axis)`, `toContours()` (the stored contour IR, deep-copied — the one readback
that tessellates nothing, unlike `toRegions()`), `fillet(r, opts?)`, `chamfer(dist,
opts?)`, `simplify(tolerance)`, `corners()`, `contains([x,y])`, `isEmpty()` (no
regions left — see the vanishing-features rule above).

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

**Making the typeface a parameter.** Give `fonts` a function of params instead of a
static object, and a `type: "font"` control can drive which face `text2d` uses —
`src/parts/nameplate.js` is the reference:

```js
{ key: "face", type: "font", label: "Typeface" },   // in `parameters`
fonts: (p) => (p.face ? { face: p.face } : {}),     // a function, not a static map
k.text2d(p.label, { font: "face" }),                // only when p.face is set
```

An empty `face` declares nothing — `fonts` returns `{}`, and `text2d` falls back to
the bundled Roboto — so the part still builds with no network access. A part with a
fixed typeface needs none of this: a plain `{ name: source }` object is fine.

The control's `allow` list bounds what a picked — or share-link-supplied — value may
be, and defaults to `["https"]`; see the control-types table above. It does **not**
constrain sources you declare yourself.

**Build-time & curve semantics:**

`text2d` is a **build-time operation** (not `derive()`), and **the curve representation differs by backend:**

- **OCCT (B-rep):** text outlines carry **exact cubic Bézier curves** into STEP export (not tessellated)
- **Manifold (mesh):** text outlines **facet at the mesh level-of-detail** (same as other curves in preview)

Both backends produce watertight emboss/deboss geometry; the difference is export fidelity. As with any `Shape2D`, composition with booleans and offset is backend-agnostic — the same code works on both.

**Overlapping / self-intersecting glyph outlines:** real font outlines aren't always simple, correctly-nested contours — counters can overlap or self-intersect. Before glyphs become curve regions, the framework resolves each glyph's raw contours with the nonzero winding rule (how all OpenType outlines — TrueType and CFF alike — are filled), so composite/overlapping outlines still produce a single correct `{outer, holes}` shape per glyph. This resolution stays curve-exact — it never flattens beziers to polygons — so the OCCT/Manifold split above still holds.

---

## Importing geometry (STEP/STL/3MF)

`k.import(name)` returns a previously-registered imported file as an ordinary `Solid` — the same handle a `k.box()` or `k.loft()` call would give you. It exists for two uses: a **reference** the agent workflow measures and rebuilds a parametric part around (with a verify-time deviation gate holding the rebuild to it), or a **component** — a real body that participates in booleans, scaling, and export like any other solid. `src/parts/import-demo.js` is the worked example for both; read it alongside this section.

**Declaring imports (the `imports` PartDefinition field):**

Exactly the `fonts` grammar, one level up in the contract — a map of names to sources:

```js
imports: {
  scan: new URL("./assets/import-demo-scan.stl", import.meta.url), // Vite serves it; Node reads disk
  lid:  "https://…/signed-url.step",                               // URL string
  chip: bytesOrThunk,                                               // ArrayBuffer/Uint8Array, or a (possibly async) thunk returning one
},
```

The framework resolves these — fetch/read bytes, detect the format (filename extension when the source has one; a magic-bytes sniff otherwise — the `ISO-10303-21` STEP header, a `PK` zip signature for 3MF, else STL), and content-hash them — before the synchronous `build` runs, registering the parsed result on the kernel through an underscore-prefixed side-channel (see `docs/KERNEL-CONTRACT.md` § "Conformance classes"). Reference an import by name: `k.import("scan")`. An undeclared name throws (mirrors `text2d`'s unknown-font error) — see [ERROR-PATTERNS.md#import-unknown-name](ERROR-PATTERNS.md#import-unknown-name).

**Backend matrix:**

- **STEP on OCCT** — native: `replicad.importSTEP` builds a real B-rep, exact into STEP export.
- **STEP on Manifold** — tessellated transparently: the framework routes an OCCT-worker tessellation pass behind the scenes (the "crossover" — see caching, below) and hands Manifold the resulting triangle mesh. Exactness is lost on this path; the STEP curves become facets at print quality, same as any other mesh geometry.
- **STL/3MF on Manifold** — native: parsed, repaired (vertex merge + winding/orientation fix), and handed to `Manifold.ofMesh`. A mesh still non-manifold after repair throws loudly with the open-edge count — see [ERROR-PATTERNS.md#import-mesh-not-solid](ERROR-PATTERNS.md#import-mesh-not-solid).
- **STL/3MF on OCCT** — never attempted: mesh-to-B-rep conversion isn't in scope for v1. Declaring a mesh import on a part (or sub-part, under per-sub-part routing) that routes to OCCT is an error — see [ERROR-PATTERNS.md#import-mesh-on-occt](ERROR-PATTERNS.md#import-mesh-on-occt).

`import` is not in `OCCT_ONLY_OPS` — a STEP import does not by itself force OCCT routing (the crossover exists precisely so it doesn't have to); backend selection is still driven by `fillet`/`chamfer`/`shell` on a `Solid`, or `meta.backend`.

**Units:** everything normalizes to millimetres at parse time — STEP units are honored by the OCCT importer, a 3MF file's `unit` attribute is converted, and **STL is assumed to already be in millimetres** (the format carries no unit metadata).

**Registration is total; errors are lazy.** Every declared import registers on whichever kernel runs a job, regardless of whether that kernel can actually use it — this is what keeps a mixed-format part (an OCCT sub-part and a Manifold sub-part with different import formats) from having one format's registration break the other's job. A format the running kernel can't use registers as an **error entry** instead of throwing at registration; the error throws from `k.import(name)` itself, at the point in a `build` that actually calls it. Two cases surface this way:

- **mesh import on OCCT** — throws immediately, every time (see the backend matrix above).
- **unprimed STEP import on Manifold** — throws once, then self-heals: the framework's crossover machinery notices, arranges the OCCT-side tessellation (a `tessellate-imports` worker job in the browser, a `node:worker_threads` hop in the CLI/tests, since the two WASM kernels may never share a process), and retries the build. A build whose params never actually reach a `k.import()` call on that STEP file never triggers the crossover at all — the cost is paid only when the import is really used. If the crossover itself fails to produce a usable mesh, that surfaces as [ERROR-PATTERNS.md#import-step-tessellation-failed](ERROR-PATTERNS.md#import-step-tessellation-failed).

**Caching & content-stability:** import sources are **content-stable for a session** — the same rule as `fonts`. Bytes are memoized process-wide by source identity (not by digest) the first time a source resolves, and stay resident for the life of that worker/process: the raw bytes in the resolver's cache, and the parsed master (a Manifold mesh or an OCCT B-rep shape) in the kernel that parsed it. A multi-megabyte STEP or STL file is read and parsed once, not on every slider drag or view switch — but it also means a changed file on disk needs a fresh worker/process to be picked up (a rebind/remount, same as changing a font). Downstream, every op built from an import folds the file's content digest into its cache key (`h("import", name, digest)`), so an actually-changed file (a new digest) still invalidates every dependent cache node correctly. On the STEP-on-Manifold crossover, note that the file is fetched **independently by both workers** — the Manifold worker resolves it to get a digest, and the OCCT worker resolves it again to tessellate — so a large STEP file used this way is held in memory twice, once per worker.

**Performance:** a `reference` deviation check (below) costs one solid boolean per verify run. On a Manifold-routed part that's cheap; on an **OCCT-routed** part it's a full OpenCASCADE boolean against the entire imported B-rep, and `docs/geometry-backend-strategy.md` measures OCCT booleans at 75–1486× slower than the equivalent Manifold operation. A `reference`-bound sub-part on OCCT is a deliberate trade — exactness for STEP export vs. a slower `measure`/`verify` loop — worth knowing about before wiring one up on a large imported assembly.

**The `reference` field and the deviation gate:**

A sub-part can bind itself to an import by name; `measure()` then computes a `deviation` fact against it (symmetric-difference volume, volume delta %, and per-axis bbox-corner drift), which three `ref*` metrics in `verify.expect` can gate on — the same `SUBPART_METRICS` registry `holes`/`volume`/`bbox` live in, so they take the same assertion DSL:

```js
parts: {
  body: {
    reference: "scan",   // an import name — measure() computes s.deviation against it
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.scanW, p.scanD, p.scanH] }),
  },
},
verify: {
  expect: {
    body: {
      refXorVolume: "<=5mm3",          // symmetric-difference volume — the real match check
      refVolumeDeltaPct: "<=1",        // cheap sanity gate, % of the reference's volume
      refBboxDelta: "<=[0.2,0.2,0.2]", // mm, per-axis max of |min|/|max| corner deltas
    },
  },
},
```

Deviation is measured in build coordinates on the posed display solid — aligning the rebuild to the reference is the part author's job, and the ghost overlay (next) is how you check it by eye. A sub-part with no `reference` gets `deviation: null` and skips any `ref*` assertion rather than failing it; `npx partforge lint` catches the inverse mistake — a `ref*` assertion on a sub-part that declares no `reference` — statically, as `ref-metric-without-reference` (see "Linting" → Rule catalog → "Geometry imports", below).

**The two-view ghost pattern:** `measure()`'s `ok` gate is **view-scoped and overlap-strict** — it requires zero sub-part overlaps among whatever the *current* view shows. A translucent ghost of the raw import, shown in the same view as its parametric rebuild, is by construction coincident with that rebuild — so that view's `overlaps` would always read greater than zero, failing `verify` on a part that is otherwise exactly correct. The fix is not a bigger overlap tolerance; it's two views:

```js
parts: {
  // Ghost overlay: only in "reference" — never coincides with body in "assembly".
  ref: {
    label: "Reference (ghost)",
    views: ["reference"],
    exportable: false,
    display: { opacity: 0.3 },
    build: (k) => k.import("scan"),
  },
  // The parametric rebuild — shown alone in "assembly", and against the ghost
  // in "reference" for visual alignment checking.
  body: {
    label: "Rebuild",
    views: ["assembly", "reference"],
    reference: "scan",
    build: (k, p) => k.box({ min: [0, 0, 0], max: [p.scanW, p.scanD, p.scanH] }),
  },
},
views: { assembly: { label: "Assembly" }, reference: { label: "Reference overlay" } },
verify: {
  expect: {
    body: { refXorVolume: "<=5mm3", /* … */ },
    _view: { overlaps: 0 },   // checked against the DEFAULT ("assembly") view only
  },
},
```

`assembly` is listed first so `measure`/`verify`/`render` — which all default to the **first** view key, `default: true` notwithstanding — see only the real, non-overlapping parts. `reference` is the ghost-overlay view: browse it by hand in the viewer, or pass it explicitly to `measure`/`render`, to eyeball how closely the rebuild tracks the scan. Declare `ref` `exportable: false` (it's not a real part of the design) and give it a `display.opacity` well under 1 so it reads as an overlay rather than an opaque duplicate. This is exactly `src/parts/import-demo.js`'s shape — read its `parts.ref`/`parts.body`/`views`/`verify` blocks for the fully worked, commented version.

**Using an import as a real component** — the other use, no ghost involved — is an ordinary boolean, chainable like any `Solid`: `import-demo.js`'s `mount` sub-part cuts a through-socket shaped to the scan itself (scaled up slightly for clearance) out of a plate:

```js
build: (k, p, d) => {
  const plate = k.box({
    min: [d.mountOffsetX - p.margin, -p.margin, -p.plateH],
    max: [d.mountOffsetX + p.scanW * p.fit + p.margin, p.scanD * p.fit + p.margin, 0],
  });
  const socket = k.import("scan")
    .scale(p.fit)
    .translate([d.mountOffsetX, 0, -p.plateH - 1]); // overcut past both plate faces
  return plate.cut(socket);
},
```

**Linting:** `npx partforge lint` learns `import` as a known op and adds four static checks — `import-unknown-name`, `import-mesh-on-occt`, `reference-unknown`, `ref-metric-without-reference` — described in full under "Linting" → Rule catalog → "Geometry imports", below; this section only points there rather than repeating it.

**CLI:** `partforge measure|render|lint` work on an importing part exactly as on any other — the `imports` field resolves in the CLI's Node boot the same way `fonts` does, no extra flags.

## Describing an imported mesh

Before you write the parametric rebuild, ask the mesh itself what's in it: `partforge
describe <part-module>#<importName>` reads an already-declared import (`k.import`'s own
name, not a bare file path — the `imports` field is how the file gets to a kernel at
all, so it's how `describe` finds it too) and emits a semantic feature report — holes,
bosses, pockets, extrusions, patterns, symmetry — rather than a triangle soup. On
`import-demo.js`, whose `scan` import is a plain 20×14×8mm block:

```
$ npx partforge describe src/parts/import-demo.js#scan

scan — 12 triangles, 20.00 x 14.00 x 8.00 mm, +Z up

Features (1):   share = fraction of part volume this feature accounts for — a size measure, not certainty
  f0    extrusion      8.000     share 100.0%

Score: 100.0% surface area explained, 100.0% volume reconstructed (residual xor 0.00% of volume)
Residual: 0.00% of area in 0 region(s)
```

**Two report shapes, and which one is authoritative.** `describe()` (`src/framework/
oracle/describe.js`) returns the FULL report — every surface, every fitted edge, every
feature at full precision — and that is the archive: `--json` prints it whole, and
`--out <file>` writes it whole. `compactDescribe()` (`src/framework/oracle/describe/
report.js`) derives a second, smaller shape from it — features, patterns, symmetry,
score, residual, and the suggested rebuild, with `surfaces`/`edges` reduced to counts —
and that is what a model reads, and what the terminal printer above reads too: **the
same `compactDescribe()` output**, not a hand-rolled subset, so what a human sees in the
default summary and what an agent gets from a cloud turn cannot drift apart. The full
report is authoritative for the facts (a fitted surface's rms, an edge's exact radius);
the compact report is authoritative for what's worth paying attention to.

**Computed once, reused for the session.** `describe` depends on nothing but the mesh's
own bytes — no part params, no derived state — so unlike `measure`/`verify` it never
needs to re-run on every parameter edit. The worker keys its memo on the import's
content digest (`kernel._importDigest(name)`), so re-describing the same file, or asking
again mid-session while you iterate on the parametric rebuild, is free after the first
call. The CLI doesn't carry a memo across process invocations — each `partforge
describe` run is its own process — but within one browser session or one long-running
tool loop, the mesh is segmented once.

**`--surfaces` and `--json`, and why the default elides.** A hand-modelled block
segments to six surfaces; a real 24k-triangle CAD export segments to hundreds. Printing
every one of them by default would bury the two or three that actually matter under
exactly the noise this oracle exists to remove — so the plain-text summary shows
features, patterns, symmetry, score, and residual only. Pass `--surfaces` to add the
surface table back (`s0 plane area … rms …`, one line per fitted patch); pass `--json`
to get everything, always, structured — the mode an agent should default to over
scraping the text summary. `--out <file>` writes the full report to disk independently
of either flag, so you can capture it once and read it multiple ways.

**Low coverage exits zero — it's a finding, not a failure.** A poor segmentation (a
dome, a free-form scan, anything the four feature detectors can't reconstruct) is
exactly the situation an agent most needs to see, not one that should make itself
harder to see. `describe` treats "the shape isn't well explained" and "the command
failed" as different questions: a `LOW COVERAGE` banner at the top of the summary (and
`compactDescribe()`'s own `warning` field in `--json` output) is how a poor result
announces itself, and the process still exits 0. Only a genuine closed-set error — the
mesh couldn't be read or segmented at all — exits 1. Coverage is gated on the WORSE of
two numbers, both always printed rather than blended into one: `explainedArea` (how much
of the mesh's *surface* a fitted primitive accounts for) and `explainedVolumeFraction`
(how much of the part's actual *shape* the accepted features reconstruct). They can
diverge totally — a dome segments to ~100% surface area (it fits a sphere cleanly) and
0% volume (a sphere isn't a candidate-eligible feature type for any detector) — so
printing only one of them, or an average, would hide precisely the gap the banner exists
to catch. Each feature's own score is named `volumeShare`, never "confidence": it is the
fraction of the part's volume that feature accounts for — a measure of *size* — so a
small-but-certain feature (a precisely-fitted 3mm hole in a large plate) legitimately
reports a small share. Read a feature's fitted surface `rms`/`maxDev` (under `--surfaces`
or `--json`) for an actual certainty signal. The one-line hint at the `Features (N):`
header states the size-not-certainty point at its point of use; the longer explanation
(`score.note` — both this and the `explainedArea`/`explainedVolumeFraction` distinction
above, spelled out for a reader who never gets this far) stays `--json`-only, since
printing it in full under `Score:` used to be the single largest visual element in every
plain-text run — measured at 36-43% of a typical report's line count, bigger than the
feature list, the banners, and the score line combined.

**Why a null `volumeShare` isn't always the same story.** A feature can carry
`volumeShare: null` for three different reasons, distinguished by its sibling field
`volumeShareReason` (`--surfaces`/`--json`; the text view renders it as `share n/a
(<reason>)`):

- `"not-proposed"` — this feature TYPE is never turned into an acceptance candidate at
  all. Fillets, chamfers, revolves and shells fall here today; they're still reported as
  features, just not yet reconstructable through this pipeline.
- `"budget"` — a candidate WAS proposed, but the search ran out of `--budget` before
  reaching it. Raise `--budget` and re-describe; the feature may resolve to a real share
  once given the chance.
- `"rejected"` — a candidate was proposed, built, and evaluated, but never won a round
  (`accept.js`'s `MIN_GAIN_FRACTION` gate, or simply never the best candidate available).
  Raising `--budget` will not change this outcome — the feature genuinely doesn't fit
  well enough to explain a meaningful share of the part.

`"budget"` and `"rejected"` are the two that matter most to get right, and the
distinction is real, not cosmetic: "try a bigger budget" and "this doesn't fit" are
different next actions for whoever is rebuilding the part.

**What `describe` reconstructs today, and what it doesn't.** The FACTS layer — surfaces,
arcs, holes, dress-ups, sweeps, patterns, symmetry — covers the tool's full detection
vocabulary; a feature can be *reported* there regardless of shape. The RECONSTRUCTION
score (`explainedVolumeFraction`, and every accepted feature's own `volumeShare`) is
narrower: `toCandidate` only proposes box and cylinder footprints as acceptance
candidates today, so it currently reconstructs prismatic parts built from roughly fewer
than eight box/cylinder features well, and does not yet reconstruct round bosses,
revolves, fillets, chamfers, or shells — those are detected and reported (with
`volumeShareReason: "not-proposed"`) but never turned into a candidate that could win
volume back. Measured directly on this repo's own reference parts: `demo.js`
reconstructs 65.7% of its volume, `filleted-box.js` 36.2%, `bracket.js` 23.6%, a plain
tube 0.0%, and a hollow box 1.9%. The low-coverage banner fires on every one of these, so
nothing here is misreported — but a low `explainedVolumeFraction` on a turned or
feature-dense part means **"not yet reconstructable by this tool"**, not "not
understood" or "broken." Read the FACTS (features, surfaces, patterns) as the ground
truth regardless of the volume score; read the volume score as a measure of how much of
that ground truth also comes with a working, boolean-verified rebuild recipe.

**Closed error set.** Anything short of a programming mistake comes back as
`{error: "<code>", detail, diagnostic}` rather than a thrown exception — a CLI or an
agent can act on a code far better than on a stack trace — and every code has an
ERROR-PATTERNS.md entry:

- `not-manifold` — the mesh still has open edges after repair; see
  [ERROR-PATTERNS.md#describe-not-manifold](ERROR-PATTERNS.md#describe-not-manifold).
- `too-large` — over the 400,000-triangle segmentation ceiling; see
  [ERROR-PATTERNS.md#describe-too-large](ERROR-PATTERNS.md#describe-too-large).
- `empty` — the mesh has zero triangles; see
  [ERROR-PATTERNS.md#describe-empty](ERROR-PATTERNS.md#describe-empty).
- `unreadable` — `solid.toMesh()` itself threw; see
  [ERROR-PATTERNS.md#describe-unreadable](ERROR-PATTERNS.md#describe-unreadable).

`not-manifold` and `empty` describe real states `describe()` itself checks for and can
return through any caller that hands it a `Solid` directly, but through the CLI they are
largely theoretical: `kernel.import()`'s own registration validation rejects an empty or
a wide-open (non-manifold) mesh *before* a `Solid` ever exists to describe, so
`partforge describe` on such a file fails earlier, as a generic import error (the
`crash()` path every other verb shares — `describe: import "x": mesh is not a solid
after repair…`) rather than as a structured `{error: "not-manifold"}` / `{error:
"empty"}` report. See
[ERROR-PATTERNS.md#import-mesh-not-solid](ERROR-PATTERNS.md#import-mesh-not-solid) for
that failure. `describe-unreadable`'s own ERROR-PATTERNS entry already draws this same
line for its own code (a `k.import` parse failure is a *different*, separately-thrown
error, not `describe-unreadable`); this is the general version of that point.

A `budget-exceeded` report (the acceptance loop ran out of boolean attempts before the
residual converged) is not one of these — it's a `warning` on an otherwise-valid report,
same tier as low coverage, not a reason to exit non-zero; raise `--budget` and re-run.
`compactDescribe()` surfaces it exactly where the low-coverage banner lives, and shows
both together if a report happens to earn both — an exhausted budget is exactly the kind
of run that also leaves coverage low, and neither warning is allowed to mask the other.
See [ERROR-PATTERNS.md#describe-budget-exceeded](ERROR-PATTERNS.md#describe-budget-exceeded).

**The loop this completes.** `describe` exists to feed a specific workflow, the one
"Importing geometry" above sets up and this closes: `describe` the import to get its
feature list and a proposed reconstruction (`suggestion` in the full report); write a
parametric part from that proposal; bind the rebuild's sub-part to the import with
`reference: "scan"`; and let `verify`'s `ref*` gates (`refXorVolume`, `refVolumeDeltaPct`,
`refBboxDelta` — "The `reference` field and the deviation gate", above) hold the rebuild
to the scan on every future `measure`/`verify` run, long after the one-time `describe`
call that suggested it. `describe` proposes; `verify` keeps you honest.

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
| `#viewbar` with `#annotate` / `#measure` / `#cutaway` / `#reframe` / `#theme` | optional viewer controls (omit any you don't want) |
| `#panel` | the full-height controls rail (`class="pf-rail"`); programmatic hosts pass `elements.rail` instead |
| `#rail-toggle` | optional — collapses/restores the rail; resolved the same way as `#reframe`/`#theme`. A sibling of `#viewbar`, not a child of it: give it `class="pf-float-rail-toggle"` and it floats at the stage's top right |

Copy `demo.html` and change the title, the panel heading, and the `<script src>`. Two
workers are spawned from your one worker entry (`name` = `"manifold"` for preview/STL/3MF,
`"occt"` for STEP — handled for you).

**`#reframe` is supported but no longer shipped.** The framework's own pages dropped
the button on 2026-08-20: clicking a face, edge or corner on the view cube reframes
too, so a separate control was one more thing in a crowded bottom-right corner. The
wiring is untouched and fully optional — supply the button (by ID or as
`elements.chrome.reframe`) and it works exactly as before — so a host with its own
scaffold need change nothing.

**`#rail-toggle` left the viewbar on 2026-08-20.** It used to be the pill's last
button; it now floats alone at the stage's **top right**, opposite the pill's bottom
right, as a bare icon that grows a background on hover. Nothing in the wiring changed —
`mount` still resolves it by id (or `elements.chrome.railToggle`), and `rail.js` still
hides it below the 720px narrow breakpoint, where the pane tab bar takes over. A host
with its own scaffold gets the new look by moving the button out of `#viewbar` and adding
`class="pf-float-rail-toggle"`; leaving it inside the pill keeps the old look and still
works.

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
  scene; `opts` forwards to the underlying render (size, quality, angle, background).
  Resolves `null` on failure rather than throwing (a build error, a part with no sub-parts
  in that view, a disposed runtime). The render happens in a throwaway scene, so it takes
  no colour from the viewer's light/dark theme: it gets a fixed neutral grey, on the
  reasoning that a thumbnail is captured once and then displayed under host chrome
  partforge cannot see. Pass `background` (any `THREE.Color`-compatible value) to choose
  your own, or `background: null` for no background at all — which clears to opaque black
  unless the embedder has set a clear colour.

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

- `fontCatalog` — a provider backing every `type: "font"` control in the part:

  - `search(query, { limit }) → Promise<FontFamily[]>`, where a `FontFamily` is
    `{ id, family, category, variants: [{ variant, label, url, bytes }],
    menuUrl }`. `url` is what the picker writes into `params`; `menuUrl` is a
    name-only subset used to draw the list row.
  - `describe(source) → { family, variant } | null` — optional reverse lookup so
    the closed control can name a face whose URL carries a hashed filename.

  partforge ships no provider — a host supplies one, and without it every font
  control renders as a URL field.

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
  target are restored after the render. Measurement-mode dimensions render directly
  in the scene, so a dimensioned capture needs no special handling — enable measure
  mode (`runtime.measure.setEnabled(true)`) and call `captureCurrent()`; the dims are
  just part of the rendered frame.
- `runtime.captureViews(viewNames) → [{ view, dataUrl }]` — the canonical-angle
  counterpart (fixed poses, framed to the visible assembly, 1024², grid hidden). Sized
  for feeding a vision model, not for display; use `captureCurrent` for showcase images.

### `runtime.projection`

`{ get(), set(mode), onChange(cb) }` where `mode` is `"perspective"` or
`"orthographic"`. Drives the **live view** and `captureCurrent` only —
`captureCanonicalViews`, `renderMeshPayloads`, and the CLI's `partforge render`
stay perspective unconditionally, so agent-facing output does not depend on a UI
toggle. The choice persists across reloads under `partforge:projection` and is
restored before the first framing. The orientation cube and its projection
button are hidden while Sketch (annotate) mode is active, but that only governs
*user-driven* view changes — the framework does not police programmatic ones.
The ink is a transparent overlay and the WebGL canvas keeps rendering beneath
it, so a host that calls `runtime.projection.set()` mid-sketch **visibly
re-frames the 3D view underneath ink the user may still be drawing**: the
strokes stay where they were laid down while the model shifts out from under
them, and the sketch that gets sent is misaligned, not merely mis-labelled.
Deliberately unguarded, the same way it's always been free to call
`setCameraState` during Sketch.

### The annotation payload's camera block

`onAnnotationSend(payload)` receives a `camera` block in two frames — `world`
(replays exactly against the build that produced it) and `parts` (pinned to
the CAD geometry, so it survives a later rebuild's bbox recentring; reread a
sketch's camera intrinsics from `parts`, not `world`, once the model has been
rebuilt). `ANNOTATION_VERSION` is **2**: both frames carry
`projection: "perspective" | "orthographic"`, and under an orthographic camera
`fov` is `null` while `orthoHeight` gives the frustum's world height instead.
(v1 had `fov` only, and predates the projection toggle.)

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
      measure,
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
`control-key-not-in-defaults`, `preset-key-not-in-defaults`, `mixed-section-shape`,
`duplicate-preset-name`, `duplicate-node-id`, `select-options-missing`,
`select-default-not-in-options`, `log-scale-needs-positive-min`,
`when-key-not-in-defaults`, `when-unknown-operator`, `unknown-control-type` (errors);
`slider-range-excludes-default`, `unknown-control-field`, `duplicate-control-key`,
`default-not-exposed`, `readout-unknown-derived-key`, `slider-refinement-invalid`,
`group-depth`, `section-too-many-controls` (warnings).

`mixed-section-shape` fires when a section mixes the new `controls` array with
a legacy field (`advanced`, `toggles`, `features`, `presets`) — the two shapes
can't coexist, since mixing them would make the render order arbitrary. Move
the legacy entries into `controls` (a toggle becomes a checkbox control,
`advanced` becomes a nested group, `presets` becomes `{ type: "preset" }`
nodes), or drop `controls` and stay legacy.
`duplicate-preset-name` fires when the same preset name is declared twice
(legacy `presets` and/or `{ type: "preset" }` nodes both count) — preset names
are global to the part, and `verify()` expands one case per name and throws on
a repeat, a worse place to find out. Rename one of them.
`duplicate-node-id` fires when two panel nodes (sections, groups, or controls)
share an `id` — the renderer keys its element and state maps on ids, and a
collision silently cross-wires the two nodes. Rename one `id`, or drop it to
use the positional default.
`select-options-missing` fires when a `select`/`radio` control has no
`options` array — with none the control renders empty and its parameter can
never change.
`select-default-not-in-options` fires when `defaults[key]` is not one of a
`select`/`radio`'s option values (watch value types — `12` is not `"12"`) —
without this the panel opens showing a value the user can never get back to.
Add the value to `options`, or change the default.
`log-scale-needs-positive-min` fires when a slider/number sets `scale: "log"`
without a positive `min` — `log(0)` is `-Infinity` and the thumb-to-value mapping
breaks, so raise `min` above 0 or drop `scale`.
`when-key-not-in-defaults` and `when-unknown-operator` walk every authored
`when` (on a control, a group, a preset, a readout, or a section itself) —
`allOf`/`anyOf`/`not` recurse — and check each condition against the two things
that make it real: the param key must be one `defaults` actually declares, and
each comparison operator (`{ gt: 0 }`, `{ in: [...] }`, …) must be one
`evalWhen` recognises. Both are silent failure modes — an unknown key reads
`undefined` and an unknown operator is treated as false, so either way the
condition is always false and the node never shows — which is why both are
errors rather than warnings.

`unknown-control-type` fires when an authored control's `type` (e.g. a typo
like `"sldier"`) isn't one of the recognised widget types — the renderer skips
a node with an unrecognised type entirely, so the control silently vanishes
from the panel with no other sign anything is wrong. An unrecognised type's
field list falls back to the common set (`key`, `type`, `label`, `description`,
`hidden`, `when`, `whenFalse`) rather than an empty one, so this error carries
the diagnosis instead of every field on the control — even ordinary ones like
`label` — separately warning as `unknown-control-field`. This only applies to
the authored `controls` shape — a legacy descriptor's `control:` value was
never validated and still isn't.

`readout-unknown-derived-key` checks a `{ type: "readout" }` entry's `derivedKey`
against the keys `derive()` actually produces (resolved once against `defaults`)
— a readout naming a key no group returns shows an em-dash forever, so it warns
rather than errors.
`slider-refinement-invalid` covers a slider/number's optional `ticks` (native
datalist marks; combine with `snap: true` to quantize slider drags to the
nearest tick) and `recommended` (an `[lo, hi]` band tinted on the track, with
the value box warning outside it): a tick outside `[min, max]`, a `recommended`
that isn't exactly `[lo, hi]` with `lo < hi`, or either of them combined with
`scale: "log"` (ticks and the band render on a linear track only) all warn.
`group-depth` warns when authored groups nest more than two levels deep — a
section plus one inner fold is as deep as a 300px rail can stay readable.
Flatten by promoting the innermost group to its own section, or folding its
controls into the parent.
`section-too-many-controls` warns when a section (authored or legacy, desugared
to a common format) shows more than 12 visible controls — the budget is
deliberately conservative, revisable against real LLM-authored parts. More than a
dozen in one section reads as a wall; split into multiple sections, or hide
internals (`hidden: true`). Grouping controls organizes them but does not
reduce the count — the check recurses into groups — so a group alone doesn't
bring a section back under budget.

**Kernel API**, found by executing `build()` against a geometry-free probe —
`unknown-kernel-op`, `unknown-solid-op`, `invalid-op-options`, `build-throws`,
`derive-throws`, `manifold-backend-uses-occt-op`, `build-runaway` (errors);
`nondeterministic-build` (warning, from diffing two probe runs).

**Verify block** — `verify-unknown-metric`, `verify-unknown-subpart`,
`verify-bad-expr`, `verify-bad-pair-check`, `verify-unknown-process`,
`verify-expect-throws` (all errors). Note `_view` also accepts the pair-wise
`contacts` / `clearance` keys, which are not scalar view metrics; they are
validated by `verify-bad-pair-check`, matching `verify.js`'s own handling.

**Animations block** — static validation of each view's `animations` block,
without executing `build`: `animation-not-in-view` (a top-level `animations`
key, which the runtime ignores), `animations-not-object`,
`animation-tracks-or-steps`,
`animation-unknown-param`, `animation-param-not-numeric`,
`animation-keyframes-invalid`, `animation-value-out-of-range`,
`animation-opacity-unknown-part`, `animation-opacity-range`,
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

**Geometry imports** — `import-unknown-name` (a build calls `k.import` with a
name the part's `imports` field doesn't declare — this throws at build time;
lint reaches it in microseconds instead), `import-mesh-on-occt` (a declared
STL/3MF import on a part that routes to OCCT — mesh imports need the Manifold
backend; the message names whether `meta.backend` or a CAD op forced OCCT.
Only extension-detectable `imports` sources — a `URL` or string path — are
checked; a bytes/thunk source's format can't be known without resolving it, so
lint skips it and the lazy `k.import` error entry at build time remains the
runtime authority for those cases), `reference-unknown` (a sub-part's
`reference` names no declared import) (all errors); `ref-metric-without-reference`
(a sub-part's `verify.expect` uses a `ref*` metric — `refXorVolume`,
`refVolumeDeltaPct`, `refBboxDelta` — but the sub-part declares no `reference`,
so the deviation gate always reports status "skip") (warning).

**Font controls** — `font-control-not-in-fonts` (a `type: "font"` control's
`key` is not read by a function-form `fonts` — a static `fonts` object or a
missing `fonts` field both provably can't depend on a param, so the picker
changes a param and nothing else happens; the message names which of the two
it is) (error); `font-source-scheme` (`defaults` holds a value for a font
control that the control's own `allow` list would refuse — at build time it's
swapped for `defaults[key]`, i.e. itself, so the part boots with no usable
font; use a source `allow` accepts, or widen `allow`) (warning).

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
per triangle, which is unbounded work on a dense mesh, so past a sample budget
it casts from a spread, deterministic subset instead — `minWallSampled` (boolean)
and `minWallSamples` (`{ sampled, total }` or `null`) say whether that happened.
**The budget depends on whether the reading is checked against anything**: a part
that declares a min-wall gate — a `verify.process` profile, or an `expect`
mentioning `minWall` — gets 50,000, because a gate's verdict rides on it; a part
that declares neither gets 5,000, because there the number is a diagnostic for a
reader rather than an assertion. Declaring the gate is what buys the resolution.
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
`measuredGaps` is the companion to `measuredMinWall` for that pass, and `gaps` is
**absent** rather than empty when it did not run — an empty table means "measured,
and these pairs have no distance", which a declared `clearance` gate fails on.

### Quick checks

An editor may ask for a **quick** check, which skips both ray-casting passes — min
wall and pair distances — and keeps everything derived from the build itself:
triangles, bbox, volume, genus, watertight, the assembly overlap check, and lint.
On a 460k-triangle assembly that is roughly 6.8 s down to 0.9 s.

Gates still run on a quick check wherever the facts allow it, so a violated `bbox`
or `holes` expectation still fails. What a quick check will **never** do is return a
pass: any gate it could not evaluate is listed in `verify.unevaluated`, and one such
gate makes `verify.ok` **`null`** rather than `true`. So `ok` is tri-state — `false`
(something failed), `null` (nothing failed, but something went unchecked), `true`
(everything declared was checked and passed) — and code that treats a truthy `ok` as
"passed" stays correct without changing. Run a full check before trusting a part.

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

**A part whose typeface is a parameter needs band assertions, not points.** Glyph
advance widths differ by family, so a `text2d` sub-part's `bbox`/`volume` shifts with
the picked face even when every other param is unchanged. Write `verify` bounds wide
enough to hold across the fonts your `allow` list admits (a range, or `<=`/`>=`,
rather than exact equality). `verify` runs against `defaults`, which is stable — the
nameplate ships `face: ""` (the bundled Roboto), so its own `verify` cases don't
need this, but a part whose default already names a specific face does.

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

## Fillet, chamfer & shell

Two backends build your part: **Manifold** (fast meshes — preview, STL, 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Most parts run on Manifold — and since
contract v3 that **includes fillet and chamfer**: the mesh backend blends straight
edges, circular-arc edges (bore rims, cylinder rims, the arcs where fillets meet a
face), and **planar contour edges at constant dihedral** — the top/bottom rims of any
extruded profile, however curvy its outline: `text2d` lettering, `Shape2D.offset`
outlines, spline profiles all round natively now. Only `shell` still routes a
sub-part to OCCT up front; a fillet/chamfer on an edge class the mesh backend can't
blend (helical edges, varying dihedral) reroutes that sub-part to OCCT automatically
at runtime — no declaration needed either way:

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
  escape hatch**: it forces the sub-part onto OCCT (the mesh backend reroutes on
  sight of it) and is non-portable — parts meant to travel must use the object forms
  (see `KERNEL-CONTRACT.md`)

```js
let s = k.box({ min: [0, 0, 0], max: [40, 30, 16] });
s = s.fillet({ r: 3, edges: { dir: "Z" } });            // round the 4 vertical edges
s = s.chamfer({ d: 1, edges: { inPlane: "XY", at: 0 } }); // bevel the base
```

See `src/parts/filleted-box.js` for the worked example.

**Automatic backend selection.** Before building, the framework runs a geometry-free *probe*
of your `build`; a `shell` call **on a Solid** routes that sub-part to OCCT up front, and
everything else — fillet and chamfer included — stays on fast Manifold. The probe tracks
which handle kind each op ran on, so `Shape2D.fillet`/`.chamfer` (the shared,
backend-identical 2-D implementations — see "Editing profiles") never look like Solid
ops. Force the backend with `meta.backend: "occt" | "manifold"` if you ever need to.
STEP export always builds on OCCT, so a filleted part gets exact B-rep blends in its
STEP even though it previews (and STL/3MF-exports) from the mesh blend — the two agree
to within tessellation on the supported edge classes, with one visible exception:
orthogonal box-style corners where three filleted edges meet get a true sphere-octant
cap, and a planar rim's own corners blend by turn direction (salient corners steer
the band around a small arc; reflex/inside corners round into an arc of the blend
radius about the vertex — the rolling-ball pivot), but other blend junctions are
mitred on the mesh where OCCT builds a vertex blend.

If the mesh backend hits an edge class it can't blend, it signals `NEEDS_OCCT` and the
framework reroutes **just that sub-part** to OCCT for those exact parameters —
dialing the parameter away re-tries Manifold automatically. A zero magnitude —
`fillet(0)`, `chamfer({ d: 0 })` — is the **identity** on both backends (see
KERNEL-CONTRACT.md), so an unguarded `s.fillet(p.r)` needs no `if (p.r > 0)` wrapper.
(`shell` is the exception: `t: 0` is degenerate, not identity, so a shell call always
routes to OCCT.)

**Clamp your radii.** The mesh fillet does **not** validate feasibility — an oversized
radius self-intersects its cutters and yields a wrong shape rather than a skipped
feature (OCCT skips instead). Clamp magnitudes against local geometry the way
`filleted-box.js` does: `Math.min(p.fillet, halfWidth - 0.5, p.h - 0.5)`.

**A defeated fillet/chamfer skips, and the build reports it.** On both backends a
fillet or chamfer the geometry defeats does **not** fail the build: the op returns its
input solid unchanged (edges left sharp) and the build result carries a feature-skip
warning naming the op, its magnitude, and the reason. The same channel carries every
other degrade — an `extrude` rim bevel reduced or left square, a `roundedBox` rim
clamped to `round.side`, a `Shape2D` corner rounded smaller than asked — so the part on screen is real,
minus that one feature, with everything downstream of it still applied. When a build
answer includes such a warning, treat it as a failed feature, not a success: say so,
and either adjust the geometry/radius and retry or leave the feature off deliberately.
Do not conclude a fillet landed just because the build succeeded.

**Preview routing is per sub-part.** Each sub-part is probed and routed independently, and
a mixed part's regen fans out to both workers in parallel — a shelled body pays for OCCT
while a plain lid rebuilds at Manifold speed beside it. Two scopes
still route whole-part (the max over the sub-parts): **exports** (one STL/STEP/3MF job
builds everything in one worker) and the **CLI** (a single Node process boots exactly one
kernel; on a mesh-side `NEEDS_OCCT` it re-runs itself once with the backend pinned to
OCCT). Within one sub-part's build there is no per-op backend mixing.

**Shading intent.** The kernel decides what shades smooth and where edge lines
draw — spheres, cylinders and fillets are smooth by construction; boolean cut
seams always shade hard and draw a line; a loft's facets shade flat when its
rings have fewer than 32 sides (`shading: "smooth"|"faceted"` on `k.loft`
overrides the inference either way). If your part previews smooth but would
print faceted — or the reverse — set the hint rather than changing facet counts.

> `partforge measure` reports `watertight`/`holes` as `n/a` for OCCT-run parts
> (Manifold-only topology); `render` works on both. Filleted parts now measure on
> Manifold with full topology.

### `roundAll(r)` — round everything at once

`s.roundAll(2)` (or `s.roundAll({ r: 2 })`) rounds **every** edge of the solid
— convex and concave — with radius ≈ 2 mm in one pass, on both backends, with
no OCCT routing. Faces stay in place (within backend tolerance). It is the
blunt, global counterpart to `fillet`/`chamfer`: there is no edge selection,
and features smaller than the ball are **consumed** — walls thinner than `2r`
melt away, holes narrower than `2r` seal shut. That makes it ideal for
"soften this whole organic part" and wrong for parts where a specific edge
must stay sharp (use `fillet` with a selector for that).

**Cost note.** On a Z-aligned extrusion (constant cross-section — a plate, a
text backing, any straight-sided prism) roundAll takes a fast path: the ball
morphology is computed as a 2-D close-open of the cross-section plus rim
fillets, so even a complex text-outline backing rounds in well under a second.
Everything else pays the full morphology (three Minkowski passes), whose
runtime grows steeply with triangle count — a rotated or lofted solid of a few
thousand triangles can take tens of seconds. When only a specific edge needs
rounding, `fillet` with a selector (e.g. `{ inPlane: "XY", at: h }` for a rim)
says what you mean and is always the cheap, predictable choice; reach for
roundAll when the design genuinely calls for every edge softened at once. At
the fast path's corners the plan silhouette follows the rim fillet's corner
rounding (radius ≈ 1.05–1.25·r rather than exactly r) — the same corner
treatment fillet itself applies.

Rules of thumb:

- Keep `r` under half your thinnest wall unless you *want* melting.
- Preview and STL/3MF export always work (mesh morphology). STEP export gets
  true B-rep arc surfaces while `r` is below the smallest feature size; at
  consuming radii OCCT cannot represent the melt and **skips the op whole**
  with a `roundall-skipped` warning — the STEP then has the un-rounded shape.
- Relying on consumption? Add a `verify` volume assertion so a regression in
  the radius (or a backend skip) fails loudly.
- A small ridge remaining where a thin rib was consumed is correct morphology
  (the rib's dilation fillet survives the opening), not a bug.

### Cost on the OCCT path: fillet/chamfer scale with edge count — and order matters

These costs apply when a sub-part **does** run on OCCT (a shell, an unsupported edge
class, a pinned backend, or STEP export). OCCT fillet/chamfer cost is **per selected
edge**, on top of the OCCT boolean tax. Two habits keep it tolerable:

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
