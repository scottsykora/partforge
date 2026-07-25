# partforge lint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `partforge/lint` — a pure, dependency-free static validator for PartDefinitions — plus a `partforge lint` CLI command and a geometry-free worker `lint` job, so authoring errors are caught in milliseconds instead of after a WASM boot or a browser render.

**Architecture:** `lintPart(part, { params })` walks an already-imported PartDefinition with two engines: a pure object-graph walk (definition shape, parameter schema, verify block) and a *validating probe* that executes `build()` against a recording Proxy with no geometry kernel. Rules are one-to-one with finding ids in a flat registry; every rule runs inside a guard so the linter can never throw. The whole import closure must stay free of `three`, `manifold-3d`, and `replicad` so it runs unchanged in Node, a browser sandbox iframe, and Deno.

**Tech Stack:** Plain ESM JavaScript, Node 24, vitest. No new runtime dependencies — this is a hard requirement, not a preference.

**Spec:** `docs/superpowers/specs/2026-07-25-partforge-lint-design.md`

## Global Constraints

- **Node 24 required.** Run `nvm use` in the repo root before any `npm`/vitest/CLI command, or geometry and tests fail confusingly.
- **Test command:** prefer `npx vitest run test/<file>`. If that fails with a `node:util styleText` or rolldown error (a known sandbox quirk), use `node node_modules/vitest/vitest.mjs run test/<file>` instead. Both are acceptable; report which you used.
- **Zero new dependencies.** Do not add anything to `package.json` `dependencies` or `devDependencies`.
- **Import-closure purity is load-bearing.** Nothing reachable from `src/lint.js` may import `three`, `manifold-3d`, `replicad`, `replicad-opencascadejs`, or any module that imports them (notably `src/testing/verify.js`, `src/testing/measure.js`, `src/framework/jobs.js`). Task 9 enforces this with a test.
- **Severity rule, applied without exception:** a finding is `severity: "error"` **only if the part provably cannot work** — i.e. the condition already fails at runtime today. Everything speculative or stylistic is `severity: "warning"`.
- **`lintPart` must never throw.** Every rule runs inside a guard; a throwing rule yields an `internal-rule-error` *warning* and the run continues.
- **Units are millimetres** throughout partforge. Not directly relevant here, but do not introduce unit conversions.
- **Finding shape** is exactly `{ rule, severity, message, hint, path }` plus an optional `pattern`. `hint` is always present and is always a complete corrective sentence.
- **`path` convention:** a JS accessor path rooted at the PartDefinition with the root omitted — `parameters[1].features[0]`, `defaults.bore`, `parts.spacer.views[0]`, `parameters[0].presets["M3"].od`. Whole-definition findings use `""`.
- **Version target:** 0.25.0 → **0.26.0** in Task 10. `CONTRACT_VERSION` stays `1`.
- **Commit style:** conventional commits (`feat:`, `test:`, `docs:`, `refactor:`). End every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** all work lands on the existing `partforge-lint` branch. Do not create new branches.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/framework/verify-metrics.js` | **new, pure** — `SUBPART_METRICS` / `VIEW_METRICS` registries, moved out of the kernel-importing `verify.js` | 1 |
| `src/testing/verify.js` | modified — imports and re-exports the registries from their new home | 1 |
| `src/framework/geometry/op-options.js` | modified — export the private `suggest()` helper | 1 |
| `src/framework/lint/finding.js` | **new** — `err()` / `warn()` finding constructors | 2 |
| `src/framework/lint/index.js` | **new** — rule registry, context builder, guarded runner, `lintPart` | 2 |
| `src/framework/lint/rules-shape.js` | **new** — Group 1: definition shape and view wiring | 2 |
| `src/lint.js` | **new** — public entry, re-exports `lintPart` | 2 |
| `package.json` | modified — add `"./lint"` export subpath (T2), version bump (T10) | 2, 10 |
| `src/framework/lint/rules-schema.js` | **new** — Group 2: parameter schema | 3 |
| `src/framework/geometry/probe.js` | modified — shared proxy factory, `createValidatingProbe`, `runValidatingProbe` | 4 |
| `src/framework/lint/rules-build.js` | **new** — Group 3: kernel API usage, probe-driven | 5 |
| `src/framework/lint/rules-verify.js` | **new** — Group 4: verify-block well-formedness | 6 |
| `bin/cli.js` | modified — `lint` command, `measure` auto-lint with `--no-lint` | 7 |
| `src/framework/worker.js` | modified — intercept `{type:"lint"}` before kernel boot | 8 |
| `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `AGENTS.md`, `skills/partforge/SKILL.md` | modified — document the command, contract, and rule catalog | 10 |

---

### Task 1: Pure foundations — extract verify metrics, export `suggest`

Two preparatory changes to existing modules. Nothing in this task is lint code; it makes the lint code possible.

`src/testing/verify.js` holds the `SUBPART_METRICS` / `VIEW_METRICS` registries but imports `./measure.js` and `../framework/jobs.js`, which reach the geometry kernels. The registries are pure data. Move them so the linter can read the legal metric vocabulary without dragging in WASM.

**Files:**
- Create: `src/framework/verify-metrics.js`
- Modify: `src/testing/verify.js:1-53`
- Modify: `src/framework/geometry/op-options.js:31`
- Test: `test/verify-metrics.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `src/framework/verify-metrics.js` exports `SUBPART_METRICS` and `VIEW_METRICS`, objects keyed by metric name whose values are `{ kind: "gate"|"warn", manifoldOnly?: boolean, extract: Function, hint: string, pattern?: string, locate?: Function }`.
  - `src/testing/verify.js` continues to export `SUBPART_METRICS` and `VIEW_METRICS` (re-exported) so every existing importer keeps working.
  - `src/framework/geometry/op-options.js` exports `suggest(key: string, valid: string[]) → string | null`.

- [ ] **Step 1: Write the failing test**

Create `test/verify-metrics.test.js`:

```js
// The verify metric vocabulary must live in a module the linter can import without
// pulling in a geometry kernel — src/testing/verify.js imports measure.js and jobs.js,
// which reach manifold-3d/replicad. This test pins both the move and the re-export.
import { expect, test } from "vitest";
import { SUBPART_METRICS, VIEW_METRICS } from "../src/framework/verify-metrics.js";
import { SUBPART_METRICS as reSub, VIEW_METRICS as reView } from "../src/testing/verify.js";
import { suggest } from "../src/framework/geometry/op-options.js";

test("verify-metrics exposes the subpart metric vocabulary", () => {
  for (const name of ["holes", "watertight", "volume", "surfaceArea", "triangleCount",
    "bbox", "centerOfMass", "boundsMin", "boundsMax", "minWall"]) {
    expect(Object.keys(SUBPART_METRICS), `missing ${name}`).toContain(name);
  }
  expect(SUBPART_METRICS.minWall.kind).toBe("warn");
  expect(SUBPART_METRICS.holes.kind).toBe("gate");
});

test("verify-metrics exposes the view metric vocabulary", () => {
  for (const name of ["bbox", "volume", "overlaps", "centerOfMass", "boundsMin", "boundsMax"]) {
    expect(Object.keys(VIEW_METRICS), `missing ${name}`).toContain(name);
  }
});

test("every metric carries a hint, as the diagnostics contract promises", () => {
  for (const [name, m] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
    expect(typeof m.hint, `${name} has no hint`).toBe("string");
    expect(m.hint.length, `${name} hint is empty`).toBeGreaterThan(0);
  }
});

test("verify.js re-exports the same registry objects", () => {
  expect(reSub).toBe(SUBPART_METRICS);
  expect(reView).toBe(VIEW_METRICS);
});

