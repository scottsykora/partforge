# Height maps and image sources — design

**Date:** 2026-08-29
**Status:** approved design, pre-implementation
**Scope:** partforge framework (a `heightfield` kernel op, an `images`
PartDefinition field, an `"image"` control type, a main-thread ingest helper) +
both backends + lint + CLI. The partforge-cloud half (ingest, storage, catalog)
is specified here as a **host contract** in §8 and gets its own sibling spec in
that repo before implementation.

## Goal

Let a part turn a **depth map into geometry** — a relief surface raised from an
image — and let the **end user of a part**, not just the authoring agent, swap
that image from the control panel and watch the geometry rebuild.

The reference case is a rectangular plate carrying a relief on its top face,
either standing alone (lithophane, textured panel, terrain tile, embossed logo)
or unioned onto / cut into a face of a part built the ordinary way.

## Decisions (settled with Scott, 2026-08-29)

| Question | Decision |
| --- | --- |
| Geometry produced | **Planar relief plate** — grid top, skirt walls, flat base cap. Returns an ordinary `Solid`, so "apply relief onto another solid" is just `union`/`cut` and needs no extra API. |
| Cylindrical / revolved wrap | **Out of scope.** A genuine branch (grid in `(theta, z)`, seam weld, annular caps), deferred. |
| Image → `Shape2D` contour tracing | **Out of scope.** Different feature (marching squares), not a vertex grid. |
| Image sourcing | **Mirrors `fonts` exactly** — an `images` field with a function-of-params form, a `type: "image"` control, an `allow` list, and an optional host-supplied `imageCatalog`. |
| Mesh resolution | **`pitch` in millimetres**, budget-clamped with a warning. Resolution tracks physical size, not pixel count; a 4K and a 256px source cost the same. |
| One pitch or two | **One.** The same geometry feeds preview, STL and STEP, so `build` stays a pure function of `(k, p, d)` and the content-hash memo is untouched. Preview ≠ export was rejected as a bad CAD property. |
| Backend support | **Both.** Not a Manifold-only op — see §6. STEP export works, with a triangular-mesh (faceted B-rep) surface, which Scott accepted explicitly. |
| Decode formats | **PNG only in core**, decoded in pure JS so one code path produces the geometry in the browser, the CLI and CI. |
| Other formats | **Converted to PNG in the browser at ingest**, by a helper partforge ships from its DOM entry. Format breadth is the host's job, the way typeface breadth is `fontCatalog`'s. |
| JPEG in the worker | **Rejected.** ~5x smaller for photographic content, but 8-bit-only and DCT-ringing — in a depth map those are *geometric* artifacts (height terracing, 8x8 block bumps), not cosmetic ones. Storage is addressed by downsampling at ingest instead. |
| Cloud sandbox / no URL fetch | **Already solved.** `asset-resolve.js` accepts raw bytes as a source, so a param holding an `ArrayBuffer` never reaches `fetch`. See §4. |
| `CONTRACT_VERSION` | **Stays 4.** `heightfield` is additive and implemented by both backends — the `import` precedent, which took no bump of its own. |
| Package version | **0.92.0**, bumped on the feature branch, per the release rule in AGENTS.md. |

## Evidence (probed 2026-08-29)

The design leans on facts checked against the installed dependencies and the
repo, not assumed:

1. **replicad ships `importSTL(STLBlob: Blob): Promise<AnyShape>`**, documented
   as converting "through OpenCascade's BRep representation" — i.e. mesh to
   faceted B-rep. This is what makes STEP export possible.
2. **The trimmed OCCT WASM build has the needed APIs**:
   `BRepBuilderAPI_Sewing`, `BRepBuilderAPI_MakeSolid`, `BRepBuilderAPI_MakeFace`,
   `StlAPI_Reader`, `Poly_Triangulation`, `BRep_Builder`, `TopoDS_Shell` are all
   present. (`BRepBuilderAPI_MakePolygon`, `BRepBuilderAPI_MakeShapeOnMesh` and
   `RWStl` are absent — none are needed on the `importSTL` path.)
