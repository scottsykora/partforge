# `partforge lint` — static PartDefinition validator

**Date:** 2026-07-25
**Status:** approved design, ready for planning
**Target version:** 0.26.0 (additive; `CONTRACT_VERSION` unchanged at 1)

## Goal

Catch PartDefinition authoring errors statically — before any WASM kernel boots
and before a browser ever renders — and report them in the repo's existing
machine-readable diagnostics format, so both the CLI and the `partforge-cloud`
browser harness can gate on them.

## Motivation

partforge's *feedback* surface is mature: `measure`/`verify` cover nine metric
families, crashes auto-cite `ERROR-PATTERNS.md`, `render` emits canonical views,
and the `inspect` worker job gives the live app the same oracle facts. An agent
can already determine whether the part it built is geometrically correct.

The *authoring* surface is thin. Every structural mistake is discovered at
runtime, usually by booting Chromium:

- A `features` entry without a `sliders` array crashes the control panel at
  `src/framework/controls.js:313` (`feat.sliders.filter(...)`, unguarded). This
  shipped in the nameplate and bracket demo parts and was found only by a
  browser boot.
- A control `key` absent from `defaults` produces a silently dead control — no
  error at all.
- `k.cylinder({ radius: 5 })` throws only when a real backend runs, despite
  `op-options.js` already owning the exact valid-key list and a did-you-mean
  suggester.
- A build that throws during backend detection is silently swallowed
  (`src/framework/geometry/probe.js:60`).
- An unknown `verify.expect` metric throws mid-run, *after* `measure` has
  printed and the kernel has booted.

In the cloud harness the cost is higher still: each of these burns an LLM turn
plus a full esbuild + WASM build cycle.

Two validators for this have already drifted. `partforge-cloud`'s
`src/sandbox/loader.js:78-86` checks `meta.title`, `defaults`, and
`parts[*].build` but **not** `views`; its eval runner checks `views` separately
in `evals/runner/headless.js:40-41`. A shared linter owned by partforge ends
that split.

## Decisions

Three decisions were settled during design and are binding on the plan.

1. **Rule scope: core semantics only.** partforge lints what partforge defines —
   PartDefinition shape, view wiring, parameter-schema form, kernel API usage,
   `verify`-block form. It does **not** own partforge-cloud's multi-tenant policy
   (file-count/byte caps in `src/parts/partTree.js`, the import allowlist in
   `src/parts/imports.js`). A library has no business encoding a hosted
   service's abuse limits, and cloud must be able to retune them without a
   partforge release. Cloud keeps those checks and additionally calls the shared
   linter, deleting its drifted shape checks.

2. **Severity: two-tier — errors block, warnings advise.** A finding is
   `error` when the part is **provably broken — it cannot behave as authored —
   whether or not that throws.** Most errors do convert a slow, late, confusing
   runtime *throw* into a fast, early, precise one. But several error-tier rules
   (`missing-meta-title`, `part-view-unknown`, `control-key-not-in-defaults`,
   `preset-key-not-in-defaults`, `verify-unknown-subpart`) catch a defect that
   never throws at all — a dead control, an empty view, a `verify` expectation
   silently dropped so its gate never runs — and still earn `error`, because the
   part quietly doesn't do what its author wrote. `error` therefore *can* fail a
   part that would previously have built, measured, and verified "clean": that's
   the fix working, not a regression. Everything speculative or stylistic — lossy
   but not broken — is `warning` and rides alongside a successful result.

3. **Engine: dynamic module linting, not source-text analysis.** `lintPart`
   operates on an already-imported PartDefinition object, using two engines: a
   pure object-graph walk and a geometry-free probe execution of `build`. No
   source text is read and no parser is added. Rationale: a source-text pass
   needs either regexes (false positives in comments and strings) or a parser
   dependency (~120 KB of acorn into the browser bundle), and its
   highest-value rule — a worker importing the main entry — is already
   unreachable in cloud, whose import allowlist permits nothing but
   `partforge/geometry`. The impurity class it would have caught is instead
   caught behaviourally by the double-probe rule below.

## Non-goals

- No source-text or AST analysis. `lintSource(files)` is a clean additive
  second export later if source rules ever earn their keep; it is out of scope
  here.
- No geometric validation. Volume, watertightness, wall thickness, and
  collisions remain `measure`/`verify`'s job. Lint never boots a kernel.
- No cloud-side code changes. Those are a follow-on pass in the
  `partforge-cloud` repo, and cannot land until 0.26.0 is published anyway.
