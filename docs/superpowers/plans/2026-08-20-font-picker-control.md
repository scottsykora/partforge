# Font Picker Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a part's typeface a parameter — an end user picks a face in the control panel and the geometry rebuilds — without partforge learning anything about Google.

**Architecture:** Four independent framework changes stack up to the feature. `PartDefinition.fonts` gains a function-of-params form resolved after `resolveParams`; the kernel's font registry moves from name-keyed to source-keyed (a live bug today); a new `"font"` control type renders a picker fed by a host-supplied `mount({ fontCatalog })` provider; and param-supplied font sources are checked against the control's `allow` list. The geometry worker only ever sees a URL — the catalog is a main-thread concern.

**Tech Stack:** Plain ESM, vitest (+ happy-dom for panel tests), opentype.js 2.x, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-font-picker-control-design.md` — read it alongside this plan. Note §4 carries a correction made during planning.

## Global Constraints

- **Node 24.** Run `nvm use` before anything. The default shell Node is too old and failures are confusing.
- **Units are millimetres** throughout.
- **`build` must stay a pure function of `(k, p, d)`.** Font resolution happens *before* the synchronous build, never inside it.
- **The worker graph stays DOM-free, `three`-free and `node:`-free.** `test/worker-layering.test.js` enforces this. `fonts.js`, `jobs.js`, `part-model.js` and anything they import are in that graph. The panel (`src/framework/panel/**`) is main-thread-only and is *not*.
- **`src/framework/lint/**` stays dependency-free** — no import may reach `three`, `manifold-3d` or `replicad`. `test/lint-purity.test.js` enforces it.
- **Never import `src/testing/**` from `src/framework/**`.**
- **The static `fonts` object form must keep working unchanged.** Every existing part is that shape. Any task that breaks `test/fonts-preload.test.js` has gone wrong.
- **Author-declared font sources get no host restriction** (spec §4 correction). Only param-supplied values are checked.
- **Release:** bump `package.json` on this branch as part of the work (Task 8). Additive contract change → **minor**. Forgetting it means the work silently never ships.
- **Commit after every task.** Do not batch.

---

### Task 1: Source-keyed font registration

The stale-font bug, first because it is a live defect today (not just a
blocker for the picker): `jobs.js` registers with `if (!kernel._fonts.has(name))`,
so when one worker is rebound to a second part that uses the same font *name*
with different bytes, the first part's font silently wins. With a picker it
would mean the first face you ever pick is the only one you ever get.

**Files:**
- Modify: `src/framework/jobs.js:100-112` (the preload block)
- Test: `test/fonts-dynamic.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `kernel._fontsBySource: Map<source, opentype.Font>` — the parse memo. `kernel._fonts: Map<name, opentype.Font>` keeps its existing meaning (what `kernel-front.js` reads) but is now rewritten every job rather than written once.

- [ ] **Step 1: Write the failing test**

Create `test/fonts-dynamic.test.js`. `synthFont` is copied from
`test/fonts-preload.test.js` — repeated deliberately so this file stands alone;
`advanceWidth` differs so the two fonts are distinguishable by their parsed
metrics.

```js
import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { handle } from "../src/framework/jobs.js";

// Two distinguishable synthetic fonts: same glyph, different advance width, so
// a stale registration is visible in the parsed font's own metrics.
function synthFont(advance) {
  const p = new opentype.Path();
  p.moveTo(50, 0); p.lineTo(50, 700); p.lineTo(650, 700); p.lineTo(650, 0); p.close();
  const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: advance, path: new opentype.Path() });
  const H = new opentype.Glyph({ name: "H", unicode: 72, advanceWidth: advance, path: p });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font.toArrayBuffer();
}

const job = { type: "generate", subparts: [], view: "iso", params: {} };

test("a second part reusing a font NAME with different bytes wins", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);

  await handle(kernel, { fonts: { face: a }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);

  await handle(kernel, { fonts: { face: b }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(300);
});

test("the same source is parsed once even across names and jobs", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700);
  const parseSpy = vi.spyOn(opentype, "parse");
  await handle(kernel, { fonts: { face: a }, parts: {}, defaults: {} }, job, () => {});
  const after = parseSpy.mock.calls.length;
  await handle(kernel, { fonts: { other: a }, parts: {}, defaults: {} }, job, () => {});
  expect(parseSpy.mock.calls.length).toBe(after);        // same bytes → memo hit
  expect(kernel._fonts.get("other")).toBe(kernel._fonts.get("face")); // same parsed object
  parseSpy.mockRestore();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
nvm use && npx vitest run test/fonts-dynamic.test.js
```

Expected: the first test FAILS with `expected 700 to be 300` — the stale
registration. The second test may already pass; that is fine, it is the guard
that stops the fix from regressing the memo.

- [ ] **Step 3: Rewrite the preload block**

In `src/framework/jobs.js`, replace the body of the `if (part.fonts && kernel._fonts)`
block (currently lines ~106-110):

```js
    if (part.fonts && kernel._fonts) {
      const opentype = normalizeOpentype(await import("opentype.js"));
      const bufs = await resolveFonts(part.fonts);
      // Keyed on the SOURCE, not the name. A name is not a font identity: one
      // worker outlives many parts (worker-rebind) and, once a font can come
      // from a param, many picks — all of which reuse the same declared name.
      // The old `if (!_fonts.has(name))` made the first bytes ever seen under a
      // name permanent for the life of the worker.
      kernel._fontsBySource ??= new Map();
      for (const [name, buf] of bufs) {
        let font = kernel._fontsBySource.get(buf);
        if (!font) { font = parseFont(opentype, buf, name); kernel._fontsBySource.set(buf, font); }
        kernel._fonts.set(name, font);            // rewritten every job, deliberately
      }
    }
```

`resolveFonts` already memoizes by source identity, so the same declared source
yields the *same* ArrayBuffer object on every call — which is what makes the
`_fontsBySource` map key work without hashing bytes.

- [ ] **Step 4: Run the new test and the existing font tests**

```bash
nvm use && npx vitest run test/fonts-dynamic.test.js test/fonts-preload.test.js test/worker-rebind.test.js
```

Expected: all PASS. `fonts-preload.test.js`'s "preloads … (parsed, once)" case
still passes because the memo, not the name check, is now what prevents the
re-parse.

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/fonts-dynamic.test.js
git commit -m "fix: key the kernel font registry on source, not name"
```

---

### Task 2: `fonts` as a function of params

**Files:**
- Modify: `src/framework/fonts.js` (add `fontsFor`, guard `resolveFonts`)
- Modify: `src/framework/jobs.js` (reorder `resolveParams` above the preload)
- Modify: `bin/cli.js:82-86` (`bootKernel` takes params)
- Test: `test/fonts-dynamic.test.js` (extend)

**Interfaces:**
- Consumes: Task 1's source-keyed registration.
- Produces: `fontsFor(part, p) → { name: source } | undefined` exported from `src/framework/fonts.js`. Every caller that previously passed `part.fonts` straight to `resolveFonts` now passes `fontsFor(part, p)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/fonts-dynamic.test.js`:

```js
import { fontsFor, resolveFonts } from "../src/framework/fonts.js";

test("fontsFor calls the function form with resolved params", () => {
  const part = { defaults: { face: "A" }, fonts: (p) => ({ face: p.face }) };
  expect(fontsFor(part, { face: "B" })).toEqual({ face: "B" });
});

test("fontsFor passes a static object through untouched", () => {
  const decl = { face: "A" };
  expect(fontsFor({ fonts: decl }, {})).toBe(decl);
  expect(fontsFor({}, {})).toBeUndefined();
});

test("resolveFonts refuses a function — it has no params to call it with", async () => {
  await expect(resolveFonts(() => ({}))).rejects.toThrow(/fontsFor/);
});

test("handle resolves a function-form fonts against the job's params", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);
  const part = {
    defaults: { face: "a" },
    fonts: (p) => ({ face: p.face === "b" ? b : a }),
    parts: {}, 
  };
  await handle(kernel, part, { ...job, params: { face: "a" } }, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);
  await handle(kernel, part, { ...job, params: { face: "b" } }, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(300);
});

test("a throwing derive() errors before any font is fetched", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const fontsSpy = vi.fn(() => ({}));
  const part = { defaults: {}, derive: () => { throw new Error("boom"); }, fonts: fontsSpy, parts: {} };
  const posts = [];
  await handle(kernel, part, job, (m) => posts.push(m));
  expect(posts.find((m) => m.type === "error")).toBeTruthy();
  expect(fontsSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
nvm use && npx vitest run test/fonts-dynamic.test.js
```

Expected: FAIL — `fontsFor is not a function` on the import.

- [ ] **Step 3: Add `fontsFor` and the guard**

In `src/framework/fonts.js`, add above `resolveFonts`:

```js
// `fonts` may be a plain { name: source } map, or a function of the resolved
// params — the second form is what lets a `type: "font"` control drive the
// typeface. Resolving it needs `p`, which is why this is a separate step from
// resolveFonts rather than folded into it.
export function fontsFor(part, p) {
  const decl = part?.fonts;
  return typeof decl === "function" ? decl(p) : decl;
}
```

and, as the first line of `resolveFonts`:

```js
export async function resolveFonts(fontsDecl) {
  // A function reaching here means a caller passed `part.fonts` raw. It cannot
  // be resolved without params, and silently returning an empty map would show
  // up much later as `text2d: unknown font "…"`.
  if (typeof fontsDecl === "function") {
    throw new Error("resolveFonts: `fonts` is a function of params — resolve it with fontsFor(part, p) first");
  }
  return resolveDecl(fontsDecl, resolveOne);
}
```

- [ ] **Step 4: Reorder `jobs.js` so params resolve first**

In `src/framework/jobs.js`, move the `const { p, d } = resolveParams(part, msg.params);`
line (currently *below* the imports registration) to sit immediately after
`const onProgress = ...` inside the `try`, and change the fonts block to use it.
The result reads:

```js
  try {
    // Params first: the fonts declaration may be a function of them, and a
    // throwing derive() should surface before a font download rather than
    // after one. Still inside the try, so that throw posts an error the UI can
    // show instead of killing the worker turn silently (an endless spinner).
    const { p, d } = resolveParams(part, msg.params);
    // Preload any part-declared fonts into the kernel before building. A lazy
    // dynamic import because this is async context (unlike the synchronous
    // kernel-front), so it doesn't cost sync callers anything. The namespace
    // shape differs between bundler and Node resolution (a bare `.default`
    // here is undefined in every browser bundle) — normalize it.
    const fontsDecl = fontsFor(part, p);
    if (fontsDecl && kernel._fonts) {
      onProgress("resolving fonts");
      const opentype = normalizeOpentype(await import("opentype.js"));
      const bufs = await resolveFonts(fontsDecl);
      kernel._fontsBySource ??= new Map();
      for (const [name, buf] of bufs) {
        let font = kernel._fontsBySource.get(buf);
        if (!font) { font = parseFont(opentype, buf, name); kernel._fontsBySource.set(buf, font); }
        kernel._fonts.set(name, font);
      }
    }
    if (part.imports) await ensureImports(kernel, part.imports, opts.importMeshes ?? null);
```

Delete the now-duplicated `const { p, d } = resolveParams(...)` line further
down, and its two comment lines about being "inside the try". Update the import
at the top of the file:

```js
import { fontsFor, resolveFonts } from "./fonts.js";
```

- [ ] **Step 5: Thread params through the CLI's kernel boot**

In `bin/cli.js`, change `bootKernel` and both call sites. Add the import:

```js
import { fontsFor } from "../src/framework/fonts.js";
```

Replace the helper:

```js
// Pass the part's declared fonts through, mirroring the worker path (jobs.js) —
// otherwise a part using a named font builds in the browser but dies headlessly
// with `text2d: unknown font …`. A function-form `fonts` is resolved against
// the CLI's base params; see "CLI limitation" in the design doc — a verify case
// or animation frame that CHANGES the font param still builds with the
// base-params face, because the kernel is booted once.
const bootKernel = (part, params = {}) => {
  const p = { ...(part.defaults ?? {}), ...params };
  const opts = { fonts: fontsFor(part, p), imports: part.imports };
  const backend = process.env.PARTFORGE_BACKEND || detectBackend(part); // env: crash()'s NEEDS_OCCT retry
  return backend === "occt" ? bootOcctKernel(opts) : bootManifoldKernel(opts);
};
```

At line ~140 (measure): `const kernel = await bootKernel(part, params);`
At line ~241 (render): `const kernel = await bootKernel(part, baseParams);`

- [ ] **Step 6: Run the full suite**

```bash
nvm use && npx vitest run
```

Expected: all PASS. Pay attention to `test/cli.test.js`, `test/cli-assets.test.js`,
`test/verify-cli.test.js` and `test/text2d-node-resolution.test.js` — they cover
the paths just touched.

- [ ] **Step 7: Commit**

```bash
git add src/framework/fonts.js src/framework/jobs.js bin/cli.js test/fonts-dynamic.test.js
git commit -m "feat: allow fonts to be a function of resolved params"
```

---

### Task 3: `allow` — checking param-supplied font sources

Per spec §4: an author-declared source is code and gets no restriction; a
param-supplied one is user input and does. This task adds the predicate and the
resolution-time check. The widget-side half lands in Task 4.

**Files:**
- Create: `src/framework/font-source.js`
- Modify: `src/framework/jobs.js` (apply the check before `resolveFonts`)
- Test: `test/fonts-allow.test.js` (create)

**Interfaces:**
- Consumes: `fontsFor` (Task 2).
- Produces:
  - `FONT_ALLOW_DEFAULT = ["https"]`
  - `fontSourceAllowed(source, allow) → boolean`
  - `fontControlAllows(part) → Map<paramKey, string[]>` — walks `part.parameters` for `type: "font"` controls and returns each one's `allow` list.

- [ ] **Step 1: Write the failing test**

Create `test/fonts-allow.test.js`:

```js
import { expect, test } from "vitest";
import { fontSourceAllowed, fontControlAllows, FONT_ALLOW_DEFAULT } from "../src/framework/font-source.js";

test("the default allow list accepts https and nothing else", () => {
  expect(FONT_ALLOW_DEFAULT).toEqual(["https"]);
  expect(fontSourceAllowed("https://fonts.gstatic.com/s/x/v1/y.ttf", FONT_ALLOW_DEFAULT)).toBe(true);
  expect(fontSourceAllowed("https://cdn.example.com/a.ttf", FONT_ALLOW_DEFAULT)).toBe(true);
  for (const bad of ["http://x.test/a.ttf", "file:///etc/passwd", "data:font/ttf;base64,AA", "blob:https://x/y", "not a url"]) {
    expect(fontSourceAllowed(bad, FONT_ALLOW_DEFAULT), bad).toBe(false);
  }
});

test('"gstatic" narrows to the Google font host only', () => {
  expect(fontSourceAllowed("https://fonts.gstatic.com/s/x/v1/y.ttf", ["gstatic"])).toBe(true);
  expect(fontSourceAllowed("https://cdn.example.com/a.ttf", ["gstatic"])).toBe(false);
  // a lookalike host must not pass
  expect(fontSourceAllowed("https://fonts.gstatic.com.evil.test/a.ttf", ["gstatic"])).toBe(false);
});

test('"asset" accepts a pfc-asset token; https alone does not', () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/roboto-700.ttf";
  expect(fontSourceAllowed(tok, ["asset"])).toBe(true);
  expect(fontSourceAllowed(tok, ["https"])).toBe(false);
  expect(fontSourceAllowed(tok, ["https", "asset"])).toBe(true);
});

test("non-string sources are never param-supplied and are not checked here", () => {
  expect(fontSourceAllowed(new ArrayBuffer(4), FONT_ALLOW_DEFAULT)).toBe(false);
});

test("fontControlAllows finds every font control and its allow list", () => {
  const part = { parameters: [
    { id: "t", controls: [
      { key: "face", type: "font" },                          // default allow
      { key: "alt",  type: "font", allow: ["gstatic"] },
      { key: "size", type: "slider" },
      { type: "group", controls: [{ key: "sub", type: "font", allow: ["asset"] }] },
    ] },
  ] };
  const m = fontControlAllows(part);
  expect(m.get("face")).toEqual(FONT_ALLOW_DEFAULT);
  expect(m.get("alt")).toEqual(["gstatic"]);
  expect(m.get("sub")).toEqual(["asset"]);
  expect(m.has("size")).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
nvm use && npx vitest run test/fonts-allow.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/framework/font-source.js`**

```js
// What a PARAM-supplied font source may be. Author-declared `fonts` sources are
// code and get no restriction (see the design doc §4); this file exists only
// for the other case — a value that arrived in `params`, which on a shared link
// is attacker-controlled text that would otherwise become a fetch URL.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.

export const FONT_ALLOW_DEFAULT = ["https"];

const GSTATIC_HOST = "fonts.gstatic.com";
const ASSET_SCHEME = "pfc-asset:";

// Parse once; an unparseable string is refused rather than guessed at.
function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function fontSourceAllowed(source, allow = FONT_ALLOW_DEFAULT) {
  if (typeof source !== "string") return false;   // bytes/thunks are never param-supplied
  const u = parse(source);
  if (!u) return false;
  for (const kind of allow) {
    // hostname, not host or a suffix test: `fonts.gstatic.com.evil.test` must
    // not pass, and neither must a userinfo trick like `https://fonts.gstatic.com@evil.test/`
    // (URL parsing puts `evil.test` in hostname, which is exactly why this
    // compares the parsed hostname rather than the raw string).
    if (kind === "gstatic" && u.protocol === "https:" && u.hostname === GSTATIC_HOST) return true;
    if (kind === "https" && u.protocol === "https:") return true;
    if (kind === "asset" && u.protocol === ASSET_SCHEME) return true;
  }
  return false;
}

// paramKey → allow list, for every `type: "font"` control in the authored tree.
// Walks sections and nested groups; deliberately tolerant of the legacy section
// shapes (advanced/toggles/features), which have no font controls but must not
// throw the walk.
export function fontControlAllows(part) {
  const out = new Map();
  const visit = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.controls)) visit(n.controls);
      if (n.type === "font" && typeof n.key === "string") {
        out.set(n.key, Array.isArray(n.allow) && n.allow.length ? n.allow : FONT_ALLOW_DEFAULT);
      }
    }
  };
  visit(part?.parameters);
  return out;
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
nvm use && npx vitest run test/fonts-allow.test.js
```

Expected: PASS.

- [ ] **Step 5: Write the failing integration test**

Append to `test/fonts-allow.test.js`:

```js
import { handle } from "../src/framework/jobs.js";

test("a param font source outside `allow` falls back to the default and warns", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://fonts.gstatic.com/s/ok/v1/ok.ttf" },
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const seen = [];
  const g = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }; };
  const posts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://evil.test/x.ttf" } }, (m) => posts.push(m));
  } finally { globalThis.fetch = g; }

  expect(seen).not.toContain("https://evil.test/x.ttf");     // never fetched
  expect(seen).toContain("https://fonts.gstatic.com/s/ok/v1/ok.ttf"); // fell back to the default
  const warn = posts.find((m) => m.type === "progress" && /not allowed/.test(m.phase));
  expect(warn, "a refused source must say so").toBeTruthy();
});
```

- [ ] **Step 6: Apply the check in `jobs.js`**

Add the import:

```js
import { fontControlAllows, fontSourceAllowed } from "./font-source.js";
```

and, in the fonts block from Task 2, sanitize `p` before calling `fontsFor`:

```js
    const { p, d } = resolveParams(part, msg.params);
    // A param bound to a `type: "font"` control is user input — on a shared
    // link it is arbitrary attacker-supplied text that `fonts: (p) => …` would
    // turn into a fetch URL. Refuse out-of-`allow` values back to the part's
    // own default rather than failing the build: a bad link should show the
    // part, not an error page.
    for (const [key, allow] of fontControlAllows(part)) {
      const v = p[key];
      if (v === undefined || fontSourceAllowed(v, allow)) continue;
      onProgress(`font source for "${key}" is not allowed — using the default`);
      p[key] = part.defaults?.[key];
    }
    const fontsDecl = fontsFor(part, p);
```

`resolveParams` returns a fresh object, so writing `p[key]` here does not mutate
the caller's params.

- [ ] **Step 7: Run and confirm pass**

```bash
nvm use && npx vitest run test/fonts-allow.test.js test/fonts-dynamic.test.js
```

Expected: PASS.

- [ ] **Step 8: Verify worker layering still holds**

```bash
nvm use && npx vitest run test/worker-layering.test.js test/lint-purity.test.js
```

Expected: PASS. `font-source.js` imports nothing, so it is safe in the worker graph.

- [ ] **Step 9: Commit**

```bash
git add src/framework/font-source.js src/framework/jobs.js test/fonts-allow.test.js
git commit -m "feat: constrain param-supplied font sources with an allow list"
```

---

### Task 4: The `"font"` control type (no catalog)

The widget without a picker: a button showing the current face, degrading to a
URL text field. Splitting this from the picker (Task 6) means the control type,
its registry entries and its label derivation get their own reviewable gate.

**Files:**
- Modify: `src/framework/panel/widget-specs.js`
- Create: `src/framework/panel/widgets/font.js`
- Modify: `src/framework/panel/widgets/index.js`
- Modify: `src/framework/app.css` (the `.font-btn` rules)
- Modify: `test/framework/panel/registry.test.js:5-7`
- Test: `test/framework/panel/font-widget.test.js` (create)

**Interfaces:**
- Consumes: `FONT_ALLOW_DEFAULT`, `fontSourceAllowed` (Task 3).
- Produces, all from `src/framework/panel/widgets/font.js`:
  - `makeFont(node, params, { onChange, onCommit, info, fontCatalog }) → { el, sync }` — the standard widget factory contract used by `render.js:215-228`.
  - `fontLabel(source) → { family, variant }` — the filename fallback label.
  - `variantLabel(variant) → string` — `"700"` → `"Bold"`, `"400i"` → `"Regular Italic"`.
  - `setFontPicker(fn)` / `openFontPicker` — the late-bound picker hook Task 6 fills.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/font-widget.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";
import { fontLabel } from "../../../src/framework/panel/widgets/font.js";

const GS = "https://fonts.gstatic.com/s/playfairdisplay/v37/abcdef.ttf";
const sec = (over = {}) => ({ id: "s", title: "S", controls: [
  { key: "face", type: "font", label: "Typeface", ...over },
] });

test("fontLabel reads family and variant off a pfc-asset filename", () => {
  expect(fontLabel("pfc-asset://11111111-2222-3333-4444-555555555555/playfair-display-700.ttf"))
    .toEqual({ family: "Playfair Display", variant: "700" });
  expect(fontLabel("pfc-asset://11111111-2222-3333-4444-555555555555/anton.ttf"))
    .toEqual({ family: "Anton", variant: null });
});

test("fontLabel falls back to the filename for an unknown URL", () => {
  expect(fontLabel("https://cdn.example.com/fonts/Courier-Prime.ttf").family).toBe("Courier Prime");
});

// A gstatic filename is a CONTENT HASH, not the family — `fontLabel` cannot do
// better than the hash, which is exactly why the provider gets `describe`.
test("fontLabel on a raw gstatic URL yields the hash, not the family", () => {
  expect(fontLabel(GS).family).toBe("Abcdef");
});

test("fontLabel never throws on junk", () => {
  for (const junk of ["", "not a url", null, undefined, 42]) {
    expect(() => fontLabel(junk)).not.toThrow();
  }
});

test("with no catalog the control is a plain URL text field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec()], params, () => {});
  const field = root.querySelector("input.text-input");
  expect(field).toBeTruthy();
  expect(root.querySelector("button.font-btn")).toBeNull();
  expect(field.value).toBe(GS);
});

test("the degraded field refuses an out-of-allow value on commit", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec({ allow: ["gstatic"] })], params, () => {});
  const field = root.querySelector("input.text-input");
  field.value = "http://evil.test/x.ttf";
  field.dispatchEvent(new Event("input"));
  field.dispatchEvent(new Event("change"));
  expect(params.face).toBe(GS);                       // unchanged
  expect(field.classList.contains("warn")).toBe(true);
});

test("with a catalog the control is a button, labelled via describe()", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec()], params, () => {}, undefined, {
    fontCatalog: {
      async search() { return []; },
      describe: (src) => (src === GS ? { family: "Playfair Display", variant: "700" } : null),
    },
  });
  const btn = root.querySelector("button.font-btn");
  expect(btn).toBeTruthy();
  await new Promise((r) => setTimeout(r, 0));                 // describe may be async
  expect(btn.querySelector(".fname").textContent).toBe("Playfair Display");
  expect(btn.querySelector(".fvar").textContent).toBe("Bold");
});

test("a provider with no describe() degrades to the filename label", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "pfc-asset://11111111-2222-3333-4444-555555555555/anton.ttf" };
  buildControls(root, [sec()], params, () => {}, undefined,
    { fontCatalog: { async search() { return []; } } });
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".fname").textContent).toBe("Anton");
});

test("sync repaints the button from params", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  const panel = buildControls(root, [sec()], params, () => {}, undefined,
    { fontCatalog: { async search() { return []; } } });
  params.face = "pfc-asset://11111111-2222-3333-4444-555555555555/anton.ttf";
  panel.syncValues();
  expect(root.querySelector(".fname").textContent).toBe("Anton");
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
nvm use && npx vitest run test/framework/panel/font-widget.test.js
```

Expected: FAIL — cannot resolve `widgets/font.js`.

- [ ] **Step 3: Register the type**

In `src/framework/panel/widget-specs.js`:

```js
// in WIDGET_SPECS, after "radio"
  { type: "font", kind: "control", fields: [...AUTHOR_COMMON, "allow", "preview"] },
// in AUTHOR_EXTRAS
  font: ["allow", "preview"],
```

In `src/framework/panel/widgets/index.js`:

```js
import { makeFont } from "./font.js";
// in WIDGET_FACTORIES
  font: makeFont,
```

Update `test/framework/panel/registry.test.js:5-7` — the list is asserted exactly:

```js
  expect(WIDGET_TYPES.sort()).toEqual(["checkbox", "font", "number", "radio", "readout", "select", "slider", "text", "textarea"]);
```

- [ ] **Step 4: Write `src/framework/panel/widgets/font.js`**

```js
// The `type: "font"` control. Its VALUE is a font source string — the same
// grammar `PartDefinition.fonts` already accepts — so everything downstream
// (presets, undo, the params hash, `when`) works with no special case.
//
// Two renderings. With a host-supplied `fontCatalog` it is a button showing the
// current face IN that face, opening the picker. Without one it degrades to a
// URL text field, so a standalone partforge app (which ships no catalog) still
// exposes the parameter.
import { attachInfo } from "../info.js";
import { FONT_ALLOW_DEFAULT, fontSourceAllowed } from "../../font-source.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const WEIGHTS = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
                  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
export const variantLabel = (v) => {
  if (!v) return "Regular";
  const w = String(v).replace(/i$/, ""), italic = /i$/.test(String(v));
  return `${WEIGHTS[w] ?? w}${italic ? " Italic" : ""}`;
};

// A source string → something human. Cloud's fetch_web_font stores files as
// `<family-slug>[-<variant>].ttf`, so the filename round-trips the label for
// free on the vendored path; a bare URL falls back to its filename stem.
export function fontLabel(source) {
  if (typeof source !== "string" || !source) return { family: "—", variant: null };
  let path = source;
  try { path = new URL(source).pathname; } catch { /* not a URL — use the raw string */ }
  const file = path.split("/").filter(Boolean).pop() ?? source;
  const stem = file.replace(/\.(ttf|otf)$/i, "");
  const m = /^(.*)-(\d{3}i?|italic)$/i.exec(stem);
  const slug = m ? m[1] : stem;
  const family = slug.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "—";
  return { family, variant: m ? m[2] : null };
}

