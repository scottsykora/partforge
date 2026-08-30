# The `partforge-vector` format

Normative. This is the file format `k.vector2d` reads: filled 2-D outlines that
become a `Shape2D`, which a part then extrudes, revolves, offsets, cuts, or
composes with any other 2-D geometry.

There are two ways a file gets here, and this document leads with the first:

- **Authored.** Write the JSON directly — a rounded rectangle, two bolt circles,
  a triangular keyway. Coordinates are millimetres, and they place exactly where
  you drew them. This is the path an agent should reach for when the geometry is
  *drawn* rather than computed.
- **Ingested.** Convert an existing `.svg` once, in a browser, with
  `partforge/ingest`, and check the resulting JSON in beside the part. The
  artwork keeps its own unitless coordinates and gets sized at every call site.

Both produce the same format, load through the same validator, and behave
identically downstream.

**Why this document is normative and not merely helpful.** Ingest needs a real
DOM (it resolves `<use>`, `<defs>`, CSS, and bakes ancestor transforms, all of
which require one), so partforge deliberately ships **no headless SVG
conversion path** — `partforge measure|render|lint` read a part's already-stored
JSON, but nothing headless can *create* it from an `.svg`. That trade was
accepted only because this file is complete enough that someone — or some agent
— with no browser and no access to partforge's source can write a compliant
converter from it alone. Everything below is written to hold that property.
`scripts/ingest-svg.mjs` (dev-only, not shipped) is the reference
implementation, described in §6.

## 1. A worked authored example

`src/parts/assets/plate.vector.json` is hand-written — no ingest step, no source
SVG. It is checked in verbatim:

```json
{
  "format": "partforge-vector",
  "version": 1,
  "units": "mm",
  "note": "Emblem backing plate. Drawn at 40 x 24 mm with M3 clearance holes on 28 mm centres and a keyway placed low, in the gap between the emblem artwork's disc and its bar, so it stays a real through-slot rather than getting capped by the emboss at the default emblem_w. Coordinates are millimetres and place as authored, so `body`, `holes`, and `keyway` share one frame — the cut in build lands where it is drawn.",
  "shapes": {
    "body": {
      "role": "add",
      "regions": [
        { "outer": { "kind": "rect", "center": [0, 0], "width": 40, "height": 24, "radius": 4 } }
      ]
    },
    "holes": {
      "role": "subtract",
      "regions": [
        { "outer": { "kind": "circle", "center": [-14, 0], "r": 1.7 } },
        { "outer": { "kind": "circle", "center": [14, 0], "r": 1.7 } }
      ]
    },
    "keyway": {
      "role": "subtract",
      "regions": [
        { "outer": { "kind": "polygon", "points": [[-3, -8], [3, -8], [0, -4]] } }
      ]
    }
  }
}
```

`src/parts/emblem.js` uses it like this:

```js
vectors: {
  emblem: new URL("./assets/emblem.vector.json", import.meta.url),
  plate: new URL("./assets/plate.vector.json", import.meta.url),
},
build: (k, p) => k
  .vector2d("plate")
  .extrude({ h: p.plate_t })
  .union(k.vector2d("emblem", { width: p.emblem_w }).extrude({ h: p.emboss }).translate([0, 0, p.plate_t])),
```

Things worth reading off that pair:

- **No coordinate in the file is derived from another.** A hole moves by editing
  its `center`; the body's corners round by editing one `radius`. Nothing has to
  be recomputed elsewhere to keep the file valid — which is the whole reason the
  primitive `kind`s exist alongside the explicit `"path"` form.
- **`body`, `holes`, and `keyway` share one coordinate frame**, because the file
  is `units: "mm"`. Millimetres place *as authored*: scale 1, no re-centring. A
  hole at `[-14, 0]` lands 14 mm left of the plate's centre in the finished
  solid, not somewhere a bounding box happened to put it.
- **`k.vector2d("plate")` passes no size option, and that is load-bearing.** The
  `emblem` call must pass one (`width: p.emblem_w`) because that document is
  `units: "artwork"`; the `plate` call must not, because a size option is applied
  **per shape group, against that group's own bounds** — see §3's "Do not size a
  role-composed millimetre document."
