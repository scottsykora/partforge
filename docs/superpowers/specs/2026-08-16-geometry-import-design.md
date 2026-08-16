# Geometry import (STEP / STL / 3MF) — design

**Date:** 2026-08-16
**Status:** approved design, pre-implementation
**Scope:** partforge framework + CLI + oracle. partforge-cloud plumbing is a
documented follow-up (see "Cloud follow-up" at the end).

## Goal

Let a part import external geometry files — STEP, STL, 3MF — and use them two
ways:

1. **Reference** — a ghost body the agent workflow measures (`partforge
   measure`, viewer measure mode) and rebuilds a parametric part around, with
   a verify-time deviation gate holding the rebuild to the reference.
2. **Component** — a real body inside the part that participates in booleans,
   scaling, placement, and export like any other `Solid`.

Primary consumer: the partforge-cloud agent loop (a user hands the agent a
file; the agent imports it, measures it, and iterates). Browser support is
required but secondary; end-user upload UI is out of scope.

## Decisions (settled during brainstorming)

| Question | Decision |
| --- | --- |
| API shape | New kernel op `k.import(name)` returning an ordinary `Solid`. |
| Asset reference | `PartDefinition.imports: { name: source }`, fonts-style; source = `URL` \| URL string \| bytes \| thunk. No author-declared digest; the framework content-hashes the bytes itself. |
| Backend mismatch | Native on the home backend (STEP→B-rep on OCCT; STL/3MF→mesh on Manifold). STEP used on the Manifold backend is tessellated transparently (exactness lost on that path). Mesh→B-rep is never attempted: STL/3MF on the OCCT backend is an error. |
| Dirty meshes | Basic repair (vertex merge + winding/orientation fix), then fail loud with an ERROR-PATTERNS entry. No hole-filling / remeshing in v1. |
| Oracle role | (a) measure the reference with existing machinery, (b) a new `deviation` verify assertion (built vs reference). Ghost display falls out of existing `exportable: false` + `display: {opacity}`. |
| Cloud | Framework first. Sources accept plain URL strings so cloud can later substitute signed Storage URLs without framework changes. |

## 1. Asset pipeline

### Declaration

```js
export default {
  // mirrors `fonts:` exactly
  imports: {
    scan: new URL("./scan.step", import.meta.url), // Vite serves it; Node reads disk
    lid:  "https://…/signed-url.stl",              // what cloud will substitute
    chip: bytesOrThunk,                            // ArrayBuffer/Uint8Array or () => any of these
  },
  subParts: [
    { // reference ghost — display-only, never exported
      name: "ref", build: (k) => k.import("scan"),
      exportable: false, display: { opacity: 0.3 },
    },
    { // component — a real body in a boolean
      name: "body",
      build: (k, p) => k.cut(k.import("scan").scale(p.fit), k.cylinder(p.hole, 20)),
    },
  ],
};
```

### Format detection

Filename extension when the source has one (`.step`/`.stp`, `.stl`, `.3mf`);
magic-bytes fallback otherwise: `ISO-10303-21` header → STEP, `PK` zip
signature → 3MF, else STL (ascii vs binary sniff).

### Resolution (async, pre-build)

`resolveImports()` — a sibling of `resolveFonts()` in `src/framework/fonts.js`
— runs in the async phase before the synchronous `build`:

- fetch/read bytes (global `fetch` for URLs, same as fonts; DOM-free,
  `node:`-free so the worker graph stays clean),
- compute a SHA-256 content digest (`globalThis.crypto.subtle`, available in
  workers and Node),
- memoize by source identity, fonts-style.

Wired in **both hosts**: the worker job loop (`src/framework/jobs.js`, where
fonts resolve today) and the Node boots (`src/testing/manifold.js`,
`src/testing/occt.js`). Parsed results land in a `kernel._imports`
side-channel following the `k._fonts` convention (`_` prefix = framework
side-channel, off the contract, invisible to the probe).

### Parsing, per backend

- **OCCT worker:** STEP bytes → replicad `importSTEP` → master B-rep shape
  held in `_imports`. STL/3MF on OCCT → **error** (ERROR-PATTERNS entry).
- **Manifold worker:** STL/3MF bytes → our own parsers (STL reader beside the
  writer in `geometry/mesh-stl.js`; 3MF reader using the same `fflate` dep as
  the writer in `geometry/threemf.js`) → repair (vertex merge à la
  `mesh.merge()` + winding/orientation fix) → `Manifold.ofMesh` (via the
  existing `mesh-build.js` path). Still non-manifold after repair → loud
  error carrying defect detail (e.g. open-edge count).
- **STEP on the Manifold backend (crossover):** the main thread sees a STEP
  import on a manifold-routed part and asks the **OCCT worker** to run a new
  `tessellate-import` job — bytes in, transferable triangle arrays out — then
  ships the triangles to the manifold worker inside the generate message.
  This is the first *inbound* transferable payload; nothing prevents it
  (worker→main already transfers everywhere).
  - **Node:** the kernels-must-not-share-a-process invariant means the CLI
    does the same hop via a `worker_thread`. **Spike first:** replicad's own
    `setManifold` integration suggests coexistence may actually work
    in-process; if the spike passes, the Node path simplifies to sequential
    in-process boots and the worker_thread is dropped.

### Units

Everything normalizes to millimetres at parse time: STEP units honored by the
OCCT importer; 3MF `unit` attribute converted; STL assumed mm (documented).

### In build

`k.import("scan")` looks up the parsed master and returns an ordinary
`Solid`:

- OCCT: a **fresh clone per call** (replicad transforms consume operands; the
  master must never be handed out directly).
- Manifold: a cheap handle over the parsed Manifold object.
- `_hash = h("import", name, digest)` — see caching.
- Undeclared name → error naming the declared imports (mirrors the
  `text2d: unknown font` behavior).