export function makeFont(node, params, { onChange, onCommit, info, fontCatalog } = {}) {
  const allow = Array.isArray(node.allow) && node.allow.length ? node.allow : FONT_ALLOW_DEFAULT;
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label ?? node.key);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  if (!fontCatalog) {
    // Degraded path: a URL field. Unlike `text`, it does NOT write on every
    // keystroke — a half-typed URL is a guaranteed failed fetch, and the
    // rebuild loop would chase every one of them.
    const field = document.createElement("input");
    field.type = "text";
    field.className = "text-input";
    field.value = String(params[node.key] ?? "");
    field.addEventListener("change", () => {
      if (!fontSourceAllowed(field.value, allow)) { field.classList.add("warn"); return; }
      field.classList.remove("warn");
      params[node.key] = field.value;
      onChange?.();
      onCommit?.();
    });
    wrap.append(field);
    return { el: wrap, sync: () => { field.value = String(params[node.key] ?? ""); field.classList.remove("warn"); } };
  }

  const btn = el("button", "font-btn");
  btn.type = "button";
  const fname = el("span", "fname");
  const fvar = el("span", "fvar");
  btn.append(fname, fvar);
  btn.insertAdjacentHTML("beforeend",
    '<svg class="caret" width="8" height="7" viewBox="0 0 8 7" aria-hidden="true"><polygon points="0,0 8,0 4,7" fill="currentColor"/></svg>');
  wrap.append(btn);

  // The value alone cannot name a live-picked face: a gstatic filename is a
  // content hash. Ask the catalog first (it holds the reverse lookup), and fall
  // back to the filename — which is right for a vendored `<family>-<variant>.ttf`
  // and merely ugly for a hash. `describe` is optional and may be async, so the
  // label is painted twice: filename immediately, catalog answer when it lands.
  let paintSeq = 0;
  const paint = () => {
    const src = params[node.key];
    const seq = ++paintSeq;
    const show = ({ family, variant }) => {
      if (seq !== paintSeq) return;                  // a newer paint already won
      fname.textContent = family;
      fvar.textContent = variantLabel(variant);
      fname.style.fontFamily = `"${family}", var(--pf-sans)`;
    };
    show(fontLabel(src));
    if (typeof fontCatalog.describe !== "function") return;
    Promise.resolve()
      .then(() => fontCatalog.describe(src))
      .then((d) => { if (d?.family) show(d); })
      .catch(() => { /* a failed lookup keeps the filename label */ });
  };
  paint();

  // Task 6 replaces this with the real picker; the seam is deliberately one line.
  btn.addEventListener("click", () => {
    openFontPicker?.({ node, params, allow, fontCatalog, anchor: wrap, onPicked: () => { paint(); onChange?.(); onCommit?.(); } });
  });

  return { el: wrap, sync: paint };
}