- **The file states its own composition.** Reading it, you can see that `holes`
  and `keyway` are subtracted. That fact does not live only in `build`.
- **There is no `bbox` and no `source`.** Both are optional. An author never
  computes a bounding box for this format.

## 2. Schema

Every field at once, in a document that has been validated against the actual
loader as written here (`partforge/geometry`'s `validateVectorDocument` accepts
it):

```json
{
  "format": "partforge-vector",
  "version": 1,
  "units": "mm",
  "note": "free text, ignored on load",
  "shapes": {
    "outline": [
      {
        "outer": {
          "kind": "path",
          "start": [0, 0],
          "segments": [
            { "kind": "line",  "to": [20, 0] },
            { "kind": "arc",   "to": [20, 20], "through": [24, 10] },
            { "kind": "cubic", "to": [0, 0],   "c1": [15, 25], "c2": [5, 25] }
          ]
        },
        "holes": [
          {
            "kind": "path",
            "start": [7, 7],
            "segments": [
              { "kind": "line", "to": [7, 13] },
              { "kind": "line", "to": [13, 13] },
              { "kind": "line", "to": [13, 7] }
            ]
          }
        ]
      }
    ],
    "notch": {
      "role": "subtract",
      "regions": [
        { "outer": { "kind": "rect", "center": [10, 0], "width": 6, "height": 4 } }
      ]
    }
  }
}
```

### 2.1 The envelope

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | `"partforge-vector"` | yes | Literal string. Anything else is refused, naming both the found and the expected value. |
| `version` | integer | yes | `1` today. Both a **floor and a ceiling**: `0`, a negative, a non-integer, and anything above what the running build understands are all refused **by name** — the error names the document's version and the build's — rather than guessed at. |
| `units` | `"mm"` \| `"artwork"` | yes | No default. See §2.2. |
| `note` | string | no | Free text for a human or agent reading the file cold. **Ignored on load** — never parsed, never validated beyond "is a string if present." Safe to omit, safe to put anything readable in. |
| `source` | string | no | Provenance only — typically the original `.svg` filename. Not used at load or build time, and **not a staleness check** (a `source` file that has since changed is not detected). Omit it in authored documents. |
| `bbox` | `{minX, minY, maxX, maxY}` | no | Optional. Validated when present, recomputed when absent — see §3. |
| `shapes` | object, ≥1 entry | yes | Name → shape. See §2.3. |

There is no `regions` array at the top level any more. A stale draft carrying one
is refused by name — `has a "regions" array, which this build does not read` —
rather than as a generic "has no shapes", so the reader is not sent hunting for a
typo.

### 2.2 `units`

`units` is required and has no default, for the same reason `k.vector2d` refuses
to guess a size: there is nothing honest to fall back on.

| | `units: "mm"` | `units: "artwork"` |
|---|---|---|
| Coordinates mean | millimetres | nothing physical |
| Scale | `1`, unless a size option is given | exactly one of `width`/`height`/`fit`, **required** at every call site |
| Placement | as authored — no translate | the geometry's bbox centre moves to the origin |

One formula covers both: **scale uniformly about the document origin, then
translate per `align`/`valign`.** "As authored" is the no-translate case. For
`units: "artwork"` the defaults are `align: "center"`, `valign: "middle"`; for
`units: "mm"` there is no default translate, and `align`/`valign` still apply
when passed explicitly.

Ingest always writes `"artwork"` — an SVG's `viewBox` units might be "pixels at
some assumed DPI" or "arbitrary design units", and neither is a length. Scaling
an `mm` document is legitimate (a drawing reused at another size), so a size
option on an `mm` document is accepted, not refused. Passing **more than one** of
`width`/`height`/`fit` is refused in either mode, naming the ones it got.

Sizing is always against the **tight geometric bounding box of the regions being
placed**, never a `viewBox`: `fit` sizes the longer extent, `width`/`height` the
named one, and the scale is uniform in every case (never stretched to fit both).

### 2.3 Shapes and roles

`shapes` maps a name to a shape. A shape takes either of two forms:

```json
"holes": [ …regions… ]                              // role "add", the default
"holes": { "role": "subtract", "regions": [ … ] }   // explicit
```