3. **`occt-backend.js` already imports `meshToStl`** (line 35), so the OCCT
   adapter needs no new serialization code.
4. **`mesh-build.js` already exports `sideQuads`, `fanCap` and
   `manifoldFromMesh`** — the entire Manifold adapter plus the skirt and cap.
5. **`asset-resolve.js` accepts bytes without fetching** — its grammar is
   "ArrayBuffer/typed-array view, URL string, `URL`, or a thunk returning any of
   those."
6. **A host-primed, message-fed data path already exists**: `worker.js`'s
   `importMeshes` map, primed by a host message and consumed by `ensureImports`
   in place of resolving.
7. **`fflate` is already inside the worker import closure** via
   `threemf-parse.js`, so the PNG decoder adds **no new dependency**.
8. **`pngjs` is already a devDependency**, Node-only and quarantined to
   `src/testing/render.js` — available as an independent reference decoder in
   tests.
9. **AGENTS.md's "mesh-to-B-rep conversion isn't in scope for v1"** was a
   scoping decision about the `imports` feature, not a capability gap. This spec
   does not change `imports`; `k.import` of an STL on OCCT stays an error.

## 1. The `heightfield` op

```js
k.heightfield(name | { width, height, data }, {
  w, d,                  // footprint mm — required
  base = 1,              // slab beneath the relief; must be > 0
  maxZ = 1,              // peak relief height above base
  pitch = 0.5,           // sample spacing mm
  invert = false,        // default: black low, white high
  range = [0, 1],        // input remap applied before scaling
  origin = "center",     // "center" | "corner"
})  ->  Solid
```

Height at a sample is `base + maxZ * f(sample(u, v))`, where `f` applies `range`
then `invert`. `range` is a **remap, not a clamp of the output**: `range[0]` maps
to 0 and `range[1]` maps to 1, with input outside the band clamped to the ends —
so `range: [0.2, 0.8]` spends the full relief height on the middle 60% of the
image's tonal range. `invert` is applied after, as `1 - v`.

`origin` positions the footprint in XY only: `"center"` centres the `w x d`
rectangle on the origin, `"corner"` puts its minimum corner there. Z is
unaffected either way — the base always sits at `z = 0` and the relief rises
toward `+Z`.

The image is **stretched** to `w x d`; aspect is not preserved.
That is documented behaviour rather than a warning, to keep the op's surface
small — a `fit` option is a non-goal (see below).

Accepting a raw `{ width, height, data }` alongside a registered name is the
low-level form: it costs one branch and lets the pure leaf be tested with a
hand-built 4x4 grid and no asset plumbing at all.

`base > 0` and `pitch > 0` are frozen errors — both produce degenerate geometry.

Sample count is `ceil(w / pitch) x ceil(d / pitch)`, clamped to a vertex budget.
A clamp is reported through the existing `takeBuildWarnings` channel, never
thrown: a pitch that is merely ambitious should still build.

### Mesh construction

Top grid at `z = base + relief`; a new ring at `z = 0` for the skirt to drop
to; an explicit skirt loop for the walls; `fanCap` for the bottom. `fanCap` is
used verbatim from `mesh-build.js`; `sideQuads` is **not** reusable here — it
derives ring bases as `i * ringSegs`, which assumes rings start at `V[0]`, and
the vertex array here leads with the grid, so the skirt is written as an
explicit loop instead.

The skirt's top ring reuses the grid's own perimeter vertex indices rather
than duplicating them — only the bottom ring (`z = 0`) is new geometry, one
vertex per perimeter vertex, plus one centre vertex for the fan cap. Reusing
the grid's indices (instead of a duplicate ring at the same position) is what
makes the top face's boundary edge and the skirt's top edge the exact same
index pair, so the mesh is watertight by index alone with no separate
weld/merge pass required. The two backends still receive **byte-identical
triangle data** — Manifold's own `mesh.merge()` before `ofMesh` and OCCT's
tolerance sewing inside `importSTL` still run downstream as normal, but this
mesh's own watertightness no longer depends on either of them — which reduces
cross-backend parity testing to "does sewing/tessellation diverge."

