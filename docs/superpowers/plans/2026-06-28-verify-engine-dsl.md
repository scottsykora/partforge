# Verify Engine + Assertion DSL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a partforge part self-verifying — a co-located `verify` block (DFM process profile + per-part `expect` assertions) evaluated across defaults+presets, surfaced through `partforge measure`'s exit gate and the `partforge/testing` `verify()` export.

**Architecture:** A layered `verify()` on top of the existing pure-facts `measure()`. A strict string-DSL parser/evaluator turns declared assertions into pass/fail; a process-profile resolver supplies DFM rules; a case expander (param-deps-aware via signature memoization) runs the checks across the default config plus every preset. Exact facts are hard gates; the approximate min-wall metric is a warn that is *unimplemented in this slice* (reports "pending SDF") and never gates.

**Tech Stack:** Plain ESM JavaScript (no TypeScript), Node 24, vitest, manifold-3d kernel for headless builds.

## Global Constraints

- **Plain ESM JS, no TypeScript** — `import`/`export`, no type annotations.
- **Node 24** — run tests with `npx vitest run` (after `nvm use`).
- **`measure()` 4-arg callers must keep working** — any new parameter is optional and last.
- **Manifold-only facts** (`holes`, `watertight`) are `null` on OCCT parts → assertions on them **skip** (never fail).
- **min-wall is always a warn**, never gates `ok`; in this slice it is unimplemented and its measured value is `null` → checks report status `"warn"` with message "min wall not yet measured (pending SDF)".
- **DSL parser is strict** — any unrecognized form throws an `Error` naming the offending string.
- **Branch:** work on `dfm-self-verify` (already checked out).
- **Commit trailer:** every commit message ends with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `src/testing/assert-dsl.js` — `parseAssertion(expr)` + `evaluateAssertion(parsed, actual)`. The DSL: parsing (with unit normalization, strict errors) and comparison.
- **Create** `src/testing/dfm-profiles.js` — built-in process profiles + `resolveProfile(spec)`.
- **Create** `src/testing/cases.js` — `expandCases(part)` → `[{name, params}]` (defaults + presets, or `verify.cases`).
- **Create** `src/testing/verify.js` — metric registry, `evaluateCase(facts, {profile, expect})` (pure policy), and `verify(kernel, part, opts)` (orchestration + param-deps signature dedup).
- **Modify** `src/testing/measure.js` — add optional `opts` arg and a placeholder `minWall: null` per-subpart field.
- **Modify** `src/testing.js` — export `verify`.
- **Modify** `bin/cli.js` — run `verify` inside the `measure` command, print a checks block, fold into JSON, gate the exit code; add `--process` / `--no-verify`.
- **Modify** `src/parts/demo.js` — add a worked `verify` block.
- **Create** `test/fixtures/bad-verify-part.js` — a part whose `verify` block deliberately fails (for the CLI exit-1 test).
- **Modify** `docs/AUTHORING-PARTS.md` — add a "Self-verification" section.
- **Tests:** `test/assert-dsl.test.js`, `test/dfm-profiles.test.js`, `test/verify-cases.test.js`, `test/verify.test.js`, `test/verify-cli.test.js`; add cases to `test/measure.test.js`.

---

### Task 1: Assertion DSL — parser

**Files:**
- Create: `src/testing/assert-dsl.js`
- Test: `test/assert-dsl.test.js`

**Interfaces:**
- Produces: `parseAssertion(expr) → predicate`. `expr` is a number, boolean, or string. Returns one of:
  `{op:"eq", value}` · `{op:"gte"|"lte"|"gt"|"lt", value}` · `{op:"range", min, max}` · `{op:"vle"|"vge", vec:[n|null,n|null,n|null]}`. Numeric values are normalized to base units (mm / mm³). Throws `Error` on any unrecognized form, unknown unit, or malformed vector.

- [ ] **Step 1: Write the failing test**

```js
// test/assert-dsl.test.js
import { expect, test } from "vitest";
import { parseAssertion } from "../src/testing/assert-dsl.js";

test("parses numbers and booleans as equality", () => {
  expect(parseAssertion(1)).toEqual({ op: "eq", value: 1 });
  expect(parseAssertion(true)).toEqual({ op: "eq", value: true });
});

test("parses scalar comparators", () => {
  expect(parseAssertion(">=1.5")).toEqual({ op: "gte", value: 1.5 });
  expect(parseAssertion("<=2")).toEqual({ op: "lte", value: 2 });
  expect(parseAssertion(">0")).toEqual({ op: "gt", value: 0 });
  expect(parseAssertion("<10")).toEqual({ op: "lt", value: 10 });
});

test("parses ranges and normalizes units to base (mm / mm3)", () => {
  expect(parseAssertion("0.4..0.6cm3")).toEqual({ op: "range", min: 400, max: 600 });
  expect(parseAssertion("5mm")).toEqual({ op: "eq", value: 5 });
  expect(parseAssertion("2cm")).toEqual({ op: "eq", value: 20 });
});

test("parses vector bounds with * to skip an axis", () => {
  expect(parseAssertion("<=[12,12,16]")).toEqual({ op: "vle", vec: [12, 12, 16] });
  expect(parseAssertion(">=[10,*,14]")).toEqual({ op: "vge", vec: [10, null, 14] });
});

test("throws on unrecognized forms (strict)", () => {
  expect(() => parseAssertion(">==1.5")).toThrow();
  expect(() => parseAssertion("abc")).toThrow();
  expect(() => parseAssertion("<=[1,2]")).toThrow();
  expect(() => parseAssertion("5kg")).toThrow();
  expect(() => parseAssertion({})).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assert-dsl.test.js`
