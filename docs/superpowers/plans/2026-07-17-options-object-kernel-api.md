# Options-Object Kernel Calling Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make options-object calls (`k.cylinder({d: 8, h: 10})`) the canonical form for every multi-parameter kernel/Solid op, with legacy positional silently accepted until contract v2.

**Architecture:** A new pure module `op-options.js` holds per-op normalizers (options object → positional argument list) plus key validation with did-you-mean errors. `finishKernel()` (kernel-front.js) and `addSugar()` (solid-sugar.js) — the two existing backend-agnostic seams — apply them, so both backends, the solid cache, and the probe are covered without touching backend internals. Parts, tests, and docs then migrate to the options form.

**Tech Stack:** Plain ESM JavaScript, vitest, Manifold + OCCT WASM backends (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-17-options-object-kernel-api-design.md` — read it first; it is the authority on canonical forms and error messages.

## Global Constraints

- **Node 24 required:** run `nvm use` in the repo root before any npm/vitest command, or WASM tests fail confusingly.
- Work on branch `options-object-api` (already created). Commit after every task; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do NOT touch the untracked `embed-test.html` / `src/app-embed-test.js` — they belong to another session.
- OCCT and Manifold must never boot in the same test file (vitest isolates per file).
- `CONTRACT_VERSION` in `src/framework/geometry/kernel.js` stays **1** — this change is additive.
- Detection rule (normative): a call is options form ⇔ the op receives **exactly one argument and it is a plain object** (prototype is `Object.prototype` or `null`) — never an Array, Solid, or typed array.
- Error messages are contract surface: use the exact strings written in this plan (ERROR-PATTERNS.md greps them verbatim).
- Full suite gate for every task: `npx vitest run` → all green.

---

### Task 1: op-options.js — detection, key checking, cylinder/sphere/box normalizers

**Files:**
- Create: `src/framework/geometry/op-options.js`
- Test: `test/op-options.test.js`

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces: `isPlainOptions(x) -> boolean`; `cylinderArgs(o) -> [rBottom, rTop, h, {center}?]`; `sphereArgs(o) -> [r]`; `boxArgs(o) -> [min, max]`. Internal helpers `checkKeys(op, o, valid)`, `req(op, o, key)`, `tail(o, keys)` are used by Task 2's normalizers in the same file.

- [ ] **Step 1: Write the failing tests**

```js
// test/op-options.test.js
// Pure unit tests for the options-object normalizers — no WASM, no kernel boot.
import { expect, test } from "vitest";
import { isPlainOptions, cylinderArgs, sphereArgs, boxArgs } from "../src/framework/geometry/op-options.js";

test("isPlainOptions accepts plain objects only", () => {
  expect(isPlainOptions({})).toBe(true);
  expect(isPlainOptions(Object.create(null))).toBe(true);
  expect(isPlainOptions([1, 2, 3])).toBe(false);
  expect(isPlainOptions(null)).toBe(false);
  expect(isPlainOptions(7)).toBe(false);
  expect(isPlainOptions("x")).toBe(false);
  expect(isPlainOptions(new Float32Array(3))).toBe(false);
  class Handle {}
  expect(isPlainOptions(new Handle())).toBe(false);
});

test("cylinderArgs resolves r/d and r1+r2/d1+d2 to [rBottom, rTop, h]", () => {
  expect(cylinderArgs({ r: 4, h: 10 })).toEqual([4, 4, 10]);
  expect(cylinderArgs({ d: 8, h: 10 })).toEqual([4, 4, 10]);
  expect(cylinderArgs({ r1: 3, r2: 1, h: 5 })).toEqual([3, 1, 5]);
  expect(cylinderArgs({ d1: 6, d2: 2, h: 5 })).toEqual([3, 1, 5]);
  expect(cylinderArgs({ r: 4, h: 10, center: true })).toEqual([4, 4, 10, { center: true }]);
});

test("cylinderArgs rejects bad radius vocabulary", () => {
  const BAD = "cylinder: pass exactly one of r/d, or r1+r2 / d1+d2";
  expect(() => cylinderArgs({ r: 4, d: 8, h: 1 })).toThrow(BAD);   // both
  expect(() => cylinderArgs({ h: 1 })).toThrow(BAD);               // neither
  expect(() => cylinderArgs({ r: 4, r1: 1, h: 1 })).toThrow(BAD);  // straight + cone
  expect(() => cylinderArgs({ r1: 1, h: 1 })).toThrow(BAD);        // one cone end
  expect(() => cylinderArgs({ r1: 1, d2: 2, h: 1 })).toThrow(BAD); // mixed cone vocab
  expect(() => cylinderArgs({ r: 4 })).toThrow("cylinder: h is required");
});

test("unknown keys error with a did-you-mean hint", () => {
  expect(() => cylinderArgs({ radius: 4, h: 1 }))
    .toThrow('cylinder: unknown option "radius" — did you mean r?');
  expect(() => cylinderArgs({ height: 4, r: 1 }))
    .toThrow('cylinder: unknown option "height" — did you mean h?');
  // no plausible hint → list valid keys
  expect(() => boxArgs({ frobnicate: 1 }))
    .toThrow('box: unknown option "frobnicate" (valid: size, center, min, max)');
});

test("sphereArgs takes exactly one of r/d", () => {
  expect(sphereArgs({ r: 5 })).toEqual([5]);
  expect(sphereArgs({ d: 10 })).toEqual([5]);
  expect(() => sphereArgs({ r: 5, d: 10 })).toThrow("sphere: pass exactly one of r/d");
  expect(() => sphereArgs({})).toThrow("sphere: pass exactly one of r/d");
});

test("boxArgs: size is centered in X/Y with base at z=0; center:true centers Z too", () => {
  expect(boxArgs({ size: [4, 6, 10] })).toEqual([[-2, -3, 0], [2, 3, 10]]);
  expect(boxArgs({ size: [4, 6, 10], center: true })).toEqual([[-2, -3, -5], [2, 3, 5]]);
  expect(boxArgs({ min: [0, 0, 0], max: [1, 2, 3] })).toEqual([[0, 0, 0], [1, 2, 3]]);
  expect(() => boxArgs({ size: [1, 1, 1], min: [0, 0, 0], max: [1, 1, 1] }))
    .toThrow("box: pass size or min+max, not both");
  expect(() => boxArgs({ min: [0, 0, 0] })).toThrow("box: max is required");
  expect(() => boxArgs({})).toThrow("box: size is required");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/op-options.test.js`
Expected: FAIL — cannot resolve `../src/framework/geometry/op-options.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/framework/geometry/op-options.js
// The options-object calling convention: pure normalizers turning each op's
// canonical options form into the backend's positional argument list, plus the
// detection predicate. Normative rule (KERNEL-CONTRACT.md "Calling convention"):
// a call is options form when the op receives exactly one plain-object argument.
// kernel-front.js and solid-sugar.js apply these at the backend-shared seams, so
// backends stay positional and the Manifold solid cache hashes normalized args —
// both spellings of a call share one cache entry. Geometry-free by design.

export function isPlainOptions(x) {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

// Small capped Levenshtein for did-you-mean hints (distance > 2 reads as "no").
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Prefix match first so long-form names hit their short key (radius→r,
// height→h, diameter→d), then edit distance ≤ 2 for plain typos.
function suggest(key, valid) {
  const lk = key.toLowerCase();
  for (const v of valid) if (lk.startsWith(v.toLowerCase())) return v;
  for (const v of valid) if (editDistance(lk, v.toLowerCase()) <= 2) return v;
  return null;
}

function checkKeys(op, o, valid) {
  for (const key of Object.keys(o)) {
    if (valid.includes(key)) continue;
    const hint = suggest(key, valid);
    throw new Error(`${op}: unknown option ${JSON.stringify(key)}${
      hint ? ` — did you mean ${hint}?` : ` (valid: ${valid.join(", ")})`}`);
  }
}

function req(op, o, key) {
  if (o[key] === undefined) throw new Error(`${op}: ${key} is required`);
  return o[key];
}

// Trailing positional opts object, only if any of `keys` is present — an empty
// options tail must normalize to *no* argument so it hashes identically to the
// bare positional call.
function tail(o, keys) {
  const t = {};
  let any = false;
  for (const key of keys) if (o[key] !== undefined) { t[key] = o[key]; any = true; }
  return any ? [t] : [];
}

export function cylinderArgs(o) {
  checkKeys("cylinder", o, ["r", "d", "r1", "r2", "d1", "d2", "h", "center"]);
  const has = (key) => o[key] !== undefined;
  const straight = has("r") + has("d");
  const coneR = has("r1") + has("r2");
  const coneD = has("d1") + has("d2");
  let rBottom, rTop;
  if (straight === 1 && coneR + coneD === 0) rBottom = rTop = has("r") ? o.r : o.d / 2;
  else if (straight === 0 && coneR === 2 && coneD === 0) { rBottom = o.r1; rTop = o.r2; }
  else if (straight === 0 && coneR === 0 && coneD === 2) { rBottom = o.d1 / 2; rTop = o.d2 / 2; }
  else throw new Error("cylinder: pass exactly one of r/d, or r1+r2 / d1+d2");
  return [rBottom, rTop, req("cylinder", o, "h"), ...tail(o, ["center"])];
}

export function sphereArgs(o) {
  checkKeys("sphere", o, ["r", "d"]);
  const hasR = o.r !== undefined;
  if (hasR === (o.d !== undefined)) throw new Error("sphere: pass exactly one of r/d");
  return [hasR ? o.r : o.d / 2];
}

export function boxArgs(o) {
  checkKeys("box", o, ["size", "center", "min", "max"]);
  if (o.min !== undefined || o.max !== undefined) {
    if (o.size !== undefined || o.center !== undefined)
      throw new Error("box: pass size or min+max, not both");
    return [req("box", o, "min"), req("box", o, "max")];
  }
  const [x, y, z] = req("box", o, "size");
  return o.center === true
    ? [[-x / 2, -y / 2, -z / 2], [x / 2, y / 2, z / 2]]   // centered on all axes
    : [[-x / 2, -y / 2, 0], [x / 2, y / 2, z]];           // canonical: centered X/Y, base at z=0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/op-options.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/op-options.js test/op-options.test.js
git commit -m "feat: options-object normalizers — detection, cylinder/sphere/box"
```

---

### Task 2: op-options.js — remaining factory normalizers + op-spec tables

**Files:**
- Modify: `src/framework/geometry/op-options.js` (append)
- Test: `test/op-options.test.js` (append)

**Interfaces:**
- Consumes: `checkKeys`, `req`, `tail` from Task 1 (same file).
- Produces: `prismArgs`, `extrudeArgs`, `revolveArgs`, `loftArgs`, `sweepArgs` (each `(o) -> positional array`); `KERNEL_OP_SPECS` — `{ [op]: { toArgs, check? } }` for cylinder/sphere/box/prism/extrude/revolve/loft/sweep, where `check(...positionalArgs)` carries the semantic validations currently in kernel-front.js; `SOLID_OP_SPECS` — same shape for fillet/chamfer/shell. Task 3 consumes `KERNEL_OP_SPECS` + `isPlainOptions`; Task 4 consumes `SOLID_OP_SPECS` + `isPlainOptions`.

- [ ] **Step 1: Write the failing tests (append to test/op-options.test.js)**

```js
import { prismArgs, extrudeArgs, revolveArgs, loftArgs, sweepArgs, KERNEL_OP_SPECS, SOLID_OP_SPECS }
  from "../src/framework/geometry/op-options.js";

const TRI = [[0, 0], [10, 0], [0, 10]];

test("prism/extrude normalize with an options tail only when needed", () => {
  expect(prismArgs({ points: TRI, h: 5 })).toEqual([TRI, 5]);            // no empty {} tail
  expect(prismArgs({ points: TRI, h: 5, twist: 30, scaleTop: 0.5 })).toEqual([TRI, 5, { twist: 30, scaleTop: 0.5 }]);
  expect(extrudeArgs({ profile: TRI, h: 5 })).toEqual([TRI, 5]);
  expect(extrudeArgs({ profile: { outer: TRI }, h: 5, scaleTop: 0.5 })).toEqual([{ outer: TRI }, 5, { scaleTop: 0.5 }]);
  expect(() => prismArgs({ h: 5 })).toThrow("prism: points is required");
  expect(() => extrudeArgs({ profile: TRI })).toThrow("extrude: h is required");
});

test("revolve/loft/sweep normalize", () => {
  const RZ = [[0, 0], [5, 0], [5, 8], [0, 8]];
  expect(revolveArgs({ profile: RZ })).toEqual([RZ]);
  expect(revolveArgs({ profile: RZ, degrees: 90 })).toEqual([RZ, { degrees: 90 }]);
  const RINGS = [{ sides: 6, radius: 5, z: 0 }, { sides: 6, radius: 3, z: 10 }];
  expect(loftArgs({ rings: RINGS })).toEqual([RINGS]);
  expect(loftArgs({ rings: RINGS, ruled: true, closed: false })).toEqual([RINGS, { ruled: true, closed: false }]);
  const PATH = [[0, 0, 0], [0, 0, 20]];
  expect(sweepArgs({ profile: TRI, path: PATH })).toEqual([TRI, PATH]);
  expect(sweepArgs({ profile: TRI, path: PATH, cornerRadius: 2, smooth: true })).toEqual([TRI, PATH, { cornerRadius: 2, smooth: true }]);
  expect(() => sweepArgs({ profile: TRI })).toThrow("sweep: path is required");
  expect(() => loftArgs({})).toThrow("loft: rings is required");
});

test("KERNEL_OP_SPECS carries the semantic checks (both calling forms)", () => {
  expect(Object.keys(KERNEL_OP_SPECS).sort()).toEqual(
    ["box", "cylinder", "extrude", "loft", "prism", "revolve", "sphere", "sweep"]);
  expect(() => KERNEL_OP_SPECS.prism.check(TRI, 5, { scaleTop: -1 })).toThrow("prism: scaleTop must be ≥ 0");
  expect(() => KERNEL_OP_SPECS.extrude.check(TRI, 5, { scaleTop: -1 })).toThrow("extrude: scaleTop must be ≥ 0");
  expect(() => KERNEL_OP_SPECS.revolve.check([[-1, 0]])).toThrow("revolve: profile radius must be ≥ 0");
  expect(KERNEL_OP_SPECS.prism.check(TRI, 5, { scaleTop: 0.5 })).toBeUndefined();
});

test("SOLID_OP_SPECS: fillet/chamfer/shell", () => {
  expect(SOLID_OP_SPECS.fillet.toArgs({ r: 2 })).toEqual([2]);
  expect(SOLID_OP_SPECS.fillet.toArgs({ r: 2, edges: { dir: "Z" } })).toEqual([2, { dir: "Z" }]);
  expect(() => SOLID_OP_SPECS.fillet.toArgs({ edges: { dir: "Z" } })).toThrow("fillet: r is required");
  expect(SOLID_OP_SPECS.chamfer.toArgs({ d: 1, edges: { at: 0 } })).toEqual([1, { at: 0 }]);
  expect(SOLID_OP_SPECS.shell.toArgs({ t: 2, open: { face: "+Z" } })).toEqual([2, { face: "+Z" }]);
  expect(() => SOLID_OP_SPECS.shell.toArgs({ t: 2 })).toThrow("shell: open is required");
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/op-options.test.js`
Expected: FAIL — `prismArgs` etc. not exported.

- [ ] **Step 3: Append the implementation to op-options.js**

```js
export function prismArgs(o) {
  checkKeys("prism", o, ["points", "h", "twist", "scaleTop"]);
  return [req("prism", o, "points"), req("prism", o, "h"), ...tail(o, ["twist", "scaleTop"])];
}

export function extrudeArgs(o) {
  checkKeys("extrude", o, ["profile", "h", "twist", "scaleTop"]);
  return [req("extrude", o, "profile"), req("extrude", o, "h"), ...tail(o, ["twist", "scaleTop"])];
}

export function revolveArgs(o) {
  checkKeys("revolve", o, ["profile", "degrees"]);
  return [req("revolve", o, "profile"), ...tail(o, ["degrees"])];
}

export function loftArgs(o) {
  checkKeys("loft", o, ["rings", "ruled", "closed"]);
  return [req("loft", o, "rings"), ...tail(o, ["ruled", "closed"])];
}

export function sweepArgs(o) {
  checkKeys("sweep", o, ["profile", "path", "closed", "cornerRadius", "ruled", "smooth"]);
  return [req("sweep", o, "profile"), req("sweep", o, "path"),
    ...tail(o, ["closed", "cornerRadius", "ruled", "smooth"])];
}

// Per-op semantic validations, applied to the NORMALIZED positional args so
// they cover both calling forms (these moved here from kernel-front.js).
const checkScaleTop = (op) => (_profile, _h, opts) => {
  if ((opts?.scaleTop ?? 1) < 0) throw new Error(`${op}: scaleTop must be ≥ 0`);
};

// Kernel factory ops under the options convention. finishKernel() wraps each:
// normalize (if options form) → check → raw backend op.
export const KERNEL_OP_SPECS = {
  cylinder: { toArgs: cylinderArgs },
  sphere:   { toArgs: sphereArgs },
  box:      { toArgs: boxArgs },
  prism:    { toArgs: prismArgs, check: checkScaleTop("prism") },
  extrude:  { toArgs: extrudeArgs, check: checkScaleTop("extrude") },
  revolve:  { toArgs: revolveArgs, check: (pts) => {
    for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
  } },
  loft:     { toArgs: loftArgs },
  sweep:    { toArgs: sweepArgs },
};

// Solid ops under the options convention; addSugar() wraps these when the
// backend provides them natively (OCCT). The Manifold KernelCapabilityError
// stubs ignore arguments, so options-form calls still throw the routing error.
export const SOLID_OP_SPECS = {
  fillet:  { toArgs: (o) => { checkKeys("fillet", o, ["r", "edges"]);
    return [req("fillet", o, "r"), ...(o.edges !== undefined ? [o.edges] : [])]; } },
  chamfer: { toArgs: (o) => { checkKeys("chamfer", o, ["d", "edges"]);
    return [req("chamfer", o, "d"), ...(o.edges !== undefined ? [o.edges] : [])]; } },
  shell:   { toArgs: (o) => { checkKeys("shell", o, ["t", "open"]);
    return [req("shell", o, "t"), req("shell", o, "open")]; } },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/op-options.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/op-options.js test/op-options.test.js
git commit -m "feat: normalizers for prism/extrude/revolve/loft/sweep + op-spec tables"
```

---

### Task 3: Wire kernel-front.js + Manifold integration tests

**Files:**
- Modify: `src/framework/geometry/kernel-front.js` (full rewrite shown below — it is 38 lines today)
- Test: `test/calling-convention.test.js` (create)

**Interfaces:**
- Consumes: `isPlainOptions`, `KERNEL_OP_SPECS` from op-options.js; existing `KernelCapabilityError` from errors.js.
- Produces: `finishKernel(k)` — same export, same call sites (both backends already call it); every factory op now accepts both calling forms. No backend file changes.

- [ ] **Step 1: Write the failing integration tests**

```js
// test/calling-convention.test.js
// Pins the options-object calling convention end-to-end on the Manifold backend:
// equivalence with positional form, the detection rule, cache-entry sharing,
// error surfacing, and OCCT routing. This file is ALSO the deliberate legacy
// suite — the positional spellings here pin the v1 compat shim until contract v2.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { detectBackend } from "../src/framework/geometry/probe.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const sameGeom = (a, b) => {
  expect(a.volume()).toBeCloseTo(b.volume(), 6);
  const ba = a.boundingBox(), bb = b.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(ba.min[i]).toBeCloseTo(bb.min[i], 4);
    expect(ba.max[i]).toBeCloseTo(bb.max[i], 4);
  }
};

const TRI = [[0, 0], [10, 0], [0, 10]];
const RZ = [[0, 0], [5, 0], [5, 8], [0, 8]];

test("options form ≡ positional form for every factory op", () => {
  sameGeom(k.cylinder({ r: 4, h: 10 }), k.cylinder(4, 4, 10));
  sameGeom(k.cylinder({ d: 8, h: 10 }), k.cylinder(4, 4, 10));
  sameGeom(k.cylinder({ d1: 8, d2: 2, h: 10 }), k.cylinder(4, 1, 10));
  sameGeom(k.cylinder({ r: 4, h: 10, center: true }), k.cylinder(4, 4, 10, { center: true }));
  sameGeom(k.sphere({ d: 10 }), k.sphere(5));
  sameGeom(k.box({ min: [0, 0, 0], max: [2, 4, 6] }), k.box([0, 0, 0], [2, 4, 6]));
  sameGeom(k.prism({ points: TRI, h: 5, twist: 30 }), k.prism(TRI, 5, { twist: 30 }));
  sameGeom(k.extrude({ profile: TRI, h: 5 }), k.extrude(TRI, 5));
  sameGeom(k.revolve({ profile: RZ, degrees: 180 }), k.revolve(RZ, { degrees: 180 }));
  const RINGS = [{ sides: 6, radius: 5, z: 0 }, { sides: 6, radius: 3, z: 10 }];
  sameGeom(k.loft({ rings: RINGS }), k.loft(RINGS));
  const PATH = [[0, 0, 0], [0, 0, 20]];
  sameGeom(k.sweep({ profile: TRI, path: PATH }), k.sweep(TRI, PATH));
});

test("box({size}) sits centered in X/Y with its base at z=0", () => {
  const b = k.box({ size: [4, 6, 10] }).boundingBox();
  expect(b.min).toEqual([-2, -3, 0]);
  expect(b.max).toEqual([2, 3, 10]);
  const c = k.box({ size: [4, 6, 10], center: true }).boundingBox();
  expect(c.min).toEqual([-2, -3, -5]);
});

test("detection rule: two-argument object-profile extrude stays positional", () => {
  const outer = [[0, 0], [20, 0], [20, 20], [0, 20]];
  const hole = [[8, 8], [12, 8], [12, 12], [8, 12]];
  sameGeom(
    k.extrude({ outer, holes: [hole] }, 5),                      // legacy positional
    k.extrude({ profile: { outer, holes: [hole] }, h: 5 }),      // options form
  );
});

test("both spellings share one solid-cache entry", () => {
  k.beginSubPart("cc"); k.cylinder(4, 4, 10).toMesh(); k.endSubPart(); k.cleanup();
  k.resetCacheStats();
  k.beginSubPart("cc"); k.cylinder({ r: 4, h: 10 }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(0);
  expect(k.cacheStats().hits).toBeGreaterThan(0);
});

test("validation errors surface through the kernel", () => {
  expect(() => k.cylinder({ r: 4, d: 8, h: 1 })).toThrow("cylinder: pass exactly one of r/d, or r1+r2 / d1+d2");
  expect(() => k.cylinder({ radius: 4, h: 1 })).toThrow('cylinder: unknown option "radius" — did you mean r?');
  expect(() => k.prism({ points: TRI, h: 5, scaleTop: -1 })).toThrow("prism: scaleTop must be ≥ 0");
  expect(() => k.prism(TRI, 5, { scaleTop: -1 })).toThrow("prism: scaleTop must be ≥ 0"); // positional still checked
});

test("options-form fillet still throws the OCCT routing error on Manifold", () => {
  expect(() => k.box({ size: [1, 1, 1] }).fillet({ r: 0.2 })).toThrow(KernelCapabilityError);
});

test("probe routes an options-form fillet build to occt", () => {
  const part = { defaults: {}, parts: { p: { build: (kk) => kk.box({ size: [1, 1, 1] }).fillet({ r: 0.1 }) } } };
  expect(detectBackend(part)).toBe("occt");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/calling-convention.test.js`
Expected: FAIL — options-form calls reach the Manifold backend as a single object argument (NaN radii / thrown backend errors). The probe and capability tests may already pass (Proxy/stub ignore arguments) — that is fine; the equivalence tests must fail.

- [ ] **Step 3: Rewrite finishKernel() in kernel-front.js**

Replace the whole file body (keep the header comment, updating it):

```js
// The backend-shared kernel front. Each backend builds its primitive mapping and
// returns finishKernel(kernel), which layers on everything that is NOT
// backend-specific:
//   - the options-object calling convention (op-options.js): one wrapper per
//     factory op normalizes an options-form call to positional args, then runs
//     the op's semantic check on the normalized args (both calling forms), then
//     calls the raw backend op — so backends stay positional and the solid
//     cache hashes normalized args;
//   - default compound-op compositions — a backend only overrides one when it has
//     a reason to (Manifold's boredCylinder hashes atomically for its solid cache);
//   - a KernelCapabilityError stub for toSTEP when the backend can't write B-rep.
// The per-Solid twin of this layer is addSugar() in solid-sugar.js.
import { KernelCapabilityError } from "./errors.js";
import { isPlainOptions, KERNEL_OP_SPECS } from "./op-options.js";

export function finishKernel(k) {
  for (const [op, { toArgs, check }] of Object.entries(KERNEL_OP_SPECS)) {
    const raw = k[op];
    if (!raw) continue;
    k[op] = (...a) => {
      const pos = a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0]) : a;
      check?.(...pos);
      return raw(...pos);
    };
  }

  // Compound: bored-through cylinder (tool overshoots 2 mm each end for a clean cut).
  k.boredCylinder ??= ({ od, h, bore }) =>
    k.cylinder(od / 2, od / 2, h).cut(k.cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2]));

  k.toSTEP ??= () => { throw new KernelCapabilityError("toSTEP requires the OCCT backend"); };

  return k;
}
```

Note this **deletes** the old hand-written `prism`/`extrude`/`revolve` validation wrappers — their checks moved into `KERNEL_OP_SPECS` (Task 2) and now cover both calling forms.

- [ ] **Step 4: Run the new tests, then the full suite**

Run: `npx vitest run test/calling-convention.test.js`
Expected: PASS (7 tests).
Run: `npx vitest run`
Expected: all green — the positional path is byte-identical behavior, so nothing else moves.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/kernel-front.js test/calling-convention.test.js
git commit -m "feat: options-object calling convention on kernel factory ops"
```

---

### Task 4: Wire solid-sugar.js + OCCT twin tests

**Files:**
- Modify: `src/framework/geometry/solid-sugar.js`
- Test: `test/calling-convention-occt.test.js` (create — OCCT must boot in its own file)

**Interfaces:**
- Consumes: `isPlainOptions`, `SOLID_OP_SPECS` from op-options.js.
- Produces: `addSugar(s)` unchanged signature; `fillet`/`chamfer`/`shell` on OCCT solids accept both forms.

- [ ] **Step 1: Write the failing OCCT tests**

```js
// test/calling-convention-occt.test.js
// OCCT twin of calling-convention.test.js: options form ≡ positional form on the
// B-rep backend, including the natively-implemented fillet/chamfer/shell.
// (replicad consumes operands — every comparison builds fresh solids.)
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("factory ops: options form ≡ positional form (volumes)", () => {
  expect(k.cylinder({ d: 8, h: 10 }).volume()).toBeCloseTo(k.cylinder(4, 4, 10).volume(), 4);
  expect(k.box({ min: [0, 0, 0], max: [2, 4, 6] }).volume()).toBeCloseTo(k.box([0, 0, 0], [2, 4, 6]).volume(), 4);
  const TRI = [[0, 0], [10, 0], [0, 10]];
  expect(k.extrude({ profile: TRI, h: 5 }).volume()).toBeCloseTo(k.extrude(TRI, 5).volume(), 4);
});

test("box({size}) placement on OCCT matches the convention", () => {
  const b = k.box({ size: [4, 6, 10] }).boundingBox();
  expect(b.min[2]).toBeCloseTo(0, 4);
  expect(b.center[0]).toBeCloseTo(0, 4);
  expect(b.center[1]).toBeCloseTo(0, 4);
});

test("fillet/chamfer options form ≡ positional form", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]).fillet({ r: 2, edges: { dir: "Z" } }).volume();
  const b = k.box([0, 0, 0], [10, 10, 10]).fillet(2, { dir: "Z" }).volume();
  expect(a).toBeCloseTo(b, 4);
  const c = k.box([0, 0, 0], [10, 10, 10]).chamfer({ d: 1, edges: { inPlane: "XY", at: 0 } }).volume();
  const d = k.box([0, 0, 0], [10, 10, 10]).chamfer(1, { inPlane: "XY", at: 0 }).volume();
  expect(c).toBeCloseTo(d, 4);
});

test("fillet options-form validation errors", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).fillet({ edges: { dir: "Z" } })).toThrow("fillet: r is required");
  expect(() => k.box([0, 0, 0], [1, 1, 1]).fillet({ radius: 2 })).toThrow('fillet: unknown option "radius" — did you mean r?');
});
```

- [ ] **Step 2: Run tests to verify the fillet/chamfer ones fail**

Run: `npx vitest run test/calling-convention-occt.test.js`
Expected: factory-op tests PASS (Task 3 wired them); the fillet/chamfer options-form and validation tests FAIL (the options object reaches replicad's native fillet as a radius).

- [ ] **Step 3: Add the wrap-if-present loop to addSugar()**

In `src/framework/geometry/solid-sugar.js`, add the import and insert the loop **before** the existing `OCCT_ONLY_OPS` stub loop:

```js
import { isPlainOptions, SOLID_OP_SPECS } from "./op-options.js";
```

```js
  // Options-object calling convention for the multi-param B-rep ops. Wrap only
  // when the backend provides the op natively (OCCT); the Manifold stubs below
  // ignore their arguments, so options-form calls still throw the routing error.
  for (const [op, { toArgs }] of Object.entries(SOLID_OP_SPECS)) {
    const raw = s[op];
    if (raw) s[op] = (...a) => raw(...(a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0]) : a));
  }
```

Also update the file's header comment list to mention the options-convention wrapping.

- [ ] **Step 4: Run the OCCT twin, then the full suite**

Run: `npx vitest run test/calling-convention-occt.test.js`
Expected: PASS (4 tests).
Run: `npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/solid-sugar.js test/calling-convention-occt.test.js
git commit -m "feat: options-object form for fillet/chamfer/shell"
```

---

### Task 5: Migrate the in-repo parts to options form

**Files:**
- Modify: `src/parts/demo.js`, `src/parts/planter.js`, `src/parts/filleted-box.js`, `src/parts/faceted-vase.js`

**Interfaces:**
- Consumes: the options forms from Tasks 3–4. Produces: the exemplar call sites LLMs copy. Geometry must be bit-identical — the existing part tests (`measure`, `verify`, smoke) are the gate.

- [ ] **Step 1: Apply the migrations**

`src/parts/demo.js` (3 sites, lines ~51–53):

```js
let s = k.cylinder({ d: p.od, h: p.h });
if (p.flange_d > 0) s = k.union([s, k.cylinder({ d: p.flange_d, h: p.flange_h })]);
return s.cut(k.cylinder({ r: d.boreR, h: d.cutH }).at([0, 0, -2]));
```

`src/parts/planter.js` (3 sites, lines ~92–104):

```js
const body = k.prism({ points: d.outerPts, h: p.height, scaleTop: p.taper, twist: p.twist }).label("Faceted wall");
// …
  .intersect(k.box({ min: [-1e4, -1e4, p.floor], max: [1e4, 1e4, p.height + 10] }))
// …
if (p.drain > 0) s = s.cut(k.cylinder({ r: d.drainR, h: p.floor + 4 }).at([0, 0, -2]).label("Drainage hole"));
```

`src/parts/filleted-box.js` (5 sites, lines ~27–40):

```js
let s = k.box({ min: [0, 0, 0], max: [p.w, p.d, p.h] });
// …
if (vFillet > 0) s = s.fillet({ r: vFillet, edges: { dir: "Z" } });                    // 4 vertical edges
// …
if (topFillet > 0) s = s.fillet({ r: topFillet, edges: { inPlane: "XY", at: p.h } });  // top rim — curves all the way around
// …
if (p.chamfer > 0) s = s.chamfer({ d: p.chamfer, edges: { inPlane: "XY", at: 0 } });   // base edges
if (p.bore > 0) s = s.cut(k.cylinder({ d: p.bore, h: p.h + 2 }).at([p.w / 2, p.d / 2, -1]).label("Bore"));
```

`src/parts/faceted-vase.js` (3 sites, lines ~57–60):

```js
const body = k.loft({ rings: vaseRings(p, false) }).label("Faceted wall");
// …
const cavity = k.loft({ rings: vaseRings(p, true) })
  .intersect(k.box({ min: [-1e4, -1e4, p.floor], max: [1e4, 1e4, p.height + 10] })).label("Cavity");
```

Then `grep -n "k\.\(cylinder\|box\|sphere\|prism\|extrude\|revolve\|loft\|sweep\)(\[\|k\.cylinder([^{]" src/parts/*.js` — expect no remaining positional factory calls (any further hits found beyond the lines listed above get the same per-op transformation as Task 6's table).

- [ ] **Step 2: Run the full suite + CLI measure gate**

Run: `npx vitest run`
Expected: all green (part geometry unchanged → measure/verify/smoke tests unaffected).
Run: `npx partforge measure src/parts/demo.js && npx partforge measure src/parts/planter.js && npx partforge measure src/parts/filleted-box.js && npx partforge measure src/parts/faceted-vase.js`
Expected: exit 0 for each, same measurements as before the change.

- [ ] **Step 3: Commit**

```bash
git add src/parts/
git commit -m "refactor: migrate parts to options-object calling convention"
```

---

### Task 6: Migrate the test suite to options form

**Files:**
- Modify: every `test/*.test.js` with positional factory / fillet-selector calls **except** `test/calling-convention.test.js`, `test/calling-convention-occt.test.js`, and `test/op-options.test.js` (those pin both forms). ~280 call sites; the big ones are `test/manifold-backend.test.js` (~82), `test/occt-backend.test.js` (~39), `test/solid-sugar.test.js` (~28), `test/occt-fillet.test.js` (~13), `test/feature-labels.test.js` (~13).

**Interfaces:**
- Consumes: options forms from Tasks 3–4. Produces: a test corpus that reads in the canonical style. Behavior identical — the transformation is mechanical.

- [ ] **Step 1: Apply the per-op transformation table, file by file**

| Positional pattern | Options form |
|---|---|
| `cylinder(X, X, H)` (same expr twice) | `cylinder({ r: X, h: H })` |
| `cylinder(A, B, H)` (different) | `cylinder({ r1: A, r2: B, h: H })` |
| `cylinder(A, B, H, { center: C })` | fold `center: C` into the object |
| `box(MIN, MAX)` | `box({ min: MIN, max: MAX })` |
| `sphere(R)` | leave as-is (undeprecated shorthand) |
| `prism(P, H)` / `prism(P, H, O)` | `prism({ points: P, h: H, ...O-keys })` |
| `extrude(P, H)` / `extrude(P, H, O)` | `extrude({ profile: P, h: H, ...O-keys })` |
| `revolve(P)` / `revolve(P, { degrees: D })` | `revolve({ profile: P, degrees?: D })` |
| `loft(R)` / `loft(R, O)` | `loft({ rings: R, ...O-keys })` |
| `sweep(P, PATH)` / `sweep(P, PATH, O)` | `sweep({ profile: P, path: PATH, ...O-keys })` |
| `.fillet(R, SEL)` | `.fillet({ r: R, edges: SEL })` |
| `.fillet(R)` / `.chamfer(D)` | leave as-is (undeprecated shorthand) |
| `.chamfer(D, SEL)` | `.chamfer({ d: D, edges: SEL })` |
| `.shell(T, OPEN)` | `.shell({ t: T, open: OPEN })` |

"…O-keys" means spread the literal keys of the old trailing options object into the new single object (e.g. `prism(pts, 5, { twist: 30 })` → `prism({ points: pts, h: 5, twist: 30 })`). Two deliberate exceptions: (1) tests that assert on *positional-form* error behavior keep their spelling; (2) the three convention test files stay untouched. Work file-by-file; after each file run that file's tests before moving on (`npx vitest run test/<file>`).

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run`
Expected: all green, same test count as before this task.

- [ ] **Step 3: Sweep for leftovers**

Run: `grep -rn "cylinder([^{]" test/ | grep -v "calling-convention\|op-options" | grep -v "sphere"`
Expected: no hits outside deliberate positional-behavior tests; spot-check any survivors against the exception list.

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "refactor: migrate test suite to options-object calling convention"
```

---

### Task 7: Docs, typedefs, error patterns, version bump

**Files:**
- Modify: `src/framework/geometry/kernel.js` (typedefs only — op lists and `CONTRACT_VERSION` unchanged)
- Modify: `docs/KERNEL-CONTRACT.md`, `docs/AUTHORING-PARTS.md`, `docs/REFERENCE-PARTS.md`, `docs/ERROR-PATTERNS.md`, `package.json`

**Interfaces:**
- Consumes: everything above. Produces: the documented contract LLMs and hosts generate against.

- [ ] **Step 1: Update kernel.js typedefs**

Rewrite the `@typedef` signature lines for the eight factory ops and fillet/chamfer/shell to options-first, each with a trailing legacy note. Exact replacements:

```js
 * @property {(o:{r?:number,d?:number,r1?:number,r2?:number,d1?:number,d2?:number,h:number,center?:boolean}) => Solid} cylinder   canonical: {r|d,h} straight, {r1,r2,h}|{d1,d2,h} cone; legacy (rBottom,rTop,h,opts) accepted until contract v2
 * @property {(o:{r?:number,d?:number}) => Solid} sphere   sphere centred at the origin; {r|d}; bare sphere(r) stays valid
 * @property {(o:{size?:number[],center?:boolean,min?:number[],max?:number[]}) => Solid} box   {size} = centered X/Y, base z=0 ({center:true} centers Z too) or {min,max}; legacy (min,max) accepted until v2
 * @property {(o:{points:number[][],h:number,twist?:number,scaleTop?:number}) => Solid} prism   extrude polygon from z=0; legacy (points,h,opts) accepted until v2
 * @property {(o:{profile:number[][]|{outer:number[][],holes?:number[][][]},h:number,twist?:number,scaleTop?:number}) => Solid} extrude   polygon-with-holes region from z=0; legacy (profile,h,opts) accepted until v2
 * @property {(o:{rings:{polygon?:number[][],sides?:number,radius?:number,z:number,rotate?:number,scale?:number|number[]}[],ruled?:boolean,closed?:boolean}) => Solid} loft   stack polygon cross-sections; legacy (rings,opts) accepted until v2
 * @property {(o:{profile:number[][],path:number[][],closed?:boolean,cornerRadius?:number,ruled?:boolean,smooth?:boolean}) => Solid} sweep   sweep a 2-D profile along a 3-D polyline; legacy (profile,path,opts) accepted until v2
 * @property {(o:{profile:number[][],degrees?:number}) => Solid} revolve   revolve a lathe profile [[r,z],…] around Z; legacy (points,opts) accepted until v2
```

and on the Solid typedef:

```js
 * @property {(r:number|{r:number,edges?:object}) => Solid} fillet    round edges (OCCT only); fillet(3) or fillet({r,edges}); legacy (r,selector) accepted until v2
 * @property {(d:number|{d:number,edges?:object}) => Solid} chamfer  bevel edges (OCCT only); chamfer(1) or chamfer({d,edges}); legacy (d,selector) accepted until v2
 * @property {(o:{t:number,open:object}) => Solid} shell   hollow inward (OCCT only); legacy (thickness,openFaces) accepted until v2
```

Update the file's top comment to note that op-options.js/kernel-front.js implement the calling convention.

- [ ] **Step 2: Add the "Calling convention" section to docs/KERNEL-CONTRACT.md**

Insert a new `## Calling convention` section immediately after `## Global semantics`, containing: the detection rule (verbatim from Global Constraints above), the canonical-forms table (copy the two tables from the spec §"Canonical signatures"), the cylinder key rules, `box({size})` placement semantics, the note that scalar `sphere(5)` / `fillet(3)` / `chamfer(1)` shorthands are permanent, and this lifecycle sentence: "Legacy positional forms remain accepted (silently — no runtime warning) until contract v2 removes them; a conforming implementation must accept both, and this repo's `finishKernel()`/`addSugar()` provide the normalization for free." Keep the `Contract version: 1` header unchanged.

- [ ] **Step 3: Rewrite docs/AUTHORING-PARTS.md and docs/REFERENCE-PARTS.md to options form**

- In the kernel op table (~line 101), replace each factory-op row's signature with the canonical options form, e.g. `k.cylinder({r|d, h, center?})` / `{r1,r2,h}` / `{d1,d2,h}`.
- Convert every code snippet: `grep -n "k\.cylinder\|k\.box\|k\.prism\|k\.extrude\|k\.revolve\|k\.loft\|k\.sweep\|\.fillet(\|\.chamfer(\|\.shell(" docs/AUTHORING-PARTS.md docs/REFERENCE-PARTS.md` and apply Task 6's transformation table to each hit.
- Add a short "Calling convention" paragraph near the op table linking to KERNEL-CONTRACT.md's new section, stating positional is legacy.

- [ ] **Step 4: Add ERROR-PATTERNS.md entries (Core framework section)**

```markdown
## options-unknown-key

- **Symptom:** `unknown option` — e.g. `cylinder: unknown option "radius" — did you mean r?`
- **Cause:** an options-form kernel call passed a key the op does not accept (typo, or long-form vocabulary like `radius`/`height`).
- **Fix:** use the canonical keys from the op table in [AUTHORING-PARTS.md](AUTHORING-PARTS.md); the error's did-you-mean / valid-keys hint names them.

## options-missing-key

- **Symptom:** `is required` — e.g. `cylinder: h is required`, `sweep: path is required`.
- **Cause:** an options-form kernel call omitted a required key.
- **Fix:** supply the key; canonical forms are in the [AUTHORING-PARTS.md](AUTHORING-PARTS.md) op table and KERNEL-CONTRACT.md "Calling convention".

## cylinder-radius-keys

- **Symptom:** `cylinder: pass exactly one of r/d, or r1+r2 / d1+d2`
- **Cause:** mixed or missing radius vocabulary — both `r` and `d`, straight + cone keys together, only one cone end, or `r1`+`d2`.
- **Fix:** straight cylinders take one of `r`|`d` plus `h`; cones take `r1`+`r2` or `d1`+`d2` plus `h`.

The sphere variant is `sphere: pass exactly one of r/d` (same cause and fix).

## box-size-vs-corners

- **Symptom:** `box: pass size or min+max, not both`
- **Cause:** the two `box` forms were mixed in one call.
- **Fix:** either `{size, center?}` (centered in X/Y, base at z=0; `center:true` centers Z too) or `{min, max}` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md).
```

Run: `npx vitest run test/error-patterns.test.js`
Expected: PASS (the lint accepts the entry shape).

- [ ] **Step 5: Bump the package version**

In `package.json`, bump the minor version (e.g. `0.12.x` → `0.13.0`) — additive API, no contract break.

- [ ] **Step 6: Full suite + smoke check**

Run: `npx vitest run`
Expected: all green.
Run: `npm run check` (requires Playwright Chromium; if unavailable, `node scripts/check-app.mjs demo.html` and note the skip)
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/kernel.js docs/ package.json
git commit -m "docs: options-object calling convention — contract, authoring guide, error patterns; bump to 0.13.0"
```
