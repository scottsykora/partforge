# SVG vector geometry (`k.svg2d`) — design

**Date:** 2026-08-29 (revised the same day — see "Revision")
**Status:** approved design, pre-implementation
**Scope:** partforge framework. A browser-side **ingest** step that converts SVG
to a documented JSON vector format, and a **runtime** op (`k.svg2d`) that places
that format as `Shape2D` geometry. Plus lint, the reference part, and docs.

No control panel and no picker. Those are phases B and C, named here only where
this design must not foreclose them.

## Revision (2026-08-29)

The first version of this spec decoded SVG **in the geometry worker**, with a
hand-rolled DOM-free parser, because the Node CLI has no DOM and a native-DOM
decoder would have meant two implementations.

Scott ruled that partforge-cloud is effectively the only real host, that the
headless CLI matters less than AGENTS.md implies, and that one code path beats
two. That inverts the trade: with a browser guaranteed at ingest,
**paper.js's `importSVG` becomes usable**, and it subsumes six of the eight
modules the first design needed.

Tasks 1–3 of the first plan (`svg-xml.js`, `svg-path.js`, `svg-transform.js` —
458 lines, built and reviewed) are superseded and deleted. `git log` holds them
if this direction disappoints.

## Goal

Make vector art a first-class geometry source. A part declares an ingested
artwork the way it declares fonts, and `k.svg2d(name, opts)` returns a `Shape2D`
that composes with every existing 2-D op:

```js
svgs: { logo: new URL("./art/logo.svg.json", import.meta.url) },

build: (k, p) => k.box({ size: [40, 40, 4] })
  .cut(k.svg2d("logo", { width: 28 }).extrude(1).translate([0, 0, 3])),
```

Because the result is an ordinary `Shape2D`, the whole downstream — union, cut,
offset, fillet, extrude, the emboss idiom from `nameplate.js` — is free.

## Architecture: one conversion, two halves

**Ingest** — `partforge/ingest`, a new published entry. DOM-required,
main-thread only, run **once per artwork** by the host:

```
SVG text
  → paper.importSVG (transforms baked, styles resolved, <use>/<defs>/CSS handled)
  → contours via paper-bridge's toContour / toOpenContour
  → outlineStroke() for stroked items
  → resolveCurveFill() per item under its own fill rule, then one union
  → flip y (SVG is y-down; the model frame is y-up)
  → arc recovery (cubic runs that are circles become symbolic arcs)
  → tight bbox, coordinates rounded
  → a VectorDocument, serialized as JSON
```

**Runtime** — the geometry worker, and that is all of it:

```
JSON → validate → scale to width|height|fit → align → k.shape2d → union
```

Nothing about the conversion is parameter-dependent, so it is done once rather
than on every regeneration. The paper boolean work — by far the most expensive
part — leaves the regen loop entirely.

### What this buys

- **`<use>`, `<defs>`, `<symbol>`, CSS `<style>` and `class=` all work**, because
  a real DOM resolves them. The first design rejected all five.
- **The runtime addition is ~70 lines** (`svg2d.js`) plus the JSON load, against
  ~1,100 lines across eight worker modules.
- **No cross-implementation drift is possible** — there is one converter.

### What it costs, accepted explicitly

- **SVG artwork can only be authored where a browser is.** `partforge
  measure|render|lint` still work on a part — they read the stored JSON — but
  nothing headless can *create* it. Mitigated by making the format normative and
  documented well enough that an agent can convert to it with its own tooling
  (see §"Documentation"); that is a requirement of this design, not a nicety.
- **paper's `importSVG` fidelity becomes the contract**, quirks included, over a
  surface partforge does not control.

## Decisions (settled with Scott, 2026-08-28/29)

1. Geometry only — no control panel, no picker.
2. **Strokes are outlined into real geometry**, not skipped.
3. **Sizing normalizes on the tight geometric bbox**, not the `viewBox`. Icons
   are padded inconsistently; viewBox-relative sizing makes two icons at the same
   nominal size look different.
