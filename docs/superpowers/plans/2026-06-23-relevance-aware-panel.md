# Relevance-Aware Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide control-panel sections whose controls don't affect the on-screen parts of the active view, and dim (but keep interactive) individual controls that don't currently affect them — recomputed dynamically.

**Architecture:** A standalone, removable layer: a pure `param-deps.js` module probes which parameters the active view's on-screen sub-parts read (reusing the geometry-free probe kernel + recording Proxies); `buildControls` returns an additive `applyRelevance(...)` method that dims controls / hides sections from a relevant-key set; `mount.js` recomputes and applies it on the initial build, view changes, and every param edit.

**Tech Stack:** Vanilla ES modules, Vitest + happy-dom (panel tests) and plain Node (probe tests), Node 24.

## Global Constraints

- **Node 24 for tests** (`nvm use` first).
- **Isolation / removability:** the feature is exactly one new module (`param-deps.js`), one additive `applyRelevance` method on the `buildControls` return, and three call sites in `mount.js`. No changes to geometry, the worker, the kernel, the schema, or B's `description`/`hidden` handling. Removing those reverts the panel to current behavior.
- **Conservative fallback:** any probe error (`derive`, `enabled`, or a sub-part `build` throwing) yields the `RELEVANT_ALL` sentinel → nothing is dimmed or hidden. Never hide a control we couldn't analyze.
- **Dynamic:** relevance is recomputed on view change and on every param change (cheap — the probe builds no geometry). Geometry regeneration keeps its existing 180ms debounce; relevance updates immediately.
- **Irrelevant controls stay interactive** — dimmed + a hover hint only; editing them still changes the param.
- **The probe must not mutate `params`** — recording Proxies target a shallow clone.
- **Section hide is a reversible class toggle** (`.section-hidden` / `display:none`), distinct from B's `hidden` (which removes DOM).
- Commit messages follow repo convention; end with the `Co-Authored-By:`/`Claude-Session:` trailers.

---

## Task 1: Dependency probe (`param-deps.js`)

The pure, standalone core. No DOM. Reuses the geometry-free probe kernel and `viewSubParts`.

**Files:**
- Create: `src/framework/param-deps.js`
- Test: `test/framework/param-deps.test.js`

**Interfaces:**
- Produces:
  - `RELEVANT_ALL` — exported sentinel (a `Symbol`) meaning "treat everything relevant".
  - `relevantParamKeys(part, view, params) => Set<string> | RELEVANT_ALL` — the raw-param keys that affect the active view's on-screen sub-parts (direct `build` reads ∪ `enabled`-gate reads ∪ `derive` inputs when a visible sub-part reads a derived value). `RELEVANT_ALL` on any probe error.
- Consumes: `createProbeKernel` from `./geometry/probe.js`; `viewSubParts` from `./jobs.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/framework/param-deps.test.js`:

```js
import { expect, test } from "vitest";
import { relevantParamKeys, RELEVANT_ALL } from "../../src/framework/param-deps.js";

// part: subpart 'a' always reads p.x and p.on; reads p.y only when on>0.
const conditional = () => ({
  defaults: { x: 5, y: 3, on: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: { views: ["v"], build: (k, p) => {
      let s = k.cylinder(p.x, p.x, 10);
      if (p.on > 0) s = s.cut(k.cylinder(p.y, p.y, 12));
      return s;
    } },
  },
});

test("conditional read: y is relevant only when the gate is on", () => {
  const part = conditional();
  expect([...relevantParamKeys(part, "v", { ...part.defaults, on: 0 })].sort()).toEqual(["on", "x"]);
  expect([...relevantParamKeys(part, "v", { ...part.defaults, on: 1 })].sort()).toEqual(["on", "x", "y"]);
});

test("derive inputs are included only when a visible sub-part reads a derived value", () => {
  const usesDerived = {
    defaults: { a: 1, b: 2, c: 9 },
    views: { v: { label: "V" } },
    derive: (p) => ({ sum: p.a + p.b }),                 // reads a, b
    parts: { d: { views: ["v"], build: (k, p, d) => k.cylinder(d.sum, d.sum, 10) } }, // reads d.sum
  };
  expect([...relevantParamKeys(usesDerived, "v", usesDerived.defaults)].sort()).toEqual(["a", "b"]);

  const ignoresDerived = {
    defaults: { a: 1, b: 2, c: 9 },
    views: { v: { label: "V" } },
    derive: (p) => ({ sum: p.a + p.b }),
    parts: { d: { views: ["v"], build: (k, p) => k.cylinder(p.c, p.c, 10) } }, // reads p.c only, no d
  };
  expect([...relevantParamKeys(ignoresDerived, "v", ignoresDerived.defaults)].sort()).toEqual(["c"]);
});

test("a param used only in a sub-part's enabled() gate is relevant", () => {
  const part = {
    defaults: { capOn: 0, r: 4 },
    views: { v: { label: "V" } },
    parts: {
      base: { views: ["v"], build: (k, p) => k.cylinder(p.r, p.r, 10) },
      cap: { views: ["v"], enabled: (p) => p.capOn > 0, build: (k) => k.sphere(2) },
    },
  };
  expect([...relevantParamKeys(part, "v", part.defaults)].sort()).toEqual(["capOn", "r"]);
});

test("a throwing build yields RELEVANT_ALL", () => {
  const part = {
    defaults: { x: 1 }, views: { v: { label: "V" } },
    parts: { bad: { views: ["v"], build: () => { throw new Error("boom"); } } },
  };
  expect(relevantParamKeys(part, "v", part.defaults)).toBe(RELEVANT_ALL);
});

test("probing does not mutate the passed params", () => {
  const part = conditional();
  const params = { ...part.defaults, on: 1 };
  const snap = { ...params };
  relevantParamKeys(part, "v", params);
  expect(params).toEqual(snap);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/param-deps.test.js`