- No auto-fixing. Findings are advisory text; the linter never rewrites a part.

## Architecture

### The load-bearing constraint: import-closure purity

`partforge/lint` must run unchanged in Node, the sandbox iframe, and Deno.
That means its transitive import closure must never reach `three`,
`manifold-3d`, or `replicad`. This is achievable today because everything the
linter needs is already pure:

| Dependency | Module | Imports |
|---|---|---|
| `KERNEL_OPS`, `SOLID_OPS`, `SHAPE2D_OPS`, `KERNEL_OPTIONAL_OPS`, `SOLID_OPTIONAL_OPS`, `OCCT_ONLY_OPS` | `src/framework/geometry/kernel.js` | none |
| `KERNEL_OP_SPECS`, `SOLID_OP_SPECS`, `isPlainOptions` | `src/framework/geometry/op-options.js` | none |
| `parseAssertion` | `src/testing/assert-dsl.js` | none |
| `PROFILES`, `resolveProfile` | `src/testing/dfm-profiles.js` | none |
| `resolveDerived` | `src/framework/derive.js` | none |
| `createProbeKernel` | `src/framework/geometry/probe.js` | `kernel.js`, `derive.js` — both pure |

**Two preparatory changes to existing modules are required.**

*First, an extraction.* `SUBPART_METRICS` and `VIEW_METRICS` currently
live in `src/testing/verify.js:14` and `:39`, and that file imports
`./measure.js` and `../framework/jobs.js` — the kernel and worker graphs. The
registries themselves are pure data. Move both to a new pure module
**`src/framework/verify-metrics.js`** and have `verify.js` re-export them from
there. `src/framework/` is the correct home: the set of legal `verify.expect`
metrics is part of the PartDefinition *contract* (framework), whereas the
verify *runner* is testing infrastructure. This is a mechanical move with no
behaviour change, and it keeps one source of truth for the metric vocabulary.

*Second, an export.* `suggest(key, valid)` at
`src/framework/geometry/op-options.js:31` — the prefix-match-then-Levenshtein
did-you-mean helper — is module-private and must be exported so
`unknown-control-field` can reuse it. Duplicating the edit-distance logic into
the linter would create exactly the kind of drift this repo's contract tests
exist to prevent.

### Packaging

Add one subpath to `package.json` `exports`:

```json
"./lint": "./src/lint.js"
```

Deliberately **not** folded into `partforge/testing`, whose entry
(`src/testing.js`) pulls in the WASM kernels and is unusable inside the sandbox.
The `files` array already ships `src` and `bin`, so nothing else changes.

### Module layout

```
src/lint.js                          public entry — re-exports lintPart
src/framework/lint/
  index.js                           rule registry + guarded runner
  rules-shape.js                     definition shape & view wiring
  rules-schema.js                    parameter schema
  rules-build.js                     probe-driven kernel API usage
  rules-verify.js                    verify-block well-formedness
src/framework/verify-metrics.js      extracted metric registries (new, pure)
```

The **validating probe lives in `src/framework/geometry/probe.js`**, not under
`lint/`, as a sibling `createValidatingProbe()` that shares the existing proxy
construction. That file's stated design principle is that a hand-maintained
allowlist would drift from the real backends; a validating probe requires
exactly such an allowlist, so it must source it from `KERNEL_OPS` / `SOLID_OPS`,
which `test/kernel-contract.test.js` already pins to both backend
implementations. Same file, same lists, no new drift surface.

### Public API

One function. Synchronous, no I/O, never throws.

```js
import { lintPart } from "partforge/lint";

lintPart(part, { params } = {}) → {
  ok: boolean,          // false iff errors.length > 0
  errors:   Finding[],
  warnings: Finding[],
}
```

`params` overrides `part.defaults` for the probe pass, letting a caller lint a
specific preset or parameter combination. Omitted, the probe runs on
`part.defaults` with `derive()` resolved through `resolveDerived`.

### Finding schema

Mirrors the existing diagnostics contract documented in
`docs/AUTHORING-PARTS.md` ("The diagnostics contract (for agents)"), which
already guarantees a self-contained `hint` and an optional `pattern`. Verify's
`location: [x,y,z]` is replaced by `path`, a pointer into the definition.

```js
{
  rule: "features-requires-sliders",         // stable kebab-case id
  severity: "error" | "warning",
  message: "section \"flange\" feature 0 has no `sliders` array",
  hint: "A bare on/off control belongs in `toggles`, not `features`; `features` entries must carry a `sliders` array.",
  path: "parameters[1].features[0]",         // dotted/indexed path into the PartDefinition
  pattern: "features-missing-sliders"        // optional ERROR-PATTERNS.md entry id
}
```

