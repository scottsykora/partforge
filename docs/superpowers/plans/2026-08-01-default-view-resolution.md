# Default View Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the viewer open on the part's assembly view — the one an author flags `default: true`, or failing that the view that places the most sub-parts — instead of always the first key in `part.views`.

**Architecture:** A new pure module `src/framework/default-view.js` owns the resolution rule and nothing else. `view-tabs.js` consumes it for the initial `on` button. Separately, `view-state.js`'s view persistence moves from a single global `localStorage` key to a part-scoped `sessionStorage` one, so a dev hot reload keeps the current tab without bleeding a view name between parts. The headless surfaces (`measure`, `verify`, `renderViews`) are untouched and stay on `Object.keys(part.views)[0]`.

**Tech Stack:** Plain ESM, vitest (+ happy-dom for DOM tests), no new dependencies.

**Design doc:** `docs/superpowers/specs/2026-08-01-default-view-resolution-design.md`

## Global Constraints

- **Node 24** — run `nvm use` before `npm install`, tests, or the CLI.
- **Framework modules are DOM-free unless they own DOM.** `default-view.js` must not touch `document`, `window`, or storage; it is a pure function of the part definition.
- **Persistence never throws.** Every storage read/write in `view-state.js` stays wrapped in try/catch; reads return the documented default, writes become no-ops.
- **No behavior change for existing parts.** All eight parts in `src/parts/` are single-view and must resolve to the view they open on today. Do not edit anything under `src/parts/`.
- **Headless defaults are out of scope.** Do not touch `src/testing/measure.js`, `src/testing/verify.js`, `src/testing/render.js`, or `bin/cli.js`.
- **Lint rule ids are docs-enforced.** `test/lint-registry.test.js` asserts every id in `RULES` appears in `docs/AUTHORING-PARTS.md`, so a new rule and its catalog entry ship in the same commit.

---

### Task 1: `resolveDefaultView`

**Files:**
- Create: `src/framework/default-view.js`
- Test: `test/framework/default-view.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveDefaultView(part) → string | null` — the view key the viewer should open on, or `null` when `part.views` is absent or empty.

- [ ] **Step 1: Write the failing test**

Create `test/framework/default-view.test.js`. No `@vitest-environment` pragma — this module is pure, so the default Node environment is correct.

```js
// resolveDefaultView: which view the tab bar opens on. Order is author override →
// most sub-parts placed at defaults → declaration order.
import { expect, test } from "vitest";
import { resolveDefaultView } from "../../src/framework/default-view.js";

const partWith = (views, parts, defaults = {}) => ({ meta: { title: "T" }, defaults, parts, views });

test("with no flag and equal counts, the first declared view wins", () => {
  const part = partWith(
    { a: { label: "A" }, b: { label: "B" } },
    { one: { views: ["a"] }, two: { views: ["b"] } },
  );
  expect(resolveDefaultView(part)).toBe("a");
});

test("the view placing the most sub-parts wins over declaration order", () => {
  const part = partWith(
    { solo: {}, assembly: {} },
    {
      base: { views: ["solo", "assembly"] },
      lid: { views: ["assembly"] },
      pin: { views: ["assembly"] },
    },
  );
  expect(resolveDefaultView(part)).toBe("assembly");
});

test("`default: true` beats a bigger view", () => {
  const part = partWith(
    { solo: { default: true }, assembly: {} },
    { base: { views: ["solo", "assembly"] }, lid: { views: ["assembly"] } },
  );
  expect(resolveDefaultView(part)).toBe("solo");
});

test("the first flagged view wins when several claim the default", () => {
  const part = partWith(
    { a: {}, b: { default: true }, c: { default: true } },
    { one: { views: ["a", "b", "c"] } },
  );
  expect(resolveDefaultView(part)).toBe("b");
});

test("sub-parts disabled at defaults don't count", () => {
  const part = partWith(
    { small: {}, big: {} },
    {
      base: { views: ["small"] },
      a: { views: ["big"], enabled: (p) => p.extras },
      b: { views: ["big"], enabled: (p) => p.extras },
    },
    { extras: false },
  );
  expect(resolveDefaultView(part)).toBe("small");
});

test("enabled() is evaluated against defaults, so an on-by-default sub-part counts", () => {
  const part = partWith(
    { small: {}, big: {} },
    {
      base: { views: ["small"] },
      a: { views: ["big"], enabled: (p) => p.extras },
      b: { views: ["big"], enabled: (p) => p.extras },
    },
    { extras: true },
  );
  expect(resolveDefaultView(part)).toBe("big");
});

test("a throwing enabled() counts the sub-part as present", () => {
  const part = partWith(
    { small: {}, big: {} },
    {
      base: { views: ["small"] },
      a: { views: ["big"], enabled: () => { throw new Error("boom"); } },
      b: { views: ["big"] },
    },
  );
  expect(resolveDefaultView(part)).toBe("big");
});

test("no views, an empty views map, or a missing part → null", () => {
  expect(resolveDefaultView({ views: {} })).toBeNull();
  expect(resolveDefaultView({})).toBeNull();
  expect(resolveDefaultView(undefined)).toBeNull();
});

test("a views map with no parts resolves to the first view", () => {
  expect(resolveDefaultView({ views: { a: {}, b: {} } })).toBe("a");
});

test("a missing defaults object is passed to enabled() as {}", () => {
  const part = {
    views: { a: {}, b: {} },
    parts: { x: { views: ["b"], enabled: (p) => p.on === undefined } },
  };
  expect(resolveDefaultView(part)).toBe("b");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/framework/default-view.test.js
```