Expected: FAIL — cannot find module `../../src/framework/param-deps.js`.

- [ ] **Step 3: Implement the module**

Create `src/framework/param-deps.js`:

```js
// Which raw parameters affect the parts on screen in the active view. A removable
// relevance layer: the panel uses this to dim controls / hide sections that don't
// affect what's visible. Pure — no DOM, no real geometry (reuses the geometry-free
// probe kernel). Errs toward RELEVANT_ALL whenever it can't analyze a build.
import { createProbeKernel } from "./geometry/probe.js";
import { viewSubParts } from "./jobs.js";

export const RELEVANT_ALL = Symbol("relevant-all");

// A read-recording Proxy over a shallow clone of `obj`: records each top-level
// property key read into `seen`, returns the real value so the build's conditionals
// evaluate correctly, and never mutates the original `obj` (writes hit the clone).
function recorder(obj, seen) {
  return new Proxy({ ...obj }, {
    get(target, key) {
      if (typeof key === "string") seen.add(key);
      return Reflect.get(target, key);
    },
  });
}

export function relevantParamKeys(part, view, params) {
  try {
    const relevant = new Set();

    // derive: record which raw params feed it; produce real derived values once.
    const deriveInputs = new Set();
    const derived = part.derive ? (part.derive(recorder(params, deriveInputs)) ?? {}) : {};

    // gate params: a param read by a view sub-part's enabled() changes what's on screen.
    for (const name of Object.keys(part.parts)) {
      const sp = part.parts[name];
      if (sp.views.includes(view) && sp.enabled) sp.enabled(recorder(params, relevant));
    }

    // direct build reads across the on-screen (enabled) sub-parts.
    const { kernel } = createProbeKernel();
    let anyDerivedRead = false;
    for (const name of viewSubParts(part, view, params)) {
      const dSeen = new Set();
      part.parts[name].build(kernel, recorder(params, relevant), recorder(derived, dSeen));
      if (dSeen.size > 0) anyDerivedRead = true;
    }
    if (anyDerivedRead) for (const k of deriveInputs) relevant.add(k);

    return relevant;
  } catch {
    return RELEVANT_ALL; // couldn't analyze — treat everything as relevant
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/framework/param-deps.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `nvm use && npx vitest run`
Expected: PASS. (A pre-existing intermittent `test/cli-occt.test.js` parallel-run flake is unrelated; if it's the only failure, confirm the new test passes in isolation and proceed.)

- [ ] **Step 6: Commit**

```bash
git add src/framework/param-deps.js test/framework/param-deps.test.js
git commit -m "feat: add param-dependency probe for panel relevance"
```

---

## Task 2: Panel registry + `applyRelevance` (`controls.js` + `app.css`)

Make `buildControls` return an additive `applyRelevance` method that dims out-of-set controls and hides all-irrelevant sections.

**Files:**
- Modify: `src/framework/controls.js` (`buildControls`; thread a `register` callback into `buildPresetSection`/`buildFeatureSection`; add an `applyRelevance` helper)
- Modify: `src/framework/app.css` (append `.irrelevant` + `.section-hidden`)
- Test: `test/framework/controls.test.js` (extend; happy-dom docblock already present)

**Interfaces:**
- Consumes (in tests only): `RELEVANT_ALL` from `param-deps.js`.
- Produces: `buildControls(...)` now returns `{ applyRelevance(relevant) }`, where `relevant` is a `Set<string>` (dim/hide by membership) or any non-Set value (e.g. `RELEVANT_ALL` → show everything).

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/controls.test.js`:

```js
import { RELEVANT_ALL } from "../../src/framework/param-deps.js";

function buildPanel(parameters, params) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const panel = buildControls(root, parameters, params, () => {});
  return { root, panel };
}
const wrapByLabel = (root, t) =>
  [...root.querySelectorAll(".slider")].find((w) => w.querySelector("label")?.textContent === t);
const sectionByTitle = (root, t) =>
  [...root.querySelectorAll(".section")].find((s) => s.querySelector(".sec-title")?.textContent === t);

const twoSections = [
  { id: "body", title: "Body", advanced: [
    { key: "od", label: "OD", min: 1, max: 10, step: 1 },
    { key: "h", label: "H", min: 1, max: 10, step: 1 },
  ] },
  { id: "bore", title: "Bore", advanced: [{ key: "bore", label: "Bore", min: 1, max: 5, step: 1 }] },
];

test("buildControls returns an applyRelevance method", () => {
  const { panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  expect(typeof panel.applyRelevance).toBe("function");
});

test("applyRelevance dims out-of-set controls and hides all-irrelevant sections", () => {
  const { root, panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  panel.applyRelevance(new Set(["od"]));
  expect(wrapByLabel(root, "OD").classList.contains("irrelevant")).toBe(false);
  expect(wrapByLabel(root, "H").classList.contains("irrelevant")).toBe(true);
  expect(wrapByLabel(root, "H").getAttribute("title")).toMatch(/current view/i);
  // Bore section's only control is out of the set → section hidden
  expect(sectionByTitle(root, "Bore").classList.contains("section-hidden")).toBe(true);
  expect(sectionByTitle(root, "Body").classList.contains("section-hidden")).toBe(false);
});

test("re-applying a different set un-dims / re-shows", () => {
  const { root, panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  panel.applyRelevance(new Set(["od"]));
  panel.applyRelevance(new Set(["h", "bore"]));
  expect(wrapByLabel(root, "OD").classList.contains("irrelevant")).toBe(true);
  expect(wrapByLabel(root, "H").classList.contains("irrelevant")).toBe(false);
  expect(sectionByTitle(root, "Bore").classList.contains("section-hidden")).toBe(false);
});

test("applyRelevance(RELEVANT_ALL) clears all dimming and shows all sections", () => {
  const { root, panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  panel.applyRelevance(new Set([]));                 // everything irrelevant
  expect(sectionByTitle(root, "Body").classList.contains("section-hidden")).toBe(true);
  panel.applyRelevance(RELEVANT_ALL);
  expect(sectionByTitle(root, "Body").classList.contains("section-hidden")).toBe(false);
  expect(wrapByLabel(root, "OD").classList.contains("irrelevant")).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/controls.test.js -t relevance`
Expected: FAIL — `panel.applyRelevance is not a function` (buildControls returns undefined).

- [ ] **Step 3: Add the `applyRelevance` helper to `controls.js`**

Add near the top of `src/framework/controls.js` (after the visibility predicates):

```js
// --- relevance (dim controls / hide sections that don't affect on-screen parts) ---
// `relevant` is a Set of param keys, or any non-Set value (e.g. RELEVANT_ALL) → show all.
function applyRelevance(relevant, controls, sections) {
  const showAll = !(relevant instanceof Set);
  for (const { key, el: node } of controls) {
    const irrelevant = !showAll && !relevant.has(key);
    node.classList.toggle("irrelevant", irrelevant);
    if (irrelevant) node.title = "Doesn't affect the parts in the current view";
    else node.removeAttribute("title");
  }
  for (const { el: node, keys } of sections) {
    const anyRelevant = showAll || [...keys].some((k) => relevant.has(k));
    node.classList.toggle("section-hidden", !anyRelevant);
  }
}
```

- [ ] **Step 4: Build the registry + return the API from `buildControls`**

Replace `buildControls` with:

```js
export function buildControls(root, parameters, params, onDirty) {
  const controls = []; // { key, el } per control element
  const sections = []; // { el, keys:Set } per rendered section
  for (const sec of parameters) {
    if (!sectionRenders(sec)) continue;
    const section = el("div", "section");
    const title = el("div", "sec-title", sec.title);
    attachInfo(title, sec.description);
    section.append(title);
    const keys = new Set();
    const register = (key, node) => { controls.push({ key, el: node }); keys.add(key); };
    if (sec.features) buildFeatureSection(section, sec, params, onDirty, register);
    else buildPresetSection(section, sec, params, onDirty, register);
    root.append(section);
    sections.push({ el: section, keys });
  }
  return { applyRelevance: (relevant) => applyRelevance(relevant, controls, sections) };
}
```

- [ ] **Step 5: Register controls in `buildPresetSection`**

Change the signature and register each advanced control. Replace the `buildPresetSection` header line:

```js
function buildPresetSection(section, sec, params, onDirty) {
```

with:

```js
function buildPresetSection(section, sec, params, onDirty, register) {
```