`hint` is always present and always a complete corrective sentence, matching the
guarantee verify's checks already make. `pattern`, where present, is a stable
`ERROR-PATTERNS.md` heading id.

**`path` convention.** A JavaScript accessor path rooted at the PartDefinition
itself, with the root omitted: dotted for object keys, bracketed for array
indices and for keys that are not valid identifiers. Examples:
`parameters[1].features[0]`, `defaults.bore`,
`parts.spacer.views[0]`, `verify.expect.spacer.holes`,
`parameters[0].presets["M3"].od`. Findings that concern the definition as a
whole (`missing-views`, `missing-defaults`) use the empty string. `path` is for
human and agent navigation only — nothing parses it.

## Rule catalog

Severity assignment follows Decision 2 without exception: `error` wherever the
part is provably broken, whether or not the condition throws at runtime — the
rule tables below mark each one, and several errors (`missing-meta-title`,
`part-view-unknown`, `control-key-not-in-defaults`, `preset-key-not-in-defaults`,
`verify-unknown-subpart`) are exactly the silent, non-throwing kind.

### Group 1 — definition shape (`rules-shape.js`)

This group is the replacement for partforge-cloud's `loader.js:78-86` and the
eval runner's separate `views` check.

| Rule | Severity | Condition |
|---|---|---|
| `missing-meta-title` | error | `part.meta?.title` absent or not a string |
| `missing-defaults` | error | `part.defaults` absent or not a plain object |
| `no-buildable-parts` | error | `part.parts` empty, or any entry whose `build` is not a function |
| `missing-views` | error | `part.views` absent or empty — **the rule cloud's browser validator lacks today** |
| `part-view-unknown` | error | a name in `parts[x].views` has no entry in the top-level `views` map |
| `view-unused` | warning | a `views` entry no subpart references — renders empty |

### Group 2 — parameter schema (`rules-schema.js`)

| Rule | Severity | Condition |
|---|---|---|
| `features-requires-sliders` | error | a `features` entry with no `sliders` array — crashes `controls.js:313` |
| `control-key-not-in-defaults` | error | an `advanced[].key` / `features[].key` / `toggles[].key` absent from `defaults` — control is silently dead |
| `preset-key-not-in-defaults` | error | a key inside a `presets` bundle absent from `defaults` — same failure via presets |
| `slider-range-excludes-default` | warning | `defaults[key]` outside a control's `min..max` — the slider snaps and the geometry silently differs from what was authored |
| `unknown-control-field` | warning | unrecognised key in a control descriptor (e.g. `lable`), with a did-you-mean |
| `duplicate-control-key` | warning | the same key owned by two sections |
| `default-not-exposed` | warning | a `defaults` key no control descriptor references |

Recognised control-descriptor fields, for `unknown-control-field`, are those
`src/framework/controls.js` reads: `key`, `label`, `unit`, `min`, `max`, `step`,
`control`, `hidden`, `description`; plus `on` and `sliders` on `features`
entries, and `key`, `label`, `on`, `description` on `toggles` entries.

`unknown-control-field`'s did-you-mean reuses the existing suggester in
`op-options.js` — the prefix-match-then-Levenshtein `suggest(key, valid)` at
`op-options.js:31`. That function is currently module-private and **must be
exported** as part of this work; the linter must not carry a second copy of the
edit-distance logic.

For `default-not-exposed`, a key counts as exposed if any control descriptor
references it — including a descriptor marked `hidden: true`. Hidden internal
constants such as `demo.js`'s `flange_h` are a documented, legitimate pattern
and must not warn.

### Group 3 — build and kernel API (`rules-build.js`, probe-driven)

| Rule | Severity | Condition |
|---|---|---|
| `unknown-kernel-op` | error | `k.<name>()` where name ∉ `KERNEL_OPS` ∪ `KERNEL_OPTIONAL_OPS` |
| `unknown-solid-op` | error | `.<name>()` on a chained handle where name ∉ `SOLID_OPS` ∪ `SOLID_OPTIONAL_OPS` ∪ `SHAPE2D_OPS` |
| `invalid-op-options` | error | re-thrown verbatim from `KERNEL_OP_SPECS[op].toArgs` / `SOLID_OP_SPECS[op].toArgs` — inherits the existing `cylinder: unknown option "radius" — did you mean r?` message at no cost |
| `build-throws` | error | the probe build threw — currently swallowed at `probe.js:60` |
| `manifold-backend-uses-occt-op` | error | `meta.backend === "manifold"` together with a call to an `OCCT_ONLY_OPS` member — a guaranteed `KernelCapabilityError` |
| `build-runaway` | error | the probe recorded more than `MAX_PROBE_OPS` (100 000) ops — a runaway loop |
| `nondeterministic-build` | warning | two probe passes with identical `(p, d)` produced different recorded op sequences → impure build; `pattern: impure-build-stale-preview` |