Expected: FAIL — `Failed to resolve import "../../src/framework/default-view.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/framework/default-view.js`:

```js
// Which view a part opens on. The rule is independent of display order: an author
// can flag a view `default: true` wherever it sits in the tab bar, and when nobody
// flags one, the biggest view wins — the one placing the most sub-parts at the
// part's defaults, which for a multi-view part is the assembly. Ties fall back to
// declaration order, so every part written before this existed resolves to the view
// it has always opened on.
//
// Pure: no DOM, no storage, no kernel, no build. The headless surfaces (measure /
// verify / renderViews) deliberately do NOT use this — they stay on
// Object.keys(part.views)[0], where a mechanically obvious rule matters more than a
// convenient one.

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// A sub-part counts toward a view when it lists that view and is enabled at the
// part's defaults. A throwing `enabled` counts as present: the same instinct as
// mount's throwing-`derive` handling, and an unrelated predicate bug shouldn't
// silently demote a whole view.
function placedCount(part, view, defaults) {
  const parts = isPlainObject(part?.parts) ? part.parts : {};
  let n = 0;
  for (const sp of Object.values(parts)) {
    if (!Array.isArray(sp?.views) || !sp.views.includes(view)) continue;
    if (typeof sp.enabled !== "function") { n++; continue; }
    try { if (sp.enabled(defaults)) n++; } catch { n++; }
  }
  return n;
}

export function resolveDefaultView(part) {
  if (!isPlainObject(part?.views)) return null;
  const keys = Object.keys(part.views);
  if (keys.length === 0) return null;

  const flagged = keys.find((k) => part.views[k]?.default === true);
  if (flagged) return flagged;

  const defaults = isPlainObject(part?.defaults) ? part.defaults : {};
  let best = keys[0];
  let bestCount = placedCount(part, best, defaults);
  for (const k of keys.slice(1)) {
    const n = placedCount(part, k, defaults);
    if (n > bestCount) { best = k; bestCount = n; } // strict > keeps a tie on the earlier key
  }
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/framework/default-view.test.js
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/default-view.js test/framework/default-view.test.js
git commit -m "feat: resolveDefaultView picks a part's opening view"
```

---

### Task 2: Part-scoped session persistence for the active view

**Files:**
- Modify: `src/framework/view-state.js:1-19` (header + key map + storage helpers), `:59-65` (`loadView` / `saveView`)
- Test: `test/view-state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadView(partKey) → string | null` and `saveView(partKey, name) → void`, both backed by `sessionStorage` under `partforge:view:<partKey>`. Both no-op when `partKey` is not a non-empty string. `loadRotating`, `saveRotating`, `loadCamera`, `saveCamera`, `loadTheme`, `saveTheme` are unchanged and stay on `localStorage`.

