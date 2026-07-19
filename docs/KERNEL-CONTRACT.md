# The partforge kernel contract

**Contract version: 1** (introduced in partforge 0.9) — mirrored by `CONTRACT_VERSION`
in `src/framework/geometry/kernel.js` and asserted by `test/kernel-contract.test.js`;
see [Versioning](#versioning) for what may change under which version bump.

This document is the portable seam of partforge. A part's `build(k, p, d)` is a pure ESM
function written against the kernel `k` and the `Solid` handles it returns — no framework
imports, no DOM, no backend types. That means **the kernel interface is the interchange
format**: any host that implements this contract can run any partforge part, and an LLM
given this document plus one exemplar part has everything it needs to write correct
geometry. There is deliberately no separate file format or DSL.

The contract has two halves:

- **Machine-checked:** the op lists in `src/framework/geometry/kernel.js`
  (`KERNEL_OPS`, `SOLID_OPS`, `OCCT_ONLY_OPS`, `*_OPTIONAL_OPS`) and their `@typedef`
  signatures. `test/kernel-contract.test.js` and the OCCT twin in
  `test/occt-backend.test.js` assert each backend exposes exactly these ops, so the list
  cannot silently drift from the implementations. **Those lists are normative.**
- **Prose (this doc):** the semantics an implementer or generator cannot read off a
  signature — coordinate conventions, value semantics, validation rules, error taxonomy,
  what parts may and may not rely on across backends.

Audience: backend/host implementers, and anyone (human or LLM) generating parts outside
this repo. For *authoring guidance* — usage tables, worked snippets, control-panel schema
— read `docs/AUTHORING-PARTS.md`. Where the two overlap (the op tables), this doc
carries the conformance semantics and that one the usage guidance;
`test/kernel-contract.test.js` keeps this doc's op coverage in sync with the code.

## Conformance classes

**Core class.** A conforming core kernel implements every op in `KERNEL_OPS` and
every `Solid` op in `SOLID_OPS`, *except* that the B-rep ops (`fillet`, `chamfer`,
`shell` — the `OCCT_ONLY_OPS` list — and `toSTEP`) may instead throw
`KernelCapabilityError`. The in-repo Manifold backend is the reference core kernel.
Kernels built from this repo get the stubs for free: `addSugar()` generates the
Solid-level stubs from `OCCT_ONLY_OPS`, and `finishKernel()` stubs `toSTEP` (a
kernel-level op, so it is not in that Solid-op list).

**B-rep class.** Core plus native `fillet`/`chamfer`/`shell` and `toSTEP`. The in-repo
OCCT/replicad backend is the reference.

**Optional ops.** `KERNEL_OPTIONAL_OPS` (`beginSubPart`/`endSubPart`/`cacheStats`/
`resetCacheStats`/`cleanup`) and `SOLID_OPTIONAL_OPS` (`genus`/`isEmpty`) may be omitted
entirely; callers in the framework guard with `?.`/`typeof`. A host that omits them loses
sub-part caching and mesh-topology gates (`holes`, emptiness), nothing else.

`KernelCapabilityError` is a *routing signal*, not a failure: partforge's geometry-free
probe (`probe.js`) runs `build` against a fake kernel, and any use of an `OCCT_ONLY_OPS`
op routes the whole part to a B-rep-class kernel. A host with only a core kernel must
surface the error ("this part needs a B-rep backend") rather than swallow it.

## Global semantics

These hold for every op on every backend. A part may assume them; an implementation must
provide them.

- **Units are millimetres.** Everywhere, including `volume()` (mm³) and mesh output.
- **Angles are degrees.** Everywhere (`rotate*`, `twist`, `revolve` `degrees`, loft ring
  `rotate`, `arcDeg` helpers).
- **Coordinates are right-handed, Z-up.** Primitives build along **+Z from z = 0**
  (`cylinder`, `prism`, `extrude` extrude upward; `revolve` spins `[[r, z], …]` about the
  Z axis). The idiom is *build canonical at the origin, then orient/place*
  (`.along(dir).at(v)`).
- **2-D contours are `[[x, y], …]` point lists, CCW = material.** Holes in an `extrude`
  profile are additional contours; winding of holes is normalized by the backend. The
  symbolic-arc alternative is an **arc profile** `{ start, segments: [{ to, via? }, …] }`
  (produced by `roundedProfile`), where a segment with `via` is a three-point circular
  arc; B-rep backends must carry these arcs exactly (real CIRCLE edges in STEP), mesh
  backends tessellate them. Cubic Bézier segments (`{to, c1, c2}`, built via `pathProfile().cubicTo(…)`)
  follow the same rule: exact spline B-rep on OCCT (→ STEP), adaptively faceted at
  the mesh `segs` LOD on Manifold. Measure-parity (volume/bbox) holds within
  tolerance as facets converge; this is not a parity waiver.
- **Ops never mutate — but they MAY consume.** Every op returns a new `Solid` and never
  mutates one in place. Whether the *inputs stay valid* is backend-dependent: the mesh
  backend leaves them usable, but the B-rep backend's engine (replicad) deletes the
  operand of a transform or boolean. The portable rule is therefore: **never reuse a
  `Solid` after passing it to a transform or boolean — `.clone()` first if you need it
  again** (failure signature: ERROR-PATTERNS.md `replicad-consumed-operand`). `clone()`
  must return an independent handle on every backend; a backend MAY additionally provide
  full value semantics, but a portable part must not rely on it.
- **Purity and determinism: identical arguments must produce identical geometry.** No
  randomness, clocks, or hidden global state in an implementation. partforge's solid
  cache memoizes by a content hash of `(op, args)`; a nondeterministic op silently
  poisons the cache.
- **Validation** (a conforming implementation enforces all of these; in-repo the kernel
  front checks the `prism`/`extrude`/`revolve` rules, `addSugar` the `scale` rule, and
  the B-rep backend the `shell` rule): `prism`/`extrude` `scaleTop ≥ 0`; `revolve`
  profile radii `≥ 0`; `scale` `factor > 0`; `shell` requires `open` (a fully
  closed hollow is not supported).
- **Error taxonomy:** invalid arguments throw plain `Error` with a message naming the op
  (`"prism: scaleTop must be ≥ 0"`); a whole op a backend class lacks throws
  `KernelCapabilityError` (from `geometry/errors.js`) — the routing signal. A
  backend-divergent *option* (`loft`/`sweep` `closed: true` on a B-rep kernel) throws a
  plain `Error` naming the limitation, not `KernelCapabilityError`: option misuse is not
  reroutable, and a host must fail loudly rather than silently ignore the option. Beyond
  those, nothing else is thrown for well-formed input — a fillet the engine cannot
  compute falls under the repair policy below, not a part-visible error class.

## Calling convention

**Detection rule (normative):** a call is **options form** when the op receives
**exactly one argument and it is a plain object** — not an `Array`, not a `Solid`.
Any other arity or first argument is legacy positional form. "Plain object" means
`Object.getPrototypeOf(x) === Object.prototype || null`, which excludes arrays,
`Solid` handles (backend handles carry methods/prototypes), and typed arrays. This
one rule disambiguates every op with no key-sniffing — the load-bearing case:
`extrude({outer, holes}, h)` is positional (two arguments); `extrude({profile, h})`
is options (one plain object).

Options form is canonical — the form this document, `AUTHORING-PARTS.md`, and every
in-repo part teach and use. Legacy positional forms remain accepted (silently — no
runtime warning) until contract v2 removes them; a conforming implementation must
accept both, and this repo's `finishKernel()`/`addSugar()` provide the normalization
for free.

### Kernel factory ops (options-canonical; legacy positional accepted)

| Op | Canonical options form | Legacy positional (until v2) |
|---|---|---|
| `cylinder` | `{r\|d, h, center?}` straight · `{r1, r2, h, center?}` or `{d1, d2, h, center?}` cone | `(rBottom, rTop, h, {center?})` |
| `sphere` | `{r\|d}` — `sphere(5)` stays valid, undeprecated | `(r)` |
| `box` | `{size:[x,y,z], center?}` (centered X/Y, base z=0; `center:true` also centers Z) · `{min, max}` | `(min, max)` |
| `prism` | `{points, h, twist?, scaleTop?}` | `(points2D, h, {twist?,scaleTop?})` |
| `extrude` | `{profile, h, twist?, scaleTop?}` — `profile` = points array, `{outer, holes}`, or arc profile | `(profile, h, {twist?,scaleTop?})` |
| `revolve` | `{profile, degrees?}` | `(points2D, {degrees?})` |
| `loft` | `{rings, ruled?, closed?}` | `(rings, {ruled?,closed?})` |
| `sweep` | `{profile, path, closed?, cornerRadius?, ruled?, smooth?}` | `(profile2D, path3D, opts?)` |

`boredCylinder` and `helixSweptTube` were always options-only (no positional
legacy form exists); they get the same unknown-key / required-key validation as
the ops above.
`union(solids[])` and `toSTEP(named[])` take a single array — unchanged.

### Solid ops

| Op | Canonical form(s) | Notes |
|---|---|---|
| `fillet` | `fillet(3)` · `fillet({r, edges?})` | options form replaces `fillet(3, selector)` |
| `chamfer` | `chamfer(1)` · `chamfer({d, edges?})` | ditto |
| `shell` | `shell({t, open})` | replaces `(thickness, openFaces)`; `open` was already required |
| everything else | unchanged | `translate/at/along/rotate*/rotateAbout/mirror/scale/cut/cutAll/intersect/union/clone/label` + queries |

### Cylinder key rules

- Straight: exactly one of `r` / `d`. Cone: `r1`+`r2` or `d1`+`d2` (no mixing
  radius and diameter across ends; no mixing straight and cone keys).
- `h` required everywhere.
- Diameter keys are sugar: normalized to radii before the backend sees them.

### `box({size})` placement

`{size:[x,y,z]}` is centered in X and Y with its base at `z = 0` — the same
canonical placement `cylinder` already has (build canonical at the origin, then
orient/place). `{center:true}` additionally centers Z. `{min, max}` remains for
explicit corners and is unaffected.

Scalar shorthands are permanent, not legacy: `sphere(5)`, `fillet(3)`, and
`chamfer(1)` stay valid and undeprecated — they take a single number with no
transposition risk, so there is no options-form pressure to replace them (only
`fillet`/`chamfer`'s two-argument selector call is superseded, by
`fillet({r, edges})` / `chamfer({d, edges})`).

## Kernel ops (make solids)

Signatures are normative in `kernel.js`'s `@typedef GeometryKernel`; this table fixes
the behavior. Signatures are shown in the canonical options form — the legacy
positional equivalents live in the [Calling convention](#calling-convention) table
above. All ops return a `Solid`.

| Op | Contract |
|---|---|
| `cylinder({r\|d, h, center?})` · `cylinder({r1, r2, h, center?})` \| `{d1, d2, h}` | Cylinder along +Z from z = 0 (straight: exactly one of `r`/`d`); the cone form (`r1`/`r2` or `d1`/`d2` ends) gives a frustum. `center: true` centers on z = 0. |
| `boredCylinder({od, h, bore})` | Compound: cylinder of diameter `od` with a through-bore `bore`. Semantically identical to the composition in `kernel-front.js`; a backend may override only for caching, never for different geometry. |
| `sphere({r\|d})` | Sphere centered at the origin; bare `sphere(r)` stays valid. |
| `box({size, center?})` · `box({min, max})` | Axis-aligned box: `{size:[x,y,z]}` centered in X/Y with base at z = 0 (`center: true` also centers Z), or explicit `[x,y,z]` `{min, max}` corners. |
| `prism({points, h, twist?, scaleTop?})` | Extrude one CCW contour (point list or arc profile) from z = 0. `twist` = total degrees over the height; `scaleTop` = uniform top scale (1 straight, 0 → apex). |
| `extrude({profile, h, twist?, scaleTop?})` | Same, for a polygon-with-holes region — `profile` is `{outer, holes?}` (bare contour = outer only) — in one op, no per-hole boolean. `profile` may also be a `Shape2D` (see below). |
| `revolve({profile, degrees?})` | Revolve a lathe profile `[[r, z], …]` (r ≥ 0) about Z; `degrees` < 360 gives a capped partial revolve. Default 360. |
| `loft({rings, ruled?, closed?})` | Stack polygon cross-sections (per-ring `z`/`rotate`/`scale`, equal vertex counts) with ruled walls and capped ends. Must self-correct a fully inverted result (CW rings / descending z) to an outward solid. |
| `sweep({profile, path, closed?, cornerRadius?, ruled?, smooth?})` | Sweep a fixed CCW profile along a polyline with a rotation-minimizing frame; sharp mitered corners, or `cornerRadius` fillets; capped ends. |
| `helixSweptTube({pathR, profileR, pitch, turns, z0, lefthand})` | Circle of radius `profileR` swept along a helix (e.g. a rope groove). |
| `union(solids[])` | Boolean union of one or more solids. |
| `toSTEP(named[])` | `[{name, solid}]` → `Promise<ArrayBuffer>` of a STEP assembly. B-rep class only. |

**Backend-divergent options** (a portable part must treat these as declared here):
`loft` `closed: true` (capless loop) and `sweep` `closed: true` are supported **only by
mesh backends** (Manifold); B-rep kernels throw a plain `Error` naming the limitation
(see the error taxonomy). `loft` `ruled: false` (smooth C2 walls) and `sweep`
`smooth: true` (native swept B-rep) are honored only by B-rep kernels; mesh kernels
render the ruled form. `sweep` `closed: true` loops must be planar. Where both backends build the same
shape they do it **by construction, not by tolerance**: sweep elbows loft the identical
station list (`sweep.js`) on both backends.

## Solid ops (combine / transform / query / output)

Normative signatures: `kernel.js`'s `@typedef Solid`.

| Op | Contract |
|---|---|
| `cut(tool)` / `cutAll(tools[])` / `intersect(other)` / `union(other)` | Boolean subtract (single / batched), intersection, and union. |
| `translate(v)` · `rotate(deg, center, axis)` · `mirror("XY"\|"XZ"\|"YZ")` · `scale(factor, center?)` | Transforms — but only two are **rigid** (pose): `translate`/`rotate` move a solid without altering it (position + orientation, shape and handedness preserved). `mirror` **reflects** — it returns the opposite-handed (chiral) solid, which no rotation can reproduce; `scale` **resizes**. So `mirror`/`scale` change the solid *itself*, not just where it sits — think of them as build operations, and never as the difference between a display pose and an export pose (see AUTHORING-PARTS.md `place`). `translate`/`rotate` are the primitives; the placement sugar below is composed *purely from them* (`solid-sugar.js`), so it is geometry-identical on every backend and a host gets it for free via `addSugar()`. |
| `rotateX(deg)` / `rotateY(deg)` / `rotateZ(deg)` · `rotateAbout({axis, deg, through?})` · `along(dir)` · `at(v)` | The readable placement vocabulary parts actually use. `along` maps the canonical +Z build axis to `"±X"\|"±Y"\|"±Z"`. |
| `clone()` | Independent handle (see value semantics). |
| `label(name)` | Name this solid's surface for feature attribution; must survive transforms and booleans; equal names merge into one feature. Affects mesh metadata only, never geometry. |
| `boundingBox()` | `{min, max, center, size}`; `center`/`size` are derived by `addSugar` from the backend's `{min, max}`. |
| `volume()` | Solid volume in mm³. |
| `genus()` / `isEmpty()` | Optional (`SOLID_OPTIONAL_OPS`): mesh-topology queries — through-hole count / no-geometry test. The mesh backend provides them; OCCT has no cheap equivalent. |
| `toMesh({quality?})` | Render mesh: `{positions, normals, indices?, triangles, edges?, featureIds?, features?}`. `indices` optional (a backend may emit soup or indexed); `normals` may be empty (`length 0`) to delegate creasing to the viewer; `edges` (feature-line segments) and the feature fields are optional metadata. |
| `toSTL({quality?})` | `Promise<ArrayBuffer>`, binary STL, outward CCW winding. Stored facet normals may be zero — slicers recompute them (the mesh backend happens to write them). |
| `toIndexedMesh()` | `{positions, indices}` indexed mesh (3MF path). |
| `fillet(r)` · `fillet({r, edges?})` / `chamfer(d)` · `chamfer({d, edges?})` / `shell({t, open})` | B-rep class (core throws `KernelCapabilityError`). Scalar `fillet(3)`/`chamfer(1)` acts on all edges; the options form adds an `edges` selector. `shell` hollows inward, keeping outer dimensions; `open` (face selector) is required. |

`quality` (`"preview"` | `"print"`) is **advisory**: it trades tessellation density for
speed and a backend may bake it at kernel creation (Manifold does). A part must never
depend on triangle counts, segment counts, or normals being present.

**Selectors** (`fillet`/`chamfer` `edges` selector, `shell` `open` face selector) are
declarative objects, criteria AND-combined:

```js
{ dir: "X"|"Y"|"Z",           // edges along / faces normal-to this axis — edge
                              //   selectors ALSO accept an [x,y,z] vector; face
                              //   selectors (shell open) accept ONLY the strings
  inPlane: "XY"|"XZ"|"YZ", at: number,   // in the given plane at offset `at`
  near: [x,y,z] }                        // containing this point
```

`undefined` selects all edges/faces. A raw replicad finder function is also accepted
in-repo (AUTHORING-PARTS.md offers it for parts that are content to stay OCCT-bound),
but it is
inherently backend-specific: portable parts **MUST** use the object form, and a host
**MAY** reject function selectors.

**B-rep repair policy** (`occt-repair.js`): a failing fillet or shell is skipped **as a
whole** — attempted once, and on failure the shape reverts to its pre-op state (OCCT
fillet failures are not monotonic in the radius, so per-edge retry would converge on
garbage). A failing chamfer instead binary-searches the largest valid distance. A
conforming B-rep kernel must degrade this way — a fillet request must never brick the
build, and authors should expect all-or-nothing filleting per call, not per edge.

## Shape2D (2-D booleans)

`k.shape2d(profile)` (`KERNEL_OPS`) lifts a point list, `{outer,
holes?}` region, or arc/curve contour into a `Shape2D` — an opaque 2-D boolean
value. Idempotent: `shape2d(x)` returns `x`
unchanged if `x` is already a `Shape2D`. `_`-prefixed keys are backend internals.
Normative signatures: `kernel.js`'s `@typedef
Shape2D`; the full public surface is `SHAPE2D_OPS`. **Both backends implement it**:
Manifold wraps a `CrossSection` (each method returns a fresh content-hash-cached
value, same caching/dispose discipline as `Solid`); OCCT wraps a replicad `Drawing`
(curve-preserving, so a curved boolean survives to exact STEP — no cache, matching
OCCT's `Solid`). The `kernel-front.js` `KernelCapabilityError` stub for `shape2d` is
now a dead / future-backend safety net only (both current backends define the op),
not an OCCT limitation.

| Op | Contract |
|---|---|
| `union(other)` / `cut(other)` / `cutAll(others[])` / `intersect(other)` | 2-D boolean ops; `other` may be a `Shape2D` or a raw profile (lifted via `shape2d` first). |
| `offset(delta, {corners?, segs?})` | Grows (`delta>0`) or insets (`delta<0`) by `delta` mm; `corners` = `round` (default) / `chamfer` / `sharp`. Curve-preserving on OCCT, faceted at mesh LOD on Manifold. Throws if the offset collapses the shape. |
| `area()` | Net area (Σ\|outers\| − Σ\|holes\|), mm². |
| `boundingBox()` | `{min, max}` — axis-aligned 2-D bounds (no `center`/`size`, unlike `Solid.boundingBox`). |
| `toRegions()` | Materialize into `{outer, holes}[]` region arrays (`assembleRegions`); a boolean result may be several disjoint regions. |
| `simple()` | `toRegions()` unwrapped — throws unless the result is exactly one region. |
| `clone()` | Independent handle. |

On `offset`: `round`, `sharp`, and `chamfer` all agree across both backends **for convex corners with interior angle ≥ 90°** (the common case: rectangles, hexagons, rounded-rects, pentagons, …). `chamfer` is a true 45° bevel — a straight chord across the corner — matching OCCT to float precision there (a 10×10 square offset +1 gives 142.0 on both; a pentagon 298.920 on both). Manifold has no native bevel join, so it renders `chamfer` as a Round join forced to a single chord per corner (`circularSegments=4`). **At acute (<90° interior) convex corners** — triangles, star points, V-notches — Clipper2 emits 2 chords rather than 1, so Manifold's chamfer bulges ~0.4% beyond OCCT's single-chord bevel (e.g. an equilateral triangle: Manifold 235.46 vs OCCT 234.50). `round` and `sharp` are exact across backends at every angle; prefer them, or accept the small acute-corner difference on `chamfer`.

2-D boolean ops are a **parity-relevant operation**: on OCCT they carry exact circular arcs and Bézier curves; on Manifold they facet curves to mesh LOD. Measure-parity (area, bounding box) holds within the tessellation tolerance as LOD converges — this is not a parity waiver.

A `Shape2D` may be passed directly as the `profile` to `extrude` — Manifold
extrudes its `CrossSection` directly (no re-tessellation) and OCCT extrudes its
`Drawing` directly, including any holes it already carries.

## The 2-D helper library

`partforge/geometry` ships pure-JS helpers of two kinds. The **contour builders**
(`piePolygon`, `hexPolygon`, `regularPolygon`, `roundedRectPolygon`, `ellipsePolygon`,
`slotPolygon`, `starPolygon`, `ringSectorPolygon`, `circleProfile`, `cornerArc`,
`filletPolygon`, `roundedProfile`) are pure functions from numbers to plain CCW point
lists or arc profiles — *data already in this contract's input format*, with no kernel
dependency at all. The **solid patterns** (`linearPattern`, `circularPattern`) take a
`Solid` and call only ops from the tables above (`clone`/`translate`/`rotate`/
`boundingBox`). The **profile transform** (`offsetPolygon`) takes a point list or
`{outer, holes}` region and grows or shrinks it by a delta in mm — printer-clearance
offsetting with round/chamfer/sharp corner styles — validating its input and result and
throwing rather than ever returning degenerate (self-intersecting or collapsed)
geometry. All three kinds are therefore portable by construction: a host implements
the kernel and the helpers come along unmodified. (`test/kernel-contract.test.js`
asserts every `polygon.js` export is named here.)

- `pathProfile` — fluent builder for a curve-native path contour (`lineTo` /
  `arcTo` / `cubicTo` / `close`); cubic segments become exact B-rep on OCCT and
  facet at mesh LOD on Manifold.

## Versioning

The contract version is the number at the top of this document, mirrored by
`CONTRACT_VERSION` in `kernel.js` (the parity test asserts the two match). The op lists
in `kernel.js` define the current surface; only breaking changes bump the version:

- **Additive** (new kernel/Solid op, new optional field on an options object, new
  optional mesh-output field): contract version unchanged, minor npm release. Old parts
  run everywhere; new parts need hosts that implement the new op.
- **Breaking** (changed signature or semantics, removed op, new *required* argument,
  tightened validation that rejects previously valid input): contract version bump,
  **major npm release**, and a migration note added here. Removal without a major bump
  is forbidden.
- The naming vocabulary is frozen deliberately: where a name was arbitrary it matches
  the OpenSCAD/Manifold/CadQuery consensus (`union`, `translate`, `rotate`, `mirror`;
  `cut` per CadQuery/replicad rather than OpenSCAD's `difference`), so LLM priors
  transfer. Renames are breaking changes with no offsetting benefit — don't.

## Why not an existing CAD language

Considered and rejected as the part format (2026-07; revisit if the landscape shifts):

- **CadQuery** — largest corpus after OpenSCAD, but its workplane-stack + string-selector
  model is B-rep-native and cannot be implemented on the mesh backend; Python besides.
- **KCL (Zoo)** — designed for LLM generation, but young, sketch-plane-shaped, and tied
  to one vendor's engine; adopting it costs the dual-backend seam.
- **replicad** — already the OCCT backend; part of partforge's value is papering over
  its consuming-transform semantics. Matching downward would re-expose them.
- **OpenSCAD** — closest semantic cousin (Manifold is its modern engine) and the largest
  LLM prior; unadoptable as syntax (own language, no fillets/STEP), so we align
  *vocabulary* instead.

The recurring constraint: every op here is implementable on **both** a mesh-CSG kernel
and a B-rep kernel (see `docs/geometry-backend-strategy.md` for why that dual-backend
property is worth protecting — OCCT booleans are ~75–1400× slower). Generation *safety*
comes not from a restricted DSL but from the verify loop (`measure`/`verify` gates:
`bbox`, `volume`, `holes`, `watertight`, overlaps — plus `minWall` *warnings*, which
report but never fail) — a generator gets machine-checkable
pass/fail feedback per part, which a syntax could never provide.

## Conformance checklist for a new backend or host

1. Implement `KERNEL_OPS` + `SOLID_OPS` (stub `OCCT_ONLY_OPS`/`toSTEP` with
   `KernelCapabilityError` if core class); route through `finishKernel()`/`addSugar()`
   if building in-repo to inherit validation, sugar, and stubs.
2. Pass `test/kernel-contract.test.js` (op-list parity) — add an equivalent for an
   out-of-repo host.
3. Honor the global semantics above (units, Z-up, CCW, value semantics, determinism).
4. Run **every part in `src/parts/`** through `npx partforge measure` unmodified — the
   directory, not this prose, is the acceptance suite (today that includes
   `faceted-vase.js`, the `loft` exerciser, and — B-rep class — `filleted-box.js`).
   Caveat: a part with no `verify` block (`filleted-box.js` today) exercises only the
   default measure gates, so B-rep implementers should also render it and export STEP
   rather than trust the exit code alone.