Expected: FAIL — cannot import `parseAssertion` (module/function missing).

- [ ] **Step 3: Write minimal implementation**

```js
// src/testing/assert-dsl.js
// Assertion mini-DSL: parse a declared expectation into a normalized predicate.
// Numeric values are normalized to base units (mm for length, mm³ for volume) at
// parse time so the evaluator compares plain numbers. Strict: any unrecognized form
// throws an Error naming the offending string.

const UNIT = { mm: 1, cm: 10, mm3: 1, cm3: 1000 };

function toBase(numStr, unit) {
  const n = Number(numStr);
  if (!Number.isFinite(n)) throw new Error(`assertion: not a number: "${numStr}"`);
  if (unit === undefined) return n;
  if (!(unit in UNIT)) throw new Error(`assertion: unknown unit: "${unit}"`);
  return n * UNIT[unit];
}

const NUM = "[-+]?[0-9]*\\.?[0-9]+";
const U = "(mm3|cm3|mm|cm)?";
const reScalar = new RegExp(`^(>=|<=|>|<)?\\s*(${NUM})\\s*${U}$`);
const reRange = new RegExp(`^(${NUM})\\s*\\.\\.\\s*(${NUM})\\s*${U}$`);
const reVec = /^(>=|<=)\s*\[\s*(.+?)\s*\]$/;

export function parseAssertion(expr) {
  if (typeof expr === "number" || typeof expr === "boolean") return { op: "eq", value: expr };
  if (typeof expr !== "string") throw new Error(`assertion: unsupported value ${JSON.stringify(expr)}`);
  const s = expr.trim();

  const vec = s.match(reVec);
  if (vec) {
    const parts = vec[2].split(",").map((t) => t.trim());
    if (parts.length !== 3) throw new Error(`assertion: vector needs 3 components: "${expr}"`);
    return { op: vec[1] === "<=" ? "vle" : "vge", vec: parts.map((t) => (t === "*" ? null : toBase(t, undefined))) };
  }
  const range = s.match(reRange);
  if (range) return { op: "range", min: toBase(range[1], range[3] || undefined), max: toBase(range[2], range[3] || undefined) };

  const sc = s.match(reScalar);
  if (sc) {
    const op = sc[1] ? { ">=": "gte", "<=": "lte", ">": "gt", "<": "lt" }[sc[1]] : "eq";
    return { op, value: toBase(sc[2], sc[3] || undefined) };
  }
  throw new Error(`assertion: unrecognized form: "${expr}"`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assert-dsl.test.js`
Expected: PASS (all parser tests).

- [ ] **Step 5: Commit**

```bash
git add src/testing/assert-dsl.js test/assert-dsl.test.js
git commit -m "feat: assertion DSL parser with unit normalization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Assertion DSL — evaluator

**Files:**
- Modify: `src/testing/assert-dsl.js`
- Test: `test/assert-dsl.test.js`

**Interfaces:**
- Consumes: `parseAssertion` output (Task 1).
- Produces: `evaluateAssertion(parsed, actual) → { pass: boolean, message: string }`. `actual` is a number, boolean, or `[x,y,z]` array (never null — null is handled by the caller in Task 6). Boundary comparisons (`gte`/`lte`/`range`/vectors) use a small epsilon; `eq` uses absolute+relative tolerance for numbers and strict `===` for booleans.

- [ ] **Step 1: Write the failing test**

```js
// append to test/assert-dsl.test.js
import { evaluateAssertion } from "../src/testing/assert-dsl.js";

const ev = (expr, actual) => evaluateAssertion(parseAssertion(expr), actual).pass;

test("evaluates scalar equality and comparators", () => {
  expect(ev(1, 1)).toBe(true);
  expect(ev(1, 2)).toBe(false);
  expect(ev(true, true)).toBe(true);
  expect(ev(true, false)).toBe(false);
  expect(ev(">=1.5", 1.5)).toBe(true);   // boundary
  expect(ev(">=1.5", 1.4)).toBe(false);
  expect(ev("<=2", 3)).toBe(false);
  expect(ev(">0", 0)).toBe(false);
});

test("evaluates ranges with unit normalization", () => {
  expect(ev("0.4..0.6cm3", 500)).toBe(true);   // 500 mm³ in [400,600]
  expect(ev("0.4..0.6cm3", 700)).toBe(false);
  expect(ev("0.4..0.6cm3", 400)).toBe(true);   // boundary
});