Winding follows the repo convention: CCW = outward.

## 2. The `images` field

Same grammar as `fonts` and `imports`, including the function-of-params form
that makes the source swappable:

```js
images: (p) => (p.relief ? { relief: p.relief } : {}),
```

An empty value declares nothing, and — unlike `text2d`, which has a bundled
Roboto to fall back to at the op level — `heightfield` has no default grid of
its own: calling it with an unset/unregistered name throws the ordinary
unknown-image error. A part that wants to build with no image branches around
the `k.heightfield` call in its own `build()`, or supplies a bundled default
through `images` itself (a function-form `images` returning a fallback URL
when the control is empty) so the name is never actually empty. Either way the
part still builds, and `partforge measure` still passes, with no network and
no image — which is what CI should see.

A part with a fixed image needs none of this; a plain `{ name: source }` object
is fine.

## 3. The `"image"` control and the catalog seam

`{ key, type: "image", label, allow?, preview? }`, rendering as a URL field with
a thumbnail when no catalog is supplied, and as a picker when the host provides
one via `mount(part, { imageCatalog })`. The provider shape mirrors
`fontCatalog`:

```js
imageCatalog: {
  search(query, { limit }) -> Promise<ImageAsset[]>,
  describe?(source)        -> { label, width, height } | null,
}
```

The worker never learns the catalog exists. As with fonts, it is a main-thread,
panel-only concern. A `type: "image"` control with no catalog degrades to a URL
field, so demo apps keep working.

The panel's thumbnail uses a plain `<img>`; the main thread needs no decoder.

## 4. Source grammar, `allow`, and the cloud sandbox

Sources follow `asset-resolve.js`'s existing grammar. Two cases matter:

**String sources** (a URL, or a `pfc-asset://` token) get the full `allow`
treatment, reusing the `fontSourceAllowed` rules — hostname comparison, not
suffix matching, so `evil.test` cannot masquerade. Default `allow: ["https"]`.

**Byte sources** (`ArrayBuffer` / typed-array view) **bypass the `allow`
check.** This is the one place the image rules deliberately diverge from
`font-source.js`, which refuses non-strings on the grounds that "bytes/thunks
are never param-supplied." That assumption does not hold here, and the
replacement rule is sound: **an `ArrayBuffer` in params definitionally did not
arrive via a shared link**, because a URL cannot carry megabytes. It can only
have been placed there by the host's own panel, which is trusted code.

This is what makes the **partforge-cloud sandbox** work without URL fetching.
Cloud puts PNG bytes in the param; `images: (p) => ({ relief: p.relief })` is
unchanged; the resolver takes its bytes branch and never calls `fetch`; the
digest is computed from the bytes.

A host-primed `imageGrids` map mirroring `importMeshes` is **deliberately not
built**. Bytes-in-params needs zero framework code and the primed map is
available later if postMessage clone cost on every regen measures badly.

**The host primes bytes, never a decoded grid.** Priming pixels would let cloud
reopen JPEG for free, but then the browser's codec produces the geometry in the
app while ours produces it in the CLI, and the two disagree. Keeping the host a
pure transport for PNG bytes keeps one decoder authoritative everywhere.

## 5. Decoding and ingest

`png-decode.js` is a pure-JS PNG decoder in the worker graph: inflate via
`fflate`, un-filter, then a bit-depth / colour-type walk to luminance. It must
support 8- and 16-bit grayscale and RGB/RGBA (16-bit matters — it is why serious
depth maps are PNG). DOM-free and `node:`-free, so `worker-layering.test.js`
covers it for free.

Storage is `Uint16Array`, not `Float32Array`: lossless for both 8- and 16-bit
sources and half the memory. Conversion to 0..1 at sample time is one multiply.

Non-PNG sources throw, naming the ingest helper.

`image-ingest.js` is **main-thread only**, DOM allowed, exported from
`src/index.js` — the entry already documented as one a build function must never
import:

```js
export async function imageToPng(fileOrBlob, { maxSize = 1024 } = {}) -> Blob
```

