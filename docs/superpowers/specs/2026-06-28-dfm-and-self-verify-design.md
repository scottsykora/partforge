# DFM checks + co-located self-verification for partforge — design

**Date:** 2026-06-28
**Status:** Approved (design). Verify engine + DSL slice implemented (2026-06-28); voxel/SDF core + min-wall computation pending (next plan).
**Repo:** `partforge` (sibling to `Drum Machine/`)
**Builds on:** the `measure` / `render` harness (2026-06-22) — this is the
printability-linting follow-on that harness explicitly left out of scope.

## Goal

Make a partforge part **self-verifying** so an LLM agent (or a human) gets a real
pass/fail signal on whether the part is *correct* and *printable* — not just whether
it boots and is watertight.

Today `measure` reports facts (bbox, volume, watertight, holes/genus, assembly
overlaps) and gates its exit code on `watertight && no-overlaps`. That catches
degenerate geometry but says nothing about manufacturability (does a wall survive an
FDM nozzle? does it fit the bed?) or design intent (is the bore still there? did an
edit blow up the size?).

This adds two complementary things, in one declarative place:

1. **DFM checks** — manufacturability metrics measured from the geometry and gated
   against a reusable **process profile** (FDM-PLA, etc.).
2. **A co-located `verify` block** on the `PartDefinition` — the part declares its own
   process profile *and* its design-intent assertions, so verification lives next to
   the schema the LLM is already writing. One artifact, self-checking.

The agent/CI verify loop is the consumer: edit the declarative part → run
`partforge measure` → get a per-check pass/fail and a meaningful exit code.

## Decisions (from brainstorming)

1. **Scope of the `verify` block:** *both* a reusable DFM **process profile** and
   per-part **design-intent assertions** (`expect`). Not one or the other.
2. **Parameter coverage:** check **defaults + every declared preset** (bounded,
   deterministic, covers the configs users actually pick). A part may override the case
   list. Slider-extreme sampling is deferred.
3. **DFM v1 set:** exact/cheap checks are **hard gates** (bed-fit, watertight,
   hole-count, assembly overlaps, declared intent). **Min wall thickness** is an
   approximate **warning** (reported, never fails `ok`) until its algorithm is trusted.
   Overhang and clearance-gap gating are deferred (clearance becomes cheap later via the
   SDF core — see below).
4. **Run surface (v1):** CLI (`partforge measure`) + the exported `verify()` for vitest.
   No in-app/live UI in v1 (same engine can feed a panel later).
5. **Architecture:** a layered `verify()` *on top of* `measure()` — `measure` stays a
   pure facts reporter; `verify` is the policy/judgment layer. (Rejected: folding policy
   into `measure`; putting verification in a separate non-co-located file.)
6. **Assertion format:** a compact **string DSL** (`">=1.5"`, `"0.4..0.6cm3"`,
   `"<=[12,12,16]"`), not structured objects — terser for an LLM to emit and a human to
   read. Mitigated by a **strict parser** that throws a clear, located error on any
   unrecognized form (no silent skips).
7. **Case checking is sub-part-aware:** reuse the `param-deps` analyzer so a preset only
   rebuilds/re-checks the sub-parts whose relevant params actually change vs. defaults.
8. **Min-wall method:** spike a **voxel/SDF** approach as a **modular, reusable core**
   (not ray/shot), because a queryable signed distance field is reusable for clearance,
   min-feature, and offset checks. Gated by an accuracy/perf evaluation with a documented
   **ray/shot fallback**.

## The `verify` schema (co-located declaration)

A `PartDefinition` gains one optional top-level key, `verify`. Everything in it is
optional; a part with no `verify` block behaves exactly as today.

```js
verify: {
  // DFM: name a built-in profile, or inline/extend one. Applies to ALL sub-parts.
  process: "fdm-pla",
  // process: { bed: [220,220,250], minWall: 1.2, clearance: 0.2 },  // inline form

  // optional: which param configs to check. Default = defaults + every preset.
  cases: ["defaults", "M3", "M5"],

  // design intent: per sub-part facts this part must satisfy.
  expect: {
    spacer: {                 // a sub-part name
      holes: 1,               // exact integer (the bore)
      minWall: ">=1.5",       // may tighten beyond the profile
      volume: "0.4..0.6cm3",
      bbox:   "<=[12,12,16]",
    },
    _view: {                  // whole-view / assembly scope
      overlaps: 0,
      bbox: "<=[220,220,250]",
    },
  },
}
```

**Division of labor:**

- `process` carries *universal manufacturability* rules and applies to every sub-part:
  `bed` → a hard bbox-fit gate; `minWall` → a warn; `clearance` → (deferred gate, see
  SDF). The part "opts into printability" just by naming a process.