test("evaluates vector bounds componentwise, * skips", () => {
  expect(ev("<=[12,12,16]", [8, 8, 10])).toBe(true);
  expect(ev("<=[12,12,16]", [13, 8, 10])).toBe(false);
  expect(ev(">=[10,*,14]", [12, 5, 20])).toBe(true);   // axis 1 skipped
  expect(ev(">=[10,*,14]", [9, 5, 20])).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/assert-dsl.test.js`
Expected: FAIL — `evaluateAssertion` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/testing/assert-dsl.js
const EPS = 1e-6;
const approxEq = (a, b) => Math.abs(a - b) <= EPS + EPS * Math.abs(b);
const fmtVec = (v) => "[" + v.map((x) => (x === null ? "*" : x)).join(",") + "]";

export function evaluateAssertion(parsed, actual) {
  switch (parsed.op) {
    case "eq": {
      const pass = typeof parsed.value === "boolean" ? actual === parsed.value : approxEq(actual, parsed.value);
      return { pass, message: `${actual} ${pass ? "==" : "!="} ${parsed.value}` };
    }
    case "gte": return mk(actual >= parsed.value - EPS, actual, ">=", parsed.value);
    case "lte": return mk(actual <= parsed.value + EPS, actual, "<=", parsed.value);
    case "gt": return mk(actual > parsed.value, actual, ">", parsed.value);
    case "lt": return mk(actual < parsed.value, actual, "<", parsed.value);
    case "range": {
      const pass = actual >= parsed.min - EPS && actual <= parsed.max + EPS;
      return { pass, message: `${actual} ${pass ? "in" : "out of"} ${parsed.min}..${parsed.max}` };
    }
    case "vle":
    case "vge": {
      const ge = parsed.op === "vge";
      let pass = true;
      for (let i = 0; i < 3; i++) {
        const lim = parsed.vec[i];
        if (lim === null) continue;
        if (ge ? actual[i] < lim - EPS : actual[i] > lim + EPS) pass = false;
      }
      return { pass, message: `${fmtVec(actual)} ${ge ? ">=" : "<="} ${fmtVec(parsed.vec)}` };
    }
    default: throw new Error(`assertion: unknown op "${parsed.op}"`);
  }
}

function mk(pass, actual, opStr, value) {
  return { pass, message: `${actual} ${pass ? opStr : "not " + opStr} ${value}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/assert-dsl.test.js`
Expected: PASS (parser + evaluator).

- [ ] **Step 5: Commit**

```bash
git add src/testing/assert-dsl.js test/assert-dsl.test.js
git commit -m "feat: assertion DSL evaluator (scalars, ranges, vectors)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: DFM process profiles

**Files:**
- Create: `src/testing/dfm-profiles.js`
- Test: `test/dfm-profiles.test.js`

**Interfaces:**
- Produces: `PROFILES` (object of built-ins) and `resolveProfile(spec) → { bed:[x,y,z], minWall, clearance }`. `spec` is a profile name string, an inline object, or `{ base: "<name>", ...overrides }`. Throws on an unknown name or non-object/non-string spec.

*(Named `dfm-profiles.js`, not `profiles.js`, to avoid confusion with the existing geometry polygon "profiles".)*

- [ ] **Step 1: Write the failing test**

```js
// test/dfm-profiles.test.js
import { expect, test } from "vitest";
import { resolveProfile, PROFILES } from "../src/testing/dfm-profiles.js";

test("resolves a built-in profile by name", () => {
  expect(resolveProfile("fdm-pla")).toEqual({ bed: [220, 220, 250], minWall: 1.2, clearance: 0.2 });
  expect(Object.keys(PROFILES)).toContain("resin");
});

test("accepts an inline profile object", () => {
  expect(resolveProfile({ bed: [100, 100, 100], minWall: 1 })).toEqual({ bed: [100, 100, 100], minWall: 1 });
});

test("merges overrides onto a named base", () => {
  expect(resolveProfile({ base: "fdm-pla", minWall: 2 })).toEqual({ bed: [220, 220, 250], minWall: 2, clearance: 0.2 });
});

test("throws on an unknown profile name", () => {
  expect(() => resolveProfile("fdm-unobtainium")).toThrow();
  expect(() => resolveProfile(42)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dfm-profiles.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/testing/dfm-profiles.js
// Reusable design-for-manufacturing process profiles. `bed` is the build volume
// [x,y,z] in mm (a hard bbox-fit gate); `minWall` mm (a warn); `clearance` mm is
// carried for a future gap check (not enforced yet).
export const PROFILES = {
  "fdm-pla": { bed: [220, 220, 250], minWall: 1.2, clearance: 0.2 },
  "fdm-petg": { bed: [220, 220, 250], minWall: 1.5, clearance: 0.3 },
  "resin": { bed: [120, 68, 160], minWall: 0.6, clearance: 0.1 },
};

export function resolveProfile(spec) {
  if (typeof spec === "string") {
    if (!(spec in PROFILES)) {
      throw new Error(`unknown process profile: "${spec}" (known: ${Object.keys(PROFILES).join(", ")})`);
    }
    return { ...PROFILES[spec] };
  }
  if (spec && typeof spec === "object") {
    const base = spec.base ? resolveProfile(spec.base) : {};
    const { base: _drop, ...overrides } = spec;
    return { ...base, ...overrides };
  }
  throw new Error(`invalid process profile: ${JSON.stringify(spec)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dfm-profiles.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/testing/dfm-profiles.js test/dfm-profiles.test.js
git commit -m "feat: DFM process profiles + resolveProfile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Case expander

**Files:**
- Create: `src/testing/cases.js`
- Test: `test/verify-cases.test.js`

**Interfaces:**
- Produces: `expandCases(part) → [{ name, params }]`. Always includes `{name:"defaults", params:{...part.defaults}}`. Adds one entry per preset found in any `part.parameters[].presets` section (preset overrides merged onto defaults). If `part.verify.cases` is set, returns exactly those names in order (`"defaults"` always valid; any other must be a preset). Throws on a duplicate preset name across sections or an unknown named case.

- [ ] **Step 1: Write the failing test**

```js
// test/verify-cases.test.js
import { expect, test } from "vitest";
import { expandCases } from "../src/testing/cases.js";

const part = {
  defaults: { od: 8, bore: 3.4, h: 10 },
  parameters: [{ id: "body", presets: { M3: { od: 8, bore: 3.4 }, M5: { od: 12, bore: 5.4, h: 16 } } }],
  views: { v: {} },
  parts: {},
};

test("expands defaults + every preset, merging overrides onto defaults", () => {
  const cases = expandCases(part);
  expect(cases.map((c) => c.name)).toEqual(["defaults", "M3", "M5"]);
  expect(cases.find((c) => c.name === "M5").params).toEqual({ od: 12, bore: 5.4, h: 16 });
  expect(cases.find((c) => c.name === "M3").params).toEqual({ od: 8, bore: 3.4, h: 10 });
});

test("verify.cases selects and orders an explicit subset", () => {
  const p = { ...part, verify: { cases: ["defaults", "M5"] } };
  expect(expandCases(p).map((c) => c.name)).toEqual(["defaults", "M5"]);
});

test("throws on an unknown named case", () => {
  const p = { ...part, verify: { cases: ["M9"] } };
  expect(() => expandCases(p)).toThrow();
});

test("a part with no parameters yields just defaults", () => {
  expect(expandCases({ defaults: { a: 1 }, views: { v: {} }, parts: {} })).toEqual([{ name: "defaults", params: { a: 1 } }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify-cases.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/testing/cases.js
// Enumerate the parameter configurations verify() checks: the default config plus
// every declared preset (or an explicit part.verify.cases list).

function presetMap(part) {
  const map = {};
  for (const section of part.parameters ?? []) {
    if (!section.presets) continue;
    for (const [name, overrides] of Object.entries(section.presets)) {
      if (name in map) throw new Error(`duplicate preset name across sections: "${name}"`);
      map[name] = overrides;
    }
  }
  return map;
}

export function expandCases(part) {
  const presets = presetMap(part);
  const make = (name) => {
    if (name === "defaults") return { name, params: { ...part.defaults } };
    if (!(name in presets)) throw new Error(`unknown verify case "${name}" (not "defaults" or a preset)`);
    return { name, params: { ...part.defaults, ...presets[name] } };
  };
  const names = part.verify?.cases ?? ["defaults", ...Object.keys(presets)];
  return names.map(make);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify-cases.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/testing/cases.js test/verify-cases.test.js
git commit -m "feat: verify case expander (defaults + presets)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `measure()` min-wall placeholder seam

**Files:**
- Modify: `src/testing/measure.js`
- Test: `test/measure.test.js`

**Interfaces:**
- Produces: `measure(kernel, part, view?, params?, opts?)` — unchanged for 4-arg callers. New optional `opts.minWall` reserves the seam; each subpart now carries `minWall` (always `null` in this slice; the SDF plan fills it in).

- [ ] **Step 1: Write the failing test**

```js
// append to test/measure.test.js
test("each subpart carries a minWall field (null until the SDF plan implements it)", () => {
  const r = measure(k, boxPart, "v");
  expect(r.subparts[0]).toHaveProperty("minWall", null);
  // opts arg is accepted; 4-arg behaviour is unchanged
  expect(measure(k, boxPart, "v", {}, { minWall: true }).subparts[0].minWall).toBe(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/measure.test.js`
Expected: FAIL — subpart has no `minWall` property.

- [ ] **Step 3: Write minimal implementation**

In `src/testing/measure.js`, change the signature line:

```js
export function measure(kernel, part, view = Object.keys(part.views)[0], params = {}, opts = {}) {
```

and add a `minWall` field to the per-subpart object returned inside `.map(...)` (right after `holes`):

```js
      holes: typeof solid.genus === "function" ? solid.genus() : null,
      // Computed by the voxel/SDF core in a later plan; reserved here so verify()
      // can consume it. opts.minWall is the enable seam (no-op until then).
      minWall: null,
```

(`opts` is intentionally unused for now beyond reserving the parameter.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/measure.test.js`
Expected: PASS (new test + the existing measure tests).

- [ ] **Step 5: Commit**

```bash
git add src/testing/measure.js test/measure.test.js
git commit -m "feat: reserve minWall seam in measure() (null until SDF)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Verify policy core (`evaluateCase`)

**Files:**
- Create: `src/testing/verify.js`
- Test: `test/verify.test.js`

**Interfaces:**
- Consumes: `parseAssertion`/`evaluateAssertion` (Tasks 1–2), `resolveProfile` (Task 3).
- Produces (this task): the metric registry and `evaluateCase(facts, { profile, expect }) → checks[]`, a **pure** function (no kernel). `facts` is a `measure()` report (`{subparts:[{name,...}], aggregate:{bbox,volume}, overlaps:[]}`). Each check is `{ scope:"view"|"subpart", subpart, metric, kind:"gate"|"warn", expr, actual, status:"pass"|"fail"|"warn"|"skip", pass, message }`. Profile rules (`bed` → view `bbox<=bed`; `minWall` → per-subpart `minWall>=n`) are merged with `expect`, where `expect` wins. Unknown metric names throw.
- Produces (Task 7, same file): `verify(kernel, part, opts)`.

- [ ] **Step 1: Write the failing test**

```js
// test/verify.test.js
import { expect, test } from "vitest";
import { evaluateCase } from "../src/testing/verify.js";
import { resolveProfile } from "../src/testing/dfm-profiles.js";

const facts = {
  subparts: [{ name: "spacer", holes: 1, volume: 500, surfaceArea: 300, triangleCount: 200, bbox: [8, 8, 10], watertight: true, minWall: null }],
  aggregate: { bbox: [8, 8, 10], volume: 500 },
  overlaps: [],
};
const byKey = (checks, scope, metric) => checks.find((c) => c.scope === scope && c.metric === metric);

test("passes exact gates from profile + expect", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: { spacer: { holes: 1, volume: "0.4..0.6cm3" }, _view: { overlaps: 0 } } });
  expect(byKey(checks, "subpart", "holes").status).toBe("pass");
  expect(byKey(checks, "subpart", "volume").status).toBe("pass");
  expect(byKey(checks, "view", "overlaps").status).toBe("pass");
  expect(byKey(checks, "view", "bbox").status).toBe("pass");       // from profile.bed
});

test("min-wall is a warn (pending SDF), never a fail", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/pending SDF/);
});

test("a violated exact gate is a fail", () => {
  const checks = evaluateCase(facts, { profile: null, expect: { spacer: { holes: 2 } } });
  expect(byKey(checks, "subpart", "holes").status).toBe("fail");
});

test("Manifold-only facts skip on OCCT (null actual)", () => {
  const occt = { subparts: [{ name: "spacer", holes: null, watertight: null, volume: 500, surfaceArea: 1, triangleCount: 1, bbox: [8, 8, 10], minWall: null }], aggregate: { bbox: [8, 8, 10], volume: 500 }, overlaps: [] };
  const checks = evaluateCase(occt, { profile: null, expect: { spacer: { watertight: true } } });
  expect(byKey(checks, "subpart", "watertight").status).toBe("skip");
});

test("throws on an unknown metric", () => {
  expect(() => evaluateCase(facts, { profile: null, expect: { spacer: { wormholes: 1 } } })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify.test.js`
Expected: FAIL — `evaluateCase` missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/testing/verify.js
import { parseAssertion, evaluateAssertion } from "./assert-dsl.js";

// Metric registry: name → how to pull the value out of facts, and whether a failure
// is a hard gate or a warning. `manifoldOnly` facts are null on OCCT parts.
const SUBPART_METRICS = {
  holes: { kind: "gate", manifoldOnly: true, extract: (s) => s.holes },
  watertight: { kind: "gate", manifoldOnly: true, extract: (s) => s.watertight },
  volume: { kind: "gate", extract: (s) => s.volume },
  surfaceArea: { kind: "gate", extract: (s) => s.surfaceArea },
  triangleCount: { kind: "gate", extract: (s) => s.triangleCount },
  bbox: { kind: "gate", extract: (s) => s.bbox },
  minWall: { kind: "warn", extract: (s) => s.minWall },
};
const VIEW_METRICS = {
  bbox: { kind: "gate", extract: (r) => r.aggregate.bbox },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length },
};

function check(scope, subpart, metric, expr, registry, factsObj) {
  const reg = registry[metric];
  if (!reg) throw new Error(`unknown ${scope} metric "${metric}"${subpart ? ` on sub-part "${subpart}"` : ""}`);
  const actual = reg.extract(factsObj);
  const base = { scope, subpart, metric, kind: reg.kind, expr: String(expr) };
  if (actual === null || actual === undefined) {
    if (reg.manifoldOnly) return { ...base, actual, status: "skip", pass: null, message: "n/a (OCCT backend)" };
    if (metric === "minWall") return { ...base, actual, status: "warn", pass: null, message: "min wall not yet measured (pending SDF)" };
    return { ...base, actual, status: "skip", pass: null, message: "unavailable" };
  }
  const { pass, message } = evaluateAssertion(parseAssertion(expr), actual);
  const status = pass ? "pass" : reg.kind === "warn" ? "warn" : "fail";
  return { ...base, actual, status, pass, message };
}

// Pure policy: profile rules + per-part expect → checks for one case's facts.
export function evaluateCase(facts, { profile, expect }) {
  const checks = [];
  const viewExp = {
    ...(profile?.bed ? { bbox: `<=[${profile.bed.join(",")}]` } : {}),
    ...(expect?._view ?? {}),
  };
  for (const [metric, expr] of Object.entries(viewExp)) checks.push(check("view", null, metric, expr, VIEW_METRICS, facts));

  for (const s of facts.subparts) {
    const merged = {
      ...(profile?.minWall != null ? { minWall: `>=${profile.minWall}` } : {}),
      ...(expect?.[s.name] ?? {}),
    };
    for (const [metric, expr] of Object.entries(merged)) checks.push(check("subpart", s.name, metric, expr, SUBPART_METRICS, s));
  }
  return checks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/testing/verify.js test/verify.test.js
git commit -m "feat: verify policy core (evaluateCase, metric registry)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Verify orchestration + param-deps dedup

**Files:**
- Modify: `src/testing/verify.js`
- Test: `test/verify.test.js`

**Interfaces:**
- Consumes: `evaluateCase` (Task 6), `expandCases` (Task 4), `resolveProfile` (Task 3), `measure` (Task 5), and `subPartReadKeys`/`relevanceHash`/`RELEVANT_ALL` from `../framework/param-deps.js`.
- Produces: `verify(kernel, part, { process?, view?, measureFn? }) → { ok, view, cases:[{name, params, checks}], failures, warnings }`. `ok` is true iff no check has status `"fail"`. `measureFn` is injectable (default: the real `measure`) for testing. Cases sharing a param-deps **signature** reuse one `measureFn` call (a preset that changes only params no on-screen sub-part reads costs nothing). When `subPartReadKeys` returns `RELEVANT_ALL`, the signature falls back to the full param set (safe; distinct presets each measure).

- [ ] **Step 1: Write the failing test**

```js
// append to test/verify.test.js
import { beforeAll } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { verify } from "../src/testing/verify.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

const tube = (od, h) => ({
  meta: { title: "Tube", units: "mm" },
  defaults: { od, h, label: "a" },
  parameters: [{ id: "b", presets: { Big: { od: 20, h: 30 }, Relabel: { label: "z" } } }],
  parts: { tube: { views: ["v"], build: (kk, p) => kk.cylinder(p.od / 2, p.od / 2, p.h).cut(kk.cylinder(2, 2, p.h + 4).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
});

test("verify passes a sound part and reports a min-wall warning", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", expect: { tube: { holes: 1 }, _view: { overlaps: 0 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.warnings.some((w) => w.metric === "minWall")).toBe(true);
});

test("verify fails a violated gate", () => {
  const part = { ...tube(12, 10), verify: { expect: { tube: { holes: 2 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  expect(v.failures).toHaveLength(3);   // defaults + 2 presets
});

test("dedup: cases with the same param-deps signature reuse one measure call", () => {
  // "Relabel" preset changes only `label`, which the build never reads → same
  // signature as defaults; "Big" changes od/h → distinct. 3 cases, 2 measures.
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", cases: ["defaults", "Relabel", "Big"] } };
  let calls = 0;
  const measureFn = (...args) => { calls++; return measureReal(...args); };
  const v = verify(k, part, { measureFn });
  expect(v.cases).toHaveLength(3);
  expect(calls).toBe(2);
});
```

Add this import near the other imports at the top of the test file:

```js
import { measure as measureReal } from "../src/testing/measure.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify.test.js`
Expected: FAIL — `verify` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to src/testing/verify.js
import { measure as defaultMeasure } from "./measure.js";
import { resolveProfile } from "./dfm-profiles.js";
import { expandCases } from "./cases.js";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../framework/param-deps.js";

export function verify(kernel, part, { process, view, measureFn = defaultMeasure } = {}) {
  view = view ?? Object.keys(part.views)[0];
  const profileSpec = process ?? part.verify?.process;
  const profile = profileSpec ? resolveProfile(profileSpec) : null;
  const expect = part.verify?.expect ?? {};
  const needMinWall = profile?.minWall != null || JSON.stringify(expect).includes("minWall");

  const cases = expandCases(part);
  const readKeys = subPartReadKeys(part, view, part.defaults);
  const signature = (params) =>
    readKeys === RELEVANT_ALL
      ? JSON.stringify(params)
      : [...readKeys.entries()].map(([name, keys]) => `${name}:${relevanceHash([...keys], params)}`).join("|");

  const memo = new Map();
  const measureCase = (params) => {
    const key = signature(params);
    if (!memo.has(key)) memo.set(key, measureFn(kernel, part, view, params, { minWall: needMinWall }));
    return memo.get(key);
  };

  const caseResults = cases.map(({ name, params }) => ({ name, params, checks: evaluateCase(measureCase(params), { profile, expect }) }));
  const all = caseResults.flatMap((c) => c.checks.map((ch) => ({ case: c.name, ...ch })));
  return {
    ok: !all.some((c) => c.status === "fail"),
    view,
    cases: caseResults,
    failures: all.filter((c) => c.status === "fail"),
    warnings: all.filter((c) => c.status === "warn"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify.test.js`
Expected: PASS (policy core + orchestration + dedup).

- [ ] **Step 5: Commit**

```bash
git add src/testing/verify.js test/verify.test.js
git commit -m "feat: verify() orchestration with param-deps case dedup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Export `verify` from `partforge/testing`

**Files:**
- Modify: `src/testing.js`
- Test: `test/verify.test.js`

**Interfaces:**
- Produces: `verify` reachable from the package entry `partforge/testing` (i.e. `src/testing.js`).

- [ ] **Step 1: Write the failing test**

```js
// append to test/verify.test.js
import { verify as verifyFromEntry } from "../src/testing.js";

test("verify is exported from the partforge/testing entry", () => {
  expect(typeof verifyFromEntry).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify.test.js`
Expected: FAIL — `verify` not exported from `src/testing.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/testing.js`:

```js
export { verify } from "./testing/verify.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/testing.js test/verify.test.js
git commit -m "feat: export verify from partforge/testing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: CLI integration (`partforge measure` runs verify + gates exit)

**Files:**
- Modify: `bin/cli.js`
- Create: `test/fixtures/bad-verify-part.js`
- Test: `test/verify-cli.test.js`

**Interfaces:**
- Consumes: `verify` from `../src/testing/verify.js`.
- Produces: `partforge measure <part>` also runs `verify` when the part has a `verify` block or `--process <name>` is passed (suppress with `--no-verify`); prints a checks block; folds the verify result into the written JSON under `report.verify`; exits non-zero if facts `ok` is false **or** any verify gate fails.

- [ ] **Step 1: Write the failing test**

```js
// test/verify-cli.test.js
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll } from "vitest";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });
afterAll(() => {
  rmSync("measure-spacer-spacer.json", { force: true });
  rmSync("measure-bad-v.json", { force: true });
});

test("measure --process runs verify, prints checks, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js", "--process", "fdm-pla"]);
  expect(out).toMatch(/verify/);
  expect(out).toMatch(/⚠/);            // min-wall warning
  expect(out).toMatch(/all gates passed/);
});

test("measure exits 1 when a verify gate fails", () => {
  try {
    run(["measure", "test/fixtures/bad-verify-part.js"]);
    throw new Error("expected non-zero exit");
  } catch (e) {
    expect(e.status).toBe(1);
    expect(String(e.stdout)).toMatch(/✗/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify-cli.test.js`
Expected: FAIL — no verify output / fixture missing.

- [ ] **Step 3: Write minimal implementation**

Create `test/fixtures/bad-verify-part.js`:

```js
// A deliberately-failing part: it has one bore (genus 1) but asserts two.
export default {
  meta: { title: "Bad", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (k) => k.cylinder(10, 10, 10).cut(k.cylinder(3, 3, 14).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { expect: { block: { holes: 2 } } },
};
```

In `bin/cli.js`, add the import near the other testing imports:

```js
import { verify } from "../src/testing/verify.js";
```

Replace the `if (cmd === "measure") { ... }` block's body with:

```js
    if (cmd === "measure") {
      const report = measure(kernel, part, view);
      printMeasure(report);
      let vok = true;
      const processFlag = typeof flags.process === "string" ? flags.process : undefined;
      if ((part.verify || processFlag) && !flags["no-verify"]) {
        const v = verify(kernel, part, { process: processFlag, view });
        printVerify(v);
        report.verify = v;
        vok = v.ok;
      }
      const file = `measure-${slug(report.part)}-${report.view}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`\nwrote ${file}`);
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok && vok ? 0 : 1);
    } else {
```

Add `printVerify` next to `printMeasure` at the bottom of `bin/cli.js`:

```js
function printVerify(v) {
  console.log(`\nverify:`);
  for (const c of v.cases) {
    console.log(`  ${c.name}`);
    for (const ch of c.checks) {
      const icon = ch.status === "pass" ? "✓" : ch.status === "fail" ? "✗" : ch.status === "warn" ? "⚠" : "·";
      console.log(`    ${icon} ${ch.subpart ?? "_view"} ${ch.metric} ${ch.expr}  (${ch.message})`);
    }
  }
  const f = v.failures.length, w = v.warnings.length;
  console.log(`  result: ${f ? `${f} gate failure(s)` : "all gates passed"}${w ? `, ${w} warning(s)` : ""}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify-cli.test.js test/cli.test.js`
Expected: PASS (new verify CLI tests and the existing CLI tests still green).

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/fixtures/bad-verify-part.js test/verify-cli.test.js
git commit -m "feat: partforge measure runs verify and gates the exit code

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Worked `verify` block on demo + docs

**Files:**
- Modify: `src/parts/demo.js`
- Modify: `docs/AUTHORING-PARTS.md`
- Test: `test/verify.test.js`

**Interfaces:**
- Produces: a reference `verify` block on the demo spacer that passes across defaults + both presets; an "Self-verification" docs section.

- [ ] **Step 1: Write the failing test**

```js
// append to test/verify.test.js
import demo from "../src/parts/demo.js";

test("the demo part ships a passing verify block", () => {
  const v = verify(k, demo);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "M3", "M5"]);
  expect(v.warnings.some((w) => w.metric === "minWall")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/verify.test.js`
Expected: FAIL — `demo` has no `verify` block, so `v.warnings` is empty (no profile → no min-wall warn) and/or cases differ.

- [ ] **Step 3: Write minimal implementation**

Add a `verify` block to `src/parts/demo.js` (top-level key, e.g. after `views`):

```js
  // Self-verification (see docs/AUTHORING-PARTS.md "Self-verification"): opt into the
  // FDM-PLA process profile (bed-fit gate + min-wall warning) and pin the design intent
  // — one through-bore, fits comfortably on the bed, no interpenetration.
  verify: {
    process: "fdm-pla",
    expect: {
      spacer: { holes: 1, bbox: "<=[60,60,60]" },
      _view: { overlaps: 0 },
    },
  },
```

Add a "Self-verification" section to `docs/AUTHORING-PARTS.md` (after the "Verifying a part headlessly" section). Use this content:

````markdown
## Self-verification (the `verify` block)

A part can declare how it should be checked, co-located with its schema, so
`partforge measure` (and vitest) can prove it is both **printable** and **correct**.
Add an optional top-level `verify` block:

```js
verify: {
  process: "fdm-pla",            // a DFM profile: fdm-pla | fdm-petg | resin, or an
                                  // inline { bed:[x,y,z], minWall, clearance } object
  cases: ["defaults", "M3"],     // optional; default = defaults + every preset
  expect: {                      // design intent, by sub-part name (+ "_view")
    spacer: { holes: 1, bbox: "<=[60,60,60]", volume: "0.4..0.6cm3" },
    _view:  { overlaps: 0 },
  },
}
```

**What the profile gives you:** a hard **bed-fit** gate (the view bbox must fit `bed`)
and a **min-wall** warning. **What `expect` gives you:** per-sub-part assertions on the
facts `measure` already reports — `holes` (through-bores / genus), `volume`,
`surfaceArea`, `triangleCount`, `bbox`, `watertight`, `minWall`; and `_view` assertions
`bbox`, `volume`, `overlaps`.

**Assertion DSL:** a bare number means equality (`holes: 1`); `">=n"`, `"<=n"`, `">n"`,
`"<n"`, or a range `"a..b"`; an optional unit suffix `mm`/`cm`/`mm3`/`cm3`; and for
`bbox`, a componentwise vector `"<=[x,y,z]"` / `">=[x,y,z]"` where `*` skips an axis.
The parser is strict — a malformed assertion fails loudly.

**Gates vs. warnings:** exact facts are **gates** (a failure sets a non-zero exit code);
`minWall` is always a **warning** (reported, never fails) — and is **not yet computed**
(it reports "pending SDF" until the voxel/SDF measurement lands). `holes`/`watertight`
are Manifold-only, so those assertions **skip** on OCCT parts rather than fail.

**Running it:**

```bash
npx partforge measure src/parts/<part>.js          # auto-runs verify if a block exists
npx partforge measure src/parts/<part>.js --process resin   # force/override a profile
npx partforge measure src/parts/<part>.js --no-verify       # facts only
```

…and in vitest:

```js
import { verify } from "partforge/testing";
test("part is printable and correct", () => {
  expect(verify(kernel, part).ok).toBe(true);
});
```

Checks run across the **default config plus every preset** (or your `cases` list); a
preset that changes only parameters no on-screen sub-part reads is deduplicated, so
coverage is cheap.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/verify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parts/demo.js docs/AUTHORING-PARTS.md test/verify.test.js
git commit -m "docs: worked verify block on demo + Self-verification guide

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Full-suite green + spec status update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-28-dfm-and-self-verify-design.md`

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS — all files, no regressions.

- [ ] **Step 2: Update the spec status note**

In the spec header, append a status line recording that the verify-engine + DSL slice is implemented and the SDF/min-wall slice remains pending:

```markdown
**Status:** Approved (design). Verify engine + DSL slice implemented
(2026-06-28); voxel/SDF core + min-wall computation pending (next plan).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-28-dfm-and-self-verify-design.md
git commit -m "docs: mark verify-engine slice implemented; SDF slice pending

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred to the next plan (SDF / min-wall slice)

Out of scope here, tracked so nothing is lost:

- `src/testing/sdf.js` — the modular voxel/SDF core (`buildSDF(mesh, opts)` with
  `sample()`), narrow-band distance + watertight sign.
- Real min-wall computation consuming the SDF (medial-ridge, sheet-vs-edge), wired into
  `measure()` behind the `opts.minWall` seam reserved in Task 5; promotes the `minWall`
  field from `null` to a value (the warn checks then report real numbers).
- The spike evaluation (accuracy on fixtures + timing vs a ray/shot baseline) and the
  go/no-go decision.
- Later SDF consumers: clearance/gap gate, min-feature size.
