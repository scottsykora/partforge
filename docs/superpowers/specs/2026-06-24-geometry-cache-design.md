# Geometry caching — design

**Date:** 2026-06-24
**Status:** Approved (design); implementation plan exists at `docs/superpowers/plans/2026-06-24-geometry-cache.md`; feature implemented on the `geometry-cache` branch

## Motivation

Every parameter edit currently rebuilds more geometry than it needs to. Two distinct
forms of waste:

1. **Whole-view invalidation.** `mount.js` bumps a global `paramsVersion` on every
   edit, invalidating *every* sub-part's mesh cache. Editing one part in a multi-part
   assembly rebuilds all of them, even parts that don't read the changed parameter.
2. **Whole-build recomputation.** A single sub-part's `build` runs start-to-finish on
   every regenerate. If a parameter only affects the *final* operations of a long build
   (a helix sweep, a chain of booleans), the expensive early work is recomputed for
   nothing.

This design eliminates both with **two independent cache layers**, each owning one
boundary and each removable without touching the other.

## Design goal: isolation / removability

Both layers are deliberately separable, matching the pattern established by
`param-deps.js` (relevance-aware panel). Each can be disabled independently and the
system falls back to today's exact behavior:

- Revert `mount.js`'s hash-validation → fall back to global-version invalidation
  (Layer 1 gone, Layer 2 unaffected).
- Remove the cache wiring in `manifold-backend.js` / delete `solid-cache.js` → fall
  back to full rebuilds (Layer 2 gone, Layer 1 unaffected).

