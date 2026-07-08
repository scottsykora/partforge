# The partforge kernel contract

**Contract version: 1** (partforge 0.9.x) — see [Versioning](#versioning) for what may
change under which version bump.

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
— read `docs/AUTHORING-PARTS.md`; this doc does not repeat it.

## Conformance classes

**Core (mesh class).** A conforming core kernel implements every op in `KERNEL_OPS` and
every `Solid` op in `SOLID_OPS`, *except* that the B-rep ops (`fillet`, `chamfer`,
`shell` — the `OCCT_ONLY_OPS` list — and `toSTEP`) may instead throw
`KernelCapabilityError`. The in-repo Manifold backend is the reference core kernel.
Kernels built from this repo get the stubs for free: `finishKernel()` (kernel-level) and
`addSugar()` (solid-level) generate them from `OCCT_ONLY_OPS`.

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
  backends tessellate them.
- **Value semantics: every op returns a new `Solid` and never invalidates its inputs.**
  `a.cut(b)` leaves both `a` and `b` usable. If the underlying engine consumes operands
  (replicad does), the backend must hide that with internal clones — that gotcha must
  never leak to part code. `clone()` exists and must return an independent handle, but a
  part should never *need* it for correctness.
- **Purity and determinism: identical arguments must produce identical geometry.** No
  randomness, clocks, or hidden global state in an implementation. partforge's solid
  cache memoizes by a content hash of `(op, args)`; a nondeterministic op silently
  poisons the cache.
- **Shared validation** (enforced once in `finishKernel`/`addSugar`; a standalone
  implementation must enforce the same): `prism`/`extrude` `scaleTop ≥ 0`; `scale`
  `factor > 0`; `revolve` profile radii `≥ 0`; `shell` requires `openFaces` (a fully
  closed hollow is not supported).
- **Error taxonomy:** invalid arguments throw plain `Error` with a message naming the op
  (`"prism: scaleTop must be ≥ 0"`); capability gaps throw `KernelCapabilityError`
  (from `geometry/errors.js`). Nothing else is thrown for well-formed input — a boolean
  or fillet that the engine cannot compute is a backend bug or falls under the repair
  policy below, not a part-visible error class.

## Kernel ops (make solids)

Signatures are normative in `kernel.js`'s `@typedef GeometryKernel`; this table fixes
the behavior. All ops return a `Solid`.

| Op | Contract |
|---|---|
| `cylinder(rBottom, rTop, h, {center?})` | Cylinder (or frustum when radii differ) along +Z from z = 0; `center: true` centers on z = 0. |
| `boredCylinder({od, h, bore})` | Compound: cylinder of diameter `od` with a through-bore `bore`. Semantically identical to the composition in `kernel-front.js`; a backend may override only for caching, never for different geometry. |
| `sphere(r)` | Sphere centered at the origin. |
| `box(min, max)` | Axis-aligned box from `[x,y,z]` corners. |
| `prism(pts, h, {twist?, scaleTop?})` | Extrude one CCW contour (point list or arc profile) from z = 0. `twist` = total degrees over the height; `scaleTop` = uniform top scale (1 straight, 0 → apex). |
| `extrude(profile, h, {twist?, scaleTop?})` | Same, for a polygon-with-holes region `{outer, holes?}` (bare contour = outer only), in one op — no per-hole boolean. |
| `revolve(pts, {degrees?})` | Revolve a lathe profile `[[r, z], …]` (r ≥ 0) about Z; `degrees` < 360 gives a capped partial revolve. Default 360. |
| `loft(rings, {ruled?, closed?})` | Stack polygon cross-sections (per-ring `z`/`rotate`/`scale`, equal vertex counts) with ruled walls and capped ends. Must self-correct a fully inverted result (CW rings / descending z) to an outward solid. |
| `sweep(profile2D, path3D, {closed?, cornerRadius?, ruled?, smooth?})` | Sweep a fixed CCW profile along a polyline with a rotation-minimizing frame; sharp mitered corners, or `cornerRadius` fillets; capped ends. |
| `helixSweptTube({pathR, profileR, pitch, turns, z0, lefthand})` | Circle of radius `profileR` swept along a helix (e.g. a rope groove). |
| `union(solids[])` | Boolean union of one or more solids. |
| `toSTEP(named[])` | `[{name, solid}]` → `Promise<ArrayBuffer>` of a STEP assembly. B-rep class only. |

**Backend-divergent options** (a portable part must treat these as declared here):
`loft` `closed: true` (capless loop) and `sweep` `closed: true` are **mesh-class only**;
B-rep kernels throw. `loft` `ruled: false` (smooth C2 walls) and `sweep` `smooth: true`
(native swept B-rep) are honored only by B-rep kernels; mesh kernels render the ruled
form. `sweep` `closed: true` loops must be planar. Where both backends build the same
shape they do it **by construction, not by tolerance**: sweep elbows loft the identical
station list (`sweep.js`) on both backends.

## Solid ops (combine / transform / query / output)

Normative signatures: `kernel.js`'s `@typedef Solid`.

| Op | Contract |
|---|---|
| `cut(tool)` / `cutAll(tools[])` / `intersect(other)` | Boolean subtract (single / batched) and intersection. |
| `translate(v)` · `rotate(deg, center, axis)` · `mirror("XY"\|"XZ"\|"YZ")` · `scale(factor, center?)` | Rigid/uniform transforms. `rotate` is the primitive; the sugar below is defined *purely in terms of it* (`solid-sugar.js`), so it is geometry-identical on every backend and a host gets it for free via `addSugar()`. |
| `rotateX/Y/Z(deg)` · `rotateAbout({axis, deg, through?})` · `along(dir)` · `at(v)` | The readable placement vocabulary parts actually use. `along` maps the canonical +Z build axis to `"±X"\|"±Y"\|"±Z"`. |
| `clone()` | Independent handle (see value semantics). |
| `label(name)` | Name this solid's surface for feature attribution; must survive transforms and booleans; equal names merge into one feature. Affects mesh metadata only, never geometry. |
| `boundingBox()` | `{min, max, center, size}`; `center`/`size` are derived by `addSugar` from the backend's `{min, max}`. |
| `volume()` | Solid volume in mm³. |
| `genus()` / `isEmpty()` | Optional (mesh class): through-hole count / no-geometry test. |
| `toMesh({quality?})` | Render mesh: `{positions, normals, indices?, triangles, edges?, featureIds?, features?}`. `indices` optional (a backend may emit soup or indexed); `normals` may be empty (`length 0`) to delegate creasing to the viewer; `edges` (feature-line segments) and the feature fields are optional metadata. |
| `toSTL({quality?})` | `Promise<ArrayBuffer>`, binary STL, outward CCW winding, non-zero facet normals. |
| `toIndexedMesh()` | `{positions, indices}` indexed mesh (3MF path). |
| `fillet(radius, selector?)` / `chamfer(distance, selector?)` / `shell(thickness, openFaces)` | B-rep class (core throws `KernelCapabilityError`). `shell` hollows inward, keeping outer dimensions. |

`quality` (`"preview"` | `"print"`) is **advisory**: it trades tessellation density for
speed and a backend may bake it at kernel creation (Manifold does). A part must never
depend on triangle counts, segment counts, or normals being present.

**Selectors** (`fillet`/`chamfer` edge selector, `shell` face selector) are declarative
objects, criteria AND-combined:

```js
{ dir: "X"|"Y"|"Z"|[x,y,z],   // edges along / faces normal-to this axis
  inPlane: "XY"|"XZ"|"YZ", at: number,   // in the given plane at offset `at`
  near: [x,y,z] }                        // containing this point
```

`undefined` selects all edges/faces. Passing a raw function is a replicad escape hatch —
**non-portable**, rejected by the contract for parts meant to travel.

**B-rep repair policy** (`occt-repair.js`): a failing fillet skips the offending edge
rather than aborting; a failing chamfer binary-searches the largest valid distance.
A conforming B-rep kernel must degrade this way — parts are written assuming a fillet
request cannot brick the build.

## The 2-D helper library

`partforge/geometry` ships pure-JS contour builders: `piePolygon`, `hexPolygon`,
`regularPolygon`, `roundedRectPolygon`, `ellipsePolygon`, `slotPolygon`, `starPolygon`,
`ringSectorPolygon`, `circleProfile`, `filletPolygon`, `roundedProfile`, plus the solid
patterns `linearPattern`/`circularPattern`. They emit plain CCW point lists or arc
profiles — i.e. *data already in this contract's input format* — and call only `Solid`
ops from the tables above. They are therefore portable by construction: a host
implements the kernel, and the helpers come along unmodified.

## Versioning

The contract version is this document's number plus the op lists in `kernel.js`; the
parity tests bind them to the code.

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
`bbox`, `volume`, `holes`, `minWall`, overlaps) — a generator gets machine-checkable
pass/fail feedback per part, which a syntax could never provide.

## Conformance checklist for a new backend or host

1. Implement `KERNEL_OPS` + `SOLID_OPS` (stub `OCCT_ONLY_OPS`/`toSTEP` with
   `KernelCapabilityError` if core class); route through `finishKernel()`/`addSugar()`
   if building in-repo to inherit validation, sugar, and stubs.
2. Pass `test/kernel-contract.test.js` (op-list parity) — add an equivalent for an
   out-of-repo host.
3. Honor the global semantics above (units, Z-up, CCW, value semantics, determinism).
4. Run the in-repo parts through `npx partforge measure` — `demo.js`, `planter.js`, and
   (B-rep class) `filleted-box.js` must pass their gates unmodified. That suite, not
   this prose, is the acceptance test.