4. **Conversion happens at ingest, in a browser**, and the result is stored.
5. **Symbolic arcs are recovered**, so OCCT still gets true circular B-rep edges.
6. **The JSON format is designed to be read and written by LLM agents** — explicit
   discriminators, a self-describing header, no structure inference.

## Evidence (probed 2026-08-28/29, against the installed tree)

- **`contour-offset.js` is already a port of `glenzli/paperjs-offset`** — its own
  header says so (`contour-offset.js:8-10`). That is precisely the library whose
  *other* half, `offsetStroke()`, is the canonical stroke outliner. The hard half
  is in-repo: `_offsetSegment` (exact for lines and arcs, adaptive Tiller–Hanson
  for cubics), `joinSegs` (round/chamfer/sharp with miter limit), `jointTangents`.
- **`joinSegs`' round branch already handles the 180° reversal**
  (`contour-offset.js:117-126`) with a pinned regression note: *"a zero-width
  spike dilated +1 round lost its end caps — area 20.000 where the stadium truth
  is 20+π."* That stadium **is** an open stroke with round caps.
- **`paper-bridge.js` already does open paths** — `toPaperPath(…, { open: true })`
  and `toOpenContour()`.
- **`resolveCurveFill(contours, { fillRule })` already accepts
  `"nonzero" | "evenodd"`** (`curve-fill.js:12`).
- **`arcCenterAndSweep`** (`paper-bridge.js:19`) is the three-point circle fit arc
  recovery needs.
- **Spike, 2026-08-29 (throwaway):** `paper.importSVG` runs under happy-dom once
  `HTMLCanvasElement.prototype.getContext` is stubbed *before* paper's module
  load. Confirmed on a real fixture: ancestor transforms are **baked into point
  coordinates**; per-item `fillColor` / `fillRule` / `strokeWidth` / `strokeCap` /
  `strokeJoin` all survive; `fill="none"` surfaces as `fillColor === undefined`;
  `path.closed` carries open/closed; a `<circle>` under `expandShapes: true`
  becomes 4 cubics with the standard kappa handle whose **endpoints lie exactly
  on the true circle**. `importSVG` also emits one extra `Shape` leaf with
  neither fill nor stroke (the root clip), which the "skip items with no paint"
  rule drops.

## 1. The vector format

Normative. This is a **published format** — agents will read and hand-write it,
so it is explicit where the internal IR is implicit.

```json
{
  "format": "partforge-vector",
  "version": 1,
  "note": "Filled 2-D outlines for k.svg2d. Coordinates are plain numbers in the artwork's own units — k.svg2d rescales at build time. y points UP. Each region is one filled area: `outer` is its boundary and `holes` are subtracted from it. Segments run head-to-tail from `start`; each segment's `to` is the next point. The contour closes implicitly from the last `to` back to `start`.",
  "source": "emblem.svg",
  "bbox": { "minX": 4, "minY": 4, "maxX": 44, "maxY": 34 },
  "regions": [
    {
      "outer": {
        "start": [14, 14],
        "segments": [
          { "kind": "line",  "to": [34, 14] },
          { "kind": "arc",   "to": [34, 24], "through": [34.5, 19] },
          { "kind": "cubic", "to": [14, 14], "c1": [30, 10], "c2": [20, 10] }
        ]
      },
      "holes": []
    }
  ]
}
```

**Rules:**

- `format` is the literal `"partforge-vector"`; `version` is an integer, `1` here.
  A document with a different `format`, or a `version` above what the running
  build knows, is refused with a message naming both.
- `note` is free text for a human or agent reading the file cold. It is **ignored
  on load** — never parsed, never validated beyond being a string if present.
