# Contour authoring (`partforge-vector` v1, `k.vector2d`) — design

**Status:** approved by Scott, 2026-08-29. Supersedes parts of
`2026-08-29-svg-vector-geometry-design.md` (see "Relationship to the earlier
spec"). Lands on the same branch, before PR #183 merges.

## Goal

Make `partforge-vector` a first-class way to author a `Shape2D` — not only the
output of an SVG conversion — so an agent can write 2-D geometry as JSON, edit
it, and compose the pieces, while SVG import stays a deterministic path into the
same format.

Two success criteria, in Scott's words:

1. **Contour authoring is easy for an LLM.** An agent with this format's
   documentation and no access to partforge's source can write a correct
   document on the first try, and can change it later by editing the thing it
   means to change — a radius, a centre — rather than recomputing derived
   values.
2. **SVG import is deterministic.** The same `.svg`, ingested twice against the
   same installed dependencies, produces byte-identical JSON.

Criterion 1 is what the current format fails; criterion 2 already holds and must
survive the changes.

## Relationship to the earlier spec

`2026-08-29-svg-vector-geometry-design.md` remains the authority for the
conversion pipeline: the ingest architecture and its browser requirement (§2),
arc recovery (§3), stroke outlining (§4), backend behaviour (§7), and the
rationale for shipping no headless SVG conversion. None of that changes.

This spec **replaces** its §1 (the vector format), §5 (the runtime op), §6
(declaration and registration), and §8 (lint), and amends §9–§10 (testing and
documentation) accordingly.

## Why now, and why on this branch

The format has never shipped. Verified 2026-08-29:

- `origin/main` contains no `src/framework/geometry/vector-format.js`.
- The published `partforge@0.92.0` tarball contains no vector, `svg2d`, or
  ingest files.
- PR #183 is open and unmerged.

So `partforge-vector` v1 has zero users and no back-compatibility obligation,
and `k.svg2d` has no deprecation cost. That is true only until #183 merges.
Landing this design on the same branch means one format, one loader, one op, and
no legacy dialect; landing it after means a v1 the loader accepts forever, a
`svg2d` alias, and a compatibility section in a normative document describing a
version nobody used.

**The branch's version bump is also stale and must be corrected.** `origin/main`
is already at `0.92.0` and npm has `0.92.0`; the branch bumps to the same
number. As it stands, merging #183 would publish nothing and the feature would
never ship — the quiet failure `AGENTS.md` describes. The branch goes to
`0.93.0`.

## Decisions (settled with Scott, 2026-08-29)

| Question | Decision |
|---|---|
| What do an authored document's coordinates mean? | Millimetres, placed as authored. Ingested artwork stays unitless and keeps mandatory sizing. |
| Where is composition expressed? | Named shapes per document; composition in `build` via ordinary `Shape2D` booleans. No op-graph in JSON. |
| Primitives in the format? | Yes — `circle`, `rect` (with optional corner radius), `polygon`, alongside the explicit `path`. No per-contour transform. |
| Sequencing | Fold into PR #183 before merge. |

## Evidence (probed 2026-08-29, against the branch)

Three findings from reading and running the shipped code drive requirements
below. Each was measured, not inferred.

- **A stored `bbox` is never read for geometry.** `placeRegions`
  (`svg2d.js:54`) calls `regionsBbox(regions)` fresh. The stored value is
  compared against a recomputation in `validateVectorDocument` and used for
  nothing else. Making it optional therefore costs no capability.
- **The stored `bbox` makes hand editing a round trip.** Moving one coordinate
  by `0.01` in an otherwise valid document is refused:
  `svg2d: "logo" file has a bbox that disagrees with its geometry (maxX: header
  10, actual 10.01)`. Computing the replacement requires analytic curve
  extrema, which is why `VECTOR-FORMAT.md` currently advises pasting the number
  out of the error message.
- **Stored winding carries no information, and the current documentation is
  wrong about it.** `k.svg2d` lowers through `k.shape2d`, whose `liftRegions`
  runs `ensureRegionWinding` — that forces `outer` counter-clockwise and every
  hole clockwise *structurally*, from the `outer`/`holes` labels, ignoring the
  stored winding. Measured: a 10×10 square with a 4×4 hole yields area `84`
  with the documented winding and `84` with both contours reversed.
  `VECTOR-FORMAT.md` §4 currently states that reversed winding "produces
  geometry with the outer treated as a hole and vice versa, silently, no
  error." That is false and must be corrected — it currently instructs agents
  to compute shoelace sums they do not need, and invites them to "fix" files
  that were never broken.

## 1. The format

```json
{
  "format": "partforge-vector",
  "version": 1,
  "units": "mm",
  "note": "Front plate. Holes are M3 clearance, on a 28 mm centre distance.",
  "shapes": {
    "body": [
      { "outer": { "kind": "rect", "center": [0, 0], "width": 40, "height": 24, "radius": 4 } }
    ],
    "holes": [
      { "outer": { "kind": "circle", "center": [-14, 0], "r": 1.7 } },
      { "outer": { "kind": "circle", "center": [ 14, 0], "r": 1.7 } }
    ]
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | `"partforge-vector"` | yes | Unchanged. |
| `version` | integer | yes | `1`. Validation gains a **floor**: `version < 1` is refused, closing the current gap where `0` and negatives load. |
| `units` | `"mm"` \| `"artwork"` | yes | No default — see §3. Ingest writes `"artwork"`. |
| `note` | string | no | Free text, ignored on load. Authored documents keep their own; only ingest writes `FORMAT_NOTE`. |
| `source` | string | **no** (was required-but-nullable) | Provenance only. Omit for authored documents. |
| `bbox` | `{minX,minY,maxX,maxY}` | **no** (was required) | A checksum, not an authority — see §5. |
| `shapes` | object, ≥1 entry | yes | Name → array of regions. Replaces the flat `regions` array. |

A **shape** is an array of regions (≥1). A **region** is `{ outer, holes? }`. A
**contour** is one of the four `kind`s in §2.

A document carrying the old flat `regions` array instead of `shapes` is refused
**by name** — `has a "regions" array, which this build does not read; regions now
live under a named shape in "shapes"` — rather than failing as "has no shapes".
Nothing has shipped, so this exists for hand-written files and stale drafts, not
for migration.

Shape names are ordinary JSON keys. Iteration order for the default union is the
document's own key order, which `JSON.parse` preserves for non-integer-like
keys; §4 makes the union order-independent anyway.

### Segments

Unchanged from the branch. Every segment has `kind` and `to`; `"line"` carries
nothing more, `"arc"` carries `through` (a point the arc passes *through*), and
`"cubic"` carries `c1` and `c2`. The `through` naming and its two gotchas
(collinearity degenerates to a line; which side of the chord decides sweep and
major/minor) stay exactly as documented.

## 2. Contour kinds

A contour is tagged with `kind`, the same discriminator segments already use, so
the format has one tagging rule rather than two.

| `kind` | Fields | Expansion |
|---|---|---|
| `"path"` | `start`, `segments` (≥2) | The explicit form — today's contour. `kind` becomes **required**; ingest emits it. |
| `"circle"` | `center`, `r` | Two 180° arcs. |
| `"rect"` | `center`, `width`, `height`, `radius?` | Four lines, or four lines and four 90° arcs when `radius > 0`. |
| `"polygon"` | `points` (≥3) | One line segment per point. |

**Expansion happens in `vector-format.js`, at the JSON→internal boundary.**
Nothing downstream — `placeRegions`, `Shape2D`, either backend, the exporters —
learns that primitives exist. This preserves the property that file's header
claims for itself: it is the only place the two vocabularies meet.

**`circle` and `rect` expand counter-clockwise by construction, including when
used as a hole; `polygon` follows the author's own point order.** Neither needs
to know which role it fills, precisely because of the winding finding above:
`ensureRegionWinding` reorients from the `outer`/`holes` labels, so a primitive
never needs to know which role it is filling. It is also the reason the format
does not offer a winding or direction field on primitives.

### Normative expansion

Let `c = center`. Coordinates are y-up.

- **`circle`** — `r` must be finite and `> 0`.
  `start = [cx + r, cy]`, segments:
  `{arc, to: [cx − r, cy], through: [cx, cy + r]}`,
  `{arc, to: [cx + r, cy], through: [cx, cy − r]}`.
  The final segment's `to` equals `start`; it is retained (the closure-dropping
  rule in `toContour` applies only to a final *line*), so the implicit closing
  edge is zero-length. This is the same shape the ingested `emblem` circle
  already takes.
- **`rect`** — `width`, `height` finite and `> 0`; `radius` optional, finite,
  `≥ 0`. With `radius` absent or `0`: `start` at the bottom-left corner, then
  lines to bottom-right, top-right, top-left. With `radius > 0`: the eight
  segments of a rounded rectangle, corner arcs specified by their `through`
  point at 45° on the corner-arc's own circle. **`radius > min(width, height) / 2`
  is refused**, naming the maximum — not clamped. A format loader has no warning
  channel, and a radius past half the shorter side is a typo, not a request. At
  exactly `min(width, height) / 2` two of the four edges are zero-length; the
  expansion **omits any line segment whose endpoints coincide**, so a square with
  `radius = width / 2` expands to four arcs rather than four arcs and two
  degenerate lines.
- **`polygon`** — `points` an array of ≥3 finite `[x, y]` pairs. `start` is
  `points[0]`; one `"line"` segment per remaining point; the closing edge is
  implicit.

Validation errors name the shape, region, role, and index, e.g.
`vector2d: "plate" shape "holes" region 2 outer has "kind": "circle" but a
non-positive r (0)`.

## 3. Units and placement

`units` is required and has no default, matching how `k.svg2d` already refuses
to guess a size.

| | `units: "mm"` | `units: "artwork"` |
|---|---|---|
| Coordinates mean | millimetres | nothing physical |
| Scale | `1` unless a size option is given | exactly one of `width`/`height`/`fit`, **required** |
| Placement | as authored (no translate) | bbox centre to the origin |

One formula covers both: **scale uniformly about the document origin, then
translate per `align`/`valign`.** "As authored" is the no-translate case. For
`units: "artwork"` the defaults are `align: "center"`, `valign: "middle"`,
reproducing today's behaviour exactly; for `units: "mm"` the default is no
translate, and `align`/`valign` still apply when given explicitly.

Two tightenings while this code is being touched:

- **More than one of `width`/`height`/`fit` is refused.** Today `scaleFor`
  silently prefers `width`, then `height`, then `fit`. Every other option in
  this feature refuses rather than guesses.
- `align`/`valign` already refuse unrecognized values; that stays.

Scaling an `mm` document is legitimate (a drawing reused at another size), so a
size option on an `mm` document is accepted, not refused.

## 4. Named shapes

`shapes` replaces the flat `regions` array.

- `k.vector2d("plate")` — the union of every shape in the document. Single-shape
  documents therefore never mention a name, and ingested artwork behaves exactly
  as it does today.
- `k.vector2d("plate", { shape: "holes" })` — one shape. An unknown name throws,
  listing the names the document does declare.

Union is commutative and the regions within a document are already
non-overlapping per shape, so the default union is independent of key order.

Ingest emits a single shape named `"artwork"`.

### Roles (added 2026-08-30, after review)

A shape may declare `role`: `"add"` (the default) or `"subtract"`.

`k.vector2d(name)` with no `shape` returns the **composed** result — the union of
every `add` shape, minus the union of every `subtract` shape — rather than a
naive union of everything. `k.vector2d(name, { shape })` returns that shape's own
geometry whatever its role: naming a shape explicitly is a request for that
geometry, and role governs only the default composition.

**Why this exists.** Without it a document is not self-describing. Reading
`plate.vector.json` and finding `body`, `holes`, and `keyway`, you cannot tell
that the last two are subtracted — that fact lives in `build`. `role` lets the
file state its own intent without becoming a language: there is no evaluation
order to reason about (union is commutative, and subtracting a union is
order-independent), no references between documents, and no cycles. It is the
middle ground between the flat union this spec originally described and the
op-graph §"Out of scope" still declines.

`role` is optional where `units` is required, and the difference is principled:
`"add"` is an honest default because a painted region adds material, which is
what every existing document already means. `units` has no honest default
because artwork coordinates have no physical meaning.

**A document must declare at least one `add` shape.** An all-`subtract`
document composes to nothing, and returning an empty `Shape2D` from the default
call would surface much later as an empty extrude. Refused at load, by name.

**`bbox` still covers every region, `subtract` shapes included.** It is a
checksum over the file's stored geometry, not over the composed result — a
`subtract` shape that extends past the `add` shapes still counts toward it.

Composition is ordinary `Shape2D` algebra in `build`, which is what makes
`units: "mm"` load-bearing — the pieces share the drawing's coordinate frame, so
a cut lands where the drawing says it lands:

```js
vectors: { plate: new URL("./assets/plate.vector.json", import.meta.url) },
build: (k) =>
  k.vector2d("plate", { shape: "body" })
   .cut(k.vector2d("plate", { shape: "holes" }))
   .extrude({ h: 3 }),
```

**Non-goal:** `k.shape2d` does not learn the JSON dialect, and there is no
inline document form in `build`. Inline authoring stays `pathProfile`. The two
vocabularies remain separated by the file boundary.

## 5. `bbox` becomes optional

- **Absent:** computed from the geometry. This is the authored case.
- **Present:** validated against a fresh recomputation exactly as today, same
  `BBOX_TOL` of `1e-3`, same error text. This is the generated case, and the
  integrity check that catches a truncated or hand-mangled ingest output is
  retained in full.

Ingest keeps writing `bbox`. Authored documents omit it, and the loader never
asks an author to compute a value it recomputes anyway.

## 6. Runtime surface

`vectors: { name: source }` on the `PartDefinition`, and
`k.vector2d(name, opts?)` returning a `Shape2D`. Options: `shape?`, `width?`,
`height?`, `fit?`, `align?`, `valign?`.

`svgs:` and `k.svg2d` are **removed**, not aliased — nothing has shipped. The
probe's `SHAPE2D_YIELDING_KERNEL_OPS` entry and `kernel.js`'s op-name list
follow the rename.

Registration, caching, and preload timing are unchanged from the earlier spec's
§6: the same source grammar as `fonts`/`imports`, the same
resolve-before-synchronous-build discipline, the same two memos (bytes by
source, parsed document by bytes), the same stale-name prune, and still no
content digest — `k.vector2d` lowers to `k.shape2d`, whose hash keys on
coordinates.

`partforge/ingest` and `ingestSvg` keep their names: they really do ingest SVG.

## 7. Ingest changes

Ingest's geometry is untouched. Only what it writes changes: `units:
"artwork"`, `shapes: { artwork: [...] }`, `kind: "path"` on every contour, and
`bbox` as before. `fromInternalRegions` gains the shape name and units as
parameters.

Because ingest emits `"artwork"` units, ingested artwork keeps requiring a size
at every call site — the property that made `k.svg2d` refuse a default in the
first place.

## 8. Determinism of SVG import

**Requirement.** Ingesting the same `.svg` twice, in the same process and
against the same installed dependencies, produces byte-identical JSON.

This already holds and must be preserved. It rests on: paper.js's traversal
being deterministic, region emission following document order, fixed 6-decimal
rounding, and arc recovery being a deterministic greedy pass with a fixed
tolerance. Nothing in this design introduces an ordering or floating-point
choice — primitives are an authoring-side feature that ingest never emits.

**Scope, stated honestly.** Determinism is guaranteed for a given installed
`paper`. It is not a guarantee across paper versions or partforge versions; that
is what `version` and re-ingest exist for. `paper` is `^0.12.18`, which npm
resolves as `<0.13.0` for a `0.x` version, so the exposure is patch releases,
and the lockfile is the practical guarantee.

**Enforcement.** Two tests: ingesting the reference artwork twice in one process
must produce identical bytes, and the checked-in `emblem` fixture must
regenerate byte-identically from its `.svg`. The second is what turns a paper
bump into a failing CI run rather than a silent geometry change.

## 9. Lint

`src/framework/lint/index.js` documents lint as **pure: no I/O, no async**, with
an import closure enforced by `test/lint-purity.test.js`, because `lintPart`
runs inside partforge-cloud's browser sandbox. A lint rule therefore cannot read
a vector document to learn its units or its shape names.

The resolution is the pattern `sources` already uses — **the caller passes the
documents in**:

```js
lintPart(part, { params, sources, vectorDocs })   // vectorDocs: { name: parsedDocument }
```

`vectorDocs` is optional and forgiving, normalized like `sources`: a malformed
value means "no document-dependent findings", never a throw. The CLI always
supplies it for readable sources, so the skip path is a host concern only; the
`--json` report gains no field for it, and the CLI contract does not widen. The CLI supplies
it (it already resolves `part.svgs` for `measure`); a host that holds the files
supplies it; anything else omits it and the dependent rules skip silently.

| Rule | Needs `vectorDocs` | Fires when |
|---|---|---|
| `vector-unknown-name` | no | `build` calls `k.vector2d` with a name `vectors` does not declare. |
| `vector-unknown-shape` | yes | A call passes `{ shape }` naming a shape the document does not contain. |
| `vector-size-missing` | yes | A call on a `units: "artwork"` document declares no size. |

`vector-size-missing` gains the units condition it could not have before —
without it the rule would fire on every correct `mm` document. It is the one
place where the document-passing seam is not optional for correctness.

Both renamed rules keep reading `probe().calls`, whose `args` are
`JSON.stringify` of resolved values, and keep the `"?` allowance in the size
regex that this basis requires.

## 10. Reference part

`src/parts/emblem.js` gains an authored document alongside its ingested one, and
cuts one against the other. One part then exercises `units: "mm"`, named shapes,
all four contour kinds, and cross-shape composition — with no new app entry,
HTML page, worker, or CI port.

The authored `plate.vector.json` uses `rect` with a corner radius for the body
and `circle` primitives for the holes, so the fixture is also the worked
example the documentation quotes.

`emblem.js`'s `verify` block extends to cover the cut: the falsification
discipline from the earlier spec applies — the gate must fail if the holes
vanish, which a bbox bound alone cannot detect. A `volume` bound does.

## 11. Renames

| From | To |
|---|---|
| `src/framework/svgs.js` | `src/framework/vectors.js` |
| `src/framework/geometry/svg2d.js` | `src/framework/geometry/vector2d.js` |
| `src/framework/lint/rules-svg.js` | `src/framework/lint/rules-vector.js` |
| `test/svg2d.test.js`, `test/svgs.test.js`, `test/lint-svg.test.js`, `test/svg2d-occt.test.js` | matching `vector*` names |
| `src/parts/assets/emblem.svg.json` | `src/parts/assets/emblem.vector.json` |
| error prefix `svg2d:` | `vector2d:` |
| `svg-unknown-name`, `svg-size-missing` | `vector-unknown-name`, `vector-size-missing` |

`src/framework/ingest/svg-ingest.js`, `src/ingest.js`, `ingestSvg`, and
`scripts/ingest-svg.mjs` keep their names.

`docs/ERROR-PATTERNS.md`'s vector entries follow the renamed error text, and the
`svg-overlapping-subpaths` entry — which documents the `curve-fill.js`
overlapping-same-winding defect found during #183 — keeps its id, since it names
an SVG ingest symptom.

## 12. Testing

Additions to the earlier spec's §9. Every new test states what it would catch.

**Format**
- `units` missing, or any value but `"mm"`/`"artwork"` → refused by name.
- `version` `0`, `-1`, and `2` → refused; `1` accepted.
- `shapes` absent, empty, or not an object → refused.
- A document with `bbox` omitted loads, and places identically to the same
  document with a correct `bbox`. *(Catches an optional-bbox implementation that
  silently changes placement.)*
- A document with a wrong `bbox` is still refused, with today's message.
  *(Catches "optional" being implemented as "ignored".)*

**Primitives**
- `circle` expands to area `πr²` within tolerance, and to two arc segments.
- `rect` with and without `radius`; `radius` exactly at `min(w,h)/2` accepted,
  just above refused, naming the maximum.
- `polygon` with 3 points accepted, 2 refused.
- A primitive used as a hole produces the hole, not a second filled region.
  *(Catches the always-CCW expansion rule being wrong.)*
- A primitive and its hand-written `path` equivalent produce equal area and
  bounds. *(Pins the normative expansion in §2.)*

**Units and placement**
- A `units: "mm"` document with no size option extrudes to exactly its authored
  bounds — coordinates in, millimetres out, no rescale, no re-centring.
- The same document with `{ width }` scales about the origin.
- A `units: "artwork"` document with no size option is refused, as today.
- Two size options together are refused. *(Catches the silent width-wins
  precedence.)*

**Named shapes**
- A two-shape document: default call unions both; `{ shape }` selects one;
  an unknown shape throws listing the available names.
- Cross-shape composition produces the expected area.

**Determinism (§8)**
- Double ingest of the reference SVG is byte-identical.
- The checked-in `emblem` fixture regenerates byte-identically.

**Unchanged and must stay green:** worker layering (`vector-format.js` and its
primitive expansion are pure leaves — DOM-free, `node:`-free, and the string
`document` must not appear in any message text), lint purity, the OCCT arc
fidelity test, and the full existing suite.

## 13. Documentation

`docs/VECTOR-FORMAT.md` is rewritten rather than amended — enough of it changes
that a patch would leave contradictions. It must:

- Lead with the authored case. The current document leads with ingest, which is
  now the secondary use.
- **Correct §4's winding section.** Say plainly that `outer`/`holes` labels
  determine orientation, that stored winding is normalized and carries no
  information, and that an author never needs a shoelace sum. This is a
  correction of a false statement, not a softening.
- Document `units`, `shapes`, all four contour `kind`s with their normative
  expansions, and `bbox` as optional.
- Keep §6 (painting order is not modelled), §7 (versioning), and the
  hand-conversion recipe, updated for the new envelope.
- Keep the property that justifies shipping no headless converter: the document
  alone is sufficient to write a compliant converter.

`docs/AUTHORING-PARTS.md` gains the authored-contour path beside `pathProfile`
and `k.text2d`, and says which to reach for: `pathProfile` for geometry computed
from parameters, an authored document for geometry that is drawn.

`AGENTS.md`, `docs/KERNEL-CONTRACT.md`, and `docs/ERROR-PATTERNS.md` follow the
rename.

## 14. Rollout

- All of it lands on `claude/svg-controls-panel-a8ab10`, before #183 merges.
- `package.json` goes to **`0.93.0`** — `0.92.0` is already published from main,
  so the branch's current bump would publish nothing.
- No deprecation window, no aliases, no v2: nothing has shipped.

## Out of scope (explicitly)

- **Controls-panel integration.** Phases B (a `type: "vector"` control with
  drag-and-drop) and C (a Noun Project picker) from the original research remain
  unstarted. This spec makes the format worth pointing a control at; it does not
  add one.
- **An op-graph in JSON.** Documents do not reference or combine other
  documents, and there is no intersect, no ordering, and no nesting. Per-shape
  `role` is deliberately the weakest thing that makes a document self-describing:
  two flat groups, both commutative. Anything that needs more than that belongs
  in `build`.
- **Per-contour transforms.** Considered and declined: they interact with the
  mm-as-authored rule and add an evaluation step to reason about, for a
  convenience an agent can meet by emitting the coordinates.
- **`k.shape2d` accepting the JSON dialect**, and any inline document form.
- **A headless SVG converter.** Unchanged from the earlier spec: ingest needs a
  DOM, and this document is the compensation.
- **The `curve-fill.js` overlapping-same-winding defect** found during #183. It
  is pinned by a known-defect test and an `ERROR-PATTERNS.md` entry, and stays
  its own piece of work.

## Open items carried into planning

- Whether the authored `plate.vector.json` belongs to `emblem` or wants its own
  reference part once the controls-panel phases land. Keeping it in `emblem` for
  now avoids a new app entry and CI port; revisit when a `type: "vector"`
  control needs somewhere to live.