// Assigned by font-picker.js when the panel bundle includes it (Task 6). Kept
// as a mutable binding rather than a static import so this file stays usable —
// and testable — without dragging the whole picker in.
export let openFontPicker = null;
export const setFontPicker = (fn) => { openFontPicker = fn; };
```

- [ ] **Step 5: Thread `opts` through `buildControls`**

`render.js` needs to accept and forward the options bag. In
`src/framework/panel/render.js`, change the signature at line 27:

```js
export function buildControls(root, parameters, params, onDirty, onCommit, opts = {}) {
```

and the factory call at line ~224:

```js
    const widget = factory(node, params, {
      onChange: () => { markCustom(); onEdit(); },
      onCommit: () => commit([node.key]),
      info,
      fontCatalog: opts.fontCatalog,
    });
```

- [ ] **Step 6: Add the CSS**

Append to `src/framework/app.css`, after the `.text-input` rules (~line 199):

```css
/* the `type: "font"` control — a button that shows the current face IN it */
.font-btn { width: 100%; display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer;
  background: var(--pf-input-bg); color: var(--pf-text-strong);
  border: 1px solid var(--pf-border); border-radius: var(--pf-radius-control); padding: 7px 9px; }
.font-btn:hover { border-color: color-mix(in oklab, var(--pf-accent) 45%, var(--pf-border)); }
.font-btn:focus-visible { outline: none; border-color: var(--pf-accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent); }
.font-btn .fname { flex: 1; min-width: 0; font-size: 15px; line-height: 1.25;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.font-btn .fvar { flex: none; font: 10px/1 var(--pf-mono); color: var(--pf-muted); }
.font-btn .caret { flex: none; opacity: .5; }
.text-input.warn { border-color: var(--pf-err); color: var(--pf-err); }
```

- [ ] **Step 7: Run the panel tests**

```bash
nvm use && npx vitest run test/framework/panel/
```

Expected: PASS, including the updated `registry.test.js`.

- [ ] **Step 8: Commit**

```bash
git add src/framework/panel/ src/framework/app.css test/framework/panel/
git commit -m "feat: add the font control type, with a URL-field fallback"
```

---

### Task 5: The `fontCatalog` mount option

**Files:**
- Modify: `src/framework/mount.js:237-239` (signature) and `:772-777` (the `buildControls` call)
- Test: `test/framework/panel/font-widget.test.js` (extend), `test/mount-font-catalog.test.js` (create)

**Interfaces:**
- Consumes: `buildControls(..., opts)` (Task 4).
- Produces: `mount(part, { fontCatalog })` where `fontCatalog` is `{ search(query, { limit }) → Promise<FontFamily[]>, describe?(source) → { family, variant } | null }` and `FontFamily` is `{ id, family, category, variants: [{ variant, label, url, bytes }], menuUrl }`. `describe` is optional — see spec §3 for why it exists.

- [ ] **Step 1: Write the failing test**

Create `test/mount-font-catalog.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../src/framework/panel/render.js";

// mount() boots a viewer and a worker, neither of which exists in a unit test —
// so the contract asserted here is the one mount is a thin pass-through for:
// the option reaches the widget factory. mount's own wiring is covered by the
// smoke check in Task 8.
test("buildControls forwards fontCatalog to the font widget", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const catalog = { async search() { return []; } };
  const params = { face: "https://fonts.gstatic.com/s/anton/v1/anton.ttf" };
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    params, () => {}, undefined, { fontCatalog: catalog });
  expect(root.querySelector("button.font-btn"), "catalog present → button form").toBeTruthy();
});