and inside the `for (const def of advanced)` loop, after `syncs[def.key] = s.sync;`, add:

```js
      register(def.key, s.wrap);
```

- [ ] **Step 6: Register controls in `buildFeatureSection`**

Change the signature. Replace:

```js
function buildFeatureSection(section, sec, params, onDirty) {
```

with:

```js
function buildFeatureSection(section, sec, params, onDirty, register) {
```

Register the feature checkbox row — after `checkRow.append(box, featLabel);` add:

```js
    register(feat.key, checkRow);
```

Register each feature slider — inside `for (const def of feat.sliders.filter((d) => !d.hidden))`, after `group.append(s.wrap);` add:

```js
      register(def.key, s.wrap);
```

- [ ] **Step 7: Add CSS**

Append to `src/framework/app.css`:

```css
/* relevance: controls/sections that don't affect the on-screen parts */
.irrelevant { opacity: 0.45; }
.irrelevant:hover { opacity: 0.7; }
.section-hidden { display: none; }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS (existing clampToRange / hidden / popover tests + the 4 new relevance tests).

- [ ] **Step 9: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: PASS (modulo the known `cli-occt` parallel-run flake — confirm in isolation if it appears).

- [ ] **Step 10: Commit**

```bash
git add src/framework/controls.js src/framework/app.css test/framework/controls.test.js
git commit -m "feat: panel applyRelevance — dim irrelevant controls, hide irrelevant sections"
```

---

## Task 3: Wire relevance into mount (`mount.js`)

Capture the panel API and recompute relevance on initial build, view change, and param change.

**Files:**
- Modify: `src/framework/mount.js` (import; capture `buildControls` return; add `updateRelevance()`; call it at 3 sites)

**Interfaces:**
- Consumes: `relevantParamKeys` (Task 1); `buildControls(...) => { applyRelevance }` (Task 2). `view` and `params` are already in scope in `mount`.

- [ ] **Step 1: Import the probe**

In `src/framework/mount.js`, add to the imports (near `import { buildControls } from "./controls.js";`):

```js
import { relevantParamKeys } from "./param-deps.js";
```

- [ ] **Step 2: Capture the panel API and add `updateRelevance`**

Replace the existing build line:

```js
  buildControls(controls, part.parameters, params, onParamChange);
```

with:

```js
  const panel = buildControls(controls, part.parameters, params, onParamChange);
  const updateRelevance = () => panel.applyRelevance(relevantParamKeys(part, view, params));
  updateRelevance(); // initial view
```

- [ ] **Step 3: Recompute on param change**

In `onParamChange`, add `updateRelevance();` after `refreshView();`:

```js
  function onParamChange() {
    paramsVersion++; // every edit invalidates the caches (by version)
    refreshView();   // keep showing the now-stale mesh (no flicker); disable export
    updateRelevance();
    scheduleGenerate();
  }
```

- [ ] **Step 4: Recompute on view change**

In the `partSeg` click handler, add `updateRelevance();` after `refreshView();`:

```js
  partSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(view);
    for (const b of partSeg.children) b.classList.toggle("on", b === btn);
    refreshView();
    updateRelevance();
    maybeGenerate();
  });
```

- [ ] **Step 5: Run the full suite (no regressions, imports resolve)**

Run: `nvm use && npx vitest run`
Expected: PASS (modulo the known `cli-occt` flake).

- [ ] **Step 6: App smoke (boots clean with relevance wired)**

If Playwright + Chromium are installed:

Run: `nvm use && node scripts/check-app.mjs demo.html`
Expected: booted, 0 console errors — confirms `updateRelevance` runs on load/param paths without throwing. (If Playwright isn't installed, skip and note it; the controller will do a browser spot-check of section hide/dim behavior on a multi-view fixture.)

- [ ] **Step 7: Commit**

```bash
git add src/framework/mount.js
git commit -m "feat: recompute panel relevance on load, view change, and param edits"
```

---

## Self-review notes

- **Spec coverage:** probe + RELEVANT_ALL + derive/enabled/conditional handling + no-mutation (Task 1); registry + applyRelevance dim/hide + CSS (Task 2); 3-site dynamic wiring (Task 3). Isolation preserved (one module, one additive method, three call sites). All spec sections covered.
- **Placeholder scan:** none — full code/commands throughout.
- **Type consistency:** `relevantParamKeys(part, view, params) → Set | RELEVANT_ALL` defined in Task 1, consumed in Task 3; `applyRelevance(relevant)` treats Set vs non-Set consistently (Task 2 helper + return); `register(key, node)` signature consistent across buildControls/buildPresetSection/buildFeatureSection.
- **No geometry/worker/schema changes;** B's `hidden`/`description` paths untouched (relevance runs over already-rendered controls).