test("suggest is exported for reuse by the linter", () => {
  expect(suggest("radius", ["r", "d", "h"])).toBe("r");
  expect(suggest("heigth", ["r", "d", "h", "height"])).toBe("height");
  expect(suggest("zzzz", ["r", "d", "h"])).toBe(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/verify-metrics.test.js`
Expected: FAIL — `Failed to resolve import "../src/framework/verify-metrics.js"`.

- [ ] **Step 3: Create the pure metrics module**

Create `src/framework/verify-metrics.js`. Move the two registries verbatim out of `src/testing/verify.js:9-53` — including the leading comment block, which documents the registry contract:

```js
// Metric registry: name → how to pull the value out of facts, whether a failure
// is a hard gate or a warning, and the diagnostics attached to a non-pass check:
// `hint` (required — the report contract promises one on every fail/warn),
// `pattern` (optional stable ERROR-PATTERNS.md#<id>), `locate` (optional
// [x,y,z] source). `manifoldOnly` facts are null on OCCT parts.
//
// This lives in framework/ rather than testing/ deliberately: the set of legal
// `verify.expect` metrics is part of the PartDefinition CONTRACT, which both the
// verify runner (testing) and the linter (partforge/lint) must agree on. Keeping
// it here lets the linter import the vocabulary without reaching measure.js or
// jobs.js, which pull in the geometry kernels. This module must stay import-free.
export const SUBPART_METRICS = {
  holes: { kind: "gate", manifoldOnly: true, extract: (s) => s.holes,
    hint: "genus is wrong — an unintended tunnel exists or an intended bore is blocked; make cut tools pierce fully (overcut past the faces)" },
  watertight: { kind: "gate", manifoldOnly: true, extract: (s) => s.watertight,
    hint: "a boolean produced an open shell — check for coplanar faces or a cut that exactly grazes a surface",
    pattern: "boolean-not-watertight" },
  volume: { kind: "gate", extract: (s) => s.volume,
    hint: "solid volume is out of range — a feature is missing, doubled, or a governing parameter is mis-scaled" },
  surfaceArea: { kind: "gate", extract: (s) => s.surfaceArea,
    hint: "surface area is out of range — detail features (facets, ribs, textures) are missing or doubled" },
  triangleCount: { kind: "gate", extract: (s) => s.triangleCount,
    hint: "triangle count is out of range — tessellation quality or feature count changed unexpectedly" },
  bbox: { kind: "gate", extract: (s) => s.bbox,
    hint: "bounding box is out of range — check the governing dimensions and the part's orientation" },
  centerOfMass: { kind: "gate", extract: (s) => s.centerOfMass,
    hint: "center of mass is outside the expected region — mass is distributed differently than intended; check feature placement or a mis-scaled sub-part" },
  boundsMin: { kind: "gate", extract: (s) => s.bounds?.min,
    hint: "the low corner is out of range — the part is positioned or oriented differently than expected" },
  boundsMax: { kind: "gate", extract: (s) => s.bounds?.max,
    hint: "the high corner is out of range — the part is positioned or oriented differently than expected" },
  minWall: { kind: "warn", extract: (s) => s.minWall,
    hint: "thinnest wall is at the reported location — increase the governing wall/thickness parameter or reduce the intersecting feature's depth",
    pattern: "minwall-sliver-triangles",
    locate: (s) => s.minWallAt },
};
export const VIEW_METRICS = {
  bbox: { kind: "gate", extract: (r) => r.aggregate.bbox,
    hint: "the assembled view exceeds its size limit — shrink the assembly or pick a process with a larger bed" },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume,
    hint: "total assembly volume is out of range — a sub-part is missing, doubled, or mis-scaled" },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length,
    hint: "sub-parts interpenetrate near the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
  centerOfMass: { kind: "gate", extract: (r) => r.aggregate.centerOfMass,
    hint: "the assembly's center of mass is outside the expected region — a sub-part is mis-placed or mis-scaled" },
  boundsMin: { kind: "gate", extract: (r) => r.aggregate.bounds?.min,
    hint: "the assembly's low corner is out of range — check placement or orientation" },
  boundsMax: { kind: "gate", extract: (r) => r.aggregate.bounds?.max,
    hint: "the assembly's high corner is out of range — check placement or orientation" },
};
```

- [ ] **Step 4: Re-export from `verify.js`**

In `src/testing/verify.js`, delete lines 9-53 (the comment block and both registry literals) and add this import beside the existing imports at the top, plus a re-export so every current importer keeps working:

```js
import { SUBPART_METRICS, VIEW_METRICS } from "../framework/verify-metrics.js";

// Re-exported for backwards compatibility: the registries moved to framework/ so
// the linter can read the metric vocabulary without importing a geometry kernel.
export { SUBPART_METRICS, VIEW_METRICS };
```

Leave the rest of `verify.js` untouched — it already references `SUBPART_METRICS` / `VIEW_METRICS` by bare name, and the import satisfies those references.

- [ ] **Step 5: Export `suggest` from op-options.js**

In `src/framework/geometry/op-options.js`, change line 31 from:

```js
function suggest(key, valid) {
```

to:

```js
// Exported so partforge/lint's `unknown-control-field` rule reuses this exact
// suggester rather than carrying a second copy of the edit-distance logic.
export function suggest(key, valid) {
```

- [ ] **Step 6: Run the new test and the full existing suite**

Run: `npx vitest run test/verify-metrics.test.js`
Expected: PASS, 5 tests.

Run: `npx vitest run`
Expected: the entire pre-existing suite passes unchanged. The registries moved but are the same object identities, so `verify.test.js`, `verify-cases.test.js`, `verify-cli.test.js`, `verify-position-metrics.test.js`, `dfm-profiles.test.js`, and `op-options.test.js` must all still pass. If any fail, the move was not verbatim — diff the registry literals against the originals rather than editing tests.

- [ ] **Step 7: Commit**

```bash
git add src/framework/verify-metrics.js src/testing/verify.js src/framework/geometry/op-options.js test/verify-metrics.test.js
git commit -m "refactor: extract verify metric registries to a pure module

Moves SUBPART_METRICS/VIEW_METRICS out of testing/verify.js (which imports
measure.js and jobs.js, reaching the geometry kernels) into a dependency-free
framework/verify-metrics.js, and exports op-options' suggest() helper. Both are
prerequisites for partforge/lint, whose import closure must stay WASM-free.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Lint core — finding constructors, registry, guarded runner, Group 1 rules

Builds the whole linter skeleton end-to-end with one rule group in it, so `lintPart` is demonstrably working before more rules pile on.

**Files:**
- Create: `src/framework/lint/finding.js`
- Create: `src/framework/lint/index.js`
- Create: `src/framework/lint/rules-shape.js`
- Create: `src/lint.js`
- Modify: `package.json` (exports map)
- Test: `test/lint-shape.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly.
- Produces:
  - `finding.js`: `err(rule, message, hint, path = "", pattern)` and `warn(rule, message, hint, path = "", pattern)`, each returning `{ rule, severity, message, hint, path }` plus `pattern` when given.
  - `index.js`: `lintPart(part, { params } = {}) → { ok, errors, warnings }`; `RULES` (array of `{ id, run }`); `runRules(rules, ctx) → Finding[]`.
  - A **rule** is `{ id: string, run(ctx) → Finding[] | undefined }`, one rule object per finding id.
  - A **context** is `{ part, p, d }` — `p` is `{...part.defaults, ...params}`, `d` is `resolveDerived(part, p)` or `{}` if it throws. Tasks 5 and 6 extend the context.
  - `rules-shape.js`: `export const SHAPE_RULES` — array of rules with ids `missing-meta-title`, `missing-defaults`, `no-buildable-parts`, `missing-views`, `part-view-unknown`, `view-unused`.
  - `src/lint.js`: `export { lintPart } from "./framework/lint/index.js";`
  - Import path for consumers: `partforge/lint`.

- [ ] **Step 1: Write the failing test**

Create `test/lint-shape.test.js`:

```js
// Group 1 — definition shape and view wiring. These rules replace the hand-rolled
// validate() in partforge-cloud's sandbox loader, which checks meta.title/defaults/
// build but NOT views, and had already drifted from the eval runner's separate check.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

// A minimal well-formed part. Each test clones and breaks exactly one thing, so a
// finding can only come from the mutation under test.
const goodPart = () => ({
  meta: { title: "Test", units: "mm" },
  defaults: { h: 10 },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
});

const ids = (findings) => findings.map((f) => f.rule);

test("a well-formed part produces no shape findings", () => {
  const r = lintPart(goodPart());
  expect(ids(r.errors)).toEqual([]);
  expect(r.ok).toBe(true);
});

test("missing meta.title is an error", () => {
  const part = goodPart();
  delete part.meta.title;
  expect(ids(lintPart(part).errors)).toContain("missing-meta-title");
});

test("missing defaults is an error", () => {
  const part = goodPart();
  delete part.defaults;
  expect(ids(lintPart(part).errors)).toContain("missing-defaults");
});

test("a part entry whose build is not a function is an error", () => {
  const part = goodPart();
  part.parts.body.build = "not a function";
  expect(ids(lintPart(part).errors)).toContain("no-buildable-parts");
});

test("missing views map is an error", () => {
  const part = goodPart();
  delete part.views;
  expect(ids(lintPart(part).errors)).toContain("missing-views");
});

test("a subpart naming a view absent from the views map is an error", () => {
  const part = goodPart();
  part.parts.body.views = ["nope"];
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("part-view-unknown");
  expect(r.errors.find((f) => f.rule === "part-view-unknown").path).toBe("parts.body.views[0]");
});

test("a declared view no subpart renders into is a warning, not an error", () => {
  const part = goodPart();
  part.views.orphan = { label: "Orphan" };
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("view-unused");
  expect(ids(r.errors)).not.toContain("view-unused");
});

test("every finding carries a rule, severity, message, hint and path", () => {
  const part = goodPart();
  delete part.meta.title;
  for (const f of [...lintPart(part).errors, ...lintPart(part).warnings]) {
    expect(typeof f.rule).toBe("string");
    expect(["error", "warning"]).toContain(f.severity);
    expect(typeof f.message).toBe("string");
    expect(f.hint.length, `${f.rule} has an empty hint`).toBeGreaterThan(0);
    expect(typeof f.path).toBe("string");
  }
});

test("lintPart never throws, even on garbage input", () => {
  for (const junk of [null, undefined, 42, "a string", [], {}]) {
    expect(() => lintPart(junk), `threw on ${JSON.stringify(junk)}`).not.toThrow();
  }
  expect(lintPart(null).ok).toBe(false);
});

test("a rule that throws degrades to an internal-rule-error warning", async () => {
  const { runRules } = await import("../src/framework/lint/index.js");
  const boom = { id: "boom", run() { throw new Error("kaboom"); } };
  const out = runRules([boom], { part: {}, p: {}, d: {} });
  expect(out).toHaveLength(1);
  expect(out[0].rule).toBe("internal-rule-error");
  expect(out[0].severity).toBe("warning");
  expect(out[0].message).toContain("boom");
  expect(out[0].message).toContain("kaboom");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lint-shape.test.js`
Expected: FAIL — `Failed to resolve import "../src/lint.js"`.

- [ ] **Step 3: Create the finding constructors**

Create `src/framework/lint/finding.js`:

```js
// Finding constructors. The shape mirrors the diagnostics contract that verify's
// checks already satisfy (docs/AUTHORING-PARTS.md "The diagnostics contract"):
// a self-contained `hint` on every finding, plus an optional stable ERROR-PATTERNS.md
// `pattern` id. Verify's [x,y,z] `location` is replaced by `path`, an accessor path
// into the PartDefinition — nothing parses it, it is for navigation only.
const make = (severity) => (rule, message, hint, path = "", pattern) => ({
  rule, severity, message, hint, path, ...(pattern ? { pattern } : {}),
});

// error → the part PROVABLY cannot work; this condition already fails at runtime
// today, so reporting it early can never block a part that would have built.
export const err = make("error");
// warning → suspicious or lossy, but the part still builds.
export const warn = make("warning");
```

- [ ] **Step 4: Create the Group 1 rules**

Create `src/framework/lint/rules-shape.js`:

```js
// Group 1 — definition shape and view wiring. This group is the shared replacement
// for partforge-cloud's hand-rolled sandbox validate(), which checks meta.title,
// defaults and build but not `views`, and had already drifted from the eval runner's
// separate views check. One source of truth ends that split.
import { err, warn } from "./finding.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const partEntries = (part) => (isPlainObject(part?.parts) ? Object.entries(part.parts) : []);

export const SHAPE_RULES = [
  {
    id: "missing-meta-title",
    run: ({ part }) => (typeof part?.meta?.title === "string" && part.meta.title.length > 0 ? [] : [
      err("missing-meta-title", "the part has no `meta.title`",
        "Add a `meta` object with a `title` string — it names the part in the viewer and in export filenames.",
        "meta.title"),
    ]),
  },
  {
    id: "missing-defaults",
    run: ({ part }) => (isPlainObject(part?.defaults) ? [] : [
      err("missing-defaults", "the part has no `defaults` object",
        "Add a `defaults` object giving every parameter its starting value; the control panel and every build read from it.",
        "defaults"),
    ]),
  },
  {
    id: "no-buildable-parts",
    run: ({ part }) => {
      const entries = partEntries(part);
      if (entries.length === 0) {
        return [err("no-buildable-parts", "the part declares no sub-parts in `parts`",
          "Add at least one entry to `parts`, each with a `build(k, p, d)` function returning a solid.",
          "parts")];
      }
      return entries
        .filter(([, sp]) => typeof sp?.build !== "function")
        .map(([name]) => err("no-buildable-parts", `sub-part "${name}" has no \`build\` function`,
          "Every entry in `parts` needs a `build(k, p, d)` function that returns a solid.",
          `parts.${name}.build`));
    },
  },
  {
    id: "missing-views",
    run: ({ part }) => (isPlainObject(part?.views) && Object.keys(part.views).length > 0 ? [] : [
      err("missing-views", "the part has no `views` map",
        "Add a top-level `views` object — e.g. `views: { main: { label: \"Main\" } }` — and list each view name in the owning sub-part's `views` array.",
        "views"),
    ]),
  },
  {
    id: "part-view-unknown",
    run: ({ part }) => {
      const known = isPlainObject(part?.views) ? new Set(Object.keys(part.views)) : new Set();
      if (known.size === 0) return []; // missing-views already reported it; don't pile on
      const out = [];
      for (const [name, sp] of partEntries(part)) {
        if (!Array.isArray(sp?.views)) continue;
        sp.views.forEach((v, i) => {
          if (!known.has(v)) {
            out.push(err("part-view-unknown",
              `sub-part "${name}" lists view "${v}", which is not in the \`views\` map`,
              `Add "${v}" to the top-level \`views\` map, or correct the name to one of: ${[...known].join(", ")}.`,
              `parts.${name}.views[${i}]`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "view-unused",
    run: ({ part }) => {
      if (!isPlainObject(part?.views)) return [];
      const used = new Set();
      for (const [, sp] of partEntries(part)) {
        if (Array.isArray(sp?.views)) for (const v of sp.views) used.add(v);
      }
      return Object.keys(part.views)
        .filter((v) => !used.has(v))
        .map((v) => warn("view-unused", `view "${v}" is not listed by any sub-part`,
          `Either add "${v}" to a sub-part's \`views\` array or remove it from the \`views\` map — as it stands the view renders empty.`,
          `views.${v}`));
    },
  },
];
```

- [ ] **Step 5: Create the registry and runner**

Create `src/framework/lint/index.js`:

```js
// partforge/lint — static PartDefinition validation. Pure: no I/O, no async, and
// (load-bearing) an import closure that never reaches three / manifold-3d / replicad,
// so this runs unchanged in Node, a browser sandbox iframe, and Deno. The purity
// guarantee is enforced by test/lint-purity.test.js — read it before adding an import.
//
// A rule is { id, run(ctx) → Finding[] }, one rule object per finding id, so the
// registry doubles as the documented rule catalog. Rules are cheap and parts are
// tiny; clarity beats sharing a walk between rules.
import { resolveDerived } from "../derive.js";
import { warn } from "./finding.js";
import { SHAPE_RULES } from "./rules-shape.js";

export const RULES = [...SHAPE_RULES];

// Every rule runs inside a guard. lintPart is called on a user-facing hosted path
// (partforge-cloud's sandbox), and a linter that takes down the preview it exists to
// protect is worse than no linter — so a throwing rule becomes a WARNING, never an
// error, and never blocks a part that would otherwise have built.
export function runRules(rules, ctx) {
  const out = [];
  for (const rule of rules) {
    try {
      const found = rule.run(ctx);
      if (Array.isArray(found)) out.push(...found);
    } catch (e) {
      out.push(warn("internal-rule-error",
        `lint rule "${rule.id}" threw: ${e?.message || String(e)}`,
        "This is a partforge bug rather than a problem with your part; every other rule still ran. Please report it with the part that triggered it."));
    }
  }
  return out;
}

// Build the shared context. A throwing derive() must not abort the lint — the
// `derive-throws` condition is reported by Group 3's build rules, and Groups 1/2/4
// remain useful without derived values.
export function lintContext(part, params) {
  const p = { ...(part?.defaults ?? {}), ...(params ?? {}) };
  let d = {};
  try { d = resolveDerived(part, p) ?? {}; } catch { d = {}; }
  return { part, p, d };
}

/**
 * Lint a PartDefinition. Never throws.
 * @param {object} part   the default-exported PartDefinition
 * @param {{params?: object}} [opts]  params layered over part.defaults for the probe pass
 * @returns {{ok: boolean, errors: object[], warnings: object[]}}
 */
export function lintPart(part, { params } = {}) {
  const findings = runRules(RULES, lintContext(part, params));
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}
```

- [ ] **Step 6: Create the public entry and wire the export map**

Create `src/lint.js`:

```js
// Public entry for `partforge/lint`. Deliberately separate from `partforge/testing`,
// whose entry pulls in the WASM kernels and cannot load in a browser sandbox.
export { lintPart, RULES } from "./framework/lint/index.js";
```

In `package.json`, add the `./lint` subpath to `exports`, after `./geometry`:

```json
  "exports": {
    ".": "./src/index.js",
    "./worker": "./src/framework/worker.js",
    "./geometry": "./src/framework/geometry/polygon.js",
    "./lint": "./src/lint.js",
    "./derive": "./src/framework/derive.js",
    "./testing": "./src/testing.js",
    "./tokens.css": "./src/framework/tokens.css"
  },
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/lint-shape.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 8: Commit**

```bash
git add src/lint.js src/framework/lint/ package.json test/lint-shape.test.js
git commit -m "feat(lint): lint core and definition-shape rules

Adds partforge/lint with the finding contract, a guarded rule runner that can
never throw, and Group 1 rules (meta.title, defaults, build, views map, view
wiring). Replaces the shape checks partforge-cloud hand-rolled and drifted on.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Group 2 — parameter schema rules

The highest-value group. `features-requires-sliders` is the bug that shipped in two demo parts and was found only by booting Chromium; `control-key-not-in-defaults` catches controls that are silently dead with no error at all.

**Files:**
- Create: `src/framework/lint/rules-schema.js`
- Modify: `src/framework/lint/index.js` (register the group)
- Test: `test/lint-schema.test.js`

**Interfaces:**
- Consumes: `err`/`warn` from `./finding.js`; `suggest(key, valid)` from `../geometry/op-options.js` (exported in Task 1); the context `{ part, p, d }` from Task 2.
- Produces: `export const SCHEMA_RULES` with ids `features-requires-sliders`, `control-key-not-in-defaults`, `preset-key-not-in-defaults`, `slider-range-excludes-default`, `unknown-control-field`, `duplicate-control-key`, `default-not-exposed`.

Schema reference — `src/framework/controls.js` reads these shapes. A `part.parameters` entry is a *section*: `{ id, title, description?, presets?, advanced?, features?, toggles? }`. An `advanced` entry is `{ key, label, unit?, min?, max?, step?, control?, hidden?, description? }`. A `features` entry is `{ key, label, on, sliders, hidden?, description? }` — `sliders` is an array of advanced-shaped descriptors and is **required** (`controls.js:313` does `feat.sliders.filter(...)` unguarded). A `toggles` entry is `{ key, label, on?, hidden?, description? }` and is the correct home for a bare boolean. `presets` is `{ [presetName]: { [paramKey]: value } }`.

- [ ] **Step 1: Write the failing test**

Create `test/lint-schema.test.js`:

```js
// Group 2 — parameter schema. features-requires-sliders is the exact crash that
// shipped in the nameplate and bracket demos: controls.js:313 does
// `feat.sliders.filter(...)` with no guard, so a bare boolean placed in `features`
// instead of `toggles` throws "Cannot read properties of undefined (reading 'filter')"
// only once a browser boots the panel.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const goodPart = () => ({
  meta: { title: "Test", units: "mm" },
  parameters: [{
    id: "body", title: "Body",
    presets: { M3: { od: 8 } },
    advanced: [{ key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 }],
    features: [{ key: "flange_d", label: "Flange", on: 16,
      sliders: [{ key: "flange_d", label: "Flange diameter", min: 8, max: 50, step: 1 }] }],
    toggles: [{ key: "vented", label: "Vented", on: false }],
  }],
  defaults: { od: 8, flange_d: 0, vented: false },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.od, p.od, p.od] }) } },
  views: { main: { label: "Main" } },
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a well-formed schema produces no schema findings", () => {
  const r = lintPart(goodPart());
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("a features entry with no sliders is an error", () => {
  const part = goodPart();
  delete part.parameters[0].features[0].sliders;
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("features-requires-sliders");
  expect(find(r, "features-requires-sliders").path).toBe("parameters[0].features[0]");
  expect(find(r, "features-requires-sliders").hint).toMatch(/toggles/);
});

test("a control key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].advanced[0].key = "diameter";
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("control-key-not-in-defaults");
  expect(find(r, "control-key-not-in-defaults").path).toBe("parameters[0].advanced[0].key");
});

test("a toggle key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].toggles[0].key = "ventilated";
  expect(ids(lintPart(part).errors)).toContain("control-key-not-in-defaults");
});

test("a preset bundle key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].presets.M3 = { outerDiameter: 8 };
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("preset-key-not-in-defaults");
  expect(find(r, "preset-key-not-in-defaults").path).toBe('parameters[0].presets["M3"].outerDiameter');
});

test("a default outside a slider's range is a warning, not an error", () => {
  const part = goodPart();
  part.defaults.od = 80; // slider is min 4 max 40
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("slider-range-excludes-default");
  expect(ids(r.errors)).not.toContain("slider-range-excludes-default");
});

test("an unrecognised control field warns with a did-you-mean", () => {
  const part = goodPart();
  part.parameters[0].advanced[0].lable = "typo";
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("unknown-control-field");
  expect(find(r, "unknown-control-field").hint).toMatch(/label/);
});

test("the same key owned by two sections warns", () => {
  const part = goodPart();
  part.parameters.push({ id: "other", title: "Other",
    advanced: [{ key: "od", label: "Also OD", min: 1, max: 5, step: 1 }] });
  expect(ids(lintPart(part).warnings)).toContain("duplicate-control-key");
});

test("a defaults key no control references warns", () => {
  const part = goodPart();
  part.defaults.orphan = 3;
  expect(ids(lintPart(part).warnings)).toContain("default-not-exposed");
});

test("a hidden control still counts as exposing its key", () => {
  // demo.js's flange_h is a documented, legitimate hidden internal constant.
  const part = goodPart();
  part.defaults.flange_h = 2;
  part.parameters[0].advanced.push({ key: "flange_h", label: "Flange thickness", min: 1, max: 5, step: 0.5, hidden: true });
  expect(ids(lintPart(part).warnings)).not.toContain("default-not-exposed");
});

test("a part with no parameters section produces no schema findings", () => {
  // `parameters` is optional — a part can ship with defaults and no control panel.
  const part = goodPart();
  delete part.parameters;
  const r = lintPart(part);
  expect(ids(r.errors)).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lint-schema.test.js`
Expected: FAIL — the `features-requires-sliders` test fails because no such rule exists yet (`expected [] to contain 'features-requires-sliders'`).

- [ ] **Step 3: Write the schema rules**

Create `src/framework/lint/rules-schema.js`:

```js
// Group 2 — the parameter schema that src/framework/controls.js turns into the panel.
// Two failure modes drive this group: a shape controls.js reads without guarding
// (features[].sliders at controls.js:313, an unguarded .filter), and keys that don't
// resolve against `defaults`, which produce a control that silently does nothing.
import { err, warn } from "./finding.js";
import { suggest } from "../geometry/op-options.js";

// Fields controls.js reads on a slider/number descriptor.
const CONTROL_FIELDS = ["key", "label", "unit", "min", "max", "step", "control", "hidden", "description"];
const FEATURE_FIELDS = ["key", "label", "on", "sliders", "hidden", "description"];
const TOGGLE_FIELDS = ["key", "label", "on", "hidden", "description"];

const sections = (part) => (Array.isArray(part?.parameters) ? part.parameters : []);
const arr = (x) => (Array.isArray(x) ? x : []);

// Every (descriptor, path, allowed-fields) triple that owns a parameter key, across
// all four section kinds. A feature's own `sliders` are collected too, since each
// slider is a full control descriptor in its own right.
function collectDescriptors(part) {
  const out = [];
  sections(part).forEach((sec, si) => {
    arr(sec?.advanced).forEach((d, i) => {
      if (d) out.push({ d, path: `parameters[${si}].advanced[${i}]`, fields: CONTROL_FIELDS });
    });
    arr(sec?.features).forEach((f, i) => {
      if (!f) return;
      out.push({ d: f, path: `parameters[${si}].features[${i}]`, fields: FEATURE_FIELDS });
      arr(f.sliders).forEach((s, j) => {
        if (s) out.push({ d: s, path: `parameters[${si}].features[${i}].sliders[${j}]`, fields: CONTROL_FIELDS });
      });
    });
    arr(sec?.toggles).forEach((t, i) => {
      if (t) out.push({ d: t, path: `parameters[${si}].toggles[${i}]`, fields: TOGGLE_FIELDS });
    });
  });
  return out;
}

const defaultKeys = (part) => new Set(Object.keys(part?.defaults ?? {}));

export const SCHEMA_RULES = [
  {
    id: "features-requires-sliders",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        arr(sec?.features).forEach((f, i) => {
          if (f && !Array.isArray(f.sliders)) {
            out.push(err("features-requires-sliders",
              `section "${sec.id ?? si}" feature ${i} has no \`sliders\` array`,
              "A `features` entry must carry a `sliders` array — the control panel reads it unguarded, so a missing one throws \"Cannot read properties of undefined (reading 'filter')\". A bare on/off control belongs in `toggles` instead.",
              `parameters[${si}].features[${i}]`,
              "features-missing-sliders"));
          }
        });
      });
      return out;
    },
  },
  {
    id: "control-key-not-in-defaults",
    run: ({ part }) => {
      const known = defaultKeys(part);
      if (known.size === 0) return []; // missing-defaults already reported it
      return collectDescriptors(part)
        .filter(({ d }) => typeof d.key === "string" && !known.has(d.key))
        .map(({ d, path }) => err("control-key-not-in-defaults",
          `control key "${d.key}" is not in \`defaults\``,
          `Add "${d.key}" to \`defaults\`${suggest(d.key, [...known]) ? `, or correct it to "${suggest(d.key, [...known])}"` : ""} — a control whose key is absent from defaults is silently dead and never reaches the build.`,
          `${path}.key`));
    },
  },
  {
    id: "preset-key-not-in-defaults",
    run: ({ part }) => {
      const known = defaultKeys(part);
      if (known.size === 0) return [];
      const out = [];
      sections(part).forEach((sec, si) => {
        const presets = sec?.presets;
        if (!presets || typeof presets !== "object") return;
        for (const [name, bundle] of Object.entries(presets)) {
          if (!bundle || typeof bundle !== "object") continue;
          for (const key of Object.keys(bundle)) {
            if (known.has(key)) continue;
            const hint = suggest(key, [...known]);
            out.push(err("preset-key-not-in-defaults",
              `preset "${name}" sets "${key}", which is not in \`defaults\``,
              `Add "${key}" to \`defaults\`${hint ? `, or correct it to "${hint}"` : ""} — a preset field absent from defaults is dropped, so selecting the preset silently does nothing for it.`,
              `parameters[${si}].presets[${JSON.stringify(name)}].${key}`));
          }
        }
      });
      return out;
    },
  },
  {
    id: "slider-range-excludes-default",
    run: ({ part }) => {
      const defaults = part?.defaults ?? {};
      return collectDescriptors(part)
        .filter(({ d }) => typeof d.key === "string"
          && typeof defaults[d.key] === "number"
          && (typeof d.min === "number" || typeof d.max === "number")
          && ((typeof d.min === "number" && defaults[d.key] < d.min)
            || (typeof d.max === "number" && defaults[d.key] > d.max)))
        .map(({ d, path }) => warn("slider-range-excludes-default",
          `\`defaults.${d.key}\` is ${defaults[d.key]}, outside this control's range ${d.min ?? "-∞"}..${d.max ?? "∞"}`,
          `Widen the control's min/max or move \`defaults.${d.key}\` inside the range — as it stands the panel clamps the value on first render, so the geometry the user sees is not the geometry the defaults describe.`,
          path));
    },
  },
  {
    id: "unknown-control-field",
    run: ({ part }) => {
      const out = [];
      for (const { d, path, fields } of collectDescriptors(part)) {
        for (const key of Object.keys(d)) {
          if (fields.includes(key)) continue;
          const hint = suggest(key, fields);
          out.push(warn("unknown-control-field",
            `unrecognised control field "${key}"`,
            `The control panel ignores "${key}"${hint ? ` — did you mean "${hint}"?` : ` (recognised: ${fields.join(", ")}).`}`,
            `${path}.${key}`));
        }
      }
      return out;
    },
  },
  {
    id: "duplicate-control-key",
    run: ({ part }) => {
      const seen = new Map();
      const out = [];
      for (const { d, path } of collectDescriptors(part)) {
        if (typeof d.key !== "string") continue;
        // A feature and its own slider legitimately share a key (see demo.js's
        // flange_d), so only flag a repeat that crosses to a different owner path.
        const root = path.replace(/\.sliders\[\d+\]$/, "");
        if (seen.has(d.key) && seen.get(d.key) !== root) {
          out.push(warn("duplicate-control-key",
            `parameter key "${d.key}" is owned by more than one control`,
            `Two controls writing "${d.key}" fight over the same value — rename one, or remove the duplicate.`,
            path));
        } else if (!seen.has(d.key)) {
          seen.set(d.key, root);
        }
      }
      return out;
    },
  },
  {
    id: "default-not-exposed",
    run: ({ part }) => {
      if (sections(part).length === 0) return []; // no panel declared at all — nothing to expose
      const exposed = new Set(collectDescriptors(part).map(({ d }) => d.key).filter(Boolean));
      for (const sec of sections(part)) {
        for (const bundle of Object.values(sec?.presets ?? {})) {
          for (const key of Object.keys(bundle ?? {})) exposed.add(key);
        }
      }
      return Object.keys(part?.defaults ?? {})
        .filter((key) => !exposed.has(key))
        .map((key) => warn("default-not-exposed",
          `\`defaults.${key}\` is not referenced by any control`,
          `Either add a control for "${key}" or leave it as an intentional internal constant — a hidden control (\`hidden: true\`) counts as exposing it, and is the documented way to keep a build-only value out of the panel.`,
          `defaults.${key}`));
    },
  },
];
```

- [ ] **Step 4: Register the group**

In `src/framework/lint/index.js`, add the import and extend `RULES`:

```js
import { SHAPE_RULES } from "./rules-shape.js";
import { SCHEMA_RULES } from "./rules-schema.js";

export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/lint-schema.test.js test/lint-shape.test.js`
Expected: PASS — 11 schema tests, 10 shape tests.

- [ ] **Step 6: Commit**

```bash
git add src/framework/lint/rules-schema.js src/framework/lint/index.js test/lint-schema.test.js
git commit -m "feat(lint): parameter schema rules

Catches the features-without-sliders crash (controls.js:313 filters unguarded),
control and preset keys that don't resolve against defaults and are therefore
silently dead, defaults outside a slider's range, and typo'd descriptor fields.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: The validating probe

Extends `probe.js` so a build can be executed with no geometry kernel while recording op names, validating option keys through the existing normalizers, and surfacing throws the current probe discards.

**Files:**
- Modify: `src/framework/geometry/probe.js` (whole file restructured; `createProbeKernel` and `detectBackend` keep their exact current behaviour)
- Test: `test/probe-validating.test.js`

**Interfaces:**
- Consumes: `KERNEL_OPS`, `KERNEL_OPTIONAL_OPS`, `SOLID_OPS`, `SOLID_OPTIONAL_OPS`, `SHAPE2D_OPS` from `./kernel.js`; `KERNEL_OP_SPECS`, `SOLID_OP_SPECS`, `isPlainOptions` from `./op-options.js`.
- Produces:
  - `MAX_PROBE_OPS = 100000`
  - `class ProbeRunawayError extends Error`
  - `createValidatingProbe({ maxOps } = {}) → { kernel, calls, issues, used }` where `calls` is `Array<{scope, op, args: string[]}>` and `issues` is `Array<{kind: "unknown-op"|"invalid-options", scope: "kernel"|"solid", op: string, message?: string}>`
  - `runValidatingProbe(part, p, d, { maxOps } = {}) → { calls, issues, used, throws, runaway }` where `throws` is `Array<{subpart, message}>` and `runaway` is a boolean
  - Unchanged: `createProbeKernel() → { kernel, used }`, `detectBackend(part, params) → "manifold"|"occt"`

- [ ] **Step 1: Write the failing test**

Create `test/probe-validating.test.js`:

```js
// The validating probe: run a part's build() with NO geometry kernel, recording op
// names and routing options-form calls through the same op-options normalizers the
// real backends use — so `k.cylinder({ radius: 5 })` is caught in microseconds with
// the existing did-you-mean message instead of after an 11 MB WASM boot.
import { expect, test } from "vitest";
import { createValidatingProbe, runValidatingProbe, ProbeRunawayError, MAX_PROBE_OPS }
  from "../src/framework/geometry/probe.js";
import { createProbeKernel, detectBackend } from "../src/framework/geometry/probe.js";

const partWith = (build) => ({
  defaults: {}, views: { main: {} },
  parts: { body: { views: ["main"], build } },
});

test("a valid build records calls and reports no issues", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ r: 5, h: 10 })), {}, {});
  expect(r.issues).toEqual([]);
  expect(r.throws).toEqual([]);
  expect(r.calls.map((c) => c.op)).toContain("cylinder");
});

test("an unknown kernel op is reported", () => {
  const r = runValidatingProbe(partWith((k) => k.cylindre({ r: 5, h: 10 })), {}, {});
  expect(r.issues).toContainEqual(expect.objectContaining({ kind: "unknown-op", scope: "kernel", op: "cylindre" }));
});

test("an unknown solid op is reported", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ r: 5, h: 10 }).tranlsate([1, 0, 0])), {}, {});
  expect(r.issues).toContainEqual(expect.objectContaining({ kind: "unknown-op", scope: "solid", op: "tranlsate" }));
});

test("an unknown option key is reported with the existing did-you-mean text", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ radius: 5, h: 10 })), {}, {});
  const issue = r.issues.find((i) => i.kind === "invalid-options");
  expect(issue.op).toBe("cylinder");
  expect(issue.message).toMatch(/did you mean r\?/);
});

test("a missing required option is reported", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder({ r: 5 })), {}, {});
  expect(r.issues.find((i) => i.kind === "invalid-options").message).toMatch(/h is required/);
});

test("a legacy positional call is recorded but not argument-validated", () => {
  const r = runValidatingProbe(partWith((k) => k.cylinder(5, 5, 10)), {}, {});
  expect(r.calls.map((c) => c.op)).toContain("cylinder");
  expect(r.issues).toEqual([]);
});

test("a throwing build is captured per sub-part instead of being swallowed", () => {
  const r = runValidatingProbe(partWith(() => { throw new Error("bad maths"); }), {}, {});
  expect(r.throws).toHaveLength(1);
  expect(r.throws[0]).toMatchObject({ subpart: "body", message: "bad maths" });
});

test("a runaway loop trips the op ceiling instead of hanging", () => {
  const r = runValidatingProbe(partWith((k) => { for (;;) k.box({ size: [1, 1, 1] }); }), {}, {}, { maxOps: 500 });
  expect(r.runaway).toBe(true);
  expect(r.calls.length).toBeLessThanOrEqual(501);
});

test("MAX_PROBE_OPS is the documented ceiling", () => {
  expect(MAX_PROBE_OPS).toBe(100000);
});

test("the probe throws ProbeRunawayError past the ceiling", () => {
  const probe = createValidatingProbe({ maxOps: 2 });
  expect(() => { for (let i = 0; i < 5; i++) probe.kernel.box({ size: [1, 1, 1] }); })
    .toThrow(ProbeRunawayError);
});

test("recorded args are stable across two runs of the same pure build", () => {
  const build = (k, p) => k.cylinder({ r: p.r ?? 5, h: 10 }).translate([1, 2, 3]);
  const a = runValidatingProbe(partWith(build), { r: 5 }, {});
  const b = runValidatingProbe(partWith(build), { r: 5 }, {});
  expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
});

test("an impure build produces differing recordings", () => {
  const build = (k) => k.cylinder({ r: Math.random(), h: 10 });
  const a = runValidatingProbe(partWith(build), {}, {});
  const b = runValidatingProbe(partWith(build), {}, {});
  expect(JSON.stringify(a.calls)).not.toBe(JSON.stringify(b.calls));
});

// The pre-existing probe API must be untouched — detectBackend and the panel's
// relevance analysis both depend on it.
test("createProbeKernel still records op names for backend detection", () => {
  const { kernel, used } = createProbeKernel();
  kernel.cylinder({ r: 1, h: 1 }).fillet({ r: 1 });
  expect(used.has("cylinder")).toBe(true);
  expect(used.has("fillet")).toBe(true);
});

test("detectBackend still routes an OCCT-only op to occt", () => {
  expect(detectBackend(partWith((k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 })))).toBe("occt");
  expect(detectBackend(partWith((k) => k.box({ size: [1, 1, 1] })))).toBe("manifold");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/probe-validating.test.js`
Expected: FAIL — `createValidatingProbe is not a function` (the module resolves; the export is missing).

- [ ] **Step 3: Restructure probe.js around a shared proxy factory**

Replace the whole body of `src/framework/geometry/probe.js` with the following. The existing `createProbeKernel` / `detectBackend` behaviour is preserved exactly; both now delegate to one proxy factory so the recording and validating probes can never drift apart.

```js
// Geometry-free build execution. Two consumers share one Proxy implementation:
//
//  • createProbeKernel() — records op NAMES so detectBackend() can route a part to
//    OCCT when it uses fillet/chamfer/shell.
//  • createValidatingProbe() — additionally checks op names against the kernel
//    contract's op lists and routes options-form calls through the same op-options
//    normalizers the real backends use, so partforge/lint can catch a bad call in
//    microseconds instead of after a WASM boot.
//
// Catch-all proxies (rather than a hand-listed allowlist) mean new kernel/solid
// methods never have to be mirrored here — the probe can't drift out of sync with
// the real backends. (That drift previously broke the panel's relevance dimming
// when the build-step vocabulary was added but not taught to the probe.) The
// validating probe DOES need an allowlist, so it takes one from kernel.js's op
// lists, which test/kernel-contract.test.js pins to both backend implementations.
import {
  OCCT_ONLY_OPS, KERNEL_OPS, KERNEL_OPTIONAL_OPS,
  SOLID_OPS, SOLID_OPTIONAL_OPS, SHAPE2D_OPS,
} from "./kernel.js";
import { KERNEL_OP_SPECS, SOLID_OP_SPECS, isPlainOptions } from "./op-options.js";
import { resolveDerived } from "../derive.js";

const OCCT_ONLY = new Set(OCCT_ONLY_OPS);

// The probe returns ONE chainable handle for every non-query op, so it cannot tell a
// Solid from a Shape2D — k.box() and k.shape2d() yield the same object. The solid-scope
// allowlist is therefore the union of all three surfaces: deliberately permissive, so
// it never false-positives on an error-severity rule.
const KERNEL_ALLOWED = new Set([...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS]);
const SOLID_ALLOWED = new Set([...SOLID_OPS, ...SOLID_OPTIONAL_OPS, ...SHAPE2D_OPS]);

export const MAX_PROBE_OPS = 100000;

// Thrown to unwind a runaway build. Never escapes runValidatingProbe.
export class ProbeRunawayError extends Error {
  constructor(message) { super(message); this.name = "ProbeRunawayError"; }
}

// Shared proxy construction. `onCall(scope, op, args)` observes every op; queries
// return realistic dummy values the build may read.
function makeProbe(onCall) {
  const solidQueries = {
    boundingBox: () => ({ min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], size: [1, 1, 1] }),
    volume: () => 1,
    toMesh: () => ({ positions: new Float32Array(9), normals: new Float32Array(9), triangles: 1, edges: new Float32Array(0) }),
    toSTL: () => new ArrayBuffer(0),
    toIndexedMesh: () => ({ positions: new Float32Array(9), indices: new Uint32Array(3) }),
  };
  const kernelQueries = {
    toSTEP: () => Promise.resolve(new ArrayBuffer(0)),
    cleanup: () => {},
  };

  // `ignore` keeps the proxy from masquerading as a thenable/internal handle: symbols,
  // `then` (so it's never await-unwrapped), and `_`-prefixed internals resolve to
  // undefined rather than a chainable op.
  const ignore = (key) => typeof key !== "string" || key === "then" || key[0] === "_";

  const opProxy = (queries, scope) => new Proxy({}, {
    get(_t, key) {
      if (ignore(key)) return undefined;
      if (key in queries) return queries[key];
      return (...args) => { onCall(scope, key, args); return proxy; };
    },
  });

  const proxy = opProxy(solidQueries, "solid");   // a solid handle: every op chains back to itself
  const kernel = opProxy(kernelQueries, "kernel"); // factory ops (cylinder/box/prism/…) return a solid
  return { kernel, proxy };
}

export function createProbeKernel() {
  const used = new Set();
  const { kernel } = makeProbe((_scope, key) => used.add(key));
  return { kernel, used };
}

export function createValidatingProbe({ maxOps = MAX_PROBE_OPS } = {}) {
  const calls = [];
  const issues = [];
  const used = new Set();
  let count = 0;
  let solidProxy = null;

  // Args are recorded as strings so two probe runs can be compared for determinism.
  // The chainable handle is a single shared object, so identity is enough to spot it —
  // and checking identity FIRST matters, because JSON.stringify would trip its traps.
  const describe = (a) => {
    if (a === solidProxy) return "<solid>";
    if (typeof a === "function") return "<fn>";
    try { return JSON.stringify(a) ?? String(a); } catch { return "<unserializable>"; }
  };

  const onCall = (scope, op, args) => {
    if (++count > maxOps) throw new ProbeRunawayError(`build exceeded ${maxOps} kernel operations`);
    used.add(op);
    const allowed = scope === "kernel" ? KERNEL_ALLOWED : SOLID_ALLOWED;
    if (!allowed.has(op)) issues.push({ kind: "unknown-op", scope, op });
    // Validate ONLY the options form — the normative rule (KERNEL-CONTRACT.md
    // "Calling convention") is that a call is options form when it receives exactly
    // one plain-object argument. Legacy positional calls have no options contract to
    // check against. We run `toArgs` (key + required validation) but never the spec's
    // separate `check` hook: `check` inspects real geometry (revolve's calls
    // boundingBox() on its profile), which is meaningless against a proxy.
    const specs = scope === "kernel" ? KERNEL_OP_SPECS : SOLID_OP_SPECS;
    if (specs[op] && args.length === 1 && isPlainOptions(args[0])) {
      try { specs[op].toArgs(args[0]); }
      catch (e) { issues.push({ kind: "invalid-options", scope, op, message: e?.message || String(e) }); }
    }
    calls.push({ scope, op, args: args.map(describe) });
  };

  const { kernel, proxy } = makeProbe(onCall);
  solidProxy = proxy;
  return { kernel, calls, issues, used };
}

/**
 * Execute every sub-part's build() against a validating probe.
 * Never throws: a build error becomes an entry in `throws`, a runaway sets `runaway`.
 */
export function runValidatingProbe(part, p, d, { maxOps = MAX_PROBE_OPS } = {}) {
  const probe = createValidatingProbe({ maxOps });
  const throws = [];
  let runaway = false;
  for (const [name, sp] of Object.entries(part?.parts ?? {})) {
    if (typeof sp?.build !== "function") continue; // no-buildable-parts already reports this
    try {
      sp.build(probe.kernel, p, d);
    } catch (e) {
      if (e instanceof ProbeRunawayError) { runaway = true; break; }
      throws.push({ subpart: name, message: e?.message || String(e) });
    }
  }
  return { calls: probe.calls, issues: probe.issues, used: probe.used, throws, runaway };
}

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  let d = {};
  // A throwing derive must not escape here — this runs on the main thread mid
  // regen (after the busy spinner goes up). Probe with an empty `d`; the worker
  // build hits the same throw and posts a proper error for the UI.
  try { d = resolveDerived(part, p); } catch { /* fall through with d = {} */ }
  const { kernel, used } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  for (const op of used) if (OCCT_ONLY.has(op)) return "occt";
  return "manifold";
}
```

- [ ] **Step 4: Run the new test plus the existing probe tests**

Run: `npx vitest run test/probe-validating.test.js test/probe.test.js`
Expected: PASS — 14 new tests, and every pre-existing probe test still green.

- [ ] **Step 5: Run the full suite to confirm no regression in backend routing**

Run: `npx vitest run`
Expected: all pass. `detectBackend` feeds routing for every part, so `capability.test.js`, `param-deps-subpart.test.js`, `build.test.js`, and the backend suites are the ones to watch. If any fail, the restructure changed behaviour — diff `makeProbe` against the original `opProxy` rather than adjusting tests.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/probe.js test/probe-validating.test.js
git commit -m "feat(probe): validating probe for geometry-free build checking

Factors the probe Proxy into one shared factory and adds createValidatingProbe /
runValidatingProbe: they check op names against the contract op lists, route
options-form calls through the existing op-options normalizers (inheriting the
did-you-mean messages), surface build throws the recording probe discards, and
bound runaway loops at MAX_PROBE_OPS. createProbeKernel and detectBackend are
behaviourally unchanged.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Group 3 — build and kernel API rules

**Files:**
- Create: `src/framework/lint/rules-build.js`
- Modify: `src/framework/lint/index.js` (register the group; add the memoized probe to the context)
- Test: `test/lint-build.test.js`

**Interfaces:**
- Consumes: `runValidatingProbe` and `MAX_PROBE_OPS` from `../geometry/probe.js` (Task 4); `OCCT_ONLY_OPS` from `../geometry/kernel.js`; the context from Task 2.
- Produces:
  - `export const BUILD_RULES` with ids `unknown-kernel-op`, `unknown-solid-op`, `invalid-op-options`, `build-throws`, `manifold-backend-uses-occt-op`, `build-runaway`, `nondeterministic-build`.
  - Context gains `ctx.probe()` — a memoized `runValidatingProbe` result — and `ctx.probeAgain()`, a second independent run used only by the determinism rule.

- [ ] **Step 1: Write the failing test**

Create `test/lint-build.test.js`:

```js
// Group 3 — kernel API usage, via the validating probe. Every error here already
// fails at runtime today; the linter just reaches it before a WASM boot.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a valid build produces no build findings", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 })));
  expect(ids(r.errors)).toEqual([]);
});

test("an unknown kernel op is an error", () => {
  const r = lintPart(partWith((k) => k.cylindre({ r: 5, h: 10 })));
  expect(ids(r.errors)).toContain("unknown-kernel-op");
  expect(find(r, "unknown-kernel-op").message).toContain("cylindre");
});

test("an unknown solid op is an error", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 }).tranlsate([1, 0, 0])));
  expect(ids(r.errors)).toContain("unknown-solid-op");
});

test("an unknown option key is an error carrying the did-you-mean text", () => {
  const r = lintPart(partWith((k) => k.cylinder({ radius: 5, h: 10 })));
  expect(ids(r.errors)).toContain("invalid-op-options");
  expect(find(r, "invalid-op-options").message).toMatch(/did you mean r\?/);
});

test("a missing required option is an error", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5 })));
  expect(find(r, "invalid-op-options").message).toMatch(/h is required/);
});

test("a throwing build is an error naming the sub-part", () => {
  const r = lintPart(partWith(() => { throw new Error("bad maths"); }));
  expect(ids(r.errors)).toContain("build-throws");
  expect(find(r, "build-throws").message).toContain("bad maths");
  expect(find(r, "build-throws").path).toBe("parts.body.build");
});

test("an OCCT-only op with meta.backend manifold is an error", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 }),
    { meta: { title: "T", backend: "manifold" } }));
  expect(ids(r.errors)).toContain("manifold-backend-uses-occt-op");
  expect(find(r, "manifold-backend-uses-occt-op").message).toContain("fillet");
});

test("an OCCT-only op without a pinned backend is fine — routing handles it", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 })));
  expect(ids(r.errors)).not.toContain("manifold-backend-uses-occt-op");
});

test("a runaway build is an error, not a hang", () => {
  const r = lintPart(partWith((k) => { for (;;) k.box({ size: [1, 1, 1] }); }));
  expect(ids(r.errors)).toContain("build-runaway");
});

test("an impure build is a warning citing the error pattern", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: Math.random() * 5 + 1, h: 10 })));
  expect(ids(r.warnings)).toContain("nondeterministic-build");
  expect(find(r, "nondeterministic-build").pattern).toBe("impure-build-stale-preview");
});

test("a pure build is not flagged as nondeterministic", () => {
  const r = lintPart(partWith((k, p) => k.cylinder({ r: p.r ?? 5, h: 10 })));
  expect(ids(r.warnings)).not.toContain("nondeterministic-build");
});

test("params override defaults for the probe pass", () => {
  // r: 0 is invalid geometry but a legal option value; what we assert is that the
  // override reaches build(), by making the build throw only for the injected value.
  const part = partWith((k, p) => {
    if (p.mode === "explode") throw new Error("exploded");
    return k.box({ size: [1, 1, 1] });
  });
  part.defaults = { mode: "ok" };
  expect(ids(lintPart(part).errors)).not.toContain("build-throws");
  expect(ids(lintPart(part, { params: { mode: "explode" } }).errors)).toContain("build-throws");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lint-build.test.js`
Expected: FAIL — the unknown-kernel-op test fails (`expected [] to contain 'unknown-kernel-op'`).

- [ ] **Step 3: Write the build rules**

Create `src/framework/lint/rules-build.js`:

```js
// Group 3 — how the build uses the kernel, discovered by executing build() against
// the validating probe with no geometry kernel. Every error in this group already
// throws at runtime; the value is reaching it in microseconds, before a WASM boot.
import { err, warn } from "./finding.js";
import { OCCT_ONLY_OPS } from "../geometry/kernel.js";
import { MAX_PROBE_OPS } from "../geometry/probe.js";

const OCCT_ONLY = new Set(OCCT_ONLY_OPS);
const unique = (xs) => [...new Set(xs)];

export const BUILD_RULES = [
  {
    id: "unknown-kernel-op",
    run: ({ probe }) => unique(probe().issues
      .filter((i) => i.kind === "unknown-op" && i.scope === "kernel").map((i) => i.op))
      .map((op) => err("unknown-kernel-op", `\`k.${op}(…)\` is not a kernel operation`,
        `Remove the call or correct the name — see the kernel op table in docs/AUTHORING-PARTS.md for the full list.`,
        "parts")),
  },
  {
    id: "unknown-solid-op",
    run: ({ probe }) => unique(probe().issues
      .filter((i) => i.kind === "unknown-op" && i.scope === "solid").map((i) => i.op))
      .map((op) => err("unknown-solid-op", `\`.${op}(…)\` is not a Solid or Shape2D method`,
        `Remove the call or correct the name — see the Solid and Shape2D method tables in docs/AUTHORING-PARTS.md.`,
        "parts")),
  },
  {
    id: "invalid-op-options",
    run: ({ probe }) => unique(probe().issues
      .filter((i) => i.kind === "invalid-options").map((i) => i.message))
      .map((message) => err("invalid-op-options", message,
        "Correct the options object to match the op's documented keys — the message above names the offending key or the missing required one.",
        "parts")),
  },
  {
    id: "build-throws",
    run: ({ probe }) => probe().throws.map(({ subpart, message }) =>
      err("build-throws", `sub-part "${subpart}" threw during a geometry-free build: ${message}`,
        "Fix the error in build(). This was raised with no kernel attached, so it is a fault in the build's own logic (bad arithmetic, a missing param, a null dereference) rather than a geometry failure.",
        `parts.${subpart}.build`)),
  },
  {
    id: "manifold-backend-uses-occt-op",
    run: ({ part, probe }) => {
      if (part?.meta?.backend !== "manifold") return [];
      return [...probe().used].filter((op) => OCCT_ONLY.has(op))
        .map((op) => err("manifold-backend-uses-occt-op",
          `\`meta.backend\` pins Manifold, but the build calls \`${op}\`, which only OCCT implements`,
          `Remove \`meta.backend: "manifold"\` and let the probe route this part to OCCT, or replace \`${op}\` with a mesh-friendly construction — as written the build throws KernelCapabilityError.`,
          "meta.backend"));
    },
  },
  {
    id: "build-runaway",
    run: ({ probe }) => (probe().runaway ? [
      err("build-runaway", `the build exceeded ${MAX_PROBE_OPS} kernel operations`,
        "A loop in build() is not terminating, or a count parameter is far larger than intended. Bound the loop, or reduce the governing parameter.",
        "parts"),
    ] : []),
  },
  {
    id: "nondeterministic-build",
    run: ({ probe, probeAgain }) => {
      const a = probe();
      if (a.runaway || a.throws.length > 0) return []; // an aborted build can't be compared
      const b = probeAgain();
      if (b.runaway || b.throws.length > 0) return [];
      if (JSON.stringify(a.calls) === JSON.stringify(b.calls)) return [];
      return [warn("nondeterministic-build",
        "two builds with identical parameters produced different kernel calls",
        "build() must be a pure function of (k, p, d). Remove Math.random(), Date/clock reads, and module-level mutable state — the preview kernel memoizes geometry by content hash, so an impure build silently returns stale geometry.",
        "parts", "impure-build-stale-preview")];
    },
  },
];
```

- [ ] **Step 4: Add the memoized probe to the context and register the group**

In `src/framework/lint/index.js`, add the import, extend `lintContext`, and extend `RULES`:

```js
import { runValidatingProbe } from "../geometry/probe.js";
import { BUILD_RULES } from "./rules-build.js";
```

```js
export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES];
```

Replace the `lintContext` body's `return` with a version carrying the probe accessors. The probe result is memoized because seven rules read it; `probeAgain` is a deliberately separate run, used only by the determinism check.

```js
export function lintContext(part, params) {
  const p = { ...(part?.defaults ?? {}), ...(params ?? {}) };
  let d = {};
  try { d = resolveDerived(part, p) ?? {}; } catch { d = {}; }
  let cached = null;
  const probe = () => (cached ??= runValidatingProbe(part, p, d));
  const probeAgain = () => runValidatingProbe(part, p, d);
  return { part, p, d, probe, probeAgain };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/lint-build.test.js`
Expected: PASS, 12 tests.

Run: `npx vitest run test/lint-shape.test.js test/lint-schema.test.js`
Expected: still PASS. Note `lint-shape.test.js`'s `runRules` test passes a bare `{ part: {}, p: {}, d: {} }` context with no `probe` — it only runs the single `boom` rule, so this stays valid.

- [ ] **Step 6: Commit**

```bash
git add src/framework/lint/rules-build.js src/framework/lint/index.js test/lint-build.test.js
git commit -m "feat(lint): kernel API rules via the validating probe

Catches unknown kernel/solid ops, bad option keys and missing required options
(reusing op-options' did-you-mean), builds that throw, an OCCT-only op under a
pinned Manifold backend, runaway loops, and impure builds — the last by diffing
two probe runs, which needs no source parsing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Group 4 — verify-block rules

All four conditions currently throw mid-run, *after* `measure` has printed and the kernel has booted.

**Files:**
- Create: `src/framework/lint/rules-verify.js`
- Modify: `src/framework/lint/index.js` (register the group)
- Test: `test/lint-verify.test.js`

**Interfaces:**
- Consumes: `SUBPART_METRICS`, `VIEW_METRICS` from `../verify-metrics.js` (Task 1); `PROFILES` from `../../testing/dfm-profiles.js` (import-free, safe); `parseAssertion` from `../../testing/assert-dsl.js` (import-free, safe); `suggest` from `../geometry/op-options.js`; the context from Task 2.
- Produces: `export const VERIFY_RULES` with ids `verify-unknown-metric`, `verify-unknown-subpart`, `verify-bad-expr`, `verify-unknown-process`, `verify-expect-throws`.

Reference — a `verify` block is `{ process?: string | object, expect?: object | ((p, d) => object), cases?: … }`. `expect` is keyed by sub-part name or the literal `_view`; each value is `{ [metric]: expression }` where an expression is a string/number/boolean or `{ expr, hint }`.

- [ ] **Step 1: Write the failing test**

Create `test/lint-verify.test.js`:

```js
// Group 4 — the verify block. Each of these currently throws mid-run, after measure
// has already printed and the kernel has booted; lint reaches them before any of that.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (verify) => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
  verify,
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a well-formed verify block produces no findings", () => {
  const r = lintPart(partWith({ process: "fdm-pla", expect: { body: { holes: 0, bbox: "<=[60,60,60]" }, _view: { overlaps: 0 } } }));
  expect(ids(r.errors)).toEqual([]);
});

test("a part with no verify block produces no findings", () => {
  const part = partWith(undefined);
  delete part.verify;
  expect(ids(lintPart(part).errors)).toEqual([]);
});

test("an unknown subpart metric is an error", () => {
  const r = lintPart(partWith({ expect: { body: { wallThickness: 2 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
  expect(find(r, "verify-unknown-metric").path).toBe("verify.expect.body.wallThickness");
});

test("a subpart metric used under _view is an error", () => {
  // `holes` is subpart-scoped only; _view has its own smaller vocabulary.
  const r = lintPart(partWith({ expect: { _view: { holes: 1 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
});

test("an unknown subpart name is an error", () => {
  const r = lintPart(partWith({ expect: { boddy: { holes: 0 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
  expect(find(r, "verify-unknown-subpart").hint).toMatch(/body/);
});

test("an unparseable assertion is an error", () => {
  const r = lintPart(partWith({ expect: { body: { volume: ">>> 5" } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
});

test("an unknown process profile is an error", () => {
  const r = lintPart(partWith({ process: "fdm-unobtanium", expect: {} }));
  expect(ids(r.errors)).toContain("verify-unknown-process");
  expect(find(r, "verify-unknown-process").hint).toMatch(/fdm-pla/);
});

test("an inline process object is accepted", () => {
  const r = lintPart(partWith({ process: { bed: [200, 200, 200], minWall: 1.2 }, expect: {} }));
  expect(ids(r.errors)).not.toContain("verify-unknown-process");
});

test("the function form of expect is resolved and linted", () => {
  const r = lintPart(partWith({ expect: () => ({ body: { wallThickness: 2 } }) }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
});

test("a throwing expect function is an error", () => {
  const r = lintPart(partWith({ expect: () => { throw new Error("nope"); } }));
  expect(ids(r.errors)).toContain("verify-expect-throws");
  expect(find(r, "verify-expect-throws").message).toContain("nope");
});

test("the { expr, hint } expectation form is accepted", () => {
  const r = lintPart(partWith({ expect: { body: { volume: { expr: ">=100", hint: "keep it chunky" } } } }));
  expect(ids(r.errors)).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lint-verify.test.js`
Expected: FAIL — the unknown-metric test fails (`expected [] to contain 'verify-unknown-metric'`).

- [ ] **Step 3: Write the verify rules**

Create `src/framework/lint/rules-verify.js`:

```js
// Group 4 — the verify block's own well-formedness. Each condition here currently
// throws from verify() mid-run, AFTER measure has printed and the kernel has booted,
// which is also the documented reason CLI stdout isn't pure JSON in that case.
// Catching them statically removes both the wasted boot and the stdout caveat.
import { err } from "./finding.js";
import { SUBPART_METRICS, VIEW_METRICS } from "../verify-metrics.js";
import { PROFILES } from "../../testing/dfm-profiles.js";
import { parseAssertion } from "../../testing/assert-dsl.js";
import { suggest } from "../geometry/op-options.js";

// Resolve `expect` to a plain object. The function form (p, d) => ({…}) is invoked
// once with the probe's params so per-preset topology can be linted like any other.
// Returns { expect, threw }.
function resolveExpect(verify, p, d) {
  if (typeof verify?.expect !== "function") return { expect: verify?.expect, threw: null };
  try { return { expect: verify.expect(p, d), threw: null }; }
  catch (e) { return { expect: null, threw: e?.message || String(e) }; }
}

const isExpectation = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && "expr" in v;
const exprOf = (v) => (isExpectation(v) ? v.expr : v);

export const VERIFY_RULES = [
  {
    id: "verify-expect-throws",
    run: ({ part, p, d }) => {
      const { threw } = resolveExpect(part?.verify, p, d);
      return threw ? [err("verify-expect-throws",
        `\`verify.expect(p, d)\` threw: ${threw}`,
        "The function form of `expect` must return an expectation object for any parameter set. Guard whatever it reads, or switch to the static object form.",
        "verify.expect")] : [];
    },
  },
  {
    id: "verify-unknown-subpart",
    run: ({ part, p, d }) => {
      const { expect } = resolveExpect(part?.verify, p, d);
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      return Object.keys(expect)
        .filter((key) => key !== "_view" && !names.includes(key))
        .map((key) => {
          const hint = suggest(key, names);
          return err("verify-unknown-subpart",
            `\`verify.expect\` targets "${key}", which is not a sub-part`,
            `Use one of the sub-part names (${names.join(", ")}) or the literal \`_view\` for whole-assembly metrics${hint ? ` — did you mean "${hint}"?` : "."}`,
            `verify.expect.${key}`);
        });
    },
  },
  {
    id: "verify-unknown-metric",
    run: ({ part, p, d }) => {
      const { expect } = resolveExpect(part?.verify, p, d);
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      const out = [];
      for (const [target, metrics] of Object.entries(expect)) {
        if (target !== "_view" && !names.includes(target)) continue; // reported by verify-unknown-subpart
        if (!metrics || typeof metrics !== "object") continue;
        const registry = target === "_view" ? VIEW_METRICS : SUBPART_METRICS;
        const valid = Object.keys(registry);
        for (const metric of Object.keys(metrics)) {
          if (valid.includes(metric)) continue;
          const hint = suggest(metric, valid);
          out.push(err("verify-unknown-metric",
            `"${metric}" is not a ${target === "_view" ? "view" : "sub-part"} metric`,
            `Valid ${target === "_view" ? "view" : "sub-part"} metrics are: ${valid.join(", ")}${hint ? ` — did you mean "${hint}"?` : "."}`,
            `verify.expect.${target}.${metric}`));
        }
      }
      return out;
    },
  },
  {
    id: "verify-bad-expr",
    run: ({ part, p, d }) => {
      const { expect } = resolveExpect(part?.verify, p, d);
      if (!expect || typeof expect !== "object") return [];
      const out = [];
      for (const [target, metrics] of Object.entries(expect)) {
        if (!metrics || typeof metrics !== "object") continue;
        for (const [metric, spec] of Object.entries(metrics)) {
          try { parseAssertion(exprOf(spec)); }
          catch (e) {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} is not a valid assertion: ${e?.message || String(e)}`,
              "Use the assertion DSL: a bare value for equality, a comparison like `>=3`, a range like `2..5`, or a componentwise vector like `<=[60,60,60]` (with `*` to skip an axis).",
              `verify.expect.${target}.${metric}`));
          }
        }
      }
      return out;
    },
  },
  {
    id: "verify-unknown-process",
    run: ({ part }) => {
      const process = part?.verify?.process;
      if (process === undefined || process === null) return [];
      if (typeof process === "object") return []; // an inline { bed, minWall, clearance } profile
      const valid = Object.keys(PROFILES);
      if (valid.includes(process)) return [];
      const hint = suggest(String(process), valid);
      return [err("verify-unknown-process",
        `\`verify.process\` names "${process}", which is not a known DFM profile`,
        `Use one of: ${valid.join(", ")}${hint ? ` — did you mean "${hint}"?` : ""}, or pass an inline profile object such as \`{ bed: [220, 220, 250], minWall: 1.2 }\`.`,
        "verify.process")];
    },
  },
];
```

- [ ] **Step 4: Register the group**

In `src/framework/lint/index.js`:

```js
import { VERIFY_RULES } from "./rules-verify.js";