test("without the option the same control degrades", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "https://fonts.gstatic.com/s/anton/v1/anton.ttf" };
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    params, () => {});
  expect(root.querySelector("input.text-input"), "no catalog → text field").toBeTruthy();
});
```

- [ ] **Step 2: Run and confirm the second test passes, first fails**

```bash
nvm use && npx vitest run test/mount-font-catalog.test.js
```

Expected: both PASS already if Task 4 landed correctly. This file is the
regression guard for the seam, not a red test — that is fine and worth
stating: it exists so a later refactor cannot quietly drop the forwarding.

- [ ] **Step 3: Add the mount option**

In `src/framework/mount.js`, add `fontCatalog` to the destructured options at
line 237:

```js
export function mount(part, { createWorker, elements = {}, onBuild, onPick, onDownload, onViewChange, onParamsCommit, onAnnotationSend,
                              fontCatalog,
                              annotateSend = "viewbar",
                              container: legacyContainer, controls: legacyControls } = {}) {
```

and pass it at the `buildControls` call (~line 772):

```js
    const panel = buildControls(els.controls, part.parameters, params, () => {
      animCtl?.notifyUserEdit();
      onParamChange();
    }, onParamsCommit
      ? (changed) => onParamsCommit({ changed, params: { ...params } })
      : undefined,
      { fontCatalog });
```

- [ ] **Step 4: Document the option**

In `docs/AUTHORING-PARTS.md`, in the "Wiring a part into a runnable app"
section, after the existing `mount` options, add:

```markdown
- `fontCatalog` — a provider backing every `type: "font"` control in the part:

  - `search(query, { limit }) → Promise<FontFamily[]>`, where a `FontFamily` is
    `{ id, family, category, variants: [{ variant, label, url, bytes }],
    menuUrl }`. `url` is what the picker writes into `params`; `menuUrl` is a
    name-only subset used to draw the list row.
  - `describe(source) → { family, variant } | null` — optional reverse lookup so
    the closed control can name a face whose URL carries a hashed filename.

  partforge ships no provider — a host supplies one, and without it every font
  control renders as a URL field.
```

- [ ] **Step 5: Run the suite**

```bash
nvm use && npx vitest run test/mount-font-catalog.test.js test/framework/ test/export-mount-wiring.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js docs/AUTHORING-PARTS.md test/mount-font-catalog.test.js
git commit -m "feat: accept a fontCatalog provider in mount options"
```

---

### Task 6: The picker

Port the spike (`spike/font-picker.html`) into the panel. **The spike is the
implementation, not pseudocode** — it is a working picker over the real catalog,
committed at `spike/font-picker.html`. Read it first. The numbered list in
Step 3 is the diff from it: what changes moving into the panel, plus the parts
that are load-bearing and must survive the port. Every behavior below is
recorded in spec §6 and was settled with the user against a running build.

**Files:**
- Create: `src/framework/panel/font-picker.js`
- Modify: `src/framework/panel/widgets/font.js` (register the picker)
- Modify: `src/framework/app.css` (picker rules — port from the spike's `<style>`)
- Test: `test/framework/panel/font-picker.test.js` (create)

**Interfaces:**
- Consumes: `fontLabel`, `variantLabel`, `setFontPicker` (Task 4); `fontSourceAllowed` (Task 3).
- Produces: `openFontPicker({ node, params, allow, fontCatalog, anchor, onPicked }) → { close() }`.

Behavior the spec fixes (§6), all non-negotiable:

- **Takeover layout at every width** — the picker fills the rail, not an inline expansion.
- **Rows: family name in its own face + a mono caption** `N style(s) · category`. Right-aligned family size.
- **Row height 44 px** (comfortable), reserved before the face loads so there is no layout shift.
- **Variants are a second pane**, sliding in from the right over 260 ms with the browse pane parallaxing back; `prefers-reduced-motion` drops the transition.
- **A single-variant family never opens the variants pane** — the row click is the selection. This is the majority path: 1,036 of 1,942 catalog families ship one face.
- **Picking a weight does not leave the pane.** Commit and navigate are separate.
- **A `Done` button** in a footer shared by both panes, beside the live selection summary. `Esc` steps back from variants, then closes.
- **Virtualized list, reconciled on `(index, family)`** — not index alone. After a search the same index holds a different family; an index-keyed row keeps rendering the stale one. The spike hit this bug.
- **The panes need a positioned container** or the variants pane escapes it.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/font-picker.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { openFontPicker } from "../../../src/framework/panel/font-picker.js";

const fam = (family, variants, over = {}) => ({
  id: family, family, category: "sans", menuUrl: `https://fonts.gstatic.com/menu/${family}.ttf`,
  variants: variants.map((v) => ({ variant: v, label: v, url: `https://fonts.gstatic.com/s/${family}/v1/${v}.ttf`, bytes: 100 })),
  ...over,
});