- `source` is provenance only (the original filename, or `null`).
- Coordinates are `[x, y]` number pairs in the artwork's own units, **y-up**, and
  are rounded to 6 decimals at ingest so files stay diffable.
- Segment `kind` is one of `"line"`, `"arc"`, `"cubic"`. Every segment has `to`.
  An `arc` additionally has `through` — **a point the arc passes through**, not a
  control point. A `cubic` additionally has `c1` and `c2`.
- A contour is **implicitly closed**: the last segment's `to` connects back to
  `start`. A final `to` equal to `start` is tolerated and dropped on load.
- Winding: `outer` is CCW, each hole is CW, in the y-up frame. This is the storage
  invariant the rest of the engine already uses.
- `bbox` is the tight geometric bounding box of `regions`. It is a **cache, not an
  authority**: `svg2d.js` recomputes it, and a mismatch beyond tolerance is a
  validation error rather than something to trust.

`through` is named for the reader, not for symmetry with the internal IR (which
calls the same point `via`). The internal name reads ambiguously — control point?
tangent? — and this format's audience includes agents hand-writing files, where
that ambiguity is an error rate. A three-line mapping on load pays for it.

### Validation

`vector-format.js` validates on load and throws with a **position and a fix**,
because hand-written documents will be wrong in ordinary ways:

```
svg2d: "emblem" region 1, outer segment 3 has "kind": "arc" but no "through"
point — an arc needs a point it passes through, between the previous point
and "to"
```

Validation is not optional and not best-effort. An invalid document fails the
build loudly rather than producing partial geometry.

## 2. Ingest

`partforge/ingest` exports one function:

```js
ingestSvg(svgText, { strokes = "outline", source = null } = {}) → VectorDocument
```

It is DOM-dependent and must never be reachable from the worker graph. The host
calls it, stores the result, and owns the storage — the same division as
`fontCatalog`. partforge does not write files.

`strokes: "ignore"` drops stroke geometry, keeping fills only. It lives here
rather than on `k.svg2d` because after ingest there are no strokes left to
ignore.

### Item walk

`importSVG(svgText, { expandShapes: true, insert: false })`, then walk the item
tree. Each leaf with paint contributes:

- **fill** (`fillColor` set) — `resolveCurveFill` over the item's own subpaths,
  under the item's `fillRule`. Per item, not per subpath: a fill rule applies
  across an item's own subpaths, which is what makes the counter of an "O" a hole.
- **stroke** (`strokeColor` set and `strokeWidth > 0`) — `outlineStroke` per
  subpath, with the item's `strokeCap`/`strokeJoin`.

An item with neither is skipped, which is also what drops `importSVG`'s root clip
`Shape`.

All resulting regions union under one final `resolveCurveFill(…, "nonzero")`.

### Ordering (load-bearing)

Strokes are outlined **before** the bbox is measured, in artwork units. Measuring
fills first and outlining afterwards would leave stroke thickness fixed while the
artwork scaled — the same icon at 28 mm and 60 mm with identical stroke weight,
wrong in a way only noticed when someone changes `width`.

The y flip happens **after** paper has baked transforms and **before** arc
recovery and the bbox.

### Named non-semantics

Painting order is **not** modelled. Every painted item contributes material and
the results union. An SVG that fakes a hole by painting a background-coloured
shape over another gives a solid shape, not a hole. Documented in
`VECTOR-FORMAT.md` and in ERROR-PATTERNS, because it is the one divergence from
"looks like my editor" that a user cannot debug by eye.

Colour is read only as present-or-absent. This produces geometry, not paint.

## 3. Arc recovery

paper has no arc primitive — everything it returns is cubic. A pure
`Contour → Contour` pass recovers circular arcs afterwards, which is better than
special-casing `<circle>` because it works uniformly on arcs from `<circle>`, from
`A` commands, from rounded-rect corners, and from arcs that survived a transform.

For each maximal run of consecutive cubic segments:

1. Fit a circle through three of the run's **segment endpoints** — its first, its
   middle, and its last — using `arcCenterAndSweep`. Endpoints are exact: paper's
   kappa construction pins a cubic's endpoints to the true circle, so the fit
   recovers the original circle to float precision. The approximation error lives
   only in each cubic's interior, which is what step 2 measures.
2. Verify: sample each cubic's interior and require every sample within
   `ARC_TOL = 1e-3 × radius` of the fitted circle. This threshold is above paper's
   own kappa error (≈2.7e-4·r, so a tighter tolerance would reject genuine
   circles) and far below anything that would mistake a freeform curve for an arc.
3. Emit arcs split at **≤180° each**, so the three-point representation stays
   unambiguous. A full circle becomes two semicircles.

Greedy: extend a run while the fit holds, then emit and start the next. A run that
fails verification is left as cubics.

## 4. Strokes

Per SVG semantics a stroke is applied in the element's local user space; paper has
already baked transforms by the time we outline, so outlining operates on final
coordinates.

`stroke-outline.js` implements `offsetStroke` on the engine already in
`contour-offset.js`:

- **closed contour** — offset `+w/2`, and offset the *reversed* contour `+w/2`.
  Two rings of opposite handedness give an annulus under nonzero winding. This is
  `_offsetContour` twice, adding no geometry code.
- **open contour** — the same two offsets as open *chains*, joined end to end by
  caps into one closed ring, then normalized through
  `resolveCurveFill(…, "nonzero")` (a stroke that crosses itself makes that ring
  self-intersecting).

`_offsetContour` assumes an explicitly-closed ring (`contour-offset.js:129`), so
the open case gets a small purpose-built chain walker built from the same
lower-level parts (`_offsetSegment`, and `joinSegs` once exported). It is not a
modification of `_offsetContour`: that function is ring-oriented throughout —
wrap-around indexing, a whole-ring collapse predicate, an overlap-side trim gate
with pinned performance numbers — and threading an "open" flag through it would
put every one of those invariants at risk for no gain.

| SVG `stroke-linecap` | Implementation |
|---|---|
| `round` | the arc `joinSegs` already emits for a 180° reversal |
| `butt` | a straight segment between the two offset endpoints |
| `square` | extend both endpoints by `w/2` along the tangent, then `butt` |

`stroke-linejoin` maps 1:1 onto `joinSegs`' `corners` argument (`miter`→`sharp`,
`bevel`→`chamfer`, `round`→`round`).

**`stroke-miterlimit` is resolved but NOT applied, and that is a recorded
limitation.** `joinSegs` carries a fixed `MITER_LIMIT = 2`
(`contour-offset.js:89`) and takes no parameter for it; threading one through
would change a signature shared with the whole offset engine for a nuance visible
only on corners sharper than about 60°. SVG's default is 4, so affected corners
bevel slightly earlier than a browser draws them.

## 5. The runtime op

```js
k.svg2d(name, {
  width?, height?, fit?,   // mm — exactly one required
  align?  = "center",      // "left" | "center" | "right"
  valign? = "middle",      // "top" | "middle" | "bottom"
}) → Shape2D
```

`name` is a declared `svgs` key; an undeclared name throws, mirroring `text2d`'s
unknown-font error and `k.import`'s unknown-name error.

**Exactly one of `width`/`height`/`fit` is required, with no default** — a
deliberate asymmetry with `text2d`'s `size = 10`. Cap height is a well-defined
physical metric of a font; an artwork's units mean nothing, so any default would
silently produce wrong-scaled geometry. `fit` sizes the longer bbox edge. Scaling
is always uniform. `align`/`valign` place the tight bbox relative to the origin,
with the same vocabulary and defaults as `text2d`.

There is no `strokes` or `fillRule` option: both moved to ingest, where the
decisions are actually made.

## 6. Declaration, registration, caching