export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES, ...VERIFY_RULES];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/lint-verify.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 6: Verify the import closure is still clean**

Run: `node --input-type=module -e "import('./src/lint.js').then(() => console.log('loaded clean'))"`
Expected: prints `loaded clean`. This is a smoke check that nothing pulled in a WASM module at import time; Task 9 adds the real automated guard.

- [ ] **Step 7: Commit**

```bash
git add src/framework/lint/rules-verify.js src/framework/lint/index.js test/lint-verify.test.js
git commit -m "feat(lint): verify-block rules

Catches unknown metrics, unknown sub-part targets, unparseable assertions,
unknown DFM profiles and a throwing expect() — all of which currently throw
from verify() only after measure has printed and the kernel has booted.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: CLI — `partforge lint` and `measure` auto-lint

**Files:**
- Modify: `bin/cli.js` — `USAGE` (line 20), imports (lines 6-17), a new `lint` command in the `commands` table (after `measure`, line 98), a `printLint` helper beside `printVerify` (line 158), and the auto-lint in `measure`
- Test: `test/lint-cli.test.js`

**Interfaces:**
- Consumes: `lintPart` from `../src/lint.js`.
- Produces: `partforge lint <part> [--params <json>] [--json] [--out <file>] [--strict]`; `partforge measure` gains `--no-lint`.
- Exit codes: `lint` exits 0 clean, 1 when any error finding is present, and (with `--strict`) 1 when any warning is present. `measure` exits 1 without booting a kernel when lint finds errors.

Existing CLI conventions to follow: one async function per command in the `commands` table; flags parsed with `parse(args, options, usage)` (strict `util.parseArgs`); failures routed through `crash(cmd, e, jsonMode)`; `die(usage)` on a missing positional; human output printed by a `printX` helper.

- [ ] **Step 1: Write the failing test**

Create `test/lint-cli.test.js`. Follow the existing `test/cli.test.js` pattern of invoking the CLI as a subprocess.

```js
// The `lint` command and measure's auto-lint. Exercised as a subprocess because
// exit codes are half the contract — agents and CI branch on them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const CLI = new URL("../bin/cli.js", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "pf-lint-"));

