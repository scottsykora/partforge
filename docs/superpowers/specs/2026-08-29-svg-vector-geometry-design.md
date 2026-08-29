# SVG vector geometry (`k.svg2d`) — design

**Date:** 2026-08-29
**Status:** approved design, pre-implementation
**Scope:** partforge framework, **worker/geometry layer only** — the author
surface (`svgs` declaration, `k.svg2d`), the decoder, stroke outlining, lint,
CLI, docs. No control panel, no picker, no host seams.

This is **phase A** of a three-phase feature. Phases B (`type: "svg"` control
with drag-drop/upload) and C (`svgCatalog` provider + icon picker, e.g. Noun
Project) are named here **only** where A's surface must not foreclose them.

## Goal

Make vector art a first-class geometry source. A part declares SVG files the
way it already declares fonts, and `k.svg2d(name, opts)` returns a `Shape2D`
that composes with every existing 2-D op:

```js
svgs: { logo: () => import("./art/logo.svg") },

build: (k, p) => k.box({ size: [40, 40, 4] })
  .cut(k.svg2d("logo", { width: 28 }).extrude(1).translate([0, 0, 3])),
```

Because the result is an ordinary `Shape2D`, the entire downstream — union,
cut, offset, fillet, extrude, the emboss/deboss idiom from `nameplate.js` — is
free. That is the whole reason this phase is worth shipping alone: it delivers
the capability with none of the UI surface area.

## Decisions (settled with Scott, 2026-08-28/29)

1. **Phase A only.** Geometry, no panel. Testable end-to-end from the CLI.
2. **Strokes are supported** — not deferred, not error-on-encounter. Line-style
   icons are too large a share of real artwork to exclude.
3. **Sizing normalizes on the tight geometric bbox**, not the `viewBox`. Icons
   are padded inconsistently; viewBox-relative sizing makes two icons at the
   same nominal size look different.
4. **No `<use>`, `<defs>`, or CSS** (`<style>` blocks, `class=`) in v1.
5. **Decode runs in the worker, DOM-free.** Not on the main thread, not behind
   a host crossover.

## Evidence (probed 2026-08-28, against the installed tree)

Recorded because three of these overturn the obvious approach:

- **`paper-core.js` ships the full SVG importer** (`importSVG`,
  `node_modules/paper/dist/paper-core.js:15604`) and it is **unusable here**:
  line 15616 is `new self.DOMParser().parseFromString(...)`, and the importer
  then walks real DOM nodes. No `DOMParser` in a Web Worker, none in Node — so
  it fails in the worker *and* in the `partforge measure|render|lint` CLI, which
  is the agent-facing surface CI gates on.