const CATALOG = [fam("Anton", ["400"]), fam("Montserrat", ["400", "700"]), fam("Roboto", ["400", "700"])];
const catalog = { search: vi.fn(async (q) => CATALOG.filter((f) => !q || f.family.toLowerCase().includes(q.toLowerCase()))) };

function open(over = {}) {
  document.body.innerHTML = '<div id="anchor"></div>';
  const params = { face: CATALOG[2].variants[0].url };
  const handle = openFontPicker({
    node: { key: "face" }, params, allow: ["https"], fontCatalog: catalog,
    anchor: document.getElementById("anchor"), onPicked: () => {}, ...over,
  });
  return { handle, params };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a single-variant family commits on row click without opening variants", async () => {
  const { params } = open();
  await flush();
  const row = [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Anton"));
  row.click();
  await flush();
  expect(params.face).toBe("https://fonts.gstatic.com/s/Anton/v1/400.ttf");
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(false);
});

test("a multi-variant family opens the variants pane", async () => {
  const { params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(true);
  expect(document.querySelectorAll(".vrow").length).toBe(2);
  expect(params.face).toContain("/Montserrat/");        // default variant already committed
});

test("picking a weight commits and STAYS in the variants pane", async () => {
  const { params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  [...document.querySelectorAll(".vrow")].find((b) => b.dataset.v === "700").click();
  await flush();
  expect(params.face).toBe("https://fonts.gstatic.com/s/Montserrat/v1/700.ttf");
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(true);
  expect(document.querySelector(".vrow.on").dataset.v).toBe("700");
});

test("Done closes the picker; the last pick stands", async () => {
  const { handle, params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Anton")).click();
  await flush();
  document.querySelector(".pk-done").click();
  expect(document.querySelector(".picker")).toBeNull();
  expect(params.face).toContain("/Anton/");
  handle.close();                                       // idempotent
});

test("Escape steps back from variants before it closes", async () => {
  open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Roboto")).click();
  await flush();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".picker")).toBeNull();
});

test("search filters, and rows do not go stale at a reused index", async () => {
  open();
  await flush();
  const first = () => document.querySelector(".pk-row .pk-face").textContent;
  expect(first()).toBe("Anton");
  const search = document.querySelector(".pk-search");
  search.value = "montse"; search.dispatchEvent(new Event("input"));
  await flush();
  expect(first()).toBe("Montserrat");                   // index 0 re-rendered, not reused
});

test("an empty result shows an empty state, not a blank pane", async () => {
  open();
  await flush();
  const search = document.querySelector(".pk-search");
  search.value = "zzzznope"; search.dispatchEvent(new Event("input"));
  await flush();
  expect(document.querySelector(".pk-empty").hidden).toBe(false);
  expect(document.querySelectorAll(".pk-row").length).toBe(0);
});

test("a family whose url fails `allow` is not offered", async () => {
  const evil = { search: async () => [fam("Bad", ["400"], { variants: [{ variant: "400", label: "400", url: "http://evil.test/x.ttf", bytes: 1 }] })] };
  open({ fontCatalog: evil, allow: ["gstatic"] });
  await flush();
  expect(document.querySelectorAll(".pk-row").length).toBe(0);
  expect(document.querySelector(".pk-empty").hidden).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
nvm use && npx vitest run test/framework/panel/font-picker.test.js
```

Expected: FAIL — cannot resolve `font-picker.js`.

- [ ] **Step 3: Write `src/framework/panel/font-picker.js`**

Port the spike's picker. Structure the module as:

```js
// The `type: "font"` picker: a takeover panel over the rail with two sliding
// panes (families, then that family's weights) and a shared footer.
//
// Main-thread only — it is DOM-heavy and is NOT part of the worker graph.
// It draws list rows in each family's own face by loading Google's name-only
// `menuUrl` subset through a FontFace, which is why a row costs a few KB and
// not the whole family.
import { fontLabel, variantLabel, setFontPicker } from "./widgets/font.js";
import { fontSourceAllowed } from "../font-source.js";

const ROW_H = 44;                  // comfortable density (spec §6)
const OVERSCAN = 4;                // rows rendered above/below the viewport

export function openFontPicker({ node, params, allow, fontCatalog, anchor, onPicked }) { /* … */ }

setFontPicker(openFontPicker);
```

Implementation requirements, each traceable to a test above:

1. Build the DOM: `.picker` (positioned) > `.pk-panes` > two `.pk-pane`
   (`data-pane="browse"` and `data-pane="variants"`), plus `.pk-foot` with
   `.pk-sel` and `.pk-done`. Append to the rail element — walk up from `anchor`
   to the nearest `.rail`, falling back to `anchor.parentElement`.
2. Load the catalog via `fontCatalog.search("")`, then re-search on every
   `input` event on `.pk-search` (debounce 120 ms).
3. **Filter every family's variants through `fontSourceAllowed(url, allow)`**
   and drop families left with none. This is the UI half of Task 3.
4. Virtualize: a `.pk-spacer` sized `rows * ROW_H`, rows absolutely positioned
   at `translateY(i * ROW_H)`, reconciled on a key of
   `` `${i}|${family}|${selected ? 1 : 0}` ``. **Not index alone.**
5. A row is `.pk-face` (family name, `font-family: "<family>", var(--pf-sans)`)
   over `.pk-sub` (`` `${n} style${n === 1 ? "" : "s"} · ${category}` `` —
   note the singular) plus a right-aligned `.pk-meta` size.
6. Lazily load `menuUrl` for rows entering the window via `new FontFace(family, `url(${menuUrl})`)`
   added to `document.fonts`; guard with a `Set` so each family loads once.
   In a test environment `FontFace` may be absent — feature-detect and skip.
7. Row click: pick the family's current-or-default variant, commit, and open the
   variants pane **only if `variants.length > 1`**.
8. Variants pane: one `.vrow` per variant with `dataset.v`, sample text drawn at
   that weight/style. Clicking commits and repaints `.on` **without** closing.
9. Committing writes `params[node.key] = url`, calls `onPicked()`, and updates
   `.pk-sel` to `` `<b>${family}</b> · ${variantLabel(v)} · ${kb}K` ``.
10. `.pk-done` and the header `×` remove the picker from the DOM. `Escape`
    clears `at-variants` if set, else closes. Remove the `keydown` listener on
    close — the returned `{ close() }` must be idempotent.
11. Return `{ close }`.

- [ ] **Step 4: Port the picker CSS**

Copy the `.picker`, `.pk-*`, `.vrow`, `.chip` and `.vchip` rules from
`spike/font-picker.html`'s `<style>` block into `src/framework/app.css`, minus
the spike-only chrome (`.spike`, `.page*`, `.stage`, `.plate`, `.rail*`, the
token block, and the `data-mode="inline"` rules — takeover is the only mode).
Keep `position: relative` on `.picker`; it is load-bearing for the panes.

- [ ] **Step 5: Run the picker tests**

```bash
nvm use && npx vitest run test/framework/panel/
```

Expected: PASS.

- [ ] **Step 6: Confirm the picker stays out of the worker graph**

```bash
nvm use && npx vitest run test/worker-layering.test.js
```

Expected: PASS. If it fails, something in the worker graph imported
`widgets/font.js` — the `setFontPicker` indirection exists precisely so the
dependency runs picker → widget, never the reverse.

- [ ] **Step 7: Commit**

```bash
git add src/framework/panel/font-picker.js src/framework/panel/widgets/font.js src/framework/app.css test/framework/panel/font-picker.test.js
git commit -m "feat: the font picker — families, weights, and a Done footer"
```

---

### Task 7: Lint rules

**Files:**
- Create: `src/framework/lint/rules-fonts.js`
- Modify: `src/framework/lint/index.js:11-20`
- Test: `test/lint-fonts.test.js` (create)

**Interfaces:**
- Consumes: `fontControlAllows` (Task 3).
- Produces: `FONT_RULES` — an array of `{ id, run(ctx) → Finding[] }`, appended to `RULES`.

Two rules:
- `font-control-not-in-fonts` (**error**) — a `type: "font"` control whose `key` is not read by a function-form `fonts`. The picker writes a param nothing resolves; the font silently never changes.
- `font-source-scheme` (**warning**) — a `defaults` value for a font control that its own `allow` list would reject. It will be replaced by the default at build time, so the authored value is dead.

- [ ] **Step 1: Write the failing test**

Create `test/lint-fonts.test.js`:

```js
import { expect, test } from "vitest";
import { lintPart } from "../src/framework/lint.js";

const ids = (part) => lintPart(part).map((f) => f.id);
const base = {
  parts: { a: { build: (k) => k.cube(10) } },
  views: { v: { label: "V" } },
};

test("a font control with no function-form fonts is an error", () => {
  const part = { ...base,
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },
    fonts: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },   // STATIC — never reads p.face
  };
  expect(ids(part)).toContain("font-control-not-in-fonts");
});

test("the function form clears the rule", () => {
  const part = { ...base,
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },
    fonts: (p) => ({ face: p.face }),
  };
  expect(ids(part)).not.toContain("font-control-not-in-fonts");
});