// Write a part module to a temp file and return its path.
const partFile = (name, source) => {
  const file = join(dir, `${name}.js`);
  writeFileSync(file, source);
  return file;
};

// Run the CLI, returning { status, stdout, stderr } without throwing on non-zero.
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stderr: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const CLEAN = `export default {
  meta: { title: "Clean" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
};`;

const BROKEN = `export default {
  meta: { title: "Broken" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ sizes: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
};`;

const WARNS = `export default {
  meta: { title: "Warns" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" }, orphan: { label: "Orphan" } },
};`;

test("lint exits 0 on a clean part", () => {
  const r = run(["lint", partFile("clean", CLEAN)]);
  expect(r.status).toBe(0);
});

test("lint exits 1 and names the rule on a broken part", () => {
  const r = run(["lint", partFile("broken", BROKEN)]);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/invalid-op-options/);
  expect(r.stdout + r.stderr).toMatch(/did you mean size\?/);
});

test("lint --json emits a machine-readable report", () => {
  const r = run(["lint", partFile("broken2", BROKEN), "--json"]);
  const report = JSON.parse(r.stdout);
  expect(report.ok).toBe(false);
  expect(report.errors.map((f) => f.rule)).toContain("invalid-op-options");
  expect(report.errors[0].hint.length).toBeGreaterThan(0);
});