- Under the probe, `k.import` returns the chainable dummy Solid like any op.

## 2. Kernel contract, probe/lint, caching

### Contract

`import` is one new kernel-level op returning a Solid — **additive** under
KERNEL-CONTRACT.md's versioning policy (no contract-version bump; minor npm
release). It is **not** in `OCCT_ONLY_OPS`: the tessellation crossover means
a STEP import does not force OCCT routing. Backend selection is unchanged
(fillet/chamfer/shell decide; `meta.backend` overrides). The op lands in the
`KERNEL_OPS` list in `geometry/kernel.js`, both backend implementations, and
the pinned coverage in `test/kernel-contract.test.js` — the three places the
contract test forces to move together.

### Probe and lint

- Probe: dummy Solid, as for any op; backend detection and relevance probing
  unchanged.
- Lint learns the op (no `unknown-op`) plus two new static checks:
  1. `k.import("x")` with `"x"` not declared in `imports:`;
  2. an STL/3MF import in a part that routes to OCCT (caught before any
     kernel boots).

### Cache correctness

1. **Worker solid cache:** the imported Solid's `_hash` is
   `h("import", name, digest)`; every downstream op key incorporates the file
   digest automatically. Changed file → changed digest → all dependent keys
   change. No poisoning, no thrashing.
2. **Main-thread display-mesh cache:** today `relevanceHash` sees only params,
   so a changed file with unchanged params would serve a stale mesh silently.
   Fix: the recording proxy that discovers param reads also records which
   import names a sub-part touches; those imports' digests are appended to
   that sub-part's relevance hash.
3. **Parse memoization:** parsed masters are memoized per kernel by digest, so
   slider drags / view switches never re-parse a multi-MB file.

Determinism holds: bytes resolve outside build, the digest pins identity, and
`build` stays a pure function of `(k, p, d)`.

## 3. Oracle, CLI, errors

### Deviation gate

New verify assertion (grammar in `oracle/assert-dsl.js`, evaluation in
`oracle/verify.js`):

```js
verify: [["deviation", "body", {
  ref: "scan",            // an import name (or another sub-part)
  maxVolumeDeltaPct: 2,   // cheap sanity gate
  maxBboxDelta: 0.5,      // mm, per-axis max
  maxXorVolume: 50,       // mm³ of symmetric difference — the real match check
}]]
```

All metrics compose from existing oracle machinery (booleans + volume + bbox
on the mesh representation). Runs wherever verify runs: `partforge measure`
(non-zero exit on failure) and the browser `inspect` job. Thresholds are all
optional; at least one must be present.

Measuring the reference itself needs nothing new: an imported ghost sub-part
already appears in `measure` output (bbox / volume / watertightness), which is
the agent's rebuild-loop input.

### CLI

`partforge measure|render|lint` work on importing parts with no new flags —
the `src/testing/` boots accept and resolve `imports` the way they accept
`fonts`. This work also **fixes the existing fonts gap**: `bin/cli.js` never
passes `fonts` to the kernel boots, so a font-using part works in the browser
but throws under `measure`. One shared asset-resolution hook, wired for both
fields, with a regression test.

### Errors

New ERROR-PATTERNS.md entries (one `##` per pattern, literal symptom → cause
→ fix):

- mesh still non-manifold after repair (with open-edge counts),
- unrecognized format,
- undeclared import name,
- STL/3MF on the OCCT backend,
- STEP tessellation hop failure.

Import errors surface through the existing build-error path with the sub-part
name attached.

## 4. Testing

- **Fixtures:** tiny checked-in files — hand-written ascii STL cube, minimal
  STEP box, and a 3MF produced by our own writer (doubling as a writer/reader
  round-trip test).
- **Isolation:** Manifold-path and OCCT-path tests in separate files (the
  per-process kernel rule; vitest isolates per file).
- **Contract:** `kernel-contract.test.js` op-list updates; probe/lint list
  coverage.
- **Layering:** the new parsers stay DOM-free and `node:`-free
  (`test/worker-layering.test.js` already enforces the graph).
- **Reference part:** `src/parts/import-demo.js` + the three glue files,
  demonstrating both uses (ghost + deviation gate; imported body in a
  boolean). Becomes a smoke-test entry and the AUTHORING-PARTS.md example.
- **CLI:** regression test that boots pass `fonts` *and* `imports` (the gap
  that let the fonts miss ship).

## 5. Rollout

- One **minor** version bump in `package.json` on the PR (release is
  automatic on merge; forgetting the bump is the known quiet failure mode).
- AUTHORING-PARTS.md gains an "Importing geometry" section;
  KERNEL-CONTRACT.md gains the op row (additive).

## Cloud follow-up (documented, not in scope)

partforge-cloud boots part modules from a blob URL, so
`new URL("./x.step", import.meta.url)` cannot resolve there. What cloud needs,
in its own brainstorm/spec against that codebase:

- A `part_assets` table + private Storage bucket, modeled on the existing
  `part_images` pattern (migration `0031_part_images.sql`: metadata table,
  bytes at `<partId>/<uuid>.<ext>` in a private bucket). **Note:** despite
  earlier recollection, no part-assets table exists in cloud today —
  `part_images` is the closest precedent.
- The loader substituting signed Storage URLs into `imports:` when compiling
  part source. No framework changes required — plain URL-string sources are
  already part of this design.
- An agent-facing way to attach a user's uploaded file to a part revision.

## Open items carried into planning

- **Spike:** can OCCT and Manifold boot in one Node process? Decides
  worker_thread vs sequential boots for the CLI crossover path.
- Repair scope is deliberately v1-minimal; an aggressive-repair pipeline is a
  possible future feature, not designed here.