- `role` is `"add"` (the default when absent) or `"subtract"`. Any other value —
  including an explicit `null` — is refused; the default applies only when the
  key is genuinely absent.
- **A file must declare at least one `add` shape.** A document whose every shape
  subtracts composes to nothing, and an empty result would surface much later as
  an empty extrude, so it is refused at load.
- A shape needs at least one region; `shapes` needs at least one entry.
- Shape names are ordinary JSON keys, with no reserved names.

How the runtime reads them:

| Call | Returns |
|---|---|
| `k.vector2d("plate")` | Every `add` shape unioned, minus every `subtract` shape unioned. |
| `k.vector2d("plate", { shape: "holes" })` | That shape's own geometry, **whatever its role**. |

Naming a shape is a request for *that* geometry; `role` governs only the default
composition. An unknown shape name throws, listing the names the document does
declare. Union is commutative and subtracting a union is order-independent, so
key order never affects the result.

`role` is optional where `units` is required, and the difference is principled:
`"add"` is an honest default because a painted region adds material, which is
what every region in every document already means. `units` has no honest default
because artwork coordinates have no physical meaning.

Anything more than two flat groups belongs in `build`, not in the file. There is
no intersect, no ordering, no nesting, no reference from one document to another
— composition beyond add/subtract is ordinary `Shape2D` algebra:

```js
k.vector2d("plate", { shape: "body" })
 .cut(k.vector2d("plate", { shape: "holes" }))
```

### 2.4 Regions

A **region** is one filled area:

| Field | Type | Required | Notes |
|---|---|---|---|
| `outer` | contour | yes | The region's boundary. |
| `holes` | array of contour | no (default `[]`) | Subtracted from `outer`. |

### 2.5 Contour kinds

Every contour carries a `kind` — the same discriminator segments use, so the
format has one tagging rule rather than two. `kind` is **required**; a contour
without one is refused.

| `kind` | Fields | Meaning |
|---|---|---|
| `"path"` | `start`, `segments` (≥2) | The explicit form: a start point and a head-to-tail segment list. |
| `"circle"` | `center`, `r` | A full circle. `r` must be finite and `> 0`. |
| `"rect"` | `center`, `width`, `height`, `radius?` | An axis-aligned rectangle, optionally with rounded corners. `width`/`height` finite and `> 0`; `radius` finite and `≥ 0`. |
| `"polygon"` | `points` (≥3) | A closed polyline through the given points. |

The three primitives are pure sugar: **they expand to exactly the internal
contour a hand-written `"path"` would produce, at the JSON boundary.** Nothing
downstream — placement, `Shape2D`, either geometry backend, the exporters —
learns that primitives exist. A converter that only ever emits `"path"` is fully
compliant.

#### Normative expansion

Let `c = center`, `hw = width / 2`, `hh = height / 2`. Coordinates are y-up. A
segment written `{to, through}` below is an `"arc"`; one written `{to}` is a
`"line"`.

**`circle`** — two 180° arcs:

```
start    = [cx + r, cy]
segments = { to: [cx − r, cy], through: [cx, cy + r] }
           { to: [cx + r, cy], through: [cx, cy − r] }
```

The last segment's `to` equals `start`, and it is **retained** — the
closure-dropping rule in §3 applies only to a final *line* — so the implicit
closing edge is zero-length.

**`rect`, with `radius` absent or `0`** — four corners, three explicit lines and
the implicit closure:

```
start    = [cx − hw, cy − hh]
segments = { to: [cx + hw, cy − hh] }
           { to: [cx + hw, cy + hh] }
           { to: [cx − hw, cy + hh] }
```

**`rect`, with `radius > 0`** — eight segments, four straight edges and four 90°
corner arcs. Each corner arc's `through` point sits at 45° on that corner's own
circle, offset from the corner-arc centre by `k = radius / √2` in both axes.
With `r = radius`:

