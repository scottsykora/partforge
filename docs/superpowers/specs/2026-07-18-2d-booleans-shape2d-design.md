# 2-D booleans — the `Shape2D` value — design

Date: 2026-07-18
Status: approved design, pre-implementation
Branch: shape2d-booleans (off main@0a67830, after the F1 curve-native-profiles merge #51)

## Problem

partforge can build rich 2-D profiles (primitives, `roundedProfile` arcs,
`pathProfile` cubics, `offsetPolygon`) and extrude/revolve them — but it cannot
**combine** two profiles in 2-D. Booleans exist only in the 3-D kernel
(`union`/`cut`/`intersect` on `Solid`). To make a keyhole, a slotted plate, or a
profile with punched islands you must extrude each piece and boolean the
*solids* — 75–1400× slower on OCCT and unable to feed a single clean
`extrude`/`revolve`.

This is **F2** of the curve-native 2-D thread (see `docs/superpowers/BACKLOG.md`):
F1 (curve-native profile IR) shipped in 0.17.0; F2 adds 2-D booleans; F3 adds a
curve-native offset. F2 builds directly on F1 — its booleans preserve curves.

## Key finding that shaped the design

**Both backends ship robust, native 2-D booleans** — so no clipper dependency is
needed (the martinez question from the research thread is moot):

- **Manifold `CrossSection`** — `add`/`subtract`/`intersect` (Clipper2 internally),
  plus `extrude`, `toPolygons`, `area`, `bounds`.
- **replicad `Drawing`** — `fuse`/`cut`/`intersect`, `sketchOnPlane`,
  `boundingBox`. Curve-preserving.

## Decisions already made (with Scott)

- **Architecture: backend-split kernel op using the native booleans** (not a
  pure-JS helper). Rationale: zero new dependency, most-robust clippers
  available, curve-preserving on OCCT (honors the curve-native thread),
  consistent with partforge's "each backend uses its native op" design. Cost:
  build-time only (not `derive()`-usable), parity-relevant (exact vs faceted —
  an established pattern; `sweep` is already parity-waived). Accepted.
- **Return a backend-native value, not materialized regions (B2).** A boolean
  returns a `Shape2D` wrapping the native object, so it flows into `extrude`
  without a lossy flatten-then-rebuild round-trip. Materializing (B1) was
  rejected because it defeats OCCT exactness.
- **Content-hash caching**, reusing the existing `Solid` machinery.
- **3-D `Solid` boolean surface aligns to the 2-D method shape** — add a binary
  `Solid.union(other)` method mirroring `Shape2D.union`, so both value types
  expose `.union`/`.cut`/`.cutAll`/`.intersect` as methods. The `k.union([array])`
  kernel op stays for the n-ary/dynamic-list case.
- **Both backends materialize** — OCCT `.toRegions()`/`.simple()` are implemented
  (not deferred), by discretizing the result `Drawing`.
- **`revolve` accepts a `Shape2D`** in v1 (both backends).

## The `Shape2D` value & API

`Shape2D` is a 2-D analogue of `Solid`: an opaque handle to a backend-native 2-D
shape (`CrossSection` on Manifold, `Drawing` on OCCT) with chainable boolean
methods that mirror `Solid`'s boolean surface.

```js
// lift a profile (point-list / {outer,holes} / curve contour) into a Shape2D
const disc = k.shape2d(circleProfile(6));

// chainable booleans — `other` is a profile spec OR a Shape2D (auto-lifted)
const keyhole = k.shape2d(rect)
  .union(disc)                 // a ∪ b
  .cut(slotProfile)            // a − b   (mirrors Solid.cut)
  .intersect(boundsProfile);   // a ∩ b   (mirrors Solid.intersect)

// feeds extrude directly — no round-trip
k.extrude({ profile: keyhole, h: 4 });
```

- **Constructor:** `k.shape2d(profile)` lifts any profile spec (point-list,
  `{outer,holes}`, or a curve contour) into a `Shape2D`.
- **Methods:** `.union(other)`, `.cut(other)`, `.cutAll(others[])`,
  `.intersect(other)` — `.cut`/`.cutAll`/`.intersect` match `Solid` names;
  `.union` is the binary 2-D counterpart. N-ary composition is chaining.
  `other` is a profile spec or a `Shape2D` (auto-lifted).
- **Consumption:** `extrude`'s and `revolve`'s `profile` option also accepts a
  `Shape2D`.
- **Escape hatch / inspection:** `.area()`, `.boundingBox()`, `.toRegions()` →
  `[{outer,holes}]`, `.simple()` → single region or throw — **all on both
  backends**.

### 3-D `Solid` alignment

To keep the two boolean surfaces consistent, `Solid` gains a binary
`Solid.union(other): Solid` method mirroring `Shape2D.union`. After this, both
value types expose the same method shape — `.union` / `.cut` / `.cutAll` /
`.intersect`. Existing simple binary call sites (`k.union([s, tool])`) migrate to
`s.union(tool)`; the `k.union([array])` kernel op is retained for the n-ary /
dynamic-list case (e.g. `k.union(patternCopies)`), which the method form does not
cover ergonomically. No behavior change to the booleans themselves.

## Backend representation & caching

`Shape2D` participates in the **same content-hash memoization as `Solid`**, using
the existing `h(...)` hasher and the WASM-agnostic per-sub-part cache
(`solid-cache.js`). No new cache infrastructure.

**Hashing** (mirrors `Solid`, including operand folding for O(1) bounded keys):

```
k.shape2d(profile)  → _hash = h("shape2d", profile, segs)   // segs: Manifold LOD; OCCT omits
a.union(b)          → _hash = h("union2d",     a._hash, b._hash)
a.cut(b)            → _hash = h("cut2d",       a._hash, b._hash)
a.intersect(b)      → _hash = h("intersect2d", a._hash, b._hash)
```

Operands fold in by their own short `_hash`, so a deep boolean graph stays O(1)
per node with bounded key length. Any upstream change invalidates exactly the
affected sub-tree. Hash namespaces (`"shape2d"`/`"union2d"`) never collide with
solid ops (`"extrude"`/`"cylinder"`), so 2-D and 3-D entries coexist in one cache.

**Representation & invariants:**
- **Manifold:** wraps a `CrossSection`; booleans → `CrossSection.add/subtract/
  intersect`; every WASM object is tracked and freed via the same dispose path
  as solids (no GC). Cache entry `dispose` frees the `CrossSection`.
- **OCCT:** wraps a replicad `Drawing`; booleans → Drawing `fuse/cut/intersect`.
  **replicad booleans consume their operands** — a cached `Shape2D` reused across
  ops must `.clone()` first (the same invariant AGENTS.md states for `Solid`).
  Cache entry `dispose` deletes the `Drawing`.

## Curves (the payoff)

Operands may be curve contours (`pathProfile`/`roundedProfile`):
- **OCCT:** `k.shape2d(cubicContour)` builds an exact `Drawing` via F1's
  `cubicBezierCurveTo` path; booleans **preserve the curves** → exact STEP.
- **Manifold:** flattens at mesh LOD (`tessellateProfile`) before
  `CrossSection.ofPolygons`; booleans run on the faceted polygons.

Point-lists and `{outer,holes}` regions work trivially on both.

## Materialization — `.toRegions()` / `.simple()` (both backends)

- **Manifold:** `CrossSection.toPolygons()` → `SimplePolygon[]`, assembled into
  `[{outer, holes}]` by winding + point-in-polygon nesting (CCW outers, holes
  nested inside their container).
- **OCCT:** the result `Drawing` has no direct point accessor, so materialization
  parses `Drawing.toSVGPathD()` (one path per contour via `toSVGPaths()`) and
  discretizes each command — lines verbatim, cubic `C` via **F1's `sampleBezier`**,
  arcs via **`sampleArc`** — then assembles like Manifold. Reuses the F1 samplers,
  so an OCCT-materialized curve facets consistently with the Manifold path.
  - **Impl risk (resolve in planning):** confirm what `toSVGPathD()` emits for a
    known circle/curve — cubic `C` commands vs SVG elliptical-arc `A` commands —
    and handle whichever appears (arc `A` uses endpoint parameterization; if
    present, convert to center form before sampling). This is the highest-risk
    task; the implementer verifies emitted commands against a fixture first.
- `.simple()` unwraps a single-region result or throws; both backends share the
  assembled-region representation, so `.simple()` is backend-agnostic on top of
  `.toRegions()`.

## Extrude / revolve integration

`extrude`'s `profile` option gains a `Shape2D` branch:
- **Manifold:** `shape.<crossSection>.extrude(h, …)` (twist/scaleTop via config).
- **OCCT:** `shape.<drawing>.sketchOnPlane("XY").extrude(h, cfg)`.

`revolve` likewise accepts a `Shape2D` (v1):
- **Manifold:** `shape.<crossSection>.revolve(segs, degrees)` (`CrossSection.revolve`).
- **OCCT:** `shape.<drawing>.sketchOnPlane("XZ").revolve([0,0,1], { angle: degrees })`.
- The `revolveArgs` option-check currently iterates the profile as `[[r,z],…]`;
  it gains a `Shape2D` branch that enforces the radius ≥ 0 rule via
  `shape.boundingBox().min[0] >= 0` instead of the per-point scan. (A curved
  lathe profile is achieved by wrapping: `k.shape2d(curveContour)` → `revolve` —
  so this also resolves F1's deferred "revolve of a curve contour" for the
  Shape2D path; a raw curve-contour passed straight to `revolve` stays out of
  scope.)

As with `Shape2D`, a 2-D shape's coordinates are interpreted by the consuming op
— XY for `extrude`, `(r,z)` for `revolve` — exactly as profile specs already are.

The existing profile-spec paths are unchanged; only new `Shape2D` branches are
added.

## Scope (v1)

**In:** `k.shape2d(profile)`; `.union`/`.cut`/`.cutAll`/`.intersect`;
`extrude` **and `revolve`** accept `Shape2D`; `.area()`/`.boundingBox()`/
`.toRegions()`/`.simple()` **on both backends**; curve operands (both backends);
content-hash caching; **`Solid.union(other)` method + call-site migration**.

**Deferred (documented follow-ups):**
- `prism` accepting `Shape2D` — redundant with `extrude` + `Shape2D`; left as-is.
- A raw curve-contour passed straight to `revolve` (not wrapped in `Shape2D`) —
  needs Manifold-side tessellation in `revolve`; wrap in `k.shape2d(...)` instead.
- Variadic 2-D kernel-op form (`k.union2d([...])`) — chaining covers n-ary.
- A `shape.extrude({h})` sugar method — use `k.extrude({profile: shape, h})`.

## Backend routing

2-D booleans work on **both** backends, so they are NOT CAD-only ops — a part
using only `shape2d` booleans + `extrude` routes to Manifold (default). No change
to the geometry-free probe / backend-selection logic.

## Validation & errors

- `k.shape2d(x)` validates `x` is a profile spec or `Shape2D`; an invalid profile
  reuses the existing `normalizeProfile`/`validateContour` errors.
- A boolean whose result is empty (e.g. `intersect` of disjoint shapes) yields an
  empty `Shape2D`; `.simple()` on it throws a clear "empty shape" error; extrude
  of an empty shape throws a clear error rather than producing degenerate
  geometry.
- Loud, greppable messages in partforge's style; ERROR-PATTERNS entries for the
  new literals.

## Testing

**Manifold integration (`bootManifoldKernel`, own file, no OCCT co-boot):**
- union/cut/intersect of two overlapping squares → `.area()` matches closed form;
- subtract that punches a hole → `extrude` → genus 1 (real through-hole);
- booleaned shape `extrude` → volume sane; **`revolve` of a booleaned shape →
  volume sane**;
- cache: same op twice → cache hit (stats) and identical geometry;
- curve operand: cut a `circleProfile` hole from a rect → faceted area sane;
- `.toRegions()`/`.simple()` round-trip (materialize → re-lift → equal area).

**OCCT integration (`bootOcctKernel`, own file, no Manifold co-boot):**
- union/cut/intersect → `extrude` → volume matches Manifold within tolerance;
- `revolve` of a Shape2D → volume sane;
- curve operand stays exact: cut a cubic-circle hole → STEP contains `B_SPLINE`;
- `.boundingBox()` sane; **`.toRegions()` materializes** (round-trips: area of the
  materialized regions matches `.area()` within tolerance).

**3-D alignment:**
- `Solid.union(other)` produces the same geometry as `k.union([a, b])`;
- migrated call sites still pass their existing assertions.

**Pure-ish unit tests (no WASM):**
- hash composition: `h("union2d", a._hash, b._hash)` stable and operand-sensitive
  (different operand → different hash);
- `k.shape2d` auto-lifts a profile spec; passing a `Shape2D` is idempotent;
- validation errors for bad profiles / empty-shape `.simple()`;
- SVG-path discretizer (the OCCT `.toRegions()` helper) is unit-testable without
  WASM: feed known path strings (`M…L…`, `M…C…`) → expect point rings, cubic `C`
  sampled via `sampleBezier`.

**Cross-backend parity:** a boolean+extrude volume pin close across backends
(tolerance — parity-relevant op).

## Out of scope (explicitly)

- The deferred items in Scope (prism + Shape2D, raw curve-contour `revolve`,
  variadic 2-D op, sugar `.extrude`).
- F3 (curve-native offset) — its own spec, built on F1/F2.
- Any change to the *behavior* of 3-D `Solid` booleans (the alignment adds a
  `Solid.union(other)` method that delegates to the existing union; the boolean
  logic is untouched).