- `expect` carries *this part's design intent* — the facts that should stay true as the
  LLM or a slider changes things. A sub-part may also tighten a DFM number here.

**Gate vs. warn is a property of the metric, not where it is declared.** A check's `kind`
is determined by the reliability of the *measured value* it compares against, not by
whether it sits in `process` or in `expect`. Exact facts (bbox, watertight, holes,
overlaps, volume, area) are **gates** wherever asserted. The approximate min-wall
measurement is a **warn** wherever asserted — so `expect.<part>.minWall` is reported but
never fails `ok` in v1, exactly like the profile's `minWall`, until the algorithm is
trusted.

**Manifold-only facts:** `holes`/`watertight` are Manifold-only (OCCT parts report them
`n/a`). Assertions on those facts are **skipped, not failed**, on OCCT parts —
consistent with current `measure` behavior.

### Assertion mini-DSL

A small, strictly-parsed grammar:

- **Scalar:**
  - bare number → equality (integers exact; floats within a small relative tolerance)
  - `">=n"`, `"<=n"`, `">n"`, `"<n"` → comparator
  - `"a..b"` → inclusive range
  - optional unit suffix on any of the above: `mm`, `cm`, `mm3`, `cm3` (normalized to
    mm / mm³ internally)
- **Vector (bbox):** `"<=[x,y,z]"` / `">=[x,y,z]"`, applied componentwise; `*` skips an
  axis (e.g. `"<=[200,*,200]"`).
- **Boolean:** `watertight: true`.

**Strictness:** any unrecognized form (typo like `">==1.5"`, unknown unit, malformed
vector) throws an error naming the part, the sub-part/scope, the metric, and the
offending string. A bad assertion fails loudly the moment `verify` runs — it never
silently passes or skips.

## Architecture

```
                 PartDefinition.verify  (process + cases + expect)
                              │
   measure(kernel, part, view, params, {minWall?})   ← pure FACTS (unchanged contract)
        bbox · volume · area · tris · watertight · holes · overlaps · [minWall]
                              │
   verify(kernel, part, {process?})                  ← POLICY / judgment layer
     case expander (param-deps aware) → measure per case → evaluate profile + expect
                              │
        { ok, cases[{case, params, checks[{id,scope,kind,expr,actual,pass,message}]}],
          failures, warnings }
                              │
   ┌──────────────────────────┴───────────────────────────┐
   CLI  `partforge measure`  (prints checks, gates exit)   `partforge/testing` → verify()
```

### `measure.js` (extended)

- New optional 5th arg: `measure(kernel, part, view, params, opts)`. Existing 4-arg
  callers are unaffected. `opts.minWall` (default off) enables min-wall computation; each
  sub-part then carries a `minWall` field (`null` when off or unreliable). Plain
  `measure` stays fast — no SDF cost unless asked.
- No change to the existing `ok` semantics here; the gate composition lives in `verify`
  and the CLI.

### `verify.js` (new) — exported as `verify` from `partforge/testing`