```
start    = [cx − hw + r, cy − hh]
segments = { to: [cx + hw − r, cy − hh] }
           { to: [cx + hw, cy − hh + r], through: [cx + hw − r + k, cy − hh + r − k] }
           { to: [cx + hw, cy + hh − r] }
           { to: [cx + hw − r, cy + hh], through: [cx + hw − r + k, cy + hh − r + k] }
           { to: [cx − hw + r, cy + hh] }
           { to: [cx − hw, cy + hh − r], through: [cx − hw + r − k, cy + hh − r + k] }
           { to: [cx − hw, cy − hh + r] }
           { to: [cx − hw + r, cy − hh], through: [cx − hw + r − k, cy − hh + r − k] }
```

`radius > min(width, height) / 2` is **refused**, naming the maximum — not
clamped. A format loader has no warning channel, and a radius past half the
shorter side is a typo, not a request. At exactly `min(width, height) / 2` two
(or four) of the straight edges are zero-length; the expansion **omits any line
segment whose endpoints coincide**, so a square with `radius = width / 2` expands
to four arcs, not four arcs and two degenerate lines.

Worked, from the plate above (`center [0,0]`, `40 × 24`, `radius 4`, so
`k = 2.828427…`): `start [−16, −12]`, then `line → [16, −12]`,
`arc → [20, −8] through [18.828427, −10.828427]`, `line → [20, 8]`,
`arc → [16, 12] through [18.828427, 10.828427]`, `line → [−16, 12]`,
`arc → [−20, 8] through [−18.828427, 10.828427]`, `line → [−20, −8]`,
`arc → [−16, −12] through [−18.828427, −10.828427]`.

**`polygon`** — `start` is `points[0]`, one `"line"` segment per remaining point,
and the closing edge is implicit. `points` must hold at least 3 finite `[x, y]`
pairs.

**Winding is not your problem.** `circle` and `rect` expand counter-clockwise by
construction and `polygon` follows the author's own point order, and none of them
needs to know whether it is filling an `outer` or a `holes` slot — see §3's
winding rule for why. There is deliberately no winding or direction field on a
primitive, and no per-contour transform: emit the coordinates you mean.

### 2.6 Segments

A `"path"` contour is `{ kind: "path", start: [x, y], segments: [...] }`, with
**at least two segments** (with the implicit closing edge, two explicit segments
plus the closure is the fewest that can bound a nonzero area — a triangle). Every
segment has a `kind` and a `to`; `kind` determines what else it carries:

| `kind` | Extra fields | Meaning |
|---|---|---|
| `"line"` | — | A straight edge from the previous point to `to`. |
| `"arc"` | `through: [x, y]` | A circular arc from the previous point to `to`, **passing through `through`**. |
| `"cubic"` | `c1: [x, y]`, `c2: [x, y]` | A cubic Bézier from the previous point to `to`, with control points `c1` (near the start) and `c2` (near `to`) — the standard SVG/PostScript cubic convention. |

**`through` is a point the arc passes through — not a control point, not a
tangent handle, not a centre.** Concretely: the arc from the segment's start
point `P0` to its `to` point `P1` is the unique circular arc through the three
points `P0`, `through`, `P1`. This is the same "three points determine a circle"
construction as an SVG `A` command's endpoint parameterization, just phrased
directly in points instead of radius + flags. Two things follow, both worth
knowing before hand-writing one:

- **`through` must not be collinear with `P0` and `P1`.** Three collinear points
  don't determine a circle; a degenerate arc silently falls back to a straight
  line rather than throwing (`k.vector2d` will not error, but the corner you
  meant to round will not be rounded — a "why does my part look wrong" bug, not a
  crash).
- **Which side of the chord `through` sits on determines the sweep direction and
  whether the arc is the major or minor arc.** Put `through` on the actual path
  the artwork traces between `P0` and `P1`, not just "somewhere off to the side"
  — for a rounded corner that means roughly on the bisector, offset toward the
  outside of the turn; for a near-semicircle it means clearly on one side or the
  other, not near either endpoint.

### 2.7 Error messages

Every validation error names the file's declared `vectors` key, then the exact
position, then the problem and a fix, e.g.:

```
vector2d: "plate" shape "holes" region 1 outer has "kind": "circle" but a non-positive r (0) — r must be a finite number greater than 0
vector2d: "plate" shape "body" region 1 outer has "kind": "rect" with radius 3.5 exceeds the maximum 3 — a corner radius cannot be more than half the shorter side
```