Neither layer knows the other exists. They operate in different memory spaces (JS
meshes on the main thread vs. WASM solids in the worker) and answer different questions
("do we even need to ask the worker?" vs. "if we must rebuild, how little can we
recompute?").

## The two layers

### Layer 1 — Mesh skip (main thread)

**Question it answers:** do we need to send a generate message at all?

Today `onParamChange` does `paramsVersion++`, invalidating all sub-parts. We replace
that with a per-sub-part **relevance hash**:

- A new `subPartReadKeys(part, view, params)` in `param-deps.js` — a per-sub-part
  variant of the existing `relevantParamKeys`. Same geometry-free probe kernel +
  recording Proxy; keyed per sub-part instead of unioned across the view.
- `mount.js` hashes the *values* of each sub-part's read keys. A sub-part's cached mesh
  is valid iff its hash is unchanged. If valid, **no generate message is sent** for it.
- `RELEVANT_ALL` fallback (probe can't analyze a build) → treat as changed (safe).

Caches plain meshes (Float32Arrays), which are already JS-owned and survive worker
`cleanup()`. The global `paramsVersion` / `cacheVersion` bookkeeping is replaced by
this per-sub-part hash map.

**Win:** editing one part in an assembly stops rebuilding the others.

### Layer 2 — Stage cache via automatic content-hash memoization (worker)

**Question it answers:** if we must rebuild, how little WASM work can we redo?

A content-hash memoization layer over the **preview** Manifold kernel. Transparent to
part authors — `build` is written exactly as today; no opt-in, no new authoring
concept.

**Mechanism — per-solid content hash (hash-consing):**

- Every solid wrapper carries a `_hash`, computed when the solid is created:
  - Primitives hash their scalar args: `cylinder(rb, rt, h, opts)` →
    `hash("cylinder", rb, rt, h, opts)`.
  - Derived ops hash `(opName, operandHashes, scalarArgs)` — operand identity is
    already baked into each operand's `_hash`, so this is an **O(1) fold**, not a
    recursive DAG walk.
- Before an op runs its WASM computation, it computes the result hash and checks a
  `Map<hash → solid>`:
  - **Hit** → return the cached solid, skip the WASM work entirely.
  - **Miss** → compute, store, return.

Because each solid carries its own hash, **call order does not matter for correctness**.
Changing a parameter gives new hashes to exactly the ops that read it (cache misses →
recompute); everything downstream inherits new hashes and recomputes; everything
upstream and on untouched branches keeps its hash → cache hits → skipped. This is
exactly "resume the build from the first affected operation," with no graph machinery.

**Retention — the current build's graph (bounded by construction):**

After a build finishes, every hash on the path to the final solid is known. We pin
exactly those solids and **evict any cached solid not used by the latest build**
(deleting its `_m`). Eviction runs every build, so memory tracks the *current* design,
not history. No LRU, no budget knob, no unbounded growth. This is the graph
generalization of "keep a single live chain per sub-part."

**Retain only at meaningful boundaries:**

- **Pinned:** booleans (`cut`, `cutAll`, `union`, `intersect`) and heavy primitives
  (`helixSweptTube`, `revolve`, twisted/tapered `prism`).
- **Folded but not pinned:** cheap ops (`translate`, `rotate`, `mirror`, `scale`, plain
  `cylinder`/`box`/`sphere`). They still contribute to the hash but aren't stored —
  cheaper to recompute than to retain. Because their hashes are deterministic, the
  expensive node downstream of them still hits its cache.
- **Retention is purely a memory/perf tuning choice; it never affects correctness.** A
  non-pinned node is simply recomputed (cheaply) on the way to the next pinned node.

**Compound operations (granularity control + ergonomics):**

In place of manual staging, richer vocabulary controls cache granularity. A compound op
(e.g. `boredCylinder({ od, h, bore })`) runs several primitives internally but
**hashes atomically from its own args** and returns one solid with one hash — so it *is*
a single cache node, and its internal pieces are never retained. This does double duty:
it reads better for authors and LLMs (one intent-revealing call), and it coarsens the
cache into meaningful units without anyone reasoning about cache boundaries. Seed a few
useful compounds; grow the vocabulary over time. The framework only needs the hook
(compounds return a solid with a fresh atomic hash).

**Scope: preview kernel only.** Exports (the print kernel, 480-segment) are one-shot and
produce large meshes; they build fresh with no cache, so high-res solids are never
pinned.

**Load-bearing invariant:** builds must be deterministic functions of `(k, p, d)` — no
`Math.random`, no clock, no module-level mutable state. Always true of these CAD builds,
but automatic memoization makes a violation *silent* (stale geometry), so it's
documented as a kernel contract and guarded in tests (build twice → identical final
hash).

## Integration with `tracked` / `cleanup()`

The Manifold backend tracks every WASM object created in a job and frees them all via
`cleanup()` after the job (solids have no GC). Caching requires cached solids to survive
cleanup:

- `tracked` = transient objects created this job that are **not** promoted to the cache.
- A `pinned` set holds the `_m` objects currently retained by the cache (maintained
  *across* jobs).
- `cleanup()` deletes `tracked − pinned`.
- The per-build retention update adjusts `pinned` (pin new boundary nodes, evict +
  `delete()` solids not in the latest build's graph).

This is the only place live WASM solids are touched.

## Module boundaries

- **`framework/geometry/solid-cache.js`** — *new, self-contained.* The
  `Map<hash → solid>`, the hash helpers, and the retention/eviction logic. Knows nothing
  about parts, views, or the worker — a pure data structure with cleanup hooks.
- **`manifold-backend.js`** — wired to consult the cache: each op computes `_hash`,
  checks the cache, pins/evicts via `solid-cache.js`. Gains the `pinned` set on the
  `tracked`/`cleanup()` system. Compound ops live here alongside the primitives.
- **`geometry/kernel.js`** — typedef gains `_hash` on `Solid` and any new compound ops.
- **`param-deps.js`** — gains `subPartReadKeys(part, view, params)`; otherwise
  untouched.
- **`mount.js`** — swaps global-version invalidation for the per-sub-part relevance-hash
  validation.

## Performance & memory

**Performance.** Layer 1 saves a full worker round-trip + remesh + buffer transfer for
unaffected sub-parts (the common assembly case). Layer 2 saves the WASM
boolean/heavy-primitive cost for the unchanged prefix of a build (the expensive part). A
cache hit is a `Map` lookup returning an existing immutable solid — no WASM work. The
added cost on a *miss* is hashing scalar args, negligible against geometry.

**Memory.** Bounded by construction: per sub-part, only the current build's
retained-boundary nodes are pinned (~3–15 nodes × ~0.5–7 MB preview-quality each ≈ low
tens of MB for a multi-part assembly, steady-state). Eviction every build keeps memory
tracking the current design, not history. Preview-only; exports never pin.

## Testing

Via `partforge/testing`, headless:

- **Hash correctness:** same params → same hashes; changing a param flips exactly the
  hashes downstream of where it's read, and no others.
- **Cache-hit accounting:** instrument the cache with hit/miss counters; assert a
  late-param change recomputes only the expected nodes.
- **Geometry equivalence:** a cached-resume build produces a mesh identical to a cold
  build (volume + bbox + triangle count). The cache must never change output.
- **Determinism guard:** build twice, assert identical final hash (catches accidental
  impurity).
- **Layer 1:** editing a param only one sub-part reads leaves the other sub-parts'
  meshes untouched (no regenerate message sent).

## Out of scope

- Caching the export (print) kernel.
- Cross-build history / LRU / A-B-comparison caching (retention is current-build-only).
- Automatic decomposition of opaque `build` bodies into finer nodes beyond what the op
  vocabulary already provides (compounds are the granularity lever).
- Persisting the cache across page reloads.