**Handle-type detail.** The probe returns one chainable proxy for every
non-query op, so it cannot distinguish a `Solid` from a `Shape2D` — `k.shape2d()`
and `k.box()` yield the same handle. `unknown-solid-op` therefore validates
against the **union** of `SOLID_OPS`, `SOLID_OPTIONAL_OPS`, and `SHAPE2D_OPS`.
This is deliberately permissive: it will not catch calling a Shape2D-only method
on a Solid, but it never produces a false positive, which matters more for an
`error`-severity rule. Distinguishing the two would require a typed probe and is
out of scope.

**Probe validation detail.** The validating probe runs each op's `toArgs`
normalizer when — and only when — the call is in options form
(`isPlainOptions(args[0]) && args.length === 1`), matching the normative rule in
`KERNEL-CONTRACT.md`. It runs `toArgs` (key and required-argument validation)
but **not** the separate `check` hook, because `check` inspects real geometry
values: `revolve`'s check calls `boundingBox()` on its profile and iterates the
point list, neither of which is meaningful against a proxy. Legacy positional
calls are recorded but not argument-validated, which is correct — they have no
options contract to validate against.

**Determinism detail.** `nondeterministic-build` compares the ordered sequence
of `(opName, normalizedArgsJSON)` pairs across two probe passes over the same
`(p, d)`. Arguments that are proxies serialize to a stable placeholder. This
catches `Math.random`, `Date.now`, and module-level mutable state without any
source analysis. It is a warning rather than an error because a
sequence difference can in principle come from a legitimate but unusual
construction, and because the failure it predicts (stale memoized geometry) is
intermittent rather than certain.

### Group 4 — verify block (`rules-verify.js`)

All four currently throw mid-run, after `measure` has printed and the kernel has
booted.

| Rule | Severity | Condition |
|---|---|---|
| `verify-unknown-metric` | error | a metric in `expect` absent from `SUBPART_METRICS` (subpart scope) or `VIEW_METRICS` (`_view` scope) |
| `verify-unknown-subpart` | error | an `expect` key that is neither `_view` nor a name in `part.parts` |
| `verify-bad-expr` | error | `parseAssertion` rejects the expression |
| `verify-unknown-process` | error | `verify.process` names a profile absent from `PROFILES` |
| `verify-expect-throws` | error | `verify.expect`, in its function form, threw when invoked |

When `verify.expect` is a function (the per-case form, `(p, d) => ({…})`), the
rule invokes it once with the probe's `(p, d)` inside the per-rule guard and
lints the returned object.

## Host integration

### CLI

New command, registered in the dispatch table at `bin/cli.js:61` and in `USAGE`:

```bash
npx partforge lint <part> [--params '<json>'] [--json] [--out <file>] [--strict]
```

- Exit 0 when clean, 1 when any `error` finding is present.
- `--strict` additionally fails on warnings, for CI.
- Human output mirrors `printVerify`'s existing shape — a `✗`/`⚠` icon, the
  `path`, an indented `hint:` line, and `(ERROR-PATTERNS.md#<id>)` where a
  pattern applies — so agents parse one diagnostic format, not two.
- `--json` / `--out` emit `{ ok, errors, warnings }`.

**`measure` gains an implicit error-tier lint** before it boots a kernel, with
`--no-lint` to opt out, symmetric with the existing `--no-verify`. This is the
main ergonomic win: the command agents already run becomes self-guarding, and a
statically broken part fails in milliseconds with a precise message instead of
after a WASM boot. On lint errors `measure` prints the findings and exits 1
without booting; with `--json`/`--out` it emits
`{ ok: false, lint: { errors, warnings } }`. `render` is **not** linted — a part
with warnings should still render.

### Worker job

partforge ships a **`lint` job** in `src/framework/jobs.js`, mirroring the
existing `inspect` job at `jobs.js:118`. It accepts `{ type: "lint", params }`
and posts back `{ type: "lintReport", report }`.