Shapes are named, regions and segments are 1-indexed, and the role (`outer` /
`hole n`) is stated. There is no error that only says "invalid document."

## 3. Rules that are not obvious from the schema

- **y points UP.** SVG (and almost every 2-D graphics format) is y-**down**:
  larger y is lower on the page. This format's frame is y-**up**, matching the
  CAD model frame `k.vector2d` places geometry into. Converting from SVG means
  flipping y. partforge's own ingest does it by **literal negation** (`y → −y`),
  applied once, after all of an SVG's own transforms have been baked into the
  coordinates — not by subtracting from the artwork's height or `viewBox` extent.
  For an `artwork` document either convention gives correct final geometry
  (sizing and alignment work off the regions' own tight bbox, so a constant
  offset in how you chose to flip is invisible after placement); negation is
  simply the simplest rule to implement correctly, and it is what the worked
  examples here look like. For an **`mm`** document the choice is *not* free —
  the coordinates are the placement — so negate.

- **A contour is implicitly closed.** The last segment's `to` connects back to
  `start`; you never write a final segment whose only job is "return to `start`."
  (If you do write one anyway — a final segment whose `kind` is `"line"` and
  whose `to` equals `start` exactly — it is tolerated and silently dropped on
  load, so round-tripping a document that has one doesn't duplicate it. A final
  *arc* that lands on `start` is kept, which is how `circle` expands. Don't rely
  on the dropping path; the canonical form omits the redundant line.)

- **Winding carries no information, and you never need a shoelace sum.**
  Orientation comes from the **`outer` / `holes` labels**, not from the direction
  the points are written in. `k.vector2d` lowers through `k.shape2d`, whose
  `liftRegions` runs `ensureRegionWinding`, and that reorients every contour
  *structurally* from its label: `outer` counter-clockwise, every hole clockwise.
  Stored winding is discarded before any boolean sees it.

  Measured, not asserted: a 10 × 10 square with a 4 × 4 hole extruded 1 mm gives
  volume **84** with the "conventional" winding (CCW outer, CW hole), **84** with
  both contours reversed, **84** with both counter-clockwise, and **84** with both
  clockwise. All four are the same solid.

  So: put a contour in `outer` to add material and in `holes` to remove it, and
  write its points in whatever order is natural. Do not compute signed areas, do
  not reverse a contour to "fix" a file, and do not treat a file whose winding
  looks unconventional as broken — it isn't. (Earlier revisions of this document
  claimed reversed winding silently swapped outer and hole. That was false.)

- **`bbox` is optional, and it is a checksum rather than an authority.**
  Placement recomputes the tight bounding box from the segment geometry on every
  build regardless — analytically, including curve extrema, not just endpoints
  and control points — so the stored value is never *used* for geometry.
  - **Absent:** computed from the geometry. This is the authored case; an author
    should not have to solve for curve extrema to satisfy a checksum.
  - **Present:** validated against a fresh recomputation, to a tolerance of
    `1e-3`. A disagreement is a **load-time error**, naming the offending field,
    the stored value, and the actual one. This is the generated case: it is what
    catches a truncated or hand-mangled ingest output.

  There is no way to make a document with an intentionally wrong `bbox` load. If
  you have one and don't want to compute the replacement, delete the field.

- **A stroke is never a line in this format — see §6.** There is no "stroked
  path" representation here at all; every stroke an SVG declares has been
  outlined into an ordinary filled `outer`/`holes` region by the time it reaches
  this JSON. A thin line in the source artwork appearing here as a thin closed
  ribbon is expected, not a bug.

- **A fill rule applies across one element's own subpaths, not globally.** SVG's
  `fill-rule` (`nonzero` — the default — or `evenodd`) is a property of a single
  `<path>`/`<circle>`/etc. element, and it resolves *that element's* subpaths
  against each other — which is what turns the counter of a letter "O" into a
  hole instead of a second filled disc. Two *different* elements that happen to
  overlap are never resolved against each other by a fill rule; they are unioned
  (every painted element adds material — see §7). One `<path d="…">` with two
  subpaths and `fill-rule="evenodd"` is one region with a hole; two separate
  `<circle>` elements are never a hole no matter what `fill-rule` either
  declares.