`svgs` is a `{ name: source }` map on the PartDefinition — exactly the `fonts` and
`imports` grammar, resolved on the shared `asset-resolve.js` core (bytes, URL,
`URL` instance, or a thunk; memoized by source identity). The source resolves to
**JSON**, not SVG.

The `new URL("./art/x.svg.json", import.meta.url)` form is the one to document:
Vite turns it into a bundled asset URL, and in Node it is a `file:` URL that
`src/testing/assets.js` reads off disk. A bare `() => import("./x.json")` works in
Vite and fails in the CLI.

`svgs` is a static object in this phase — no function-of-params form. That form
exists so a control can drive the value; there is no control yet. Phase B adds it.

Registration mirrors fonts and imports: `jobs.js` registers the parsed documents
on `kernel._svgs` in the async pre-phase, and prunes names the declaration no
longer supplies (a kernel outlives a job, so a stale name would stay resolvable).

**No content digest.** It looks like a missing piece next to `imports.js`; it is
not. `k.svg2d` lowers to `k.shape2d(regions)` and the `Shape2D` hash keys on the
actual coordinates, so different artwork gives a different cache entry
automatically. Imports need a digest because a `Solid` master is registered by
name and is opaque to that hash; a parsed vector document is not. This is the
same argument `kernel-front.js:117-121` records for `text2d`.

Purity holds trivially: parsing is a pure function of bytes.

## 7. Backends

`k.svg2d` is backend-agnostic because it lowers to `k.shape2d`, which both
backends implement (`test/shape2d-occt.test.js` covers OCCT). Nothing
probe-routes; `ROUTED_CAD_OPS` is unchanged. Arc recovery is what makes the
curve-native promise hold across the split: arcs stay arcs, so OCCT builds exact
B-rep circles and Manifold tessellates the same spec.

## 8. Lint

A new `lint/rules-svg.js`, two rules, mirroring `rules-fonts.js`' scope discipline
(static, no kernel boot, no execution):

- **`svg-unknown-name`** (error) — `k.svg2d("foo")` with a literal string argument
  the part's `svgs` field does not declare. Parallel to `import-unknown-name`.
- **`svg-size-missing`** (error) — a `k.svg2d` call whose options object literal
  carries none of `width`/`height`/`fit`.

Both judge only literal arguments; a computed name or options object is skipped
and still fails correctly at build time. `partforge/lint` keeps its
zero-runtime-dependency guarantee.

## 9. Testing

**Pure unit tests, no WASM:**

- `vector-format` — validation of every malformed shape (bad `format`, future
  `version`, unknown `kind`, arc without `through`, cubic without `c2`, non-numeric
  coordinate, bbox mismatch), each asserting the message names the position; and
  round-tripping internal regions → JSON → internal.
- `arc-fit` — a paper-style 4-cubic circle collapses to arcs with the exact
  original centre and radius; an ellipse does **not** collapse; a freeform curve
  does not collapse; a partial arc run collapses while its neighbours stay cubic;
  arcs are split at ≤180°.
- `stroke-outline` — **the stadium: a straight open segment of length 10 stroked at
  width 2 with round caps has area `20 + π`.** That is the exact figure `joinSegs`'
  comment pins, and it is what proves the caps survived. Plus butt/square caps,
  each linejoin, a closed contour becoming outer+hole, and a collapse throwing.
- `svg2d` — each of `width`/`height`/`fit`; omitting all three throwing;
  align/valign placement; the tight bbox ignoring padding.

**DOM tests (happy-dom):**

- `svg-ingest` — transforms baked; `fill="none"` + stroke giving stroke geometry
  only; `evenodd` making a hole where `nonzero` does not; overlapping shapes
  unioning rather than double-counting; `<use>`/`<defs>`/CSS `class=` all resolving
  (the capability this architecture bought); stroke width scaling with the artwork;
  a circle surviving as arcs end-to-end.
