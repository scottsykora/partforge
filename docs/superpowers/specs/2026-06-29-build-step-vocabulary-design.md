# Self-describing build-step vocabulary for partforge parts — design

**Date:** 2026-06-29
**Status:** Approved (design). Vocabulary implemented in partforge (2026-06-29):
rotateX/Y/Z, rotateAbout, along, at via a shared addSugar over both backends; example
parts migrated to `at`. Drum migration is a separate Drum-Machine change.
**Repo:** `partforge` (the framework); the drum migration lands separately in `Drum-Machine`

## Goal

Make a part's **build steps** easy for an LLM to author *correctly the first time*, and
easy for a human to read — by replacing the cryptic, positional geometry operations with
a small, self-describing vocabulary.

Today the build bodies (e.g. the capstan drum's `bodies.js`/`stand.js`/`bridge.js`) are
dense with operations you must decode every time:

```js
cylinder(r, r, L).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([rp, y1, sz])
// rotate(deg, center, axis): [1,0,0]=X axis, [0,0,0]=origin → orient +Z to +Y, then place
```

Three pains, confirmed during brainstorming, are in scope:

1. **Opaque transforms** — `rotate(deg, center, axis)` with magic axis/centre vectors.
2. **The make→orient→place triple** — build a primitive, rotate to orient, translate to
   position, all spelled with raw vectors.
3. **Cut-chain mutation** — bodies built by repeated `s = s.cut(...)` reassignment.

A clearances/dimensioning vocabulary (named fits, `+0.4` magic offsets) is **out of
scope** — deliberately excluded.

**Primary optimization target: LLM-authoring correctness**, with human readability as a
strong, usually-aligned secondary.

## Decisions (from brainstorming)

1. **Optimize for LLM-authoring correctness first**, readability second.
2. **Target the three pains above** (opaque transforms, make→orient→place, cut-chains).
   Not a clearances/dimensioning vocabulary.
3. **Approach: fluent semantic ops** on the Solid handle — keep the build imperative and
   chainable, just self-describing. (Rejected: a declarative part-as-data build DSL — it
   fights the procedural reality of real parts (computed counts, `.map` over angles,
   conditional features, derive-driven dimensions) and is over-built for these pains. Also
   rejected: a hybrid `recipe(...)` helper — little gain over the existing `cutAll`/`union`,
   and a second idiom is its own cost.)
4. **Keep the capability, retire the cryptic spelling.** Some transforms genuinely need an
   arbitrary axis or non-origin centre (the drum rotates a tool about `[rp,0,0]`), so a
   general rotation must remain — but as a *legible* named-argument form, not the bare
   positional one. The new vocabulary becomes the canonical, documented authoring style.
5. **Migrate everything** to the new style; the drum migration is a pure *spelling* change
   gated on geometry-unchanged. The `partforge` PR ships the ops + tests + docs + the small
   applicable in-repo migrations; the **drum migration is a separate `Drum-Machine` change**
   against the new partforge version (the drum doesn't live in partforge).

## The op set

Five additions, all pure sugar over the existing `rotate`/`translate` primitives — so
there is no new geometry path, only new spelling.

**Axis-aligned rotation shortcuts** (rotate about a world axis through the origin):

```js
s.rotateX(deg)   s.rotateY(deg)   s.rotateZ(deg)
```

**Legible general rotation** (the escape hatch; replaces the bare positional form):

```js
s.rotateAbout({ axis, deg, through })
//   axis:    "X" | "Y" | "Z" | [x,y,z]      (a named world axis or a raw vector)
//   deg:     degrees
//   through: [x,y,z]                          (centre of rotation; default [0,0,0])
// e.g.  .rotate(angle, [rp,0,0], [0,0,1])  →  .rotateAbout({ axis: "Z", deg: angle, through: [rp,0,0] })
```

**Placement pair — collapses the make→orient→place triple:**

```js
s.along(dir)    // orient the solid's canonical +Z build-axis to point along dir
s.at([x,y,z])   // place it there (a readable alias of translate, for origin-built solids)
// e.g.  cylinder(r,r,L).rotate(-90,[0,0,0],[1,0,0]).translate([rp,y1,sz])
//          →  cylinder(r,r,L).along("+Y").at([rp, y1, sz])
```

`along(dir)` has a fixed, exact mapping (the solid's canonical build axis is **+Z** —
`cylinder`/`prism`/`revolve`/`helixSweptTube` all build along +Z from z=0):

| `dir` | rotation |
|---|---|
| `"+Z"` | identity (no rotation) |
| `"-Z"` | `rotateX(180)` |
| `"+Y"` | `rotateX(-90)`  ← exactly today's `rotate(-90,[0,0,0],[1,0,0])` |
| `"-Y"` | `rotateX(90)` |
| `"+X"` | `rotateY(90)` |
| `"-X"` | `rotateY(-90)` |

`along` rotates about the origin, so the convention is **orient-then-place**: `.along(dir).at(P)`.
`at([x,y,z])` is a readable alias of `translate([x,y,z])` (move by the vector), for the
build-at-origin-then-place convention parts already follow.

**Cut-chains** need no new op: `s.cutAll([...])` and `k.union([...])` already exist. The
migration replaces `s = s.cut(a); s = s.cut(b); …` with `s.cutAll([a, b, …])`.

`mirror("XY"|"XZ"|"YZ")` and `scale(...)` already read well and are unchanged. The
low-level `rotate(deg, center, axis)` stays as the internal primitive the sugar compiles
to, but is **retired from the authoring surface** — the guide stops teaching it and
`rotateAbout` is the blessed general form.

The entire new authoring vocabulary an LLM must learn: `rotateX/Y/Z`, `rotateAbout`,
`along`, `at` — plus the already-existing `cutAll`/`union`. Small and closed.

## Architecture: where it lives & why it's safe

Both backends already funnel every Solid they return through a `wrap(...)` factory
(`manifold-backend.js`, `occt-backend.js`). A new shared module
**`src/framework/geometry/solid-sugar.js`** exports `addSugar(solid)`, which attaches the
five methods to a wrapped Solid, each defined purely in terms of that solid's existing
`rotate`/`translate`. Both backends' `wrap` funnel their result through `addSugar`.

- **One definition, both backends.** Manifold and OCCT get identical sugar from the same
  code — no duplicated transform math to drift.
- **Geometry-identical by construction.** The sugar compiles to the exact `rotate`/`translate`
  calls authors write by hand today (`along("+Y")` *is* `rotate(-90,[0,0,0],[1,0,0])`), so
  there is no new geometry path to validate — which is what makes the migration low-risk.
- **Fluent + consume-safe.** Each sugar method returns the primitive's result re-funnelled
  through `wrap`/`addSugar`, so chaining stays fluent and respects replicad's
  consume-on-transform rule (every op already returns a fresh solid).

The kernel `@typedef` (`kernel.js`) `Solid` gains the five method signatures; `rotate`
keeps its signature with an "internal primitive — prefer rotateX/Y/Z/rotateAbout" note.

## Migration (geometry-unchanged)

The drum's build modules (`bodies.js`, `stand.js`, `bridge.js`) and the placement
transforms in `drum.js` migrate to the new vocabulary as a **pure spelling change**, in
the `Drum-Machine` repo against the new partforge version. The safety net is the existing
test suite, which is built for exactly this:

- `partforge measure` / `assemblyOverlaps` — bbox, volume, genus, no interpenetration.
- The **Manifold↔OCCT volume-parity** fixtures (`test/parity.test.js` +
  `test/fixtures/occt-volumes.json`).

Because the migration is geometry-identical, **these fixtures must not change** — a moved
measured value is the signal that a step changed geometry (a bug), not an expected update.
Workflow per module: migrate → run the geometry tests → they stay green with no fixture
regeneration; if a value moves, the spelling change wasn't faithful, so fix it.

Within `partforge` itself, the in-repo example parts only place a bore with a single
`translate`, so their migration is limited to `translate → at`. The richer vocabulary
(`along`, `rotateAbout`, `cutAll` chains) is exercised by the tests below and by the drum
migration; the docs cite the drum for the convincing before/after.

## Docs

`docs/AUTHORING-PARTS.md`:

- The **Solid API table** gains `rotateX/Y/Z`, `rotateAbout`, `along`, `at`; `rotate`
  moves to an "internal primitive — prefer the above" note.
- A new short **"Build-step style"** subsection: the make→orient→place pattern with
  `along(dir).at(P)`, `rotateAbout` for arbitrary centres, and `cutAll` for feature
  batches — with a real **before/after snippet drawn from the drum** (e.g. the tensioner
  tools). Leading examples throughout adopt the new vocabulary.

## Testing

`test/solid-sugar.test.js`:

- **Per-op equivalence** (Manifold): each sugar op yields geometry identical (volume +
  bbox, plus a sampled transformed point) to its primitive composition —
  `rotateX/Y/Z(d)` ≡ `rotate(d, [0,0,0], axisVec)`; `rotateAbout({axis:"Z",deg,through:P})`
  ≡ `rotate(deg, P, [0,0,1])`; `along(dir)` for all six directions ≡ its mapped rotation;
  `at(v)` ≡ `translate(v)`.
- **OCCT funnel check**: one op verified on the OCCT backend, confirming `occt-backend`'s
  `wrap` also routes through `addSugar` (the decorator is wired into both backends).
- **Comprehensive "mini-part both ways"**: build a small feature with the full vocabulary
  (`cylinder(...).along("+Y").at(P)` + `body.cutAll([...])`) and the same shape with raw
  `rotate(...).translate(...)` + sequential `.cut`; assert geometry-identical (volume +
  bbox). The real proof the vocabulary composes correctly — without shipping new app glue.

`demo.js` and `filleted-box.js` bore placements migrate to `.at(...)`; their existing
tests stay green (geometry unchanged), demonstrating real in-repo usage.

## Out of scope

- A clearances/fits/dimensioning vocabulary (named offsets, semantic `bore(..., fit:…)`).
- A declarative part-as-data build DSL.
- A `recipe(...)` helper (the existing `cutAll`/`union` already cover batch booleans).
- The drum migration itself (a separate `Drum-Machine` change; this spec ships the ops it
  consumes).
- Deleting the low-level `rotate` primitive (it is the substrate the sugar compiles to and
  the escape hatch for arbitrary axis/centre; only its *authoring use* is retired).
