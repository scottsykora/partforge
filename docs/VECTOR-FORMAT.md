# The `partforge-vector` format

Normative. This is the file format `k.svg2d` reads. It is designed to be read
**and hand-written** by an agent with no access to partforge's source — that is
not a courtesy, it is the condition under which partforge ships no headless SVG
conversion path (see "Why this file exists," below). If you have an SVG and a
way to run your own geometry code, this document alone should be enough to
produce a document `k.svg2d` accepts.

## 1. What this is

`partforge/ingest` is a small, DOM-dependent, browser-only function:

```js
ingestSvg(svgText, { strokes?, source? }) → VectorDocument
```

It converts an SVG document into this JSON format, **once**, in a browser. The
host (the app embedding partforge, or a human) runs it, stores the resulting
JSON file next to the part, and never runs it again unless the artwork changes.
`k.svg2d(name, opts)` — the runtime half, which runs on every build, on both
geometry backends, headlessly — reads that stored JSON and turns it into a
`Shape2D`:

```js
svgs: { emblem: new URL("./assets/emblem.svg.json", import.meta.url) },
build: (k, p) => k.svg2d("emblem", { width: 30 }).extrude({ h: 1 }),
```

**Why this file exists:** ingest needs a real DOM (it resolves `<use>`,
`<defs>`, CSS, and bakes ancestor transforms, all of which require one), so
partforge deliberately ships no headless CLI subcommand to produce this format
— `partforge measure|render|lint` read a part's *already-ingested* JSON, but
nothing headless can *create* it from an `.svg`. That trade was accepted only
because this format is documented well enough for someone (or some agent)
without a browser, and without reading partforge's source, to write a
compliant converter of their own. `scripts/ingest-svg.mjs` (dev-only, not
shipped) is the reference implementation, described in §5 below.

## 2. A complete worked example

`src/parts/assets/emblem.svg` is partforge's own reference artwork:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="10" fill="#111"/>
  <polyline points="6 42 42 42" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/>