- [ ] **Step 1: Write the failing tests**

In `test/view-state.test.js`, replace the `beforeEach` / `afterEach` pair at lines 17-18 with:

```js
beforeEach(() => {
  globalThis.localStorage = mockStorage();
  globalThis.sessionStorage = mockStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});
```

Replace the existing `"view round-trips a name; null when absent"` test (lines 34-38) with these four:

```js
test("view round-trips per part key in sessionStorage; null when absent", () => {
  expect(loadView("Planter")).toBeNull();
  saveView("Planter", "assembly");
  expect(loadView("Planter")).toBe("assembly");
  expect(globalThis.sessionStorage.getItem("partforge:view:Planter")).toBe("assembly");
});

test("a view saved for one part is not visible to another", () => {
  saveView("Planter", "assembly");
  expect(loadView("Bracket")).toBeNull();
});

test("the view is never written to localStorage", () => {
  saveView("Planter", "assembly");
  expect(globalThis.localStorage.getItem("partforge:view:Planter")).toBeNull();
  expect(globalThis.localStorage.getItem("partforge:view")).toBeNull();
});

test("an absent or empty part key is a no-op for load and save", () => {
  expect(loadView("")).toBeNull();
  expect(loadView(undefined)).toBeNull();
  saveView("", "assembly");
  saveView(undefined, "assembly");
  expect(globalThis.sessionStorage.getItem("partforge:view:")).toBeNull();
  expect(globalThis.sessionStorage.getItem("partforge:view:undefined")).toBeNull();
});
```

Replace the final `"storage that throws"` test (lines 70-85) with a version that makes both stores throw and uses the new signatures:

```js
test("storage that throws → loads return defaults, saves are no-ops", () => {
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  globalThis.localStorage = throwing;
  globalThis.sessionStorage = throwing;
  expect(loadRotating()).toBe(true);
  expect(loadCamera()).toBeNull();
  expect(loadView("Planter")).toBeNull();
  expect(loadTheme()).toBe("dark");
  expect(() => {
    saveRotating(false);
    saveCamera({ pos: [1, 2, 3], target: [0, 0, 0] });
    saveView("Planter", "x");
    saveTheme("light");
  }).not.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/view-state.test.js
```

Expected: FAIL — the round-trip test gets `null` from `loadView("Planter")` after saving, because the current `saveView` writes the single global `partforge:view` key in `localStorage`.

- [ ] **Step 3: Write the implementation**

In `src/framework/view-state.js`, replace the header comment (lines 1-5) with:

```js
// Persist a little viewer UI state across browser reloads (notably Vite dev
// auto-refresh). `rotating`, `camera` and `theme` live in localStorage under global
// keys — they're viewer preferences, not part state. The active view is different:
// it's scoped to one part and stored in sessionStorage, so a hot reload keeps your
// tab but the name can't bleed into another part that happens to share a view name,
// and a fresh session opens on the part's own default (see default-view.js).
// Reads/writes are guarded: if storage is unavailable (private mode, disabled) or a
// value is corrupt, reads return the documented default and writes are no-ops —
// persistence never throws.
```

Replace the `KEY` map (lines 7-12) with:

```js
const KEY = {
  rotating: "partforge:rotating",
  camera: "partforge:camera",
  theme: "partforge:theme",
};

const viewKey = (partKey) => `partforge:view:${partKey}`;
```

Immediately after the existing `write` helper (line 19), add the session-scoped pair:

```js
function readSession(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeSession(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* storage unavailable — no-op */ }
}
```

Replace `loadView` / `saveView` (lines 59-65) with:

```js
// `partKey` identifies the part — mount passes `meta.title`. Without one there is
// nothing safe to key on, so both calls no-op rather than falling back to a shared
// key (the cross-part bleed this scoping exists to remove).
export function loadView(partKey) {
  if (typeof partKey !== "string" || !partKey) return null;
  return readSession(viewKey(partKey)); // raw string or null; caller validates against available tabs
}

export function saveView(partKey, name) {
  if (typeof partKey !== "string" || !partKey) return;
  if (typeof name === "string" && name) writeSession(viewKey(partKey), name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/view-state.test.js
```

Expected: PASS.

