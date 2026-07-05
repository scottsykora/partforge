# Structured Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every failure from `partforge measure`/`verify` carries cause + location + corrective hint (and an ERROR-PATTERNS.md ID where one applies), machine-readable, per the approved spec `docs/superpowers/specs/2026-07-04-structured-diagnostics-design.md` (issue #27).

**Architecture:** Hints/pattern-IDs/locate functions ride the existing metric registries in `src/testing/verify.js`; the fence-aware ERROR-PATTERNS.md parser moves out of the #28 lint test into a shared `src/testing/error-patterns.js` module whose `matchPattern()` the CLI crash path uses. Locations flow from where they're already computed (`min-wall.js`) or are one `boundingBox().center` call away (`assembly.js`).

**Tech Stack:** Node 24 ESM, vitest, Manifold WASM kernel (no new dependencies).

## Global Constraints

- **Node 24 required** — run `nvm use` in the repo root before any install/test/CLI command, or WASM boot fails confusingly.
- All code is plain ESM; part modules and `src/testing/*` stay DOM-free.
- **Exit-code semantics unchanged**: `measure` exits 0 on pass, 1 on gate failure or crash.
- **The diagnostics layer must never throw**: any internal error in pattern loading/matching degrades to "no pattern attached", never a crashed `measure`.
- `minWall` in subpart facts **stays a number** (the assertion DSL compares plain numbers); the location is a sibling `minWallAt`.
- ERROR-PATTERNS.md IDs are permanent; code cites them as `ERROR-PATTERNS.md#<id>`.
- Work happens on the existing `structured-diagnostics` branch.
- Run a task's test file with: `npx vitest run test/<file>.test.js`; full suite: `npm test`.

---

### Task 1: Shared ERROR-PATTERNS parser + matcher (`src/testing/error-patterns.js`)

**Files:**
- Create: `src/testing/error-patterns.js`
- Modify: `test/error-patterns.test.js` (delete its inline `parse`, import the shared one; add matcher tests)

**Interfaces:**
- Produces: `parsePatterns(md) → [{ id, section, body, symptom, fix, symptomStrings }]`; `loadPatterns() → patterns | null` (cached; null on any read error); `matchPattern(message, patterns?) → { id, fix } | null`. Tasks 4 uses `matchPattern`; Task 3's lint additions use `parsePatterns` output already loaded in the test.

- [ ] **Step 1: Write the failing matcher tests** — append to `test/error-patterns.test.js`:

```js
import { parsePatterns, matchPattern } from "../src/testing/error-patterns.js";

describe("matchPattern", () => {
  const md = [
    "# Core framework",
    "## short-string",
    "- **Symptom:** `boom` everywhere.",
    "- **Cause:** x.",
    "- **Fix:** do the short fix.",
    "## long-string",
    "- **Symptom:** `boom in the geometry worker` on build.",
    "- **Cause:** y.",
    "- **Fix:** do the long fix.",
  ].join("\n");
  const patterns = parsePatterns(md);

  test("parses symptom strings and fix text", () => {
    expect(patterns[1].symptomStrings).toEqual(["boom in the geometry worker"]);
    expect(patterns[1].fix).toBe("do the long fix.");
  });

  test("longest matching symptom string wins", () => {
    const m = matchPattern("Error: boom in the geometry worker (job 3)", patterns);
    expect(m).toEqual({ id: "long-string", fix: "do the long fix." });
  });

  test("symptom strings under 6 chars never match (guards generic backticks)", () => {
    expect(matchPattern("boom", patterns)).toBeNull();
  });

  test("no match, null patterns, and non-string messages return null, never throw", () => {
    expect(matchPattern("totally unrelated", patterns)).toBeNull();
    expect(matchPattern("anything", null)).toBeNull();
    expect(matchPattern(undefined, patterns)).toBeNull();
  });

  test("matches a real thrown string from the live doc", () => {
    // assert-dsl.js throws `assertion: unrecognized form: "…"`; if no live entry
    // covers it yet this test documents the gap — match against the real doc and
    // accept either null or a { id, fix } shape, but never a throw.
    const m = matchPattern('assertion: unrecognized form: "wat"', parsePatterns(doc));
    expect(m === null || (typeof m.id === "string" && typeof m.fix === "string")).toBe(true);
  });
});
```