`verify(kernel, part, { process? })` (an optional `process` overrides the part's):

1. **Case expander** — builds `{ name, params }` from `verify.cases` (or defaults + every
   preset), merging preset overrides onto defaults exactly as the control panel does.
   **Sub-part-aware:** using `param-deps`, compute each sub-part's read-set; per case,
   only sub-parts whose relevant params differ from the defaults case are rebuilt /
   re-measured / re-asserted (reusing the same relevance hash `mount.js` uses for its
   layer-1 cache). Unaffected sub-parts reuse the defaults result.
2. For each (case, sub-part) it needs: call `measure` (with `minWall` enabled iff a
   profile/`expect` references wall thickness).
3. **Evaluate** profile gates/warns + `expect` assertions via the DSL evaluator.
4. Return the structured result above. `kind: "gate"` failures set `ok:false`;
   `kind: "warn"` (currently just `minWall`) are reported but never affect `ok`.

Three independently-testable internals:

- **`profiles.js`** — built-in process profiles (`fdm-pla`, `fdm-petg`, `resin`)
  resolved by name; an inline object overrides/extends a named base. A `process` passed
  to `verify()` / the CLI overrides the part's.
- **assertion parser + evaluator** — DSL string → predicate; compares to a measured
  value with unit normalization and a small float tolerance; strict on bad input.
- **case expander** — the param-deps-aware logic above.

### CLI `partforge measure` (extended)

- Still prints the facts table.
- If the part has a `verify` block (or `--process <name>` / `--verify` is passed), also
  prints a **checks block grouped by case** — `✓` gate pass, `✗` gate fail, `⚠` warn —
  and folds the verify result into the JSON report it already writes.
- **Exit code** = non-zero if the existing facts `ok` (watertight/overlaps) is false
  **or** any verify hard gate fails. `--no-verify` opts out; `--json` (exists) includes
  everything.

## Min-wall thickness: modular SDF core + first consumer

### `sdf.js` (new, reusable) — the spike's durable asset

```
buildSDF(mesh, { voxelSize | resolution, sign? }) → {
  dims:[nx,ny,nz], origin, voxelSize,
  data: Float32Array,        // signed distance per voxel (− outside / + inside)
  sample(x,y,z) → number,    // trilinear query at an arbitrary point
}
```

- **Distance:** unsigned distance to the nearest triangle, computed in a narrow band
  around the surface and propagated inward (fast-sweeping). The spike may start
  brute-force-per-voxel and optimize once correctness is pinned.
- **Sign:** Manifold meshes are watertight, so inside/outside is cheap (ray-parity).
  `sign` is pluggable so a winding-number variant can drop in for dirty meshes later.
- **Resolution policy:** `voxelSize` defaults to ≈ `profile.minWall / 3` (a thin wall
  spans ~3 voxels), with a hard voxel-count cap and a clear "resolution too fine for
  bbox" warning instead of an OOM. Narrow-band storage keeps memory bounded.
- Operates on the **mesh `measure` already extracts** (positions/indices) — no new kernel
  dependency; works for both Manifold and OCCT parts (both produce a mesh).

### Min-wall as the first SDF consumer

From the interior distance field, thickness at a medial-axis (ridge) point ≈
`2 × distance`. Take the minimum over ridge points classified as a **sheet** (a wall)
rather than a **curve/point** (an edge or spike) — that classification is what stops
bores and corners from reading as thin walls. Returns `{ value, location }`, or `null`
when no reliable reading exists (a failed measurement must never masquerade as a thin
wall). Always a **warn**.

**Documented limitations:** holes/bores read thin near their rims; very tight concave
corners can under-report. Acceptable for a warning whose job is "look here," and the
reason it does not gate `ok`.

### Reusable later (designed-for, not v1)

Same SDF core, future consumers: **clearance/gap** between two sub-parts (query A's SDF
at B's surface → min positive distance = real gap; this revives the deferred clearance
gate cheaply), **min feature size**, **shell/offset validation**, a faster `overlaps`
proxy.

### Spike gate (go / no-go)

v1 delivers the SDF core + min-wall-via-SDF behind an explicit **evaluation**: accuracy
on known fixtures (a ~1 mm-wall tube → ~1.0, a solid block → large, the drum) and
wall-clock vs a quick ray/shot baseline. If accurate and not pathologically slow, it
ships. If it underperforms, fall back to ray/shot for min-wall and **keep the SDF core**
for clearance/feature use. Either way min-wall is a warn, so the spike can't block a
release.

## Testing

- **Unit — DSL parser/evaluator:** every form (scalar comparators, range, units,
  vector, boolean) and strict-error cases (bad comparator, unknown unit, malformed
  vector) with clear located messages.
- **Unit — profiles:** resolution by name, inline object, and inline-overrides-named.
- **Unit — case expander:** the param-deps dedup — assert sub-parts unaffected by a
  preset reuse the defaults result and affected ones recompute.
- **SDF core:** sampled distance accuracy on analytic shapes (cube center, sphere)
  within tolerance.
- **Min-wall fixtures:** ~1 mm-wall tube → ~1.0, solid block → large, degenerate →
  `null`.
- **`verify()` integration:** `demo.js` with a good block → `ok:true`; a deliberately
  violating block (e.g. `holes: 2`) → `ok:false` naming the right failure.
- **CLI:** exit 0 on a clean part, 1 on a violating one.
- **Spike artifact:** a small eval (test or script) reporting SDF min-wall accuracy +
  timing vs a ray/shot baseline on the fixtures — the go/no-go evidence.

## Docs

- New **"Self-verification"** section in `AUTHORING-PARTS.md`: the `verify` schema, the
  DSL, the built-in process profiles, and how to run it (CLI + vitest).
- `demo.js` gains a worked `verify` block, as it is the worked example for everything
  else in the guide.

## Out of scope (v1)

- In-app / live-in-the-viewer DFM warnings (same engine can feed a panel later).
- Slider-extreme / corner parameter sampling (presets + defaults only for now).
- Overhang / support analysis (needs a build orientation + true support detection).
- Clearance-gap gating (the SDF core is designed to enable it next, but it is not a v1
  check).
- Threaded-fastener fit, material-shrink modeling, multi-material rules.
- Any change to the geometry kernel — this reads meshes/facts, it does not build
  geometry.