`view-tabs.js` still calls the old signatures at this point, so its suite is expected to fail until Task 3. Confirm the failure is only there:

```bash
npx vitest run test/framework/view-tabs.test.js
```

Expected: FAIL — the two saved-view restore tests and the click-persistence assertion, because `view-tabs.js` still calls `loadView()` / `saveView(view)` with the old signatures. This is the known intermediate state; Task 3 closes it. Nothing else in the suite should be red.

- [ ] **Step 5: Commit**

```bash
git add src/framework/view-state.js test/view-state.test.js
git commit -m "feat: scope the persisted view per part in sessionStorage"
```

---

### Task 3: Wire the resolved default into the tab bar

**Files:**
- Modify: `src/framework/view-tabs.js` (whole file), `docs/AUTHORING-PARTS.md` (contract block ~line 88, Rules list ~line 112, host-element table ~line 705)
- Test: `test/framework/view-tabs.test.js`

**Interfaces:**
- Consumes: `resolveDefaultView(part)` from Task 1; `loadView(partKey)` / `saveView(partKey, name)` from Task 2.
- Produces: `createViewTabs(el, part, { onChange }) → { current, detach }` — signature and return shape unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/framework/view-tabs.test.js`, replace the fixture and `beforeEach` (lines 7-20) with:

```js
const part = {
  meta: { title: "Test part" },
  views: {
    assembly: { label: "Assembly" },
    drum: { label: "Drum" },
    bare: {}, // no label → key is the label
  },
};

let el;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div class="seg" id="part"></div>';
  el = document.getElementById("part");
});
```

Replace the two saved-view tests (lines 36-47) with sessionStorage equivalents:

```js
test("a saved view is restored and its tab marked active", () => {
  sessionStorage.setItem("partforge:view:Test part", "drum");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("drum");
  expect(el.querySelector("button.on").dataset.part).toBe("drum");
});

test("a saved view that matches no tab is ignored", () => {
  sessionStorage.setItem("partforge:view:Test part", "retired-view");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});

test("a view saved under another part's key is ignored", () => {
  sessionStorage.setItem("partforge:view:Other part", "drum");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});
```

In the click test (lines 49-58), replace the persistence assertion:

```js
  expect(sessionStorage.getItem("partforge:view:Test part")).toBe("drum");