- **paper.js cannot outline strokes.** `importSVG` imports stroke *style* and
  yields the centreline path. Stroke outlining has been an open paper.js
  request since 2013 (paperjs/paper.js#371).
- **`contour-offset.js` is already a port of `glenzli/paperjs-offset`** — its
  own header says so (`src/framework/geometry/contour-offset.js:8-10`). That is
  precisely the library whose *other* half, `offsetStroke()`, is the canonical
  stroke outliner. The hard half is in-repo: `_offsetSegment` (exact for lines
  and arcs, adaptive Tiller–Hanson for cubics), `joinSegs` (round/chamfer/sharp
  with miter limit), `jointTangents`.
- **`joinSegs`' round branch already handles the 180° reversal**
  (`contour-offset.js:117-126`) with a pinned regression note: *"a zero-width
  spike dilated +1 round lost its end caps — area 20.000 where the stadium
  truth is 20+π."* That stadium **is** an open stroke with round caps. The
  nastiest case in this geometry is already found and fixed.
- **`paper-bridge.js` already does open paths** — `toPaperPath(scope, contour,
  segMap, { open: true })` and `toOpenContour()` (`paper-bridge.js:64`, `:128`).
- **`resolveCurveFill(contours, { fillRule })` already accepts
  `"nonzero" | "evenodd"`** (`curve-fill.js:12`). Built for OpenType, which only
  ever needs nonzero; it is exactly SVG's `fill-rule`.
- **`shape2d-regions.js` already has the elliptical-arc math** — `sampleSvgArc`
  (W3C SVG 1.1 F.6 endpoint→centre) and `svgPathToRings`. Its curve-native twin
  `svgPathToContours` was written and then deleted for having no caller
  (`shape2d-regions.js:112`). This feature is that caller.
- **`worker-layering.test.js:62` greps worker-graph module *source* for
  `document`/`window`.** The DOM-free boundary is mechanically enforced, not a
  convention.

## Why the worker, and not the main thread

Recorded because it was asked and the reasoning is non-obvious.

The DOM only helps if we use the **native** `DOMParser`. But the CLI runs in
pure Node, so a native-DOM decoder forces a second implementation there
(`linkedom`/`jsdom`) — the browser and `partforge measure` then free to disagree
about the same icon, which is the exact failure class the backend-identical
discipline exists to prevent. And once a shim dependency is acceptable, it runs
in the worker anyway, so the thread move buys nothing.

The cost side is concrete: the STEP-on-Manifold crossover — the existing
"worker can't do this, the host arranges it" pattern — is spread across
`mount.js:807`, `export-controller.js:60`, `capture-build.js:48` and
`imports.js:72`, with jobId claiming, prime-state tracking, retry and two
documented failure modes. Host-side decode would also oblige *every* entry point
(`mount.js`, `bin/cli.js`, `src/testing/`, `scripts/check-app.mjs`,
partforge-cloud) to implement it, where today `runWorker(part)` is the whole
story. It would additionally force pre-decoded contours through
`partforge/oracle`, a published surface whose DOM-free closure is pinned by
`test/oracle-entry.test.js` and by the closed oracle package's peer contract.

Decisive point: **decision 4 removed the features a real DOM earns its keep on.**
`<use>` resolution, node cloning and CSS cascade are what `getElementById` /
`getComputedStyle` are for. Without them, decoding is walking children and
reading attributes.

If v2 ever needs a real cascade, the STEP crossover is the pattern to copy then.

## Module layout

The modularity requirement, made concrete. Every new file is a **pure leaf** —
DOM-free, `three`-free, `node:`-free, WASM-free — with one job and a
one-directional dependency edge. Each is unit-testable without booting a kernel.

| New file (`src/framework/geometry/`) | Job | Depends on |
|---|---|---|
| `svg-xml.js` | bytes → element tree (`{tag, attrs, children}`) | — |
| `svg-path.js` | `d` string → contours, incl. `A` → cubics | `polygon.js` (`pathProfile`) |
| `svg-transform.js` | `transform=` → 2×3 matrix; compose; apply | `paper-bridge.js` (arc→cubic) |
| `svg-shapes.js` | `rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon` → contours | `polygon.js` |
| `svg-style.js` | presentation attributes → resolved style | — |
| `svg-doc.js` | tree → flat `[{ contours, style, closed }]` in user units | the five above |
| `stroke-outline.js` | open/closed contour + stroke style → regions | `contour-offset.js`, `paper-bridge.js` |
| `svg2d.js` | document + opts → `[{ outer, holes }]` in mm | `svg-doc.js`, `stroke-outline.js`, `curve-fill.js` |

| Changed file | Change |
|---|---|
| `src/framework/svgs.js` *(new, framework root)* | declared sources → decoded documents; ~30 lines on `asset-resolve.js` |
| `geometry/kernel-front.js` | `k._svgs ??= new Map()` and a ~6-line `k.svg2d` |
| `jobs.js` | register `k._svgs` in the async pre-phase, beside fonts/imports |
| `lint/rules-svg.js` *(new)* | two static rules |

The shape deliberately mirrors `text2d`: a pure layout leaf (`text2d.js`) plus
six lines in `kernel-front.js` (`:156-162`). `svg2d.js` is `text2d.js`'s
sibling, and `k.svg2d` is `k.text2d`'s.

**One dependency decision:** `svg-xml.js` is **hand-rolled** (~120 lines) rather
than taking `svg-parser`/`svgson`. Reasons: no new runtime dependency inside the
worker import closure (which `worker-layering.test.js` guards jealously); we
need a strict subset with no DTD, no entities beyond the five predefined, and
namespace prefixes simply stripped; and the hostile-input surface stays ours to
bound. **Tripwire:** if the parser exceeds ~200 lines or needs entity/CDATA
handling to pass the corpus in §9, stop and take `svg-parser` instead — it is
DOM-free and would drop in behind the same interface.

## 1. Author surface

### `svgs` declaration

Exactly the `fonts`/`imports` grammar, one level up in the contract:

```js
svgs: {
  logo: () => import("./art/logo.svg"),        // Vite bundles → { default: url } → fetched
  badge: "https://cdn.example.com/badge.svg",  // URL fetch
  inline: someUint8Array,                      // bytes
},
```

Resolved by `svgs.js` on `asset-resolve.js`'s shared core — same source grammar,
same identity memoization, same `{ default: url }` dynamic-import handling. A
third caller of a core that already has two.

Unlike `fonts`, **`svgs` is a static object in phase A** — no function-of-params
form. That form exists so a `type: "font"` control can drive the value; there is
no control yet. Phase B adds it, and adds it the same way.

### `k.svg2d(name, opts)`

```js
k.svg2d(name, {
  width?, height?, fit?,        // mm — exactly one required
  align?   = "center",          // "left" | "center" | "right"
  valign?  = "middle",          // "top" | "middle" | "bottom"
  strokes? = "outline",         // "outline" | "ignore"
  fillRule?,                    // override the document's own rule
}) → Shape2D
```

`name` is a declared `svgs` key. An undeclared name throws, mirroring
`text2d`'s unknown-font error and `k.import`'s unknown-name error. No
inline-bytes form in phase A (see Open items).

## 2. Sizing

**Exactly one of `width` / `height` / `fit` is required.** There is no default,
and this is a deliberate asymmetry with `text2d`'s `size = 10`.

`text2d` can default because cap height is a well-defined physical metric of a
font. An SVG's user units mean nothing — the same icon ships as `viewBox="0 0
24 24"` or `"0 0 512 512"` — so any default would silently produce
wrong-scaled geometry. Omitting all three throws `svg-size-required`, naming
the three options.

- `width: mm` — scale so the tight bbox is this wide
- `height: mm` — so it is this tall
- `fit: mm` — so the **longer** bbox edge is this

Always a uniform scale; aspect is preserved. `align`/`valign` place the tight
bbox relative to the origin, with the same vocabulary and defaults as `text2d`,
so the two ops feel like siblings.

### Ordering (load-bearing)

The pipeline order is fixed and is **not** the obvious one:

1. decode to contours **in SVG user units**, carrying each element's style;
2. **outline strokes**, in user units;
3. assemble regions (§5);
4. compute the tight bbox of the **final** regions;
5. apply the uniform scale and the alignment translate.

Outlining before measuring is what makes stroke width scale with the artwork.
Measuring the fill geometry first and then outlining at the authored width
would leave a 28 mm icon and a 60 mm icon with identical stroke thickness —
visibly wrong, and wrong in a way that only shows up when someone changes
`width`.

## 3. The document subset

**Admitted:** `<svg>`, `<g>`, `<path>`, `<rect>` (incl. `rx`/`ry`), `<circle>`,
`<ellipse>`, `<line>`, `<polyline>`, `<polygon>`. `transform=` on any of them.
Presentation attributes `fill`, `fill-rule`, `stroke`, `stroke-width`,
`stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `display`. `viewBox`.

**Path data:** the full `d` grammar — absolute *and* relative commands, and the
`H`/`V`/`S`/`T` shorthands. Real-world SVGs are almost entirely relative (SVGO
minifies to them), so `svg-path.js` normalizes to absolute before emitting
contours. `A` reuses the centre-parameterization already proven in
`sampleSvgArc`, emitting curve-native cubics rather than sampled points.

**Ignored silently:** `fill`/`stroke` *colours* (this produces geometry, not
paint), `opacity`, gradients, `<title>`/`<desc>`/`<metadata>`, XML comments,
namespace prefixes, unknown attributes.

**Rejected loudly** (`svg-unsupported-element`, naming the tag): `<use>`,
`<defs>`, `<symbol>`, `<style>`, `<text>`, `<image>`, `<clipPath>`, `<mask>`,
`<filter>`, and `class=`. Loud rather than silent because each of these
*removes* geometry the author can see in their editor — a silent skip produces
a part that is quietly missing a shape.

### Named non-semantics

Painting order is **not** modelled. Every admitted element contributes material
and the results union (§5). An SVG that fakes a hole by painting a white shape
over a black one will produce a solid shape, not a hole. Documented in
AUTHORING-PARTS and in the error-pattern entry, because it is the one
divergence from "looks like my editor" that a user cannot debug by eye.

### Transforms and arcs

`svg-transform.js` composes ancestor `transform=` attributes into one 2×3
matrix per element. Applying it needs care: an arc (`{to, via}`) under a
**non-uniform or skewed** matrix becomes an ellipse, which the contour IR
cannot represent. So `applyMatrix` checks uniformity and, when the matrix is
non-uniform, degrades arcs to cubics first via `arcToCubicSegments` (already in
`paper-bridge.js:40`) — cubics being closed under affine transform. Uniform
matrices keep arcs symbolic, so OCCT still gets true circular edges.

## 4. Strokes

Per SVG semantics a stroke is applied in the element's **local** user space and
the result is then transformed. Outlining locally is therefore both simpler and
more correct than outlining after transform, and it sidesteps the non-uniform
stroke-ellipticity problem entirely.

`stroke-outline.js` implements `offsetStroke` on the engine already in
`contour-offset.js`:

- **closed contour** — offset `+w/2` and `−w/2`; the outer becomes the region
  outer and the inner becomes a hole. This is `_offsetContour` twice, unchanged.
- **open contour** — offset `+w/2`, offset `−w/2`, reverse the second, cap both
  ends, and close into a single ring. A stroke path that crosses itself makes
  that ring self-intersecting, so it is normalized through `resolveCurveFill`
  (nonzero) — the same resolver §5 already uses, not a second mechanism.

`_offsetContour` currently assumes an explicitly-closed ring
(`contour-offset.js:129`). The open case needs a sibling — call it
`_offsetOpenChain` — that reuses the interior-vertex join loop verbatim and
differs only in dropping the wrap-around join and emitting caps at the two ends.

Cap mapping, all onto existing machinery:

| SVG `stroke-linecap` | Implementation |
|---|---|
| `round` | the arc `joinSegs` already emits for a 180° reversal |
| `butt` | a straight segment between the two offset endpoints |
| `square` | extend both endpoints by `w/2` along the tangent, then `butt` |

`stroke-linejoin` maps 1:1 onto `joinSegs`' existing `corners` argument
(`miter`→`sharp`, `bevel`→`chamfer`, `round`→`round`).

**`stroke-miterlimit` is resolved but not applied, and that is a recorded
limitation.** `joinSegs` carries a fixed `MITER_LIMIT = 2`
(`contour-offset.js:89`) and takes no parameter for it; threading one through
would change a signature shared with the whole offset engine for a nuance that
shows only on corners sharper than about 60 degrees. SVG's default is 4, so
affected corners bevel slightly earlier than a browser would draw them. The
style resolver keeps the value so a later change has somewhere to read it from.

`stroke-width` defaults to `1` user unit per the SVG spec when `stroke` is set
without it. `strokes: "ignore"` skips outlining entirely, which is the escape
hatch for artwork whose strokes are decorative.

A stroke whose offset collapses throws through `contour-offset.js`'s existing
collapse path, surfaced as `svg-stroke-collapsed`.

## 5. Fill rules and region assembly

Each element is resolved **independently** with its own fill rule, then all
elements' regions are unioned.

Per-element is the correct grain: a single `<path>` with multiple subpaths
relies on the fill rule *within* that path to make its counters (a donut, the
inside of an "O"), so the rule cannot be applied across elements. Union across
elements matches the "every element contributes material" semantics of §3.

An element contributes up to two independent region sets — its **fill** (when
`fill` is not `none`) and its **stroke outline** (when `stroke` is set and
`strokes: "outline"`) — which union like any others.

Fill rule precedence: `opts.fillRule` if given, else the element's own
`fill-rule` attribute, else `nonzero` (the SVG default). This is all existing
capability in `resolveCurveFill`; the only new thing is plumbing the per-element
value through.

An SVG that resolves to no regions at all throws `svg-no-geometry` rather than
returning an empty `Shape2D` — the `text2d` precedent
(`kernel-front.js:160`), and the same reasoning: an empty shape fails later and
further away.

## 6. Registration, caching, purity

`svgs.js` resolves each declared source to bytes (memoized by source identity
in `asset-resolve.js`), decodes bytes → text via `TextDecoder` (present in
workers and Node), and decodes text → document. The decode is pure over bytes
and memoized alongside.

`jobs.js` registers the resolved map on `k._svgs` in the async pre-phase,
beside the existing font and import registration — gated on the part *declaring*
`svgs` at all, exactly as the font branch is gated on `part.fonts`
(`jobs.js:190`), so a part with no `svgs` field never touches the map.

**No separate geometry cache and no content digest are needed.** `k.svg2d`
lowers to `k.shape2d(regions)`, and the `Shape2D` hash keys on the actual
coordinates — different artwork gives different coordinates gives a different
cache entry, automatically. This is the same argument `kernel-front.js:117-121`
records for `text2d`, and the reason `svg2d` does **not** need the digest
machinery `imports` carries (imports need it because a `Solid` master is
registered on the kernel by name, opaque to the hash).

Purity holds trivially: decode is a pure function of bytes, so `build` stays a
pure function of `(k, p, d)`.

## 7. Backends

`k.svg2d` is backend-agnostic by construction because it lowers to `k.shape2d`,
which both backends implement (`test/shape2d-occt.test.js` covers the OCCT
side). Nothing in this feature probe-routes, and `ROUTED_CAD_OPS` is unchanged.

Curve-native output is what makes this hold: arcs stay arcs and cubics stay
cubics through the whole pipeline, so OCCT builds exact B-rep edges and Manifold
tessellates the same spec — backend-identical the same way every other
`Shape2D` op is.

## 8. Lint

A new `lint/rules-svg.js`, two rules, mirroring `rules-fonts.js`' scope
discipline (static checks only, no kernel boot, no execution):

- **`svg-unknown-name`** (error) — `k.svg2d("foo")` with a literal string
  argument that the part's `svgs` field does not declare. Directly parallel to
  `import-unknown-name`. Non-literal arguments are skipped, not guessed at.
- **`svg-size-missing`** (error) — a `k.svg2d` call whose options object literal
  carries none of `width`/`height`/`fit`. This throws at build time anyway; the
  lint rule moves it to before the kernel boots.

`partforge/lint` keeps its zero-runtime-dependency guarantee — both rules read
only the part module's source and its `svgs` field.

## 9. Testing

**Pure unit tests, no WASM, one file per leaf:**

- `svg-xml` — nested elements, self-closing tags, attribute quoting, namespace
  prefixes stripped, malformed input throwing rather than hanging.
- `svg-path` — relative commands, `H`/`V`/`S`/`T` shorthands, implicit repeated
  commands, `A` checked against `sampleSvgArc` as the truth oracle (semicircle
  and full-circle cases, which is where a three-point arc fit degenerates),
  malformed `d` throwing.
- `svg-transform` — matrix composition through nested `<g>`; **arcs degrade to
  cubics under a non-uniform matrix and stay arcs under a uniform one**.
- `svg-shapes` — each element type; `rect` with and without `rx`/`ry`.
- `svg-style` — inheritance through `<g>`, `stroke-width` defaulting, `display:none`.
- `stroke-outline` — **the stadium regression: a straight open segment of length
  10 stroked at width 2 with round caps has area `20 + π`.** This is the exact
  figure `joinSegs`' comment pins, and it is the test that proves the caps
  survived. Plus butt/square caps, each linejoin, a closed contour becoming
  outer+hole, and a collapse throwing.
- `svg2d` — each of `width`/`height`/`fit`; omitting all three throwing;
  align/valign placement; **stroke width scaling with the artwork** (the §2
  ordering guarantee — the same icon at two sizes has proportional stroke).

**Integration:**

- A new reference part, `src/parts/emblem.js`, with a small bundled SVG that
  exercises a filled path *and* a stroked open path, plus a `verify` block
  asserting the bbox. Built through the CLI (`npx partforge measure
  src/parts/emblem.js`) so the whole path is proven with no browser. Added to
  `docs/REFERENCE-PARTS.md` as the SVG reference part, and to the CI app list.
- A cross-backend area test in the `shape2d-occt` style: the same SVG yields
  matching region area on both kernels.
- `test/worker-layering.test.js` needs no new guard — it walks the import
  closure, so the new files are covered the moment `jobs.js` reaches them. Its
  passing **is** the DOM-free assertion.

## 10. Docs

- **AUTHORING-PARTS.md** — a "Vector art (SVG)" section immediately after the
  `k.text2d` section, structured as its sibling: the op, the `svgs` field,
  sizing, the admitted subset, strokes, and the named non-semantics of §3. The
  aspirational "imported SVG" reference at `AUTHORING-PARTS.md:1231` becomes a
  real cross-reference. The `svgs` field joins the `PartDefinition` table at the
  top, next to `fonts` and `imports`.
- **ERROR-PATTERNS.md** — one `##` per pattern: `svg-unknown-name`,
  `svg-unsupported-element`, `svg-no-geometry`, `svg-size-required`,
  `svg-stroke-collapsed`, `svg-malformed`, and `svg-painting-order` (the
  white-shape-over-black case from §3, which has no error to attach to and is
  purely a "why does my part look wrong" entry).
- **KERNEL-CONTRACT.md** — `svg2d` added to the op list and its conformance
  class recorded (both backends, via `shape2d`). Its version header and op
  coverage are held to the code by `test/kernel-contract.test.js`, so this is
  not optional.
- **skills/partforge/SKILL.md** — `svg2d` in the op vocabulary.

## Rollout

Per AGENTS.md: **bump `package.json` on this branch, as part of the PR.** The
publish workflow tags and publishes on merge; forgetting the bump fails quietly
— the merge lands and the work never ships. Minor bump (new author-facing
surface, no breaking change): `0.91.0` → `0.92.0`.

Downstream, partforge-cloud pins `^<version>` and regenerates its prompt corpus
against the installed package, so let the publish finish before bumping there.

## Out of scope (explicitly)

- `<use>`, `<defs>`, `<symbol>`, CSS `<style>`/`class` — decision 4.
- `<text>` — an SVG-embedded typeface is `k.text2d`'s job, not this one.
- `<image>`, gradients, opacity, colour of any kind. This op produces geometry.
- Painting-order occlusion (§3).
- Elliptical stroke profiles from non-uniform ancestor transforms — §4 outlines
  in local space, which is correct per spec; the residual case is an artwork
  that scales a stroked group non-uniformly, and it renders as a
  uniformly-stroked shape under that scale.
- **Phase B** — `type: "svg"` control, drag-drop, upload, `pfc-asset:` vendoring.
- **Phase C** — `svgCatalog` provider seam, icon picker, Noun Project. Noted
  for whoever picks it up: Noun Project asset URLs expire within ~an hour, so a
  picked URL can never be the persisted param value — vendoring is a day-one
  requirement there, not an optimization.

## Open items carried into planning

1. **Inline-bytes form of `k.svg2d`.** `text2d` accepts either a declared name
   or raw bytes. `k.svg2d` takes a name only in phase A, matching `k.import`.
   Worth revisiting if a generated-SVG use case appears; not speculating now.
2. **Whether `fit` should acquire a default** once real parts exist. §2 argues
   no; revisit only with evidence from authored parts.
3. **`svg-xml.js` hand-rolled vs. `svg-parser`.** Decided hand-rolled, with the
   explicit tripwire in the Module layout section. Planning should treat the
   swap as a known, cheap contingency rather than a redesign.