</svg>
```

One filled circle, and one **stroked, open** polyline — deliberately, so this
one file exercises both of ingest's geometry paths (a fill, and a stroke that
has to be outlined into a filled shape; see §5). Ingesting it
(`node scripts/ingest-svg.mjs src/parts/assets/emblem.svg`) produces
`src/parts/assets/emblem.svg.json`, checked in beside it. Here it is with the
`note` field elided for brevity — nothing else is shortened:

```json
{
  "format": "partforge-vector",
  "version": 1,
  "source": "emblem.svg",
  "bbox": { "minX": 4, "minY": -44, "maxX": 44, "maxY": -14 },
  "regions": [
    {
      "outer": {
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
```

Notice, and this is the point of using a real file rather than a hand-picked
one:

- **The `<circle>` survived as three arcs**, not the 4-cubic Bézier
  approximation a naive converter would emit — this is arc recovery (§5)
  working as intended, and it is why OCCT still gets true circular B-rep edges
  from an SVG circle.
- **The stroked polyline became a closed, filled region** — two arcs (the
  round caps) and two lines (the long sides) — even though the source SVG has
  `fill="none"` and no closing segment. A stroke is never a line in this
  format; see §5.
- **y is negative where the SVG artwork sits below its own origin.** SVG's
  `cy="24"` became `y: -24`: ingest flips y by literal negation (`y → -y`),
  not by mirroring within the `viewBox`. See §4.
- This fixture's two regions both happen to have **no holes**, and every
  segment is either `"line"` or `"arc"` — it never needed a `"cubic"` segment.
  §3 below adds a small synthetic example (not from this fixture) for the two
  things this real file doesn't demonstrate: a hole, and a `"cubic"` segment.

## 3. Schema

```json
{
  "format": "partforge-vector",
  "version": 1,
  "note": "free text, ignored on load",
  "source": "logo.svg",
  "bbox": { "minX": 0, "minY": 0, "maxX": 20, "maxY": 22.612305 },
  "regions": [
    {
      "outer": {
        "start": [0, 0],
        "segments": [
          { "kind": "line",  "to": [20, 0] },
          { "kind": "arc",   "to": [20, 20], "through": [20, 10] },
          { "kind": "cubic", "to": [0, 0],   "c1": [15, 25], "c2": [5, 25] }
        ]
      },
      "holes": [
        {
          "start": [7, 7],
          "segments": [
            { "kind": "line", "to": [7, 13] },
            { "kind": "line", "to": [13, 13] },
            { "kind": "line", "to": [13, 7] }
          ]
        }
      ]
    }
  ]
}
```

(This example is constructed for this document, not extracted from a real
SVG — it exists purely to show every field at once. It has been validated
against the actual loader, including its bbox check, so it is not merely
plausible-looking JSON: `partforge/geometry`'s `validateVectorDocument` accepts
it as written.)

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | `"partforge-vector"` | yes | Literal string. Anything else is refused, naming both the found and expected value. |
| `version` | integer | yes | `1` today. A document whose `version` exceeds what the running partforge build understands is refused **by name** — the error names both the document's version and the version the build understands — rather than guessed at. |
| `note` | string | no | Free text for a human or agent reading the file cold. **Ignored on load** — never parsed, never validated beyond "is a string if present." Safe to omit, safe to put anything readable in. |
| `source` | string \| `null` | yes (may be `null`) | Provenance only — typically the original `.svg` filename. Not used for anything at load or build time; not a staleness check (a `source` file that has since changed is not detected — see §7). |
| `bbox` | `{minX, minY, maxX, maxY}` | yes | The **tight geometric bounding box of `regions`** — every field a finite number. See §4: it is a cache, not an authority, and is validated against a fresh recomputation. |
| `regions` | array, ≥1 | yes | Each region is one filled area: `{ outer, holes? }`. An empty `regions` array is refused — a vector file needs at least one filled region. |
| `regions[].outer` | contour | yes | The region's boundary. |
| `regions[].holes` | array of contour | no (default `[]`) | Subtracted from `outer`. |

A **contour** is `{ start: [x, y], segments: [...] }`, with **at least two
segments** (a closed shape needs at least two segments once you account for
the implicit closing edge — see §4). Every segment has a `kind` and a `to`;
`kind` determines what else it carries:

| `kind` | Extra fields | Meaning |
|---|---|---|
| `"line"` | — | A straight edge from the previous point to `to`. |
| `"arc"` | `through: [x, y]` | A circular arc from the previous point to `to`, **passing through `through`**. |
| `"cubic"` | `c1: [x, y]`, `c2: [x, y]` | A cubic Bézier from the previous point to `to`, with control points `c1` (near the start) and `c2` (near `to`) — the standard SVG/PostScript cubic convention. |

**`through` is a point the arc passes through — not a control point, not a
tangent handle, not a centre.** Concretely: the arc from the segment's start
point `P0` to its `to` point `P1` is the unique circular arc through the three
points `P0`, `through`, `P1`. This is the same "three points determine a
circle" construction as an SVG `A` command's endpoint-parameterization, just
phrased directly in points instead of radius+flags. Two things follow from
that construction, both worth knowing before hand-writing one:

- **`through` must not be collinear with `P0` and `P1`.** Three collinear
  points don't determine a circle; a degenerate arc silently falls back to a
  straight line rather than throwing (`k.svg2d` will not error, but the corner
  you meant to round will not be rounded — this is a "why does my part look
  wrong" bug, not a crash).
- **Which side of the chord `through` sits on determines the sweep direction
  and whether the arc is the major or minor arc.** Put `through` on the actual
  path the artwork traces between `P0` and `P1`, not just "somewhere off to the
  side" — for a rounded corner that means roughly on the bisector, offset
  toward the outside of the turn; for a near-semicircle it means clearly on
  one side or the other, not near either endpoint.

## 4. Rules that are not obvious from the schema

These are the parts a schema alone won't tell you, and they are exactly the
things that go wrong when someone builds this format by hand or writes a
from-scratch converter without reading this section first.

- **y points UP.** SVG (and almost every 2-D graphics format) is y-**down**:
  larger y is lower on the page. This format's coordinate frame is y-**up**,
  matching the CAD model frame `k.svg2d` places geometry into. Converting from
  SVG means flipping y. partforge's own ingest does this by **literal
  negation** (`y → -y`), applied once, after all of an SVG's own transforms
  have already been baked into the coordinates — not by subtracting from the
  artwork's height or `viewBox` extent. Either convention actually produces
  correct final geometry through `k.svg2d`: sizing and alignment (`width` /
  `height` / `fit`, `align`, `valign`) work off the region's own tight `bbox`,
  recomputed from whatever coordinates you give it, so a constant offset in
  how you chose to flip is invisible after placement. Negation is simply the
  simplest rule to implement correctly, and it's what partforge's own ingest
  does, so it's what worked examples in this document look like.
- **Coordinates are plain numbers in the artwork's own units — not
  millimetres, not necessarily even meaningful ones.** An SVG's `viewBox` units
  might be anything from "pixels at some assumed DPI" to "arbitrary design
  units." `k.svg2d`'s `width`/`height`/`fit` option (in millimetres, exactly
  one required, no default) rescales the whole document uniformly at build
  time. This is also why the format itself has no unit field: there is nothing
  honest to put in it.
- **A contour is implicitly closed.** The last segment's `to` connects back to
  `start` — you never write a final segment whose only job is "return to
  `start`." (If you do write one anyway — a final segment whose `kind` is
  `"line"` and whose `to` equals `start` exactly — it's tolerated and silently
  dropped on load, so round-tripping a document that has one doesn't
  duplicate it. But don't rely on that path; the canonical form omits it.)
  This is also why every contour needs **at least two segments**: with the
  implicit closing edge, two explicit segments plus the closure is the fewest
  that can bound a nonzero area (a triangle).
- **Winding is a storage invariant, not a suggestion: `outer` is
  counter-clockwise, and every hole is clockwise, in the y-up frame.** This is
  the same convention the rest of partforge's contour engine uses internally
  (offset, fillet, boolean union all assume it), and `k.svg2d` does not
  re-normalize it for you — a `regions` entry with the windings backwards
  produces geometry with the outer treated as a hole and vice versa, silently,
  no error. Concretely: walking `outer`'s points in order, the signed polygon
  area (the shoelace sum, `Σ(x_i·y_{i+1} − x_{i+1}·y_i) / 2`) must be positive;
  walking a hole's points, it must be negative. If you're converting from an
  SVG fill-rule resolution rather than authoring by hand, get this from your
  own boolean/fill-rule engine's output — don't guess it after the fact.
- **`bbox` is a cache, not an authority.** `k.svg2d` (and the loader itself)
  recompute the tight bounding box of `regions` from the segment geometry —
  sampling curves, not just looking at endpoints and control points, since a
  curve's extent can exceed its endpoints — and a stored `bbox` that disagrees
  with that recomputation by more than a small tolerance is a **load-time
  error**, not a warning. There is no way to make a document with an
  intentionally-wrong `bbox` load successfully. If you're hand-authoring and
  don't want to compute this yourself, the practical move is to compute the
  geometry first, run it through partforge's own loader once (it will tell you
  the *actual* bbox in the error message if yours disagrees), and paste that
  value in — or see the open question about making `bbox` optional, noted in
  the design spec, which had not shipped as of this writing.
- **A stroke is not a line in this format — see §5.** There is no "stroked
  path" representation here at all; every stroke an SVG declares has already
  been outlined into an ordinary filled `outer`/`holes` region by the time it
  reaches this JSON. If you're looking at a document and wondering why a thin
  line in the source artwork turned into a thin closed ribbon shape here, that
  is expected and is not a bug.
- **A fill rule applies across one element's own subpaths, not globally.**
  SVG's `fill-rule` (`nonzero` — the default — or `evenodd`) is a property of
  a single `<path>`/`<circle>`/etc. element, and it resolves *that element's*
  subpaths against each other — which is what turns the counter of a letter
  "O" into a hole instead of a second filled disc. Two *different* elements
  that happen to overlap are never resolved against each other by a fill
  rule; they are unioned (every painted element adds material — see §6). If
  your source SVG has one `<path d="…">` with two subpaths (an outer ring and
  an inner ring) and `fill-rule="evenodd"`, that is one `regions` entry with a
  hole. If it instead has two separate `<circle>` elements, that's never a
  hole no matter what `fill-rule` either one declares — it's two overlapping
  filled regions that union into one bigger filled region.

## 5. Converting an SVG to this format by hand

If you're writing your own converter (no browser, no paper.js, no partforge
source), these are the steps in the order that avoids the mistakes above,
followed by the one already-written reference to check your output against.

1. **Resolve everything the SVG defers** — `<use>`/`<defs>`/`<symbol>`
   references, CSS `class=`/`<style>` rules, and every ancestor `transform`
   (`<svg>`, `<g>`, and the element itself) — down to concrete, final `(x, y)`
   coordinates per element. This is the step a real DOM does for you almost
   for free (which is why partforge's own ingest requires a browser); doing it
   by hand means implementing SVG's transform-composition and CSS cascade
   rules, or using a library that already has.
2. **For each element that paints, decide fill vs. stroke vs. both**, per
   SVG's own paint model: an element with a `fill` (anything but `none`, the
   default is `black`) contributes filled geometry; an element with a `stroke`
   set and a nonzero `stroke-width` contributes stroke geometry; an element
   can do both, or neither (in which case it contributes nothing and is
   skipped — no error, it's just not painted).
3. **Outline every stroke into a filled shape.** A stroke of width `w` becomes
   the region swept by a `w`-wide pen along the path: offset the path by
   `+w/2` on each side (for a closed path, this gives an outer ring and an
   inner ring — an annulus; for an open path, the two offset sides are joined
   at the ends by caps per `stroke-linecap` — `butt`, `round`, or `square` —
   and at interior corners per `stroke-linejoin` — `miter`, `round`, or
   `bevel`). Do this **before** measuring anything against the artwork's
   scale, and in the same units the rest of the element's geometry is already
   in (i.e., after transforms are baked in, per step 1) — outlining after a
   later rescale would leave the stroke's *thickness* keyed to the wrong
   scale, which is a bug that only shows up when someone changes the `width`
   your artwork is placed at.
4. **Resolve each element's own fill under its own fill rule** — nonzero or
   evenodd, defaulting to nonzero — across that element's own subpaths only
   (§4's fill-rule rule). Do this per element, not globally.
5. **Union everything** — every element's resolved fill regions and every
   element's outlined stroke regions, across the whole document — into one
   flat list of non-overlapping `{outer, holes}` regions. This is an ordinary
   planar boolean union under nonzero winding; it is also the step that
   silently discards painting order (§6).
6. **Flip y** (§4) — after all of the above, so the flip doesn't have to be
   threaded through transform composition, stroke outlining, or fill
   resolution. Do this **before** any arc-recovery pass (next) — flipping
   after arc recovery reverses winding relative to what your fill resolution
   already decided, which corrupts hole/outer classification without
   necessarily crashing anything.
7. **(Optional but recommended) recover circular arcs.** Every step above
   likely worked in cubic Béziers (SVG's `A` command and every simple-shape
   element expand to cubics in most tooling, paper.js included). You can ship
   pure `"cubic"` segments and `k.svg2d` will accept them — but a circle or
   arc represented as cubics tessellates to a facet approximation on export,
   even on the OCCT backend, where a symbolic `"arc"` segment gives an exact
   circular B-rep edge. If you want that fidelity: for each maximal run of
   consecutive cubic segments, fit a circle through the run's first, middle,
   and last **segment endpoints** (a three-point circle fit), then verify by
   sampling each cubic's interior and checking it stays within a tight
   tolerance of that fitted circle (something around `1e-3 × radius` is what
   partforge's own recovery uses); if it doesn't hold for the whole run, leave
   it as cubics rather than emitting a wrong arc. Split any recovered arc at
   180° so the three-point form stays unambiguous (a full circle becomes two
   `"arc"` segments, not one).
8. **Compute the tight bbox** of the final, flipped `regions` — sampling
   curves, not just their endpoints/control points — and write it into
   `bbox`. Round every coordinate to a fixed, small number of decimal places
   (partforge's own ingest uses 6) so the file stays diffable and so the
   stored `bbox` matches a later recomputation from the *rounded* coordinates
   exactly, rather than drifting by a rounding residual that trips the load-time
   bbox check (§4).

`scripts/ingest-svg.mjs` in the partforge repository is the worked reference
implementation of exactly this pipeline — it runs `partforge/ingest`'s real
`ingestSvg()` (paper.js's `importSVG` for steps 1–2 and 4–5, this repo's own
`contour-offset.js`/`stroke-outline.js` for step 3, and its own
`arc-fit.js` for step 7) inside a headless DOM (`happy-dom`, a
devDependency), specifically so that repository's own fixtures — including the
worked example in §2 — are reproducible instead of being hand-maintained
blobs, and so there is a second thing (besides this document) to check a
from-scratch converter's output against: ingest the same SVG both ways and
diff the JSON.

## 6. Painting order is not modelled

Every region in `regions` **adds material** — there is no concept of "this
shape is painted on top of, and therefore hides, that one." An SVG that
achieves a visual hole by painting a background-colored shape *over* another
shape (rather than actually cutting a hole via a fill rule or a second
subpath) will ingest as a **solid** shape in this format, not a shape with a
hole — because at the geometry level, two overlapping filled shapes are two
overlapping filled shapes, full stop; there is no "paint order" left by the
time union has run (§5, step 5), and colour itself is read only as
present-or-absent, never compared between elements.

Concretely, this SVG does **not** produce a ring:

```xml
<circle cx="0" cy="0" r="10" fill="#111"/>
<circle cx="0" cy="0" r="6"  fill="white"/>   <!-- looks like a hole, isn't one -->
```

It produces one solid disc of radius 10 — the white circle's colour is
irrelevant to the geometry; it just contributes more filled area, unioned in.
If you're converting artwork that relies on this "paint-over" trick to fake a
hole (a common pattern for hand-drawn icons, since it's how they render
correctly in any raster or vector viewer), you have two ways to fix it before
it reaches this format:

- **Make it a real hole in the source artwork** — one `<path>` element with
  two subpaths (the outer boundary and the inner boundary) and
  `fill-rule="evenodd"` (or subpaths wound oppositely under `nonzero`), so
  ingest's own fill-rule resolution produces `{ outer, holes: [...] }` for
  that one element, per §4's fill-rule rule.
- **Subtract it in the part instead of the artwork**, with an ordinary
  `.cut()` — bring in the "hole" shape as its own geometry (a second `svgs`
  entry, or plain kernel geometry) and cut it from the artwork's `Shape2D` in
  `build`, rather than expecting ingest to infer the subtraction from paint
  order.

## 7. Versioning

`version` is a plain integer, currently `1`. A document whose `version` is
higher than the number the running partforge build understands is **refused**,
by name — the error names both the document's own version and the version the
running build understands, so the fix (re-ingest with a newer partforge, or
upgrade the consuming app) is never a guess. `version` is not a feature-flag
field to be partially understood; a build either knows a version fully or
refuses the whole document. There is no `0`; `1` is the format's first and, as
of this writing, only version.