This exists specifically for the cloud harness. Because the probe *executes*
`build`, a runaway loop that today hangs a killable worker would instead hang
the iframe main thread if `lintPart` were called from `loader.js`. Two
mitigations, both included: the `build-runaway` op ceiling bounds the common
case, and the worker job gives hosts a terminable, timeout-guarded path that
bounds even a bare `while (true)` with no kernel calls. Cloud already does
`worker.postMessage({ type: "inspect" })` on a budget
(`src/sandbox/mountManager.js:90`), so it gets this with no new plumbing.

### partforge-cloud (follow-on, separate repo and pass)

Recorded here so the API is shaped correctly, **not** in scope for this plan:

1. Delete the hand-rolled `validate(part)` at `src/sandbox/loader.js:78-86` and
   call `lintPart` instead — this alone closes the `views` drift against
   `evals/runner/headless.js:40`.
2. Prefer the `lint` worker job over a main-thread call, per the hang analysis
   above.
3. Whitelist and cap a `lint: { errors, warnings }` field in
   `sanitizeResult` in `src/sandbox/protocol.js`. Fields absent from that
   whitelist are silently dropped crossing the sandbox boundary.
4. Thread it into the model-facing emit at `src/chat/toolCall.js:143-152`,
   beside `measure` and `verify`.

## Error handling

`lintPart` must never throw. It runs in a user-facing hosted path, and a linter
that takes down the preview it was meant to protect is worse than no linter.

Every rule is invoked inside a guard. A rule that throws is caught, and the run
continues with an `internal-rule-error` **warning** naming the failed rule and
its message. `internal-rule-error` is a warning, not an error, so a bug in the
linter can never block a part that would otherwise build.

The probe pass is likewise wrapped: a probe failure that is not attributable to
a specific rule degrades to skipping Group 3 with one `internal-rule-error`,
leaving Groups 1, 2, and 4 intact.

## Testing

- **One test per rule.** A minimal fixture PartDefinition that trips exactly
  that rule, asserting `rule`, `severity`, and `path`; plus a clean negative
  case asserting the rule does *not* fire.
- **Every shipped part lints clean.** A sweep calling `lintPart` over every
  module in `src/parts/`. This is the test that would have caught the nameplate
  `features`/`sliders` bug before a browser boot.
- **Import-closure purity test.** Walk `src/lint.js`'s transitive import graph
  and assert that `three`, `manifold-3d`, and `replicad` never appear. This is
  the browser-compatibility guarantee, and it is precisely the property that
  regresses silently the first time someone adds a convenient import.
- **Rule-registry contract test**, in the style of
  `test/kernel-contract.test.js`: rule ids are unique and kebab-case, every
  registered rule is documented in `docs/AUTHORING-PARTS.md`, and every
  registered rule is exercised by at least one test.
- **Determinism rule test.** A fixture whose `build` calls `Math.random()`
  produces `nondeterministic-build`.
- **Extraction regression.** The existing verify suite must pass unchanged after
  `SUBPART_METRICS`/`VIEW_METRICS` move to `src/framework/verify-metrics.js`.

OCCT is not involved anywhere in this feature, so the
"never co-boot OCCT and Manifold" test-file isolation rule does not apply —
no lint test boots a kernel at all.

## Docs and versioning

- **`docs/AUTHORING-PARTS.md`** — a "Linting" section: the `partforge lint`
  command, the `Finding` schema, the two-tier severity contract, and the full
  rule catalog with each rule's id.
- **`docs/ERROR-PATTERNS.md`** — entries for the new error rule ids that do not
  already map to an existing pattern. Note these serve agents grepping and are
  the target of the finding's `pattern` field; the CLI's `matchPattern` symptom
  matcher is not the delivery path for lint findings, which carry `pattern`
  explicitly. Existing patterns are reused where they apply —
  `nondeterministic-build` → `impure-build-stale-preview`.
- **`AGENTS.md`** and **`skills/partforge/SKILL.md`** — add `npx partforge lint`
  to the CLI command list.
- **Version:** 0.25.0 → **0.26.0**. Additive throughout: a new export subpath, a
  new CLI command, a new worker job, one internal module extraction.
  `CONTRACT_VERSION` stays 1 — no kernel contract change.

## Future work (explicitly out of scope)

- `lintSource(files)` as a second export, if source-level rules ever justify a
  parser dependency.
- Seeding `verify.expect` blocks from `measure` output as a toil-reducer, with
  explicit `TODO: state intent` markers rather than finished assertions — the
  hazard being that facts generated from current output lock in current bugs as
  intent.
- A `partforge new <name>` scaffold for the five per-part glue files and the
  `vite.config.js` registration.