```

Then append these three tests to the end of the file:

```js
test("the resolved default view opens, not the first key", () => {
  const multi = {
    meta: { title: "Multi" },
    defaults: {},
    parts: {
      body: { views: ["body", "assembly"] },
      lid: { views: ["assembly"] },
      pin: { views: ["assembly"] },
    },
    views: { body: { label: "Body" }, assembly: { label: "Assembly" } },
  };
  const tabs = createViewTabs(el, multi, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
  expect(el.querySelector("button.on").dataset.part).toBe("assembly");
  expect(el.querySelectorAll("button.on")).toHaveLength(1);
});

test("an author's `default: true` view opens", () => {
  const flagged = {
    meta: { title: "Flagged" },
    defaults: {},
    parts: { body: { views: ["body", "assembly"] }, lid: { views: ["assembly"] } },
    views: { body: { label: "Body", default: true }, assembly: { label: "Assembly" } },
  };
  const tabs = createViewTabs(el, flagged, { onChange: () => {} });
  expect(tabs.current()).toBe("body");
});

test("a part with no meta.title switches tabs but persists nothing", () => {
  const untitled = { views: { a: { label: "A" }, b: { label: "B" } } };
  const tabs = createViewTabs(el, untitled, { onChange: () => {} });
  el.querySelector('button[data-part="b"]').click();
  expect(tabs.current()).toBe("b");
  expect(sessionStorage.length).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/framework/view-tabs.test.js
```

Expected: FAIL — "the resolved default view opens" gets `"body"`, and the saved-view tests get `"assembly"` because `loadView` is still being called with no argument.

- [ ] **Step 3: Write the implementation**

Replace `src/framework/view-tabs.js` in full:

```js
import { resolveDefaultView } from "./default-view.js";
import { loadView, saveView } from "./view-state.js";

// The view-tab segmented control. When the part declares `views`, the buttons are
// generated from it (part.views is the single source of truth — host pages leave
// the #part div empty); a part without `views` keeps whatever buttons the page
// hand-wrote. Which tab opens is resolveDefaultView's call, not key order. The
// choice then persists per part for the rest of the browser session, so a Vite dev
// reload doesn't throw you back to the default mid-edit.
export function createViewTabs(el, part, { onChange }) {
  const generated = !!(el && part.views);
  const partKey = part?.meta?.title ?? "";
  const resolved = resolveDefaultView(part);
  if (generated) {
    el.innerHTML = Object.entries(part.views)
      .map(([key, v]) => `<button data-part="${key}"${key === resolved ? ' class="on"' : ""}>${v?.label ?? key}</button>`)
      .join("");
  }

  const setActive = (btn) => { for (const b of el.children) b.classList.toggle("on", b === btn); };

  // Initial view: the session-saved one if it still matches a tab, else the active
  // button — the resolved default for a generated bar, or whatever the page's own
  // markup marked `on` for a hand-written one.
  const defaultView = el.querySelector("button.on")?.dataset.part ?? el.querySelector("button")?.dataset.part;
  const saved = loadView(partKey);
  const savedBtn = saved ? [...el.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === saved) : null;
  let view = savedBtn ? saved : defaultView;
  if (savedBtn) setActive(savedBtn);

  const onClick = (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(partKey, view);
    setActive(btn);
    onChange(view);
  };
  el.addEventListener("click", onClick);

  return {
    current: () => view,
    detach: () => {
      el.removeEventListener("click", onClick);
      if (generated) el.innerHTML = ""; // we generated these buttons; hand-written markup stays
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/framework/view-tabs.test.js test/view-state.test.js test/framework/default-view.test.js
```

Expected: PASS, all three files.

- [ ] **Step 5: Update the authoring docs**

In `docs/AUTHORING-PARTS.md`, in the `PartDefinition` contract block, replace the `views` line:

```js
  views: { <name>: { label, default? } },  // the view tabs (a view = a set of sub-parts)
```

In the **Rules** list directly below, replace this bullet:

```markdown
- A view's sub-parts are derived, never hard-coded: those whose `views` include the view
  and whose `enabled(p)` is true.
```

with:

```markdown
- A view's sub-parts are derived, never hard-coded: those whose `views` include the view
  and whose `enabled(p)` is true.
- **Which view the viewer opens on** is resolved in this order: the first view flagged
  `default: true`; else the view placing the most sub-parts at `defaults` (counting
  `enabled(defaults)`), which for a multi-view part is normally the assembly; else the
  first key in `views`. So flag the assembly view `default: true` when you want it to
  open but sit last in the tab bar. The chosen tab then persists per part for the rest
  of the browser session. The headless tools are deliberately different: `measure`,
  `verify` and `render` all default to the **first key** in `views`, ignoring
  `default: true`, so a CI gate can't move because a sub-part was added to a view.
```

In the host-element ID table, replace the `#part` row:

```markdown
| `#part` | view-tab bar — leave the div **empty**; `mount` generates one button per entry in `part.views` and opens the one `default: true` / the biggest view selects (see the `views` rules above) |
```

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS. `test/lint-registry.test.js` reads `AUTHORING-PARTS.md`, so this also confirms the docs edit didn't break the docs-coverage assertion.

- [ ] **Step 7: Commit**

```bash
git add src/framework/view-tabs.js test/framework/view-tabs.test.js docs/AUTHORING-PARTS.md
git commit -m "feat: open the resolved default view instead of the first tab"
```

---

### Task 4: Lint the ambiguous-default case

**Files:**
- Modify: `src/framework/lint/rules-shape.js` (append to `SHAPE_RULES`), `docs/AUTHORING-PARTS.md` (rule catalog, "Definition shape" line)
- Test: `test/lint-shape.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks — the rule reads `part.views` directly.
- Produces: a `default-view-ambiguous` warning in `RULES`.

- [ ] **Step 1: Write the failing test**

Append to `test/lint-shape.test.js`, before the final `"every finding carries…"` test:

```js
test("two views both flagged default is a warning naming the winner", () => {
  const part = goodPart();
  part.views.main.default = true;
  part.views.extra = { label: "Extra", default: true };
  part.parts.body.views = ["main", "extra"];
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("default-view-ambiguous");
  expect(ids(r.errors)).not.toContain("default-view-ambiguous");
  const f = r.warnings.find((w) => w.rule === "default-view-ambiguous");
  expect(f.hint).toContain('"main"');
  expect(f.path).toBe("views.extra.default");
});

test("a single default-flagged view is not a finding", () => {
  const part = goodPart();
  part.views.main.default = true;
  expect(ids(lintPart(part).warnings)).not.toContain("default-view-ambiguous");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/lint-shape.test.js
```

Expected: FAIL — `expect(ids(r.warnings)).toContain("default-view-ambiguous")` gets an array without it.

- [ ] **Step 3: Write the implementation**

In `src/framework/lint/rules-shape.js`, append a fifth entry to `SHAPE_RULES`, after the `view-unused` object and before the closing `];`:

```js
  {
    id: "default-view-ambiguous",
    run: ({ part }) => {
      if (!isPlainObject(part?.views)) return [];
      const flagged = Object.keys(part.views).filter((v) => part.views[v]?.default === true);
      if (flagged.length < 2) return [];
      return [warn("default-view-ambiguous",
        `${flagged.length} views set \`default: true\`: ${flagged.map((v) => `"${v}"`).join(", ")}`,
        `Only one view can open by default. The viewer takes the first one declared — "${flagged[0]}" — and ignores the rest; remove \`default: true\` from the others.`,
        `views.${flagged[1]}.default`)];
    },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/lint-shape.test.js
```

Expected: PASS.

```bash
npx vitest run test/lint-registry.test.js
```

Expected: FAIL on `"every rule id is documented in AUTHORING-PARTS.md"` — the catalog entry lands in the next step.

- [ ] **Step 5: Document the rule**

In `docs/AUTHORING-PARTS.md`, in the **Rule catalog**, replace the "Definition shape" line:

```markdown
**Definition shape** — `missing-meta-title`, `missing-defaults`, `no-buildable-parts`,
`missing-views`, `part-view-unknown` (all errors); `view-unused`,
`default-view-ambiguous` (warnings).
```

- [ ] **Step 6: Run the lint suite**

```bash
npx vitest run test/lint-shape.test.js test/lint-registry.test.js
```

Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add src/framework/lint/rules-shape.js test/lint-shape.test.js docs/AUTHORING-PARTS.md
git commit -m "feat: lint warns when several views claim default: true"
```

---

### Task 5: Release prep

**Files:**
- Modify: `package.json:3`

**Interfaces:**
- Consumes: everything above.
- Produces: version `0.40.0` on the branch, ready for the tag-driven publish after merge.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.39.0"` to `"version": "0.40.0"`. Minor bump: `views[…].default` is a new authoring field and the opening tab changes for multi-view parts, but no existing API signature is removed from the public entry points.

- [ ] **Step 2: Run the whole suite**

```bash
npm test
```

Expected: PASS, no skips.

- [ ] **Step 3: Lint every shipped part**

```bash
for p in src/parts/*.js; do npx partforge lint "$p" || echo "FAILED: $p"; done
```

Expected: no `FAILED:` lines. None of the eight parts declares `default: true`, so none should trip the new rule.

- [ ] **Step 4: Smoke-test the apps in a real browser**

```bash
npm run check
```

Expected: PASS for `demo.html`, `planter.html`, `filleted-box.html`. This needs Playwright's Chromium (`npm i -D playwright && npx playwright install chromium`); if it isn't installed and you can't install it, say so in the PR rather than skipping silently.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: 0.40.0"
```

---

## Notes for the reviewer

- **Do not** change the headless view defaults in `src/testing/` or `bin/cli.js`. UI and headless disagreeing about "the default view" is intentional and documented in Task 3's Rules bullet.
- Stale `partforge:view` values in users' `localStorage` are deliberately left in place — nothing reads that key after Task 2, so the leftover string is inert and a migration would be more moving parts than it's worth.
- Tab persistence depends on `meta.title`. A part without one loses persistence rather than falling back to a shared key; `missing-meta-title` is already a lint error, so it shouldn't reach the viewer.