- The canvas-context stub belongs in `test/setup/happy-dom-patches.js`, which runs
  before test-module imports — that lets ingest tests use a plain static import.

**Integration:**

- A reference part, `src/parts/emblem.js`, with a checked-in ingested JSON
  exercising a filled shape *and* a stroked open shape, plus a `verify` block.
  Built through the CLI so the whole runtime path is proven headlessly.
- A cross-backend area/bbox test in the `shape2d-occt` style.
- `test/worker-layering.test.js` must keep passing. It also proves — implicitly but
  completely — that `partforge/ingest` is unreachable from the worker graph: the
  ingest path uses `document`, and the test fails the build if any module in the
  worker's import closure so much as names it.

## 10. Documentation

- **`docs/VECTOR-FORMAT.md`** (new, normative, shipped in `package.json`'s
  `files`) — the schema, a worked example, the line/arc/cubic rules, winding, the
  y convention, and a **"converting an SVG to this by hand"** section covering
  what is not obvious: the y flip, hole winding, stroke outlining, fill rules, and
  the painting-order non-semantics. This section is what makes the loss of
  headless creation acceptable, so it is a requirement, not an appendix.
- **AUTHORING-PARTS.md** — a "Vector art (SVG)" section after `k.text2d`, the
  `svgs` field in the PartDefinition table, the ingest story, and the lint rules in
  the rule catalog. The aspirational "imported SVG" reference at line 1231 becomes
  a real cross-reference.
- **ERROR-PATTERNS.md** — `svg-unknown-name`, `svg-size-required`,
  `svg-invalid-document`, `svg-stroke-collapsed`, `svg-no-geometry`, and
  `svg-painting-order` (which has no error text — it is a "why does my part look
  wrong" entry).
- **KERNEL-CONTRACT.md** — `svg2d` in the op list with its conformance class.
  `test/kernel-contract.test.js` holds this to the code, so it is not optional.
- **skills/partforge/SKILL.md** — `svg2d` in the op vocabulary.

## Rollout

Per AGENTS.md: **bump `package.json` on this branch, as part of the PR.** The
publish workflow tags and publishes on merge; forgetting the bump fails quietly.
Minor bump: `0.91.0` → `0.92.0`. `package.json` also gains the
`./ingest` export and `docs/VECTOR-FORMAT.md` in `files`.

## Out of scope (explicitly)

- Writing the ingested file. The host owns storage.
- **Shipped** headless ingest — no `partforge` CLI subcommand, and no browser
  dependency in the published package. A dev-only `scripts/ingest-svg.mjs` running
  on the existing happy-dom **devDependency** does exist: it regenerates this
  repo's own fixtures and doubles as a worked reference implementation for anyone
  converting artwork with their own tooling. It is not in `package.json`'s `files`
  and nothing shipped imports it.
- `<text>` — an SVG-embedded typeface is `k.text2d`'s job.
- Raster `<image>`, gradients, opacity, colour of any kind.
- Painting-order occlusion (§2).
- Re-ingest staleness detection. A stored document that no longer matches its
  `source` file is not detected; `source` is provenance for a human, not a check.
- **Phase B** — `type: "svg"` control, drag-drop, upload, `pfc-asset:` vendoring.
- **Phase C** — `svgCatalog` provider, icon picker, Noun Project. Noted for
  whoever picks it up: Noun Project asset URLs expire within ~an hour, so a picked
  URL can never be the persisted value — and this architecture already answers
  that, since the pick is ingested to JSON in the browser at pick time.

## Open items carried into planning

1. **Inline-object form of an `svgs` source.** A document could be written
   literally into the part instead of referenced as a file. Deferred: the file
   form keeps part sources readable and reuses `asset-resolve.js` unchanged.
2. **Whether `bbox` should be optional in the format.** It is required in v1 and
   validated against a recomputation. If hand-authoring proves that annoying,
   making it optional is a backward-compatible v1 change.