Also replace the test file's inline parser: delete its local `function parse(md) {…}` block and change `const entries = parse(doc);` to `const entries = parsePatterns(doc);` (the parsed entries keep `id`/`section`/`body`, so every existing assertion still works).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/error-patterns.test.js`
Expected: FAIL — `Cannot find module '../src/testing/error-patterns.js'`

- [ ] **Step 3: Create `src/testing/error-patterns.js`**

```js
// Shared parser + matcher for docs/ERROR-PATTERNS.md — the symptom-indexed
// error→pattern library (issue #28). The parser here is the single source of
// truth: the format lint (test/error-patterns.test.js) and the CLI crash-path
// matcher (issue #27) both import it. Contract: partforge code that throws must
// throw strings appearing verbatim, in backticks, in some entry's Symptom line —
// that is what matchPattern matches on.
import { readFileSync } from "node:fs";

// Single-pass, fence-aware parse: a heading inside a ``` / ~~~ fence is quoted
// content, not structure. Each `## <id>` entry records the `# <section>` it sits
// under; its body runs to the next h1/h2 heading. (Moved verbatim from the lint
// test, then enriched with symptom/fix extraction.)
export function parsePatterns(md) {
  const entries = [];
  let section = null;
  let entry = null;
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (entry) entry.body += line + "\n";
      continue;
    }
    if (!inFence) {
      const h1 = line.match(/^# (.+)$/);
      const h2 = line.match(/^## (.+)$/);
      if (h1) { section = h1[1]; entry = null; continue; }
      if (h2) { entry = { id: h2[1], section, body: "" }; entries.push(entry); continue; }
    }
    if (entry) entry.body += line + "\n";
  }
  const field = (body, label) => {
    const i = body.indexOf(`- **${label}:**`);
    return i < 0 ? null : body.slice(i).split("\n")[0].replace(`- **${label}:**`, "").trim();
  };
  return entries.map((e) => {
    const symptom = field(e.body, "Symptom");
    return {
      ...e,
      symptom,
      fix: field(e.body, "Fix"),
      symptomStrings: symptom ? [...symptom.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : [],
    };
  });
}

// Cached read of the live doc, resolved relative to this module so it works from
// a consuming app's node_modules too. Any read/parse error → null (callers treat
// that as "no patterns available", never an error).
let cached;
export function loadPatterns() {
  if (cached !== undefined) return cached;
  try {
    cached = parsePatterns(readFileSync(new URL("../../docs/ERROR-PATTERNS.md", import.meta.url), "utf8"));
  } catch {
    cached = null;
  }
  return cached;
}

// First-line symptom literals ≥ 6 chars, longest match wins. Never throws.
export function matchPattern(message, patterns = loadPatterns()) {
  if (!patterns || typeof message !== "string") return null;
  let best = null;
  let bestLen = 5;
  for (const p of patterns) {
    for (const s of p.symptomStrings) {
      if (s.length > bestLen && message.includes(s)) { best = p; bestLen = s.length; }
    }
  }
  return best ? { id: best.id, fix: best.fix } : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/error-patterns.test.js`
Expected: PASS (all pre-existing lint tests + the new matcher block)

- [ ] **Step 5: Commit**

```bash
git add src/testing/error-patterns.js test/error-patterns.test.js
git commit -m "feat: shared ERROR-PATTERNS parser + crash-message matcher (#27)"
```

---

### Task 2: Locations in measure/assembly (`minWallAt`, overlap `location`)

**Files:**
- Modify: `src/testing/measure.js:31` (min-wall), `src/framework/assembly.js:19-23` (overlaps)
- Create: `test/diagnostics-locations.test.js`

**Interfaces:**
- Consumes: `minWall(mesh) → { value, location } | null` (already exists in `src/testing/min-wall.js`); `Solid.boundingBox() → { min, max, center, size }` (kernel API).
- Produces: subpart facts gain `minWallAt: [x,y,z] | null`; overlap entries become `{ a, b, volume, location: [x,y,z] }`. Task 3's `locate` functions read both.

- [ ] **Step 1: Write the failing tests** — create `test/diagnostics-locations.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/testing/measure.js";
import thin from "./fixtures/thin-wall-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("measure reports minWallAt alongside the minWall value", () => {
  const r = measure(k, thin, "v", {}, { minWall: true });
  const ring = r.subparts.find((s) => s.name === "ring");
  expect(ring.minWall).toBeGreaterThan(0.4);   // the fixture's 0.6 mm wall
  expect(ring.minWall).toBeLessThan(0.8);
  expect(ring.minWallAt).toHaveLength(3);
  const radius = Math.hypot(ring.minWallAt[0], ring.minWallAt[1]);
  expect(radius).toBeGreaterThan(3);            // sample sits on the tube wall…
  expect(radius).toBeLessThan(4.5);             // …not in the bore or outside
});