It decodes with `createImageBitmap`, draws to a canvas, downsamples to
`maxSize`, and re-encodes as PNG. Hosts call it at ingest so every stored source
is a PNG.

`maxSize` is the answer to storage cost, in place of switching codec. Pitch caps
useful resolution anyway — at pitch 0.3 on a 60 mm plate the grid is 200x200, so
storing 4096² is waste. A 1024² cap is generous against any realistic pitch,
saves comparably to JPEG, stays lossless, and preserves 16 bits when present. It
also keeps a stored grid near 2 MB, which retires any worker-memory concern.

## 6. Backend adapters

`heightfield.js` returns plain `{ positions, indices }` and knows nothing about
either kernel. Each backend consumes it with machinery that already exists:

| Backend | Path |
| --- | --- |
| Manifold | `manifoldFromMesh(wasm, V, Tr)` — merge + `ofMesh`, as `loft` and `helix-tube` already do. |
| OCCT | `meshToStl(positions, indices)` -> `Blob` -> `replicad.importSTL` -> faceted `TopoDS_Shape`, participating in booleans and STEP export like any other shape. |

Consequences to state plainly, because they are the real cost of STEP support:

- **OCCT booleans against a faceted relief are expensive.** `docs/geometry-backend-strategy.md`
  measures OCCT booleans at 75-1486x Manifold's. A relief with tens of thousands
  of planar faces is squarely in that territory.
- **STEP files get large.** OCCT writes each triangle as an `ADVANCED_FACE` over
  a `PLANE`, roughly 25-40 entities apiece. A 60x60 mm plate at pitch 0.3 is
  79,202 top triangles; at pitch 1.0 it is 6,962. Pitch is the throttle.
- The OCCT adapter therefore emits a `takeBuildWarnings` message above a
  triangle threshold. It is the only layer that knows the target.

`importSTL` is the design's load-bearing unknown — replicad's own documentation
says it "can fail in bad ways" and is "relatively long depending on how much
tesselation." See Rollout.

## 7. Registration and cache correctness

`ensureImages(kernel, imagesDecl)` resolves, digests and decodes before the
synchronous build, then registers via a `_registerImage` / `_imageDigest`
side-channel mirroring `_registerImport` / `_importDigest`. `jobs.js` calls it
beside `ensureImports`.

Registration is **simpler than imports**: every backend can consume a normalized
grid, so there are no per-format error entries, no lazy-error registrations and
no crossover.

Digest gating means a slider drag never re-decodes. Downstream, the op folds the
digest into its cache key, following `h("import", name, digest)`:

```
h("heightfield", digest, w, d, base, maxZ, pitch, invert, range, origin)
```

Sources stay content-stable for a session, the same rule as `fonts` and
`imports`: a changed file needs a fresh worker to be picked up, and an actually
changed source (new digest) invalidates every dependent cache node.

**Two invariants to verify during implementation**, cheap now and ugly late:
that `resolveParams` passes an `ArrayBuffer` through untouched, and that
wherever params feed a content hash, an `ArrayBuffer` value is substituted by
the image digest rather than hashed directly.

## 8. Host contract (partforge-cloud)

1. **Ingest.** On upload, call `imageToPng(file, { maxSize })`. Store the
   resulting PNG. Non-PNG input is converted here and nowhere else.
2. **Delivery.** Supply the stored PNG to the part as **bytes in the param** in
   the sandboxed panel, or as a `pfc-asset://` token / signed Storage URL where
   fetching works. Both are already valid sources.
3. **Catalog.** Implement `imageCatalog` for the picker. partforge never learns
   where images are stored.
4. **CLI parity.** Whatever the panel uses must also be resolvable by
   server-side `partforge measure` / `render` runs, or the `verify` gate stops
   covering the part. Cloud already satisfies this for fonts.

## 9. Lint and CLI

Two rules, both mirroring existing ones:

- `image-control-not-in-images` — a `type: "image"` control whose key never
  reaches the `images` declaration (mirrors `font-control-not-in-fonts`).