- **Do not size a role-composed millimetre document.** A size option is applied
  **per shape group, against that group's own bounds**: the `add` union is scaled
  so that *its* bounding box hits the requested size, and the `subtract` union is
  scaled so that *its own, different* bounding box hits the same number — two
  different scale factors, applied to geometry that was drawn in one frame. On an `artwork` document with a single shape that is exactly
  right. On an `mm` document with `add` and `subtract` shapes it silently
  destroys the shared frame — the holes end up scaled and positioned against
  their own bounding box rather than the plate's, and the geometry is wrong with
  no error anywhere. Measured on the §1 plate, whose `add` shape is 40 mm wide
  anyway: `k.vector2d("plate")` extrudes to bbox `40 × 24 × 3`, volume `2748.3`,
  3 through-holes; the same call with `{ width: 40 }` gives the **same** bbox and
  volume `2692.0` with only **2** holes — one cut has walked off the plate, and
  nothing reports it. Millimetre documents place as authored; leave the size
  options off. (If a millimetre drawing genuinely needs rescaling, scale the
  finished `Shape2D` in `build`, where one transform applies to the composed
  result.) See
  [ERROR-PATTERNS.md#vector-mm-shapes-misscaled](ERROR-PATTERNS.md#vector-mm-shapes-misscaled).

## 4. A worked ingested example

`src/parts/assets/emblem.svg` is partforge's own reference artwork:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="10" fill="#111"/>
  <polyline points="6 42 42 42" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/>
</svg>
```

One filled circle, and one **stroked, open** polyline — deliberately, so this one
file exercises both of ingest's geometry paths (a fill, and a stroke that has to
be outlined into a filled shape; see §6). Ingesting it
(`node scripts/ingest-svg.mjs src/parts/assets/emblem.svg`) produces
`src/parts/assets/emblem.vector.json`, checked in beside it. Here it is with the
`note` field elided for brevity and the coordinate arrays put on one line —
nothing else is changed:

```json
{
  "format": "partforge-vector",
  "version": 1,
  "units": "artwork",
  "source": "emblem.svg",
  "bbox": { "minX": 4, "minY": -44, "maxX": 44, "maxY": -14 },
  "shapes": {
    "artwork": [
      {
        "outer": {
          "kind": "path",
          "start": [14, -24],
          "segments": [
            { "kind": "arc", "to": [31.071068, -31.071068], "through": [20.173166, -33.238795] },
            { "kind": "arc", "to": [24, -14],               "through": [33.238795, -20.173166] },
            { "kind": "arc", "to": [14, -24],               "through": [16.928932, -16.928932] }
          ]
        },
        "holes": []
      },
      {
        "outer": {
          "kind": "path",
          "start": [6, -40],
          "segments": [
            { "kind": "arc",  "to": [6, -44],  "through": [4, -42] },
            { "kind": "line", "to": [42, -44] },
            { "kind": "arc",  "to": [42, -40], "through": [44, -42] },
            { "kind": "line", "to": [6, -40] }
          ]
        },
        "holes": []
      }
    ]
  }
}
```

Notice, and this is the point of quoting a real file rather than a hand-picked
one:

- **The `<circle>` survived as three arcs**, not the 4-cubic Bézier
  approximation a naive converter would emit — this is arc recovery (§6) working
  as intended, and it is why OCCT still gets true circular B-rep edges from an
  SVG circle.
- **The stroked polyline became a closed, filled region** — two arcs (the round
  caps) and two lines (the long sides) — even though the source SVG has
  `fill="none"` and no closing segment.
- **y is negative where the SVG artwork sits below its own origin.** SVG's
  `cy="24"` became `y: −24`: ingest flips y by literal negation, not by mirroring
  within the `viewBox`.
- **Ingest emits one shape, named `artwork`, with no `role`** — so it is an `add`
  shape and `k.vector2d("emblem", { width })` returns it without naming it.
- **`units` is `"artwork"` and `bbox` is written.** Both are what ingest always
  does, and both are the opposite of the authored plate in §1.

## 5. Which to reach for

- **Geometry computed from parameters** — a profile whose dimensions come from
  sliders — belongs in `build`, with `pathProfile` and the polygon helpers. A
  JSON file cannot see `p`.
- **Geometry that is drawn** — a logo, a faceplate outline, a decorative cutout —
  belongs in an authored `partforge-vector` file, where each number means one
  thing and can be edited on its own.
- **Existing artwork** — an `.svg` someone else made — goes through
  `partforge/ingest` once and is then referenced like any other document.

`k.shape2d` does **not** accept this JSON dialect, and there is no inline
document form in `build`. The two vocabularies stay separated by the file
boundary; that separation is what lets this document be the only place they meet.

## 6. Converting an SVG to this format by hand

If you're writing your own converter (no browser, no paper.js, no partforge
source), these are the steps in the order that avoids the mistakes above,
followed by the one already-written reference to check your output against.

1. **Resolve everything the SVG defers** — `<use>`/`<defs>`/`<symbol>`
   references, CSS `class=`/`<style>` rules, and every ancestor `transform`
   (`<svg>`, `<g>`, and the element itself) — down to concrete, final `(x, y)`
   coordinates per element. This is the step a real DOM does for you almost for
   free (which is why partforge's own ingest requires a browser); doing it by
   hand means implementing SVG's transform-composition and CSS cascade rules, or
   using a library that already has.
2. **For each element that paints, decide fill vs. stroke vs. both**, per SVG's
   own paint model: an element with a `fill` (anything but `none`; the default is
   black) contributes filled geometry; an element with a `stroke` set and a
   nonzero `stroke-width` contributes stroke geometry; an element can do both, or
   neither (in which case it contributes nothing and is skipped — no error, it's
   just not painted).
3. **Outline every stroke into a filled shape.** A stroke of width `w` becomes
   the region swept by a `w`-wide pen along the path: offset the path by `±w/2`
   on each side (for a closed path this gives an outer ring and an inner ring —
   an annulus; for an open path the two offset sides are joined at the ends by
   caps per `stroke-linecap` — `butt`, `round`, or `square` — and at interior
   corners per `stroke-linejoin` — `miter`, `round`, or `bevel`). Do this
   **before** measuring anything against the artwork's scale, and in the same
   units the rest of the element's geometry is already in (i.e. after transforms
   are baked in, per step 1) — outlining after a later rescale would leave the
   stroke's *thickness* keyed to the wrong scale, a bug that only shows up when
   someone changes the `width` the artwork is placed at.
4. **Resolve each element's own fill under its own fill rule** — nonzero or
   evenodd, defaulting to nonzero — across that element's own subpaths only (§3's
   fill-rule rule). Do this per element, not globally.
5. **Union everything** — every element's resolved fill regions and every
   element's outlined stroke regions, across the whole document — into one flat
   list of non-overlapping `{outer, holes}` regions. This is an ordinary planar
   boolean union under nonzero winding; it is also the step that silently
   discards painting order (§7).
6. **Flip y** (§3) — after all of the above, so the flip doesn't have to be
   threaded through transform composition, stroke outlining, or fill resolution.
   Do this **before** any arc-recovery pass (next).
7. **(Optional but recommended) recover circular arcs.** Every step above likely
   worked in cubic Béziers (SVG's `A` command and every simple-shape element
   expand to cubics in most tooling, paper.js included). You can ship pure
   `"cubic"` segments and `k.vector2d` will accept them — but a circle or arc
   represented as cubics tessellates to a facet approximation on export, even on
   the OCCT backend, where a symbolic `"arc"` segment gives an exact circular
   B-rep edge. If you want that fidelity: for each maximal run of consecutive
   cubic segments, fit a circle through the run's first, middle, and last
   **segment endpoints** (a three-point circle fit), then verify by sampling each
   cubic's interior and checking it stays within a tight tolerance of that fitted
   circle (something around `1e-3 × radius` is what partforge's own recovery
   uses); if it doesn't hold for the whole run, leave it as cubics rather than
   emitting a wrong arc. Split any recovered arc at 180° so the three-point form
   stays unambiguous (a full circle becomes two `"arc"` segments, not one).
8. **Write the envelope.** Emit `"units": "artwork"` (an SVG's coordinates are
   not millimetres), wrap the flat region list in a named shape —
   `"shapes": { "artwork": [ …regions… ] }` is what ingest uses — and tag every
   contour `"kind": "path"`. Give the document a `note` if it helps whoever reads
   it next, and a `source` naming the `.svg` it came from.
9. **Optionally write `bbox`.** It is no longer required, so the simplest correct
   converter omits it. If you do emit one it must be the tight bbox of the final,
   flipped regions, computed from the curve extrema rather than just endpoints
   and control points, or the document will be refused. Round every coordinate to
   a fixed, small number of decimal places (partforge's own ingest uses 6) so the
   file stays diffable and so a stored `bbox` matches a later recomputation from
   the *rounded* coordinates rather than drifting past the tolerance.

`scripts/ingest-svg.mjs` in the partforge repository is the worked reference
implementation of exactly this pipeline — it runs `partforge/ingest`'s real
`ingestSvg()` (paper.js's `importSVG` for steps 1–2 and 4–5, this repo's own
`contour-offset.js`/`stroke-outline.js` for step 3, and its own `arc-fit.js` for
step 7) inside a headless DOM (`happy-dom`, a devDependency), specifically so
that repository's own fixtures — including the worked example in §4 — are
reproducible instead of being hand-maintained blobs, and so there is a second
thing (besides this document) to check a from-scratch converter's output
against: ingest the same SVG both ways and diff the JSON.

Ingest is deterministic: the same `.svg`, ingested twice against the same
installed dependencies, produces byte-identical JSON. That is a property of the
pipeline, not of this format, and it holds for a given installed `paper` — not
across `paper` or partforge versions, which is what `version` and re-ingest exist
for.

## 7. Painting order is not modelled

Every region in an `add` shape **adds material** — there is no concept of "this
shape is painted on top of, and therefore hides, that one." An SVG that achieves
a visual hole by painting a background-colored shape *over* another shape (rather
than actually cutting a hole via a fill rule or a second subpath) will ingest as
a **solid** shape in this format, not a shape with a hole — because at the
geometry level, two overlapping filled shapes are two overlapping filled shapes,
full stop; there is no paint order left by the time union has run (§6, step 5),
and colour itself is read only as present-or-absent, never compared between
elements.

Concretely, this SVG does **not** produce a ring:

```xml
<circle cx="0" cy="0" r="10" fill="#111"/>
<circle cx="0" cy="0" r="6"  fill="white"/>   <!-- looks like a hole, isn't one -->
```

It produces one solid disc of radius 10 — the white circle's colour is irrelevant
to the geometry; it just contributes more filled area, unioned in. If you're
converting artwork that relies on this "paint-over" trick to fake a hole (a
common pattern for hand-drawn icons, since it's how they render correctly in any
raster or vector viewer), you have three ways to fix it:

- **Make it a real hole in the source artwork** — one `<path>` element with two
  subpaths (the outer boundary and the inner boundary) and `fill-rule="evenodd"`
  (or subpaths wound oppositely under `nonzero`), so ingest's own fill-rule
  resolution produces `{ outer, holes: [...] }` for that one element, per §3's
  fill-rule rule.
- **Give the file a `subtract` shape** — put the "hole" geometry in its own
  shape with `"role": "subtract"`, so the document composes correctly on its own.
  This is an edit to the JSON, not to the SVG, and does not survive a re-ingest.
- **Subtract it in the part instead of the artwork**, with an ordinary `.cut()` —
  bring in the "hole" shape as its own geometry (a second `vectors` entry, a
  named shape, or plain kernel geometry) and cut it from the artwork's `Shape2D`
  in `build`.

Note that `role` does **not** reintroduce paint order: `subtract` applies to the
whole document's composition at once, and subtracting a union is
order-independent. Two `subtract` shapes cannot be sequenced against each other.

## 8. Versioning

`version` is a plain integer, currently `1`, and validation applies **both a
floor and a ceiling**: `0`, negatives, non-integers, and anything above the
number the running partforge build understands are all refused, by name — the
error names the document's own version and the version the running build
understands, so the fix (re-ingest with a newer partforge, or upgrade the
consuming app) is never a guess. `version` is not a feature-flag field to be
partially understood; a build either knows a version fully or refuses the whole
document. `1` is the format's first and, as of this writing, only version.