test("a part with no font control is untouched by both rules", () => {
  const part = { ...base, parameters: [{ id: "s", controls: [{ key: "w", min: 1, max: 9 }] }], defaults: { w: 4 } };
  const found = ids(part);
  expect(found).not.toContain("font-control-not-in-fonts");
  expect(found).not.toContain("font-source-scheme");
});

test("a default the control's own allow list rejects warns", () => {
  const part = { ...base,
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://cdn.example.com/x.ttf" },
    fonts: (p) => ({ face: p.face }),
  };
  const f = lintPart(part).find((x) => x.id === "font-source-scheme");
  expect(f).toBeTruthy();
  expect(f.severity).toBe("warning");
  expect(f.message).toContain("cdn.example.com");
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
nvm use && npx vitest run test/lint-fonts.test.js
```

Expected: FAIL — the rule ids are absent.

- [ ] **Step 3: Write `src/framework/lint/rules-fonts.js`**

```js
// Group 8 — font-control well-formedness. Both conditions here are silent
// failures at runtime rather than errors: a picker bound to a key no `fonts`
// declaration reads changes a param and nothing else (the typeface never
// moves), and a default outside its own `allow` list is swapped for… itself,
// which is to say the part boots with no font at all.
//
// Detecting "does the fonts function read this key?" without executing the
// function is impossible in general, so the rule asks the cheaper, honest
// question: is `fonts` a function at all? A static `fonts` provably cannot
// depend on a param.
import { err, warn } from "./finding.js";
import { fontControlAllows, fontSourceAllowed } from "../font-source.js";

export const FONT_RULES = [
  {
    id: "font-control-not-in-fonts",
    run: ({ part }) => {
      const controls = fontControlAllows(part);
      if (controls.size === 0 || typeof part?.fonts === "function") return [];
      return [...controls.keys()].map((key) => err("font-control-not-in-fonts",
        `control "${key}" is a font picker, but this part's \`fonts\` is ${part?.fonts ? "a static object" : "missing"} — the picked value is never resolved.`,
        `Declare fonts as a function of params, e.g. fonts: (p) => ({ ${key}: p.${key} }), and reference it with k.text2d(str, { font: "${key}" }).`,
        "fonts"));
    },
  },
  {
    id: "font-source-scheme",
    run: ({ part }) => {
      const out = [];
      for (const [key, allow] of fontControlAllows(part)) {
        const v = part?.defaults?.[key];
        if (v === undefined || fontSourceAllowed(v, allow)) continue;
        out.push(warn("font-source-scheme",
          `defaults.${key} is "${String(v).slice(0, 120)}", which control "${key}" would refuse (allow: ${allow.join(", ")}).`,
          `Use a source the allow list accepts, or widen \`allow\` on the control. At build time this value is replaced by defaults.${key}, so as written the part has no usable font.`,
          "defaults"));
      }
      return out;
    },
  },
];
```

- [ ] **Step 4: Register the group**

In `src/framework/lint/index.js`, add the import and extend `RULES`:

```js
import { FONT_RULES } from "./rules-fonts.js";

export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES, ...VERIFY_RULES, ...ANIMATION_RULES, ...PLACE_RULES, ...IMPORT_RULES, ...FONT_RULES];
```

- [ ] **Step 5: Run the lint suite**

```bash
nvm use && npx vitest run test/lint-fonts.test.js test/lint-purity.test.js test/lint-registry.test.js test/lint-parts.test.js
```

Expected: PASS. `lint-purity` matters most — `font-source.js` imports nothing,
so the closure stays clean. If `lint-registry.test.js` asserts a rule count or
catalog, update it.

- [ ] **Step 6: Document the rules**

In `docs/AUTHORING-PARTS.md`'s "Rule catalog" section, add two rows matching
the surrounding format — `font-control-not-in-fonts` (error) and
`font-source-scheme` (warning), each with its one-line cause and fix.

- [ ] **Step 7: Commit**

```bash
git add src/framework/lint/ docs/AUTHORING-PARTS.md test/lint-fonts.test.js
git commit -m "feat: lint font controls for a resolvable fonts declaration"
```

---

### Task 8: Reference part, docs, and the version bump

**Files:**
- Modify: `src/parts/nameplate.js`
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `package.json` (version)
- Test: `test/nameplate-part.test.js` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing downstream — this is the closing task.

- [ ] **Step 1: Write the failing test**

Append to `test/nameplate-part.test.js`:

```js
import { fontsFor } from "../src/framework/fonts.js";
import { fontControlAllows } from "../src/framework/font-source.js";
import { lintPart } from "../src/framework/lint.js";

test("nameplate exposes a font control wired to a function-form fonts", () => {
  expect(fontControlAllows(part).has("face")).toBe(true);
  expect(typeof part.fonts).toBe("function");
  expect(fontsFor(part, part.defaults)).toHaveProperty("face");
});

test("nameplate lints clean", () => {
  expect(lintPart(part).filter((f) => f.severity === "error")).toEqual([]);
});
```

(`part` is already imported at the top of that file; if it is not, add
`import part from "../src/parts/nameplate.js";`.)

- [ ] **Step 2: Run and confirm failure**

```bash
nvm use && npx vitest run test/nameplate-part.test.js
```

Expected: FAIL — no `face` control.

- [ ] **Step 3: Add the control to `src/parts/nameplate.js`**

The nameplate is already the `text2d` reference, which makes it the right
reference for this too. Its `parameters` use the legacy section shape, so the
new control goes in a **new canonical section** — the two coexist by design
(`bracket.js` does the same).

Add to `parameters`, after the `text` section:

```js
    {
      id: "typeface",
      title: "Typeface",
      description: "The face the lettering is cut in. Falls back to the bundled Roboto when left as the default.",
      controls: [
        { key: "face", type: "font", label: "Typeface",
          description: "Any face the host's font catalog offers. Without a catalog this is a URL field — a direct link to a `.ttf` or `.otf` that allows cross-origin requests." },
      ],
    },
```

Add to `defaults`: `face: ""`.

Add the declaration and use it:

```js
  // A function of params, not a static map — that is what makes `face` a
  // parameter rather than a constant. An empty value declares nothing, and
  // text2d falls back to the bundled Roboto.
  fonts: (p) => (p.face ? { face: p.face } : {}),
```

and in `build`, pass the name only when one is declared:

```js
        let text = k.text2d(p.label, { size: p.size, align: "center", valign: "middle",
          lineHeight: p.size * 1.7, ...(p.face ? { font: "face" } : {}) });
```

- [ ] **Step 4: Run the part tests and the CLI against it**

```bash
nvm use && npx vitest run test/nameplate-part.test.js
nvm use && npx partforge lint src/parts/nameplate.js
nvm use && npx partforge measure src/parts/nameplate.js
```

Expected: tests PASS; `lint` exits 0; `measure` reports a watertight solid.

- [ ] **Step 5: Document the control type**

In `docs/AUTHORING-PARTS.md`:

1. **Control types table** (~line 620) — add the row:
   `| `"font"` | a typeface picker, or a URL field with no catalog | `allow`, `preview` |`
2. **`PartDefinition` contract** (~line 75) — amend the `fonts` line to note the
   function form: `fonts?, // { name: source } — or (p) => ({ name: source }) when a control drives the typeface`
3. **Font sourcing** section (~line 1303) — add a short subsection, "Making the
   typeface a parameter", showing the nameplate's three lines (control,
   function-form `fonts`, `font: "face"`) and stating plainly that a part with
   a fixed typeface needs none of it.