- `heightfield-unknown-image` — a literal name not in a static `images` map
  (mirrors `import-unknown-name`).

Both come nearly free once `heightfield` has a `KERNEL_OP_SPECS` entry, since
the validating probe already routes options-form calls through it.

`partforge lint | measure | render` work on an image-using part with no extra
flags — `images` resolves in the CLI's Node boot exactly as `fonts` and
`imports` do.

## 10. Testing

Pure leaves carry most of the weight, with no WASM boot:

- **`heightfield.test.js`** — hand-built 4x4 grid. Vertex and triangle counts;
  **watertightness by edge parity** (every edge shared exactly twice); outward
  winding via positive signed volume; `base`/`pitch` validation; the
  `invert` / `range` / `origin` mappings; pitch clamping and its warning.
- **`png-decode.test.js`** — 8-bit gray, 16-bit gray, RGB, RGBA, interlaced,
  truncated. Diffed against `pngjs` as an independent reference decoder.
- **`image-source.test.js`** — `allow` rules for string sources, including the
  hostname-spoofing cases `fonts-allow.test.js` already covers; and that byte
  sources bypass `allow`.

Kernel tests, OCCT in its own file per the same-process rule:

- **`heightfield-manifold.test.js`** — watertight, genus 0, volume against an
  analytic ramp.
- **`heightfield-occt.test.js`** — `importSTL` yields a solid; STEP export
  succeeds; a boolean against another solid succeeds.
- **Cross-backend parity** — same image and params, volumes within the
  contract's tolerance class.

Free coverage: `kernel-contract.test.js` picks up `heightfield` once it is in
`KERNEL_OPS`, and **fails until the op table in `KERNEL-CONTRACT.md` has its
row** — the forcing function for the doc. `worker-layering.test.js` enforces
that `png-decode.js`, `images.js` and `heightfield.js` stay DOM- and
`node:`-free, and that `image-ingest.js` stays out of the worker graph.

Plus `relief.html` added to the ci.yml smoke list.

## 11. Rollout

**Task 1 is a de-risking probe, before anything is built on top:** feed
`importSTL` a realistic relief at a realistic triangle count and confirm it sews
reliably and exports STEP. The entire STEP story rests on it, and replicad
documents it as failure-prone.

If it cannot sew reliably, the fallbacks in preference order are (a) a
hand-written faceted-B-rep STEP writer — real work, but the repo already writes
STL and 3MF, or (b) dropping back to Manifold-only, which would reopen the
decision Scott explicitly pushed back on and so requires re-consultation, not a
silent narrowing.

Then: pure leaves (`heightfield.js`, `png-decode.js`) with their tests; the
asset layer (`images.js`, registration, cache keys); the Manifold adapter; the
OCCT adapter; the control type and ingest helper; the `relief.js` reference part
and its three glue files; docs; version bump.

### Probe result (2026-08-29)

Task 1's probe (`spike/importstl-probe.mjs`, deleted after this recording —
full report in `.superpowers/sdd/2026-08-29-heightfield-images/task-1-report.md`)
fed a watertight sine-relief mesh (the plan's own `relief(n)` generator,
60x60mm plate) to both `replicad.importSTL` (async) and a hand-assembled
synchronous equivalent reached through `replicad.getOC()`, at five grid sizes.

| n | triangles | sew (async / sync) | STEP export (async / sync) | STEP size | boolean on sync shape |
|---|---|---|---|---|---|
| 60 | 7,670 | 2.47s / 2.49s | 1.33s / 1.18s | 17.6 MB | OK, 1.73s |
| 90 | 16,910 | 5.79s / 5.88s | 3.04s / 2.76s | 40.3 MB | OK, 4.03s |
| 108 | 24,182 | 8.22s / 8.60s | 4.41s / 4.11s | 58.3 MB | OK, 5.86s |
| 120 | 29,750 | 10.40s / 10.61s | 5.44s / 8.67s | 72.4 MB | OK, 11.32s |
| 200 | 81,590 | 31.72s / 35.14s | 16.10s / 15.45s | 206.5 MB | OK, 22.85s |