test("minWallAt is null when min-wall measurement is off", () => {
  const r = measure(k, thin, "v", {}, {});
  expect(r.subparts[0].minWall).toBeNull();
  expect(r.subparts[0].minWallAt).toBeNull();
});

const overlapping = {
  meta: { title: "Overlap", units: "mm" },
  defaults: {},
  parts: {
    a: { views: ["v"], build: (k) => k.box([0, 0, 0], [10, 10, 10]) },
    b: { views: ["v"], build: (k) => k.box([8, 0, 0], [18, 10, 10]) },
  },
  views: { v: { label: "V" } },
};

test("overlap entries carry the intersection-region center", () => {
  const r = measure(k, overlapping, "v");
  expect(r.ok).toBe(false);
  expect(r.overlaps).toHaveLength(1);
  const o = r.overlaps[0];
  expect(o.volume).toBeCloseTo(200, 0);      // the 2×10×10 mm shared slab
  expect(o.location[0]).toBeCloseTo(9, 1);   // slab center x (8..10)
  expect(o.location[1]).toBeCloseTo(5, 1);
  expect(o.location[2]).toBeCloseTo(5, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/diagnostics-locations.test.js`
Expected: FAIL — `minWallAt` is `undefined`; overlap entries have no `location`

- [ ] **Step 3: Implement.** In `src/testing/measure.js`, the subparts map currently ends with:

```js
      minWall: opts.minWall ? (minWall(mesh)?.value ?? null) : null,
```

Replace the map callback's body so the min-wall result is read once:

```js
  const subparts = built.map(({ name, solid, mesh }) => {
    const b = bounds(mesh.positions);
    subBounds.push(b);
    const mw = opts.minWall ? minWall(mesh) : null;
    return {
      name,
      bbox: size(b),
      volume: solid.volume(),
      surfaceArea: meshArea(mesh.positions, mesh.indices),
      triangleCount: mesh.triangles,
      watertight: typeof solid.isEmpty === "function" ? !solid.isEmpty() : null,
      holes: typeof solid.genus === "function" ? solid.genus() : null,
      minWall: mw?.value ?? null,
      minWallAt: mw?.location ?? null,
    };
  });
```

In `src/framework/assembly.js`, the pair loop currently reads:

```js
      const volume = posed[i].solid.intersect(posed[j].solid).volume();
      if (volume > tolerance) overlaps.push({ a: posed[i].name, b: posed[j].name, volume });
```

Replace with (and update the doc comment's shape line to `→ [{ a, b, volume, location }]`):

```js
      const inter = posed[i].solid.intersect(posed[j].solid);
      const volume = inter.volume();
      if (volume > tolerance) {
        overlaps.push({ a: posed[i].name, b: posed[j].name, volume, location: inter.boundingBox().center });
      }
```

- [ ] **Step 4: Run to verify pass, plus the neighbors that consume these shapes**

Run: `npx vitest run test/diagnostics-locations.test.js test/measure.test.js test/measure-occt.test.js test/verify.test.js`
Expected: PASS (existing tests assert `overlaps` equality on the *empty* array and never enumerate subpart keys, so the added fields don't break them — if one does fail, fix the assertion to include the new field, not the code)

- [ ] **Step 5: Commit**

```bash
git add src/testing/measure.js src/framework/assembly.js test/diagnostics-locations.test.js
git commit -m "feat: min-wall and overlap locations in measure reports (#27)"
```

---

### Task 3: Registry hints + part-authored `{ expr, hint }` in verify

**Files:**
- Modify: `src/testing/verify.js` (registries, `check()`, `evaluateCase()`)
- Modify: `test/verify.test.js` (new cases), `test/error-patterns.test.js` (two lint additions)

**Interfaces:**
- Consumes: `minWallAt` / overlap `location` from Task 2.
- Produces: exported `SUBPART_METRICS` and `VIEW_METRICS` (for the lint test); check objects gain optional `hint` / `pattern` / `location` on non-pass statuses; `verify.expect.<subpart>.<metric>` and `verify.expect._view.<metric>` accept `{ expr, hint }`. Task 4 prints these fields; the report contract in Task 5 documents them.

- [ ] **Step 1: Write the failing tests** — append to `test/verify.test.js`:

```js
const factsThin = {
  subparts: [{ name: "ring", holes: 1, volume: 500, surfaceArea: 300, triangleCount: 200,
    bbox: [8, 8, 10], watertight: true, minWall: 0.8, minWallAt: [3.7, 0, 5] }],
  aggregate: { bbox: [8, 8, 10], volume: 500 },
  overlaps: [],
};

test("a failed check carries registry hint, pattern, and location", () => {
  const checks = evaluateCase(factsThin, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.hint).toMatch(/wall/);
  expect(w.pattern).toBe("minwall-sliver-triangles");
  expect(w.location).toEqual([3.7, 0, 5]);
});

test("part-authored { expr, hint } wins over the registry hint (pattern still applies)", () => {
  const checks = evaluateCase(factsThin, { profile: null,
    expect: { ring: { minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" } } } });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.expr).toBe(">=1.2");
  expect(w.hint).toBe("increase `wallThickness` or reduce `twist`");
  expect(w.pattern).toBe("minwall-sliver-triangles");
});

test("passing checks carry no diagnostic noise", () => {
  const checks = evaluateCase(factsThin, { profile: null, expect: { ring: { holes: 1 } } });
  const c = byKey(checks, "subpart", "holes");
  expect(c.status).toBe("pass");
  expect(c.hint).toBeUndefined();
  expect(c.pattern).toBeUndefined();
  expect(c.location).toBeUndefined();
});

test("a failing view overlaps gate locates the first offending pair", () => {
  const facts2 = { ...factsThin, overlaps: [{ a: "a", b: "b", volume: 200, location: [9, 5, 5] }] };
  const checks = evaluateCase(facts2, { profile: null, expect: { _view: { overlaps: 0 } } });
  const c = byKey(checks, "view", "overlaps");
  expect(c.status).toBe("fail");
  expect(c.hint).toMatch(/clearance|placement/);
  expect(c.location).toEqual([9, 5, 5]);
});

test("min-wall-unavailable warn still carries a hint", () => {
  const noReading = { ...factsThin, subparts: [{ ...factsThin.subparts[0], minWall: null, minWallAt: null }] };
  const checks = evaluateCase(noReading, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/unavailable/);
  expect(w.hint).toBeTruthy();
});
```

And append to `test/error-patterns.test.js` (inside the existing describe, after the anchors test — `entries` is already in scope):

```js
  test("every verify registry metric has a hint (report contract: hint on every fail/warn)", async () => {
    const { SUBPART_METRICS, VIEW_METRICS } = await import("../src/testing/verify.js");
    for (const [name, reg] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
      expect(typeof reg.hint, `${name}: missing registry hint`).toBe("string");
    }
  });

  test("every pattern ID cited by the verify registries resolves", async () => {
    const { SUBPART_METRICS, VIEW_METRICS } = await import("../src/testing/verify.js");
    const ids = new Set(entries.map((e) => e.id));
    for (const [name, reg] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
      if (reg.pattern) expect(ids.has(reg.pattern), `${name}: dangling pattern "${reg.pattern}"`).toBe(true);
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/verify.test.js test/error-patterns.test.js`
Expected: FAIL — no `hint` on checks; `SUBPART_METRICS` not exported

- [ ] **Step 3: Implement in `src/testing/verify.js`.** Replace the two registry consts (keeping every existing `kind`/`manifoldOnly`/`extract` exactly as-is) with exported, hint-carrying versions:

```js
// Metric registry: name → how to pull the value out of facts, whether a failure
// is a hard gate or a warning, and the diagnostics attached to a non-pass check:
// `hint` (required — the report contract promises one on every fail/warn),
// `pattern` (optional stable ERROR-PATTERNS.md#<id>), `locate` (optional
// [x,y,z] source). `manifoldOnly` facts are null on OCCT parts.
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
    hint: "sub-parts interpenetrate at the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
};
```

Add the expectation normalizer above `check()`:

```js
// An expectation is a bare expression (string/number/boolean) or { expr, hint }.
const normalizeExpectation = (spec) =>
  spec !== null && typeof spec === "object" && !Array.isArray(spec) && "expr" in spec
    ? { expr: spec.expr, hint: spec.hint }
    : { expr: spec, hint: undefined };
```

Replace `check()` (same call sites — only the fourth argument's meaning widens):

```js
function check(scope, subpart, metric, spec, registry, factsObj) {
  const reg = registry[metric];
  if (!reg) throw new Error(`unknown ${scope} metric "${metric}"${subpart ? ` on sub-part "${subpart}"` : ""}`);
  const { expr, hint: partHint } = normalizeExpectation(spec);
  const actual = reg.extract(factsObj);
  const base = { scope, subpart, metric, kind: reg.kind, expr: String(expr) };
  if (actual === null || actual === undefined) {
    if (reg.manifoldOnly) return { ...base, actual, status: "skip", pass: null, message: "n/a (OCCT backend)" };
    if (metric === "minWall") {
      return { ...base, actual, status: "warn", pass: null, message: "min wall unavailable",
        hint: partHint ?? "no min-wall reading for this mesh — treat thin features as unverified" };
    }
    return { ...base, actual, status: "skip", pass: null, message: "unavailable" };
  }
  const { pass, message } = evaluateAssertion(parseAssertion(expr), actual);
  const status = pass ? "pass" : reg.kind === "warn" ? "warn" : "fail";
  const out = { ...base, actual, status, pass, message };
  if (!pass) {
    out.hint = partHint ?? reg.hint;
    if (reg.pattern) out.pattern = reg.pattern;
    const loc = reg.locate?.(factsObj);
    if (loc) out.location = loc;
  }
  return out;
}
```

`evaluateCase` needs no change — it already passes each merged expectation value straight through as `check()`'s fourth argument, and `{ expr, hint }` values ride along. (The `expectMentionsMinWall` scan in `verify()` also keeps working: it checks key presence, not value shape.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/verify.test.js test/error-patterns.test.js test/verify-cases.test.js test/dfm-profiles.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/testing/verify.js test/verify.test.js test/error-patterns.test.js
git commit -m "feat: registry hints, pattern IDs, and part-authored {expr,hint} in verify (#27)"
```

---

### Task 4: CLI crash contract + diagnostic printers

**Files:**
- Modify: `bin/cli.js`
- Modify: `test/cli.test.js` (new cases)

**Interfaces:**
- Consumes: `matchPattern` from Task 1; check `hint`/`pattern`/`location` from Task 3; overlap `location` from Task 2.
- Produces: `--json` crash output `{ ok: false, error: { message, pattern?, hint? } }` on stdout, exit 1; human printers append `at [x, y, z]` / `hint: … (ERROR-PATTERNS.md#id)` lines.

- [ ] **Step 1: Write the failing tests** — append to `test/cli.test.js`:

```js
const runFail = (args) => {
  try { run(args); } catch (e) { return e; }
  throw new Error("expected non-zero exit");
};

test("measure --json crash contract: structured JSON on stdout, exit 1", () => {
  const err = runFail(["measure", "test/fixtures/no-such-part.js", "--json"]);
  const payload = JSON.parse(`${err.stdout}`);   // stdout is PURE JSON on the crash path
  expect(payload.ok).toBe(false);
  expect(payload.error.message).toMatch(/cannot load part/);
});

test("measure crash without --json keeps the human message on stderr", () => {
  const err = runFail(["measure", "test/fixtures/no-such-part.js"]);
  expect(`${err.stderr}`).toMatch(/measure failed: cannot load part/);
});

test("failing verify checks carry hints in the written report", () => {
  const err = runFail(["measure", "test/fixtures/bad-verify-part.js", "--out", `${OUT}/bad.json`]);
  const report = JSON.parse(readFileSync(`${OUT}/bad.json`, "utf8"));
  expect(report.verify.failures.length).toBeGreaterThan(0);
  for (const f of report.verify.failures) expect(f.hint, `${f.metric} lacks a hint`).toBeTruthy();
});

test("human verify output appends hint lines on failures", () => {
  const err = runFail(["measure", "test/fixtures/bad-verify-part.js"]);
  expect(`${err.stdout}`).toMatch(/hint: /);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cli.test.js`
Expected: FAIL — crash path prints bare text (no JSON), no `hint:` lines

- [ ] **Step 3: Implement in `bin/cli.js`.**

Add the import and crash helper (after the existing imports / `die`):

```js
import { matchPattern } from "../src/testing/error-patterns.js";

// Crash contract (issue #27): with --json, a thrown error becomes structured
// stdout JSON; either way the message is matched against ERROR-PATTERNS.md and
// the pattern's fix is surfaced. Exit 1 always. NOTE: on the crash path nothing
// else has been printed yet, so --json stdout is pure JSON.
function crash(cmd, e, jsonMode) {
  const message = e?.message || String(e);
  const m = matchPattern(message);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: { message, ...(m && { pattern: m.id, hint: m.fix }) } }, null, 2));
  } else {
    console.error(`${cmd} failed: ${message}`);
    if (m) console.error(`pattern: ERROR-PATTERNS.md#${m.id} — ${m.fix}`);
  }
  process.exit(1);
}
```

Make `loadPart` throw instead of dying on load errors, so crashes reach the caller's catch (usage errors still `die` — they're arg mistakes, not crashes):

```js
async function loadPart(partPath, usage) {
  if (!partPath) die(usage);
  const mod = await import(pathToFileURL(resolve(process.cwd(), partPath)))
    .catch((e) => { throw new Error(`cannot load part "${partPath}": ${e.message}`); });
  const part = mod.default;
  if (!part?.parts || !part?.views) throw new Error(`"${partPath}" has no default-exported PartDefinition`);
  return part;
}
```

In `commands.measure`, move `loadPart`/`bootKernel` inside the try and route the catch through `crash` (replacing `die(\`measure failed: …\`)`):

```js
    try {
      const part = await loadPart(partPath, usage);
      const kernel = await bootKernel(part);
      const report = measure(kernel, part, view);
      // …existing body unchanged from here…
    } catch (e) {
      crash("measure", e, !!flags.json);
    }
```

In `commands.render`, likewise move `loadPart`/`bootKernel` inside its try, and change its catch to `crash("render", e, false)` (render has no `--json`; it gains the pattern line for free).

In `printMeasure`, extend the overlaps line to include locations:

```js
  console.log(`  overlaps: ${r.overlaps.length
    ? r.overlaps.map((o) => `${o.a}×${o.b} (${o.volume.toFixed(1)}mm³ at [${o.location.map((n) => n.toFixed(1)).join(", ")}])`).join(", ")
    : "none"}`);
```

In `printVerify`, after the existing per-check `console.log`, append the diagnostics lines:

```js
      console.log(`    ${icon} ${ch.subpart ?? "_view"} ${ch.metric} ${ch.expr}  (${ch.message})`);
      if (ch.status === "fail" || ch.status === "warn") {
        if (ch.location) console.log(`        at [${ch.location.map((n) => n.toFixed(1)).join(", ")}]`);
        if (ch.hint) console.log(`        hint: ${ch.hint}${ch.pattern ? ` (ERROR-PATTERNS.md#${ch.pattern})` : ""}`);
      }
```

- [ ] **Step 4: Run to verify pass, plus every CLI-adjacent suite**

Run: `npx vitest run test/cli.test.js test/cli-occt.test.js test/verify-cli.test.js test/pick-cli.test.js`
Expected: PASS (verify-cli asserts on exit codes and gate lines, which are unchanged; if a stdout regex in it breaks on the new `hint:` lines, loosen that assertion, not the printer)

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/cli.test.js
git commit -m "feat: structured --json crash contract + hint/location lines in CLI output (#27)"
```

---

### Task 5: Document the agent contract

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (the "Verifying a part headlessly" section)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–4. Produces: the documented report shape agents (and partforge-cloud later) code against.

- [ ] **Step 1: Add the contract subsection.** In `docs/AUTHORING-PARTS.md`, inside the section that documents `partforge measure` / the `verify` block, append:

```markdown
### The diagnostics contract (for agents)

`partforge measure <part> --json` / `--out <file>` emits the machine-readable
report. Every `fail`/`warn` check in `verify.failures` / `verify.warnings`
carries:

- `hint` — one self-contained corrective sentence (always present),
- `pattern` — a stable [ERROR-PATTERNS.md](ERROR-PATTERNS.md) entry ID when one
  applies (follow it with `ERROR-PATTERNS.md#<id>`),
- `location` — `[x, y, z]` in mm where the metric has one: `minWall` (thinnest
  sample point) and `overlaps` (center of the first offending intersection).
  Whole-solid metrics (bbox, volume, …) have none.

Subpart facts include `minWall` (number) and `minWallAt` (`[x,y,z]` or `null`);
overlap entries are `{ a, b, volume, location }`.

A **thrown** error (bad part module, kernel failure) with `--json` prints pure
JSON to stdout and exits 1:

​```json
{ "ok": false, "error": { "message": "…", "pattern": "<id>", "hint": "…" } }
​```

`pattern`/`hint` appear when the message matches an ERROR-PATTERNS.md symptom
string. Exit codes: 0 pass, 1 gate failure or crash — unchanged.

**Part-authored hints.** Any `verify.expect` metric accepts `{ expr, hint }` in
place of a bare expression — use it to name the governing parameter:

​```js
verify: {
  expect: {
    body: { minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" } },
  },
}
​```
```

(Remove the zero-width characters before the inner code fences when pasting — they exist only to nest the fences in this plan.)

- [ ] **Step 2: Verify the lint still passes** (it greps citing docs for `ERROR-PATTERNS.md#<id>` anchors; this section adds none that must resolve, but run it anyway)

Run: `npx vitest run test/error-patterns.test.js`
Expected: PASS

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS (all files)

- [ ] **Step 4: Commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -m "docs: diagnostics report contract for agents (#27)"
```