4. **`verify`** section — add the font-sensitivity note from spec §8: glyph
   advance widths differ by family, so a text part's bbox assertions should be
   bands, not points. `verify` runs against `defaults`, which is stable.

- [ ] **Step 6: Bump the version**

Additive contract change → minor. Edit `package.json`, incrementing the minor
and zeroing the patch (e.g. `0.72.0` → `0.73.0`). Confirm the current value
first:

```bash
node -p "require('./package.json').version"
```

**This is the step that is quiet when forgotten** — the merge lands, the version
already exists on npm, the publish workflow correctly does nothing, and the work
never ships (AGENTS.md § Releasing).

- [ ] **Step 7: Run everything**

```bash
nvm use && npm test
nvm use && node scripts/check-app.mjs nameplate.html
```

Expected: full suite PASS; the smoke check boots the nameplate app in Chromium
with no console errors. If Playwright's Chromium is missing:
`npm i -D playwright && npx playwright install chromium`.

- [ ] **Step 8: Commit**

```bash
git add src/parts/nameplate.js docs/AUTHORING-PARTS.md package.json test/nameplate-part.test.js
git commit -m "feat: make the nameplate's typeface a parameter; bump to 0.73.0"
```

---

## Notes carried out of planning

**Spec §4 was corrected before this plan was written.** An earlier draft put a
host allowlist on `resolveFonts` itself, which would have refused the
`https://cdn.example.com/fonts/Courier-Prime.ttf` source `AUTHORING-PARTS.md`
documents — a breaking change hidden inside a feature. The guard moved to
param-supplied values only (Task 3). Author-declared sources are unchanged.

**CLI limitation, accepted.** `bootKernel` resolves a function-form `fonts` once,
against base params. A `verify` case or animation frame that *changes* the font
param still builds with the base-params face, because the kernel is booted once
per CLI invocation. The browser path has no such limitation — `handle()`
re-resolves every job. Record this in the spec's accepted-risks list when Task 2
lands.

**Not in scope, by design:** the partforge-cloud half — the catalog proxy
endpoint, vendor-on-save, and the sandbox posture change. Spec §7 is the host
contract this plan builds against; that repo gets its own sibling spec once this
framework contract is real.