test("lint --out writes the report to a file", () => {
  const out = join(dir, "report.json");
  run(["lint", partFile("broken3", BROKEN), "--out", out]);
  expect(JSON.parse(readFileSync(out, "utf8")).ok).toBe(false);
});

test("warnings alone exit 0, but --strict exits 1", () => {
  const file = partFile("warns", WARNS);
  expect(run(["lint", file]).status).toBe(0);
  expect(run(["lint", file, "--strict"]).status).toBe(1);
});

test("measure refuses a lint-broken part without booting a kernel", () => {
  const r = run(["measure", partFile("broken4", BROKEN)]);
  expect(r.status).toBe(1);
  expect(r.stdout + r.stderr).toMatch(/invalid-op-options/);
  // The kernel never booted, so no measure table was printed.
  expect(r.stdout).not.toMatch(/watertight/);
});

test("measure --no-lint skips the gate", () => {
  // Without the lint gate this reaches the kernel and fails there instead, so the
  // assertion is only that the failure is no longer the lint gate.
  const r = run(["measure", partFile("broken5", BROKEN), "--no-lint"]);
  expect(r.stdout + r.stderr).not.toMatch(/lint:/);
});

test("usage lists the lint command", () => {
  const r = run(["nonsense"]);
  expect(r.stderr).toMatch(/lint/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lint-cli.test.js`
Expected: FAIL — the CLI rejects `lint` as an unknown command, so the clean-part case exits 1 rather than 0.

- [ ] **Step 3: Add the import and update USAGE**

In `bin/cli.js`, add to the import block (after line 17):

```js
import { lintPart } from "../src/lint.js";
```

And change line 20:

```js
const USAGE = "usage: partforge <lint|measure|render|pick-serve|pick> …";
```

- [ ] **Step 4: Add the `printLint` helper**

In `bin/cli.js`, add beside `printVerify` (after it, around line 173). The format deliberately mirrors `printVerify` so agents parse one diagnostic shape:

```js
function printLint(r) {
  const all = [...r.errors, ...r.warnings];
  if (all.length === 0) { console.log("lint: clean"); return; }
  console.log("lint:");
  for (const f of all) {
    console.log(`  ${f.severity === "error" ? "✗" : "⚠"} ${f.rule}${f.path ? `  ${f.path}` : ""}`);
    console.log(`      ${f.message}`);
    console.log(`      hint: ${f.hint}${f.pattern ? ` (ERROR-PATTERNS.md#${f.pattern})` : ""}`);
  }
  const e = r.errors.length, w = r.warnings.length;
  console.log(`  result: ${e ? `${e} error(s)` : "no errors"}${w ? `, ${w} warning(s)` : ""}`);
}
```

- [ ] **Step 5: Add the `lint` command**

In `bin/cli.js`, insert into the `commands` object immediately before `async measure(args)` (line 62), so `lint` reads first in both the table and `--help` output:

```js
  async lint(args) {
    const usage = "usage: partforge lint <part-module> [--params <json>] [--json] [--out <file>] [--strict]";
    const { values: flags, positionals: [partPath] } = parse(args, {
      params: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      strict: { type: "boolean" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      const params = flags.params ? JSON.parse(flags.params) : undefined;
      const report = lintPart(part, { params });
      if (!flags.json) printLint(report);
      if (flags.out) {
        mkdirSync(dirname(resolve(flags.out)), { recursive: true });
        writeFileSync(flags.out, JSON.stringify(report, null, 2));
        console.log(`\nwrote ${flags.out}`);
      }
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok && (!flags.strict || report.warnings.length === 0) ? 0 : 1);
    } catch (e) {
      crash("lint", e, !!flags.json);
    }
  },
```

- [ ] **Step 6: Add the auto-lint to `measure`**

In `bin/cli.js`'s `measure`, add `"no-lint"` to the parsed flags and gate on lint before `bootKernel`. Change the flag block (lines 64-69) to:

```js
    const { values: flags, positionals: [partPath, view] } = parse(args, {
      process: { type: "string" },
      "no-verify": { type: "boolean" },
      "no-lint": { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
    }, usage);
```

Update the usage string on line 63:

```js
    const usage = "usage: partforge measure <part-module> [view] [--process <profile>] [--no-verify] [--no-lint] [--json] [--out <file>]";
```

And insert the gate between `loadPart` and `bootKernel` (between lines 71 and 72):

```js
      const part = await loadPart(partPath, usage);
      // Error-tier lint before the kernel boots: a statically broken part fails in
      // milliseconds with a precise message rather than after a WASM boot and a
      // downstream error that doesn't name the cause. Warnings never gate measure.
      if (!flags["no-lint"]) {
        const lint = lintPart(part);
        if (!lint.ok) {
          if (flags.json) console.log(JSON.stringify({ ok: false, lint }, null, 2));
          else printLint(lint);
          if (flags.out) {
            mkdirSync(dirname(resolve(flags.out)), { recursive: true });
            writeFileSync(flags.out, JSON.stringify({ ok: false, lint }, null, 2));
          }
          process.exit(1);
        }
      }
      const kernel = await bootKernel(part);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/lint-cli.test.js`
Expected: PASS, 8 tests.

Run: `npx vitest run test/cli.test.js test/verify-cli.test.js`
Expected: still PASS. The demo parts must lint clean for `measure` to keep working — if a pre-existing part now fails the gate, that is a real finding: fix the part, not the linter.

- [ ] **Step 8: Commit**

```bash
git add bin/cli.js test/lint-cli.test.js
git commit -m "feat(cli): partforge lint command and measure auto-lint

Adds \`partforge lint\` (exit 1 on errors, --strict also on warnings, --json/--out
for machine consumption) and gates \`measure\` on the error tier before the kernel
boots, with --no-lint to opt out — mirroring the existing --no-verify.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Worker `lint` job

**Files:**
- Modify: `src/framework/worker.js:50-67`
- Test: `test/lint-worker.test.js`

**Interfaces:**
- Consumes: `lintPart` from `../lint.js`.
- Produces: the worker answers `{ type: "lint", params? }` with `{ type: "lint-report", report }`, where `report` is `lintPart`'s return value.

**Why this goes in `worker.js` and NOT in `jobs.js`:** `handle(kernel, part, msg, post)` receives an already-booted kernel, and `self.onmessage` awaits that boot before calling it (`worker.js:50-64`). Routing lint through `handle` would force an 11 MB OCCT boot to run a check that touches no geometry at all. The lint message must therefore be answered *before* kernel resolution. The message name uses the kebab-case convention of the existing protocol (`download-parts`, `needs-occt`).

- [ ] **Step 1: Write the failing test**

Create `test/lint-worker.test.js`. Follow the fake-`self` pattern in `test/worker-runtime.test.js` — note that `self` needs a `navigator.userAgent`, because paper (pulled into the worker graph via curve-fill) reads it.

```js
// The worker lint job. The point of this job is that it answers WITHOUT booting a
// kernel: handle() in jobs.js takes an already-booted kernel and worker.js awaits
// that boot before calling it, so lint must be intercepted ahead of both.
import { expect, test, vi } from "vitest";

const goodPart = () => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
});

// Install a fake WorkerGlobalScope, import runWorker, and return the captured hooks.
async function bootWorker(part) {
  const posted = [];
  const self = {
    name: "occt", // the expensive backend: proves lint never triggers its boot
    navigator: { userAgent: "node" },
    onmessage: null,
    postMessage: (m) => posted.push(m),
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("postMessage", self.postMessage);
  const { runWorker } = await import("../src/framework/worker.js");
  runWorker(part);
  return { self, posted };
}

test("a lint message is answered with a lint-report", async () => {
  const { self, posted } = await bootWorker(goodPart());
  await self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report");
  expect(report).toBeDefined();
  expect(report.report.ok).toBe(true);
  expect(report.report.errors).toEqual([]);
});

test("the lint report carries findings for a broken part", async () => {
  const part = goodPart();
  part.parts.body.build = (k, p) => k.box({ sizes: [p.h, p.h, p.h] });
  const { self, posted } = await bootWorker(part);
  await self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report").report;
  expect(report.ok).toBe(false);
  expect(report.errors.map((f) => f.rule)).toContain("invalid-op-options");
});

test("params are forwarded to lintPart", async () => {
  const part = goodPart();
  part.parts.body.build = (k, p) => {
    if (p.mode === "explode") throw new Error("exploded");
    return k.box({ size: [1, 1, 1] });
  };
  part.defaults = { mode: "ok" };
  const { self, posted } = await bootWorker(part);
  await self.onmessage({ data: { type: "lint", params: { mode: "explode" } } });
  const report = posted.find((m) => m.type === "lint-report").report;
  expect(report.errors.map((f) => f.rule)).toContain("build-throws");
});

test("lint does not boot the OCCT kernel", async () => {
  // A cold OCCT boot posts { type: "progress", phase: "loading exact kernel" }
  // before it starts. Its absence is the evidence that no boot was attempted.
  const { self, posted } = await bootWorker(goodPart());
  await self.onmessage({ data: { type: "lint" } });
  expect(posted.find((m) => m.type === "progress" && /exact kernel/.test(m.phase ?? ""))).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lint-worker.test.js`
Expected: FAIL — no `lint-report` is posted; the message falls through to the OCCT boot path and the test times out or errors on the missing WASM.

- [ ] **Step 3: Intercept the lint message**

In `src/framework/worker.js`, add the import beside the existing one at line 5:

```js
import { handle } from "./jobs.js";
import { lintPart } from "../lint.js";
```

And add the early return at the top of `self.onmessage` (line 50), before any kernel resolution:

```js
  self.onmessage = async (e) => {
    // Lint is geometry-free by construction, so answer it before touching — or
    // booting — a kernel. handle() in jobs.js takes an already-booted kernel, and
    // the branches below await that boot, so routing lint through them would drag
    // in OCCT's ~11 MB WASM to run a check that never calls the kernel at all.
    if (e.data?.type === "lint") {
      postMessage({ type: "lint-report", report: lintPart(part, { params: e.data.params }) });
      return;
    }
    let kernel;
```

Leave the rest of the handler unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lint-worker.test.js test/worker-runtime.test.js`
Expected: PASS — 4 new tests, and the pre-existing worker-runtime tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/framework/worker.js test/lint-worker.test.js
git commit -m "feat(worker): geometry-free lint job

Answers { type: \"lint\" } with { type: \"lint-report\", report } before any kernel
resolution. Deliberately not in jobs.js: handle() takes an already-booted kernel,
so routing lint there would boot OCCT's 11 MB WASM for a check that never touches
geometry. Gives browser hosts a terminable, timeout-guarded lint path.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Cross-cutting guard tests

Three tests that protect properties no single-rule test can: that the shipped parts are clean, that the browser-compatibility promise holds, and that the rule registry stays coherent.

**Files:**
- Create: `test/lint-parts.test.js`
- Create: `test/lint-purity.test.js`
- Create: `test/lint-registry.test.js`

**Interfaces:**
- Consumes: `lintPart`, `RULES` from `../src/lint.js`; the rule ids defined in Tasks 2, 3, 5, 6.
- Produces: no source changes — but this task **may surface real defects in shipped parts**, which must be fixed in the part, not silenced in the linter.

- [ ] **Step 1: Write the shipped-parts sweep**

Create `test/lint-parts.test.js`:

```js
// Every shipped part must lint clean. This is the regression net that would have
// caught the nameplate/bracket `features`-without-`sliders` bug before a browser boot.
// A failure here is a real defect in the part — fix the part, never the linter.
import { readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const files = readdirSync(new URL("../src/parts", import.meta.url).pathname).filter((f) => f.endsWith(".js"));

test("src/parts is not empty (the sweep would pass vacuously otherwise)", () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)("%s lints without errors", async (file) => {
  const mod = await import(`../src/parts/${file}`);
  const report = lintPart(mod.default);
  const detail = report.errors.map((f) => `${f.rule} @ ${f.path}: ${f.message}`).join("\n");
  expect(report.errors, `\n${detail}`).toEqual([]);
});
```

- [ ] **Step 2: Run it and fix any real defects it finds**

Run: `npx vitest run test/lint-parts.test.js`
Expected: PASS for every part.

If a part fails, read the finding and **fix the part**. Do not weaken a rule to make a part pass. If you believe a finding is a false positive, stop and report it rather than editing the rule — a false positive on an `error`-severity rule is a design defect that needs a decision, because errors gate `measure` and block the cloud build.

- [ ] **Step 3: Write the import-purity guard**

Create `test/lint-purity.test.js`:

```js
// partforge/lint must load in a browser sandbox iframe and in Deno, so its transitive
// import closure may never reach a WASM geometry kernel or the DOM viewer. This is the
// property that silently regresses the first time someone adds a convenient import —
// e.g. pulling SUBPART_METRICS from src/testing/verify.js, which imports measure.js
// and jobs.js. Walk the graph and prove it.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";

const BANNED = ["three", "manifold-3d", "replicad", "replicad-opencascadejs"];
const ENTRY = new URL("../src/lint.js", import.meta.url).pathname;

// Collect every static import specifier in a module.
const importsOf = (src) =>
  [...src.matchAll(/^\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1])
    .concat([...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));

function walk(entry) {
  const seen = new Set();
  const bare = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const next = resolve(dirname(file), spec);
        queue.push(next);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files: seen, bare };
}

test("the lint import closure reaches no geometry kernel or renderer", () => {
  const { bare } = walk(ENTRY);
  for (const banned of BANNED) {
    expect([...bare], `partforge/lint must not import ${banned}`).not.toContain(banned);
  }
});

test("the lint import closure does not reach the kernel-importing modules", () => {
  const { files } = walk(ENTRY);
  const forbidden = ["src/testing/verify.js", "src/testing/measure.js", "src/framework/jobs.js", "src/index.js"];
  for (const f of forbidden) {
    expect([...files].some((p) => p.endsWith(f)), `partforge/lint must not reach ${f}`).toBe(false);
  }
});

test("the lint closure has no bare dependencies at all", () => {
  // Zero runtime dependencies is the strongest form of the browser guarantee, and
  // the spec requires it. Loosen this only with a deliberate decision.
  expect([...walk(ENTRY).bare]).toEqual([]);
});
```

- [ ] **Step 4: Run the purity guard**

Run: `npx vitest run test/lint-purity.test.js`
Expected: PASS, 3 tests. If the third fails, read the reported specifier: something in the closure took on a runtime dependency, which breaks the browser promise.

- [ ] **Step 5: Write the registry contract test**

Create `test/lint-registry.test.js`:

```js
// The rule registry is the documented catalog. Like test/kernel-contract.test.js, this
// pins the code to the docs so the two can't drift. The docs-coverage assertion lands
// in Task 10 with the catalog it checks, so every task in this plan ends green.
import { expect, test } from "vitest";
import { RULES } from "../src/lint.js";

test("every rule has a unique id", () => {
  const ids = RULES.map((r) => r.id);
  expect(ids.length).toBe(new Set(ids).size);
});

test("every rule id is kebab-case", () => {
  for (const r of RULES) expect(r.id, `${r.id} is not kebab-case`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
});

test("every rule exposes a run function", () => {
  for (const r of RULES) expect(typeof r.run, `${r.id} has no run()`).toBe("function");
});

test("the registry covers all four rule groups", () => {
  const ids = RULES.map((r) => r.id);
  for (const id of ["missing-views", "features-requires-sliders", "invalid-op-options", "verify-unknown-metric"]) {
    expect(ids, `registry is missing ${id}`).toContain(id);
  }
  expect(RULES.length).toBeGreaterThanOrEqual(25);
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run test/lint-registry.test.js`
Expected: PASS, 4 tests.

Run: `npx vitest run`
Expected: the entire suite passes. Every task in this plan ends green.

- [ ] **Step 7: Commit**

```bash
git add test/lint-parts.test.js test/lint-purity.test.js test/lint-registry.test.js
git commit -m "test(lint): shipped-part sweep, import purity, registry contract

Pins three properties no per-rule test can: every part in src/parts lints clean,
partforge/lint's import closure has zero bare dependencies and never reaches a
geometry kernel, and the rule registry stays unique, well-formed and documented.
The docs assertion fails until the next commit lands the rule catalog.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Documentation and version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (new "Linting" section)
- Modify: `docs/ERROR-PATTERNS.md` (one new entry)
- Modify: `AGENTS.md` (CLI command list, around line 40)
- Modify: `skills/partforge/SKILL.md` (CLI command list)
- Modify: `package.json` (version)
- Modify: `test/lint-registry.test.js` (add the docs-coverage assertion)

**Interfaces:**
- Consumes: the rule ids from Tasks 2, 3, 5, 6; `test/lint-registry.test.js` from Task 9, which this task extends with the docs-coverage assertion.
- Produces: `docs/AUTHORING-PARTS.md` contains every rule id; version becomes `0.26.0`.

- [ ] **Step 1: Add the Linting section to AUTHORING-PARTS.md**

Insert a new `## Linting` section immediately before the existing "The diagnostics contract (for agents)" section, so the two diagnostic surfaces read together. Include the full rule catalog — `test/lint-registry.test.js` asserts every registered id appears in this file.

````markdown
## Linting

`partforge lint` statically validates a PartDefinition without booting a geometry
kernel. It runs in milliseconds and catches the authoring mistakes that otherwise
surface only at runtime — or, worse, not at all.

```bash
npx partforge lint src/parts/<part>.js [--params '{"h":40}'] [--json] [--out f] [--strict]
```

Exit 0 when clean, 1 when any **error** finding is present; `--strict` also fails on
warnings. `partforge measure` runs the error tier automatically before booting a
kernel — pass `--no-lint` to skip it.

The same check is available programmatically and in the browser:

```js
import { lintPart } from "partforge/lint";
const { ok, errors, warnings } = lintPart(part, { params });
```

`partforge/lint` has **zero runtime dependencies** and never imports a geometry
kernel or the DOM viewer, so it runs unchanged in Node, a Web Worker, a sandboxed
iframe, and Deno. A worker also answers `{ type: "lint", params }` with
`{ type: "lint-report", report }` without booting its kernel.

**Findings** carry the same guarantees as verify's checks — a self-contained `hint`
on every one, and a stable `pattern` id where an ERROR-PATTERNS.md entry applies:

```js
{ rule: "features-requires-sliders", severity: "error",
  message: "section \"flange\" feature 0 has no `sliders` array",
  hint: "A `features` entry must carry a `sliders` array …",
  path: "parameters[1].features[0]", pattern: "features-missing-sliders" }
```

`path` is a JS accessor path rooted at the PartDefinition — `parameters[1].features[0]`,
`defaults.bore`, `parts.spacer.views[0]`, `parameters[0].presets["M3"].od`. Findings
about the definition as a whole use `""`.

**Severity.** A finding is an `error` only when the part *provably cannot work* — the
condition already fails at runtime, so lint just reaches it sooner and says it more
precisely. Everything speculative is a `warning` and never blocks anything.

### Rule catalog

**Definition shape** — `missing-meta-title`, `missing-defaults`, `no-buildable-parts`,
`missing-views`, `part-view-unknown` (all errors); `view-unused` (warning).

**Parameter schema** — `features-requires-sliders`, `control-key-not-in-defaults`,
`preset-key-not-in-defaults` (errors); `slider-range-excludes-default`,
`unknown-control-field`, `duplicate-control-key`, `default-not-exposed` (warnings).

**Kernel API**, found by executing `build()` against a geometry-free probe —
`unknown-kernel-op`, `unknown-solid-op`, `invalid-op-options`, `build-throws`,
`manifold-backend-uses-occt-op`, `build-runaway` (errors);
`nondeterministic-build` (warning, from diffing two probe runs).

**Verify block** — `verify-unknown-metric`, `verify-unknown-subpart`,
`verify-bad-expr`, `verify-unknown-process`, `verify-expect-throws` (all errors).

A rule that itself throws yields an `internal-rule-error` **warning** and the run
continues: `lintPart` never throws and never blocks a part because of a linter bug.
````

- [ ] **Step 2: Add the ERROR-PATTERNS.md entry**

Add one entry to `docs/ERROR-PATTERNS.md`, in the `# Core framework` namespace, following the file's exact `## <id>` + `Symptom:`/`Cause:`/`Fix:` structure. The symptom's leading backtick literal is what the CLI's `matchPattern` indexes on, so it must be the runtime error text verbatim.

```markdown
## features-missing-sliders

Symptom: `Cannot read properties of undefined (reading 'filter')` thrown from the
control panel while the app boots, with no geometry ever rendering.
Cause: a `features` entry in the parameter schema has no `sliders` array —
`controls.js` reads `feat.sliders.filter(...)` unguarded. A bare on/off control was
put in `features` instead of `toggles`.
Fix: move a bare boolean to the section's `toggles` array (`{ key, label, on }`), or
give the `features` entry the `sliders` array it requires. `npx partforge lint <part>`
catches this statically as `features-requires-sliders`.
```

Do not add entries for the other rule ids: their findings carry `hint` text inline,
and `impure-build-stale-preview` (cited by `nondeterministic-build`) already exists.

- [ ] **Step 3: Add the command to AGENTS.md and SKILL.md**

In `AGENTS.md`, in the CLI code block that currently lists `measure` / `render` /
`pick-serve`, add `lint` as the first entry:

```bash
npx partforge lint    src/parts/<part>.js            # static checks, no kernel boot; exits non-zero on errors
npx partforge measure src/parts/<part>.js [view]   # bbox/volume/holes/watertight + verify gate; exits non-zero on failure
```

Make the equivalent addition to the CLI list in `skills/partforge/SKILL.md`, matching
whatever formatting that file already uses for the other commands.

- [ ] **Step 4: Bump the version**

In `package.json`, change `"version": "0.25.0"` to `"version": "0.26.0"`. Leave
`CONTRACT_VERSION` in `src/framework/geometry/kernel.js` at `1` — this release is
purely additive and changes no kernel contract.

- [ ] **Step 5: Add the docs-coverage assertion to the registry test**

The catalog now exists, so pin it. In `test/lint-registry.test.js`, add the `readFileSync` import and a fifth test. This is what stops a future rule from being added to the registry without a doc entry:

```js
import { readFileSync } from "node:fs";
```

```js
test("every rule id is documented in AUTHORING-PARTS.md", () => {
  const docs = readFileSync(new URL("../docs/AUTHORING-PARTS.md", import.meta.url).pathname, "utf8");
  for (const r of RULES) expect(docs, `${r.id} is missing from the docs`).toContain(r.id);
});
```

- [ ] **Step 6: Run the registry test, then the whole suite**

Run: `npx vitest run test/lint-registry.test.js`
Expected: PASS, 5 tests — including the new documentation assertion. If it fails, a rule id is missing from the catalog you wrote in Step 1; add it there rather than relaxing the test.

Run: `npx vitest run`
Expected: the entire suite passes.

Run: `npm run check`
Expected: the headless smoke check boots the demo app in real Chromium without console errors. (Requires Playwright's Chromium: `npx playwright install chromium`. If Playwright is unavailable in your environment, say so in your report rather than skipping silently.)

- [ ] **Step 7: Verify the CLI end-to-end by hand**

Run: `npx partforge lint src/parts/demo.js`
Expected: prints `lint: clean` and exits 0.

Run: `npx partforge lint src/parts/planter.js --json`
Expected: valid JSON with `"ok": true`.

- [ ] **Step 8: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md AGENTS.md skills/partforge/SKILL.md package.json test/lint-registry.test.js
git commit -m "docs: document partforge lint; release 0.26.0

Adds the Linting section with the finding contract and full rule catalog (which
test/lint-registry.test.js pins), an ERROR-PATTERNS entry for the unguarded
features/sliders crash, and the command to AGENTS.md and SKILL.md.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Walked every spec section against the plan:

| Spec requirement | Task |
|---|---|
| Import-closure purity constraint | 1 (extraction), 9 (enforced) |
| `verify-metrics.js` extraction | 1 |
| `suggest()` export | 1 |
| `./lint` export subpath | 2 |
| Module layout (`finding`/`index`/4 rule files/`src/lint.js`) | 2, 3, 5, 6 |
| `lintPart` API + finding schema + `path` convention | 2 |
| Group 1 (6 rules) | 2 |
| Group 2 (7 rules) | 3 |
| `createValidatingProbe` in probe.js, `toArgs` not `check`, handle-type union | 4 |
| Group 3 (7 rules) incl. double-probe determinism | 5 |
| Group 4 (5 rules) | 6 |
| CLI `lint` + `measure` auto-lint + `--no-lint` | 7 |
| Worker `lint` job | 8 |
| Error handling: never throws, `internal-rule-error` warning | 2 (implemented + tested) |
| Testing: per-rule, shipped parts, purity, registry, determinism | 2,3,5,6 + 9 |
| Docs, ERROR-PATTERNS, AGENTS/SKILL, 0.26.0 | 10 |

No gaps. Two deviations from the spec, both corrections found while reading the code:

1. **The worker job moves from `jobs.js` to `worker.js`.** The spec said to mirror the `inspect` job in `jobs.js`, but `handle()` receives an already-booted kernel and `worker.js:50-64` awaits that boot first, so a lint job there would force an 11 MB OCCT boot for a check that never touches geometry. Task 8 documents this in a code comment and a test.
2. **Message name is `lint-report`, not `lintReport`** — the existing protocol is kebab-case (`download-parts`, `needs-occt`).

**Placeholder scan.** No TBD/TODO, no "handle edge cases", no "similar to Task N". Every code step carries complete code. One defect found and fixed inline: Task 3 Step 3 originally carried a dead `controlDescriptors` generator stub alongside the real `collectDescriptors`, with a note telling the implementer to delete it. An implementer reading tasks out of order could have pasted it, so the stub is gone rather than annotated.

**Type consistency.** Checked names across tasks: `err`/`warn` (T2) used in T3/T5/T6; rule shape `{ id, run }` consistent; context `{ part, p, d }` (T2) extended with `probe`/`probeAgain` (T5) and consumed by T5/T6; `runValidatingProbe` return `{ calls, issues, used, throws, runaway }` (T4) matches every field T5 reads; `lintPart` return `{ ok, errors, warnings }` (T2) matches T7/T8/T9 usage; `SUBPART_METRICS`/`VIEW_METRICS` (T1) match T6 imports; `suggest` (T1) matches T3/T6 usage.