(`n=120`'s sync STEP-export and boolean times run ~1.6x above the
per-triangle trend the other rows follow — probable measurement noise from
running sizes back to back in one process, not a real per-size effect; see
the task 1 report §1 for detail.)

**Both paths sewed at every size, including the nominal `n=200` case, with no
failures and no hangs.** Open item 2 below (the OCCT triangle-count threshold
for the STEP-size warning) is answered by this probe — see
`STEP_TRIANGLE_WARN` below — and is struck from that list. This is also Task
1's own go/no-go: proceed with OCCT STEP support as designed.

**`STEP_TRIANGLE_WARN = 24,000`** — the sew-time threshold, set just under
`n=108` (24,182 tris, 8.2-8.6s), the largest size measured to sew in under
10s.

**The synchronous path works and is what Task 6 implements.** replicad's own
`importSTL` is async only because it awaits `Blob.arrayBuffer()`; since
`meshToStl` already hands back an `ArrayBuffer`, that await is pure overhead.
The same OCCT sequence (`StlAPI_Reader` -> `ShapeUpgrade_UnifySameDomain` ->
`BRepBuilderAPI_MakeSolid`) run synchronously through `replicad.getOC()`,
wrapped with `replicad.cast()` (a public export, despite this plan's earlier
assumption it wasn't), sewed successfully at every size and produced a shape
that both `exportSTEP` and a boolean accepted. Every intermediate OCCT
object is freed via `replicad.localGC()` (also a public export) in a
`try/finally`, so the sequence leaks no native memory across repeated calls —
important since `heightfield` rebuilds on every param change during an
editing session. `heightfield` therefore stays synchronous on both backends —
no contract change. The exact call sequence, cleanup included, is recorded
verbatim in the task 1 report §2 for Task 6 to copy.

**Surprising finding: STEP file size, not sew time, is the binding
constraint at realistic grid sizes.** `importSTL`'s OCCT sequence keeps the
mesh's own per-triangle faceting rather than merging into larger planar
faces, so STEP size scales roughly linearly with triangle count at ~2.3-2.6
KB/triangle — the `n=200` case (81,590 triangles, the plan's own nominal
size) produces a 206.5 MB STEP file. `STEP_TRIANGLE_WARN` as set above bounds
sew time to under 10s but still permits a ~55-60 MB export; the design may
want a separate, size-driven warning independent of triangle count, since
STEP size is also content-dependent (flatter reliefs compress better via
`ShapeUpgrade_UnifySameDomain` than high-frequency ones at the same triangle
count).

## Accepted risks and non-goals (recorded)

- **`importSTL` robustness** — the load-bearing unknown, probed first.
- **STEP file size** — a fine-pitch relief produces a very large STEP. Warned
  about, not prevented; pitch is the author's throttle.
- **OCCT boolean cost** — a relief unioned into an OCCT-routed part is slow by
  construction. Documented, not mitigated.
- **A bare `.jpg` URL in `images` fails in core** — consistent with the layering
  (format breadth is the host's job), but a real edge an author can hit. The
  error names `imageToPng`.
- **Aspect is not preserved** — the image stretches to `w x d`. A `fit` option
  is a non-goal.
- **Non-goals:** cylindrical/revolved wrapping; image-to-`Shape2D` contour
  tracing; true displacement of an arbitrary existing surface (`refine` + `warp`
  — verified present in manifold-3d 3.5.1, but blocked on UV projection and
  self-intersection, and deserving its own spike); WebP/AVIF/HEIC in core;
  bytes-in-params share links.

## Open items carried into planning

1. The exact vertex budget and its default `pitch` clamp.
2. ~~The OCCT triangle-count threshold for the STEP-size warning.~~ Resolved
   by the Task 1 probe: `STEP_TRIANGLE_WARN = 24,000` (see "Probe result
   (2026-08-29)" above).
3. Whether interlaced (Adam7) PNG is supported or rejected with a clear message.
4. `imageCatalog`'s `ImageAsset` shape, settled against cloud's storage model.
