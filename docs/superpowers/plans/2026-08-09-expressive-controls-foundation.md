# Expressive Control Panels — Foundation (Phases 1–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the control panel's three special-cased section shapes with one recursive node model, share that model with lint, and make sections collapsible with a small-panel auto-open rule — without changing what any existing part renders.

**Architecture:** A new `src/framework/panel/` directory splits today's 364-line `controls.js` into a pure schema layer (desugar legacy shapes → canonical nodes → render tree), a pure state layer (`computeState`, mirroring the existing `rail-state.js` / `rail.js` split), a widget registry that is the single source of truth for each control type's fields, and a thin DOM binder. `controls.js` stays at its path as the public entry and re-exports everything, because `animation-controls.js` and the test suite import from it.

**Tech Stack:** Plain ESM, no build step, no new dependencies. Vitest with `happy-dom` for DOM tests (`// @vitest-environment happy-dom` as the first line of the file). Node 24 — run `nvm use` before anything.

**Source spec:** `docs/superpowers/specs/2026-08-09-expressive-controls-panel-design.md`

## Global Constraints

- **Node 24.** Run `nvm use` before `npm install`, `npm test`, or the CLI. The default shell Node is too old and geometry/tests fail confusingly.
- **Zero new dependencies.** `test/lint-purity.test.js` asserts the entire `src/lint.js` import closure has *no* bare imports at all (`expect([...walk(ENTRY).bare]).toEqual([])`). Everything under `src/framework/panel/` that lint imports must therefore import nothing bare and must not reach `markdown.js` (which pulls `marked` + `dompurify`) or `controls.js`.
- **Phases 1 and 2 change no behavior.** `test/framework/controls.test.js` (27 tests), `test/lint-schema.test.js` (19 tests), and `test/lint-animations.test.js` must pass **completely unmodified**. If a test needs editing during Tasks 1–9, that is a regression — stop and fix the implementation.
- **Top-level sections stay flat DOM siblings.** `app.css:64` draws inter-section hairlines with `.section:not(.section-hidden) ~ .section:not(.section-hidden)`, and `controls.test.js:392` asserts flatness. Nesting happens only *inside* a section.
- **Units are millimetres**; part modules are DOM-free and side-effect-free. Neither is touched by this plan, but do not break them.
- **Version bump rides the branch.** Per `AGENTS.md`, bump `package.json` as part of the PR or the work silently never ships. Target for this plan: **0.47.0**.
- **Public exports of `controls.js` must not shrink.** `buildControls`, `createInfoPopover`, `attachInfo`, `clampToRange`, `popoverTop`, `sectionRenders`, `visibleAdvanced`, `visibleFeatures`, `visibleToggles`. `animation-controls.js:9` imports two of them; `controls.test.js:3,27` imports six.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/framework/panel/info.js` | `popoverTop`, `createInfoPopover`, `attachInfo` — the ⓘ popover, moved verbatim. Shared with `animation-controls.js`. |
| `src/framework/panel/legacy.js` | **Pure, zero-import.** The only code that knows `advanced` / `toggles` / `features` / `control:`. Exports `desugar()` plus the four legacy visibility predicates. |
| `src/framework/panel/model.js` | **Pure, zero-import.** `buildTree()`, `controlNodes()`, `evalWhen()`, `WHEN_OPS`. |
| `src/framework/panel/widget-specs.js` | **Pure, zero-import.** `WIDGET_SPECS` registry: per type, its node kind and allowed fields. |
| `src/framework/panel/panel-state.js` | **Pure, zero-import.** `computeState(tree, { params, relevant })` → `Map<id, {visible, disabled, dimmed, open}>`. |
| `src/framework/panel/widgets/numeric.js` | DOM factory for `slider` + `number`. |
| `src/framework/panel/widgets/text.js` | DOM factory for `text` + `textarea`. |
| `src/framework/panel/widgets/checkbox.js` | DOM factory for `checkbox`. |
| `src/framework/panel/widgets/index.js` | `WIDGET_FACTORIES` — type → factory. The DOM half of the registry. |
| `src/framework/panel/render.js` | The DOM binder: tree → elements, apply state, wire presets, expose the handle. |
| `test/framework/panel/legacy.test.js` | `desugar` unit tests, no DOM. |
| `test/framework/panel/model.test.js` | `buildTree` / `controlNodes` / `evalWhen` unit tests, no DOM. |
| `test/framework/panel/panel-state.test.js` | `computeState` unit tests, no DOM. |
| `test/framework/panel/registry.test.js` | Registry coherence: every spec has a factory and vice versa. |

**Modified:**

| File | Change |
|---|---|
| `src/framework/controls.js` | Becomes a ~20-line re-export barrel. |
| `src/framework/lint/rules-schema.js:9-11,20-60` | Drop the three hardcoded field allow-lists and the duplicated visibility predicates; consume `desugar` + the registry. |
| `src/framework/lint/rules-animations.js:28-41` | `paramRanges` consumes `controlNodes`. |
| `src/framework/app.css:55-88` | Section disclosure styles (Task 11 only). |
| `types/part.d.ts` | New node types; legacy types marked `@deprecated` (Task 12). |
| `package.json` | Version → 0.47.0 (Task 12). |

---

## Canonical node shapes

Every task below assumes these. `desugar` produces them with `hidden` nodes **retained**; `buildTree` drops hidden nodes and assigns `id`.

```js
// Group — a container. Top-level groups are the sections.
{ kind: "group", id, title, description, presets, collapsed, when, whenFalse, hidden, bare, children: [] }

// Control — a leaf bound to one key in `defaults`.
{ kind: "control", key, type, label, description, unit, min, max, step,
  on, preserveOn, customOnSync, when, whenFalse, hidden }
```

Field notes that matter for parity:

- `bare: true` on a group means "render as a plain `<div class="feat-group">`, no title, no disclosure". Used for a legacy feature's slider group.
- `preserveOn: true` on a checkbox means "on enable, only write `on` if the current value isn't already `> 0`" — the legacy **feature** behavior (`controls.js:352`). `false` means "always write `on`" — the legacy **toggle** behavior (`controls.js:286`).
- `customOnSync: true` means "when `syncValues()` touches this control, also drop the section's preset picker to `Custom`" — the legacy behavior for preset-section `advanced` controls (`controls.js:302`), which feature sliders deliberately do *not* have (`controls.js:346`).

**`when` is internal in this plan.** Authors do not get it until phase 5. But legacy `features` desugar to it, so every existing part with a feature section exercises it from Task 2 onward. That is deliberate: the conditions engine ships battle-tested against real parts before it is ever exposed.

---

## Phase 1 — Pure refactor (Tasks 1–7)

### Task 1: Move the ⓘ popover into `panel/info.js`

The smallest safe first cut: pure code motion, no logic change.

**Files:**
- Create: `src/framework/panel/info.js`
- Modify: `src/framework/controls.js:50-114` (remove), `src/framework/controls.js:9` (import)
- Test: `test/framework/controls.test.js` (existing, unmodified)

**Interfaces:**
- Consumes: nothing.
- Produces: `popoverTop({glyphTop, glyphBottom, popHeight, viewportHeight}) -> number`, `createInfoPopover() -> {toggle(glyph, description), dispose()}`, `attachInfo(container, description, info) -> void`. All three re-exported from `controls.js`.

- [ ] **Step 1: Run the existing popover tests to record the green baseline**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS, 27 tests.

- [ ] **Step 2: Create `src/framework/panel/info.js`**

Move `popoverTop`, `createInfoPopover`, and `attachInfo` **verbatim** from `controls.js:50-114`, plus the local `el()` helper they need. Keep every comment.

```js
// The ⓘ glyph and its per-panel popover. Shared by the control panel and the
// animation transport bar (animation-controls.js), which is why it is its own
// module rather than living inside the panel renderer.
import { renderMarkdown } from "../markdown.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Popover top edge: below the glyph when it fits, flipped above when the
// viewport bottom would clip it (e.g. the animation transport bar's ⓘ, which
// sits at the bottom of the stage). Pure, for direct unit testing — happy-dom
// reports zero layout metrics, so the flip can't be exercised via the DOM.
export function popoverTop({ glyphTop, glyphBottom, popHeight, viewportHeight }) {
  const below = glyphBottom + 6;
  if (below + popHeight <= viewportHeight - 8) return below;
  return Math.max(8, glyphTop - 6 - popHeight);
}
```

Then `createInfoPopover` and `attachInfo`, copied exactly as they stand at `controls.js:64-114`.

- [ ] **Step 3: Re-export from `controls.js`**

Replace the removed block with:

```js
export { popoverTop, createInfoPopover, attachInfo } from "./panel/info.js";
```

Keep the local `el()` in `controls.js` — the remaining widget code still uses it. Drop the now-unused `import { renderMarkdown }`.

- [ ] **Step 4: Verify nothing changed**

Run: `nvm use && npx vitest run test/framework/controls.test.js test/framework/mount.test.js`
Expected: PASS, unmodified. If any test needed editing, revert and find the difference.

- [ ] **Step 5: Verify the animation bar still resolves its import**

Run: `nvm use && npx vitest run`
Expected: full suite PASS. `animation-controls.js:9` imports `createInfoPopover, attachInfo` from `controls.js`; the re-export must satisfy it.

- [ ] **Step 6: Commit**

```bash
git add src/framework/panel/info.js src/framework/controls.js
git commit -m "Move the info popover into panel/info.js"
```

---

### Task 2: `panel/legacy.js` — desugar the old shapes

**Files:**
- Create: `src/framework/panel/legacy.js`
- Create: `test/framework/panel/legacy.test.js`

**Interfaces:**
- Consumes: nothing. **This module must import nothing at all** — lint depends on it in Task 8.
- Produces:
  - `desugar(parameters) -> GroupNode[]` — top-level groups, hidden nodes retained.
  - `visibleAdvanced(sec) -> ControlDef[]`, `visibleFeatures(sec) -> FeatureDef[]`, `visibleToggles(sec) -> ToggleDef[]`, `sectionRenders(sec) -> boolean` — the legacy predicates, moved unchanged so `controls.js` can keep exporting them.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/legacy.test.js`. No `@vitest-environment` line — this is pure.

```js
import { expect, test } from "vitest";
import { desugar } from "../../../src/framework/panel/legacy.js";

test("a preset section becomes a group with an Advanced child group", () => {
  const tree = desugar([{
    id: "body", title: "Body", presets: { A: { od: 5 } },
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }],
  }]);
  expect(tree).toHaveLength(1);
  const sec = tree[0];
  expect(sec.kind).toBe("group");
  expect(sec.title).toBe("Body");
  expect(sec.presets).toEqual({ A: { od: 5 } });
  expect(sec.children).toHaveLength(1);
  const adv = sec.children[0];
  expect(adv).toMatchObject({ kind: "group", title: "Advanced", collapsed: "auto" });
  expect(adv.children).toEqual([
    expect.objectContaining({ kind: "control", type: "slider", key: "od", label: "OD",
      min: 1, max: 10, step: 1, customOnSync: true }),
  ]);
});

test("toggles become checkbox controls placed before the Advanced group", () => {
  const [sec] = desugar([{
    id: "m", title: "Motor",
    toggles: [{ key: "show", label: "Show", on: 1, description: "preview" }],
    advanced: [{ key: "od", label: "OD", min: 0, max: 10, step: 1 }],
  }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["control", "group"]);
  expect(sec.children[0]).toMatchObject({
    kind: "control", type: "checkbox", key: "show", label: "Show",
    on: 1, preserveOn: false, description: "preview",
  });
});

test("a toggle with no `on` defaults to 1", () => {
  const [sec] = desugar([{ id: "m", toggles: [{ key: "show", label: "S" }] }]);
  expect(sec.children[0].on).toBe(1);
});

test("a feature becomes a checkbox plus a conditional bare group", () => {
  const [sec] = desugar([{
    id: "f", title: "Flange",
    features: [{ label: "Flange", key: "flange_d", on: 16,
      sliders: [{ key: "flange_d", label: "D", min: 1, max: 50, step: 1 }] }],
  }]);
  const adv = sec.children[0];
  expect(adv.title).toBe("Advanced");
  const [box, group] = adv.children;
  expect(box).toMatchObject({ kind: "control", type: "checkbox", key: "flange_d",
    on: 16, preserveOn: true });
  expect(group).toMatchObject({ kind: "group", bare: true,
    when: { flange_d: { gt: 0 } } });
  expect(group.children).toEqual([
    expect.objectContaining({ key: "flange_d", type: "slider", customOnSync: false }),
  ]);
});

test("hidden nodes are RETAINED — lint needs them", () => {
  const [sec] = desugar([{
    id: "body", hidden: true,
    advanced: [{ key: "secret", label: "S", min: 0, max: 1, step: 1, hidden: true }],
  }]);
  expect(sec.hidden).toBe(true);
  expect(sec.children[0].children[0]).toMatchObject({ key: "secret", hidden: true });
});

test("the legacy `control` field maps to `type`, defaulting to slider", () => {
  const [sec] = desugar([{ id: "b", advanced: [
    { key: "a", control: "number" }, { key: "b", control: "textarea" }, { key: "c" },
  ] }]);
  expect(sec.children[0].children.map((c) => c.type)).toEqual(["number", "textarea", "slider"]);
});

test("a feature with no sliders array does not throw", () => {
  // rules-schema.js flags this as an error, but desugar must survive it —
  // lint has to be able to walk a broken part in order to report on it.
  expect(() => desugar([{ id: "f", features: [{ key: "k", on: 1 }] }])).not.toThrow();
});

test("a section with no legacy arrays yields a group with no children", () => {
  const [sec] = desugar([{ id: "p", presets: { A: {} } }]);
  expect(sec.children).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/panel/legacy.test.js`
Expected: FAIL — "Failed to resolve import ... panel/legacy.js".

- [ ] **Step 3: Implement `src/framework/panel/legacy.js`**

```js
// Everything this project knows about the ORIGINAL parameter-schema shapes —
// `advanced`, `toggles`, `features`, and the `control:` field — lives here and
// nowhere else. Those shapes still work and still ship; when they are eventually
// retired, this is one file to delete rather than an archaeology dig through the
// model.
//
// Imports nothing, on purpose: partforge/lint consumes desugar() and
// test/lint-purity.test.js asserts lint's whole import closure has zero bare
// dependencies.

const arr = (x) => (Array.isArray(x) ? x : []);

// --- the legacy visibility predicates (unchanged behavior) ------------------
export const visibleAdvanced = (sec) => (sec.advanced ?? []).filter((d) => !d.hidden);
export const visibleFeatures = (sec) => (sec.features ?? []).filter((f) => !f.hidden);
export const visibleToggles = (sec) => (sec.toggles ?? []).filter((t) => !t.hidden);

export function sectionRenders(sec) {
  if (sec.hidden) return false;
  if (sec.features) return visibleFeatures(sec).length > 0;
  const hasPresets = sec.presets && Object.keys(sec.presets).length > 0;
  return !!hasPresets || visibleAdvanced(sec).length > 0 || visibleToggles(sec).length > 0;
}

// --- desugaring -------------------------------------------------------------

// One legacy control descriptor -> a control node. `customOnSync` records the
// legacy split at controls.js:302 vs :346 — a preset-section control drops its
// picker to "Custom" when synced externally, a feature's own slider does not.
const toControl = (d, customOnSync) => ({
  kind: "control",
  key: d.key,
  type: d.control ?? "slider",
  label: d.label,
  description: d.description,
  unit: d.unit,
  min: d.min,
  max: d.max,
  step: d.step,
  hidden: !!d.hidden,
  customOnSync,
});

const toCheckbox = (d, { preserveOn, on }) => ({
  kind: "control",
  key: d.key,
  type: "checkbox",
  label: d.label,
  description: d.description,
  on,
  preserveOn,
  hidden: !!d.hidden,
});

// A legacy feature -> [checkbox, bare group of its sliders gated on the checkbox].
// This is the whole point of the exercise: a feature stops being a special
// renderer path and becomes an ordinary conditional group.
function featureNodes(f) {
  const box = toCheckbox(f, { preserveOn: true, on: f.on });
  const group = {
    kind: "group",
    bare: true,
    hidden: !!f.hidden,
    when: { [f.key]: { gt: 0 } },
    children: arr(f.sliders).map((s) => toControl(s, false)),
  };
  return [box, group];
}

export function desugar(parameters) {
  return arr(parameters).map((sec) => {
    const children = [];

    // Toggles sit directly in the section, before the Advanced fold, exactly as
    // controls.js:278-289 rendered them.
    for (const t of arr(sec?.toggles)) {
      children.push(toCheckbox(t, { preserveOn: false, on: t.on ?? 1 }));
    }

    // Everything else lands inside an "Advanced" group. `collapsed: "auto"` is
    // what later hands these folds to the small-panel auto-open rule.
    const advChildren = [];
    for (const d of arr(sec?.advanced)) advChildren.push(toControl(d, true));
    for (const f of arr(sec?.features)) advChildren.push(...featureNodes(f));
    if (advChildren.length) {
      children.push({ kind: "group", title: "Advanced", collapsed: "auto",
        legacyAdvanced: true, children: advChildren });
    }

    return {
      kind: "group",
      id: sec?.id,
      title: sec?.title,
      description: sec?.description,
      presets: sec?.presets,
      collapsed: "auto",
      hidden: !!sec?.hidden,
      children,
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `nvm use && npx vitest run test/framework/panel/legacy.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the module imports nothing**

Run: `nvm use && node -e "import('./src/framework/panel/legacy.js').then(()=>console.log('ok'))"`
Expected: prints `ok`. Then confirm by eye that the file has no `import` statement — Task 8 depends on it.

- [ ] **Step 6: Commit**

```bash
git add src/framework/panel/legacy.js test/framework/panel/legacy.test.js
git commit -m "Add panel/legacy.js: desugar the original schema shapes to nodes"
```

---

### Task 3: `panel/model.js` — tree building and conditions

**Files:**
- Create: `src/framework/panel/model.js`
- Create: `test/framework/panel/model.test.js`

**Interfaces:**
- Consumes: node shapes from `desugar` (Task 2).
- Produces:
  - `buildTree(canonical) -> GroupNode[]` — drops hidden nodes and empty groups, assigns `id` to every node.
  - `controlNodes(tree) -> ControlNode[]` — depth-first flat walk of `kind === "control"`.
  - `evalWhen(condition, params) -> boolean`.
  - `WHEN_OPS` — the operator table, `{ gt, gte, lt, lte, ne, in }`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/model.test.js`:

```js
import { expect, test } from "vitest";
import { buildTree, controlNodes, evalWhen, WHEN_OPS } from "../../../src/framework/panel/model.js";

const group = (over = {}) => ({ kind: "group", children: [], ...over });
const control = (key, over = {}) => ({ kind: "control", key, type: "slider", ...over });

test("buildTree drops hidden controls, hidden groups, and groups left empty", () => {
  const tree = buildTree([
    group({ title: "A", children: [control("a"), control("b", { hidden: true })] }),
    group({ title: "B", children: [control("c", { hidden: true })] }),
    group({ title: "C", hidden: true, children: [control("d")] }),
  ]);
  expect(tree.map((g) => g.title)).toEqual(["A"]);
  expect(tree[0].children.map((c) => c.key)).toEqual(["a"]);
});

test("a group with presets survives even with no visible children", () => {
  const tree = buildTree([group({ title: "P", presets: { A: {} }, children: [] })]);
  expect(tree).toHaveLength(1);
});

test("buildTree assigns stable positional ids, honouring an authored id", () => {
  const tree = buildTree([
    group({ id: "body", children: [control("a"), group({ children: [control("b")] })] }),
    group({ children: [control("c")] }),
  ]);
  expect(tree[0].id).toBe("body");
  expect(tree[0].children[0].id).toBe("body/0");
  expect(tree[0].children[1].id).toBe("body/1");
  expect(tree[0].children[1].children[0].id).toBe("body/1/0");
  expect(tree[1].id).toBe("1");
});

test("ids are stable across repeated builds of the same schema", () => {
  const schema = () => [group({ children: [control("a"), control("b")] })];
  const ids = (t) => controlNodes(t).map((c) => c.id);
  expect(ids(buildTree(schema()))).toEqual(ids(buildTree(schema())));
});

test("controlNodes walks depth-first and returns only controls", () => {
  const tree = buildTree([group({ children: [
    control("a"),
    group({ children: [control("b"), control("c")] }),
    control("d"),
  ] })]);
  expect(controlNodes(tree).map((c) => c.key)).toEqual(["a", "b", "c", "d"]);
});

test("evalWhen: absent condition is always true", () => {
  expect(evalWhen(undefined, { a: 1 })).toBe(true);
});

test("evalWhen: bare value is equality", () => {
  expect(evalWhen({ mode: "round" }, { mode: "round" })).toBe(true);
  expect(evalWhen({ mode: "round" }, { mode: "square" })).toBe(false);
});

test("evalWhen: every comparison operator", () => {
  expect(evalWhen({ w: { gt: 2 } }, { w: 3 })).toBe(true);
  expect(evalWhen({ w: { gt: 2 } }, { w: 2 })).toBe(false);
  expect(evalWhen({ w: { gte: 2 } }, { w: 2 })).toBe(true);
  expect(evalWhen({ w: { lt: 2 } }, { w: 1 })).toBe(true);
  expect(evalWhen({ w: { lte: 2 } }, { w: 2 })).toBe(true);
  expect(evalWhen({ w: { ne: 2 } }, { w: 3 })).toBe(true);
  expect(evalWhen({ w: { in: [1, 2] } }, { w: 2 })).toBe(true);
  expect(evalWhen({ w: { in: [1, 2] } }, { w: 3 })).toBe(false);
});

test("evalWhen: multiple keys in one object are ANDed", () => {
  expect(evalWhen({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  expect(evalWhen({ a: 1, b: 2 }, { a: 1, b: 9 })).toBe(false);
});

test("evalWhen: allOf, anyOf, not", () => {
  expect(evalWhen({ allOf: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 2 })).toBe(true);
  expect(evalWhen({ allOf: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 9 })).toBe(false);
  expect(evalWhen({ anyOf: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 2 })).toBe(true);
  expect(evalWhen({ anyOf: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 9 })).toBe(false);
  expect(evalWhen({ not: { a: 1 } }, { a: 2 })).toBe(true);
  expect(evalWhen({ not: { a: 1 } }, { a: 1 })).toBe(false);
});

test("evalWhen: the legacy feature gate reads as expected", () => {
  expect(evalWhen({ flange_d: { gt: 0 } }, { flange_d: 16 })).toBe(true);
  expect(evalWhen({ flange_d: { gt: 0 } }, { flange_d: 0 })).toBe(false);
});

test("evalWhen: an unknown operator is false, never a throw", () => {
  expect(evalWhen({ w: { bogus: 1 } }, { w: 5 })).toBe(false);
});

test("WHEN_OPS is the single source of truth for operator names", () => {
  expect(Object.keys(WHEN_OPS).sort()).toEqual(["gt", "gte", "in", "lt", "lte", "ne"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/panel/model.test.js`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `src/framework/panel/model.js`**

```js
// The pure panel model: canonical nodes in, render tree out, plus the condition
// evaluator. No DOM, no dependencies — partforge/lint imports this and
// test/lint-purity.test.js requires its whole closure to be dependency-free.

// The operator table IS the grammar. evalWhen dispatches through it and (from
// phase 5) `when-unknown-operator` builds its did-you-mean list from its keys,
// so adding an operator can never leave lint behind.
export const WHEN_OPS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  ne: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
};

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// A condition against raw params. Never throws: a malformed condition reads as
// false, because a panel that crashes is worse than a control that hides.
export function evalWhen(cond, params) {
  if (cond == null) return true;
  if (!isPlainObject(cond)) return false;
  for (const [key, want] of Object.entries(cond)) {
    if (key === "allOf") {
      if (!Array.isArray(want) || !want.every((c) => evalWhen(c, params))) return false;
    } else if (key === "anyOf") {
      if (!Array.isArray(want) || !want.some((c) => evalWhen(c, params))) return false;
    } else if (key === "not") {
      if (evalWhen(want, params)) return false;
    } else if (isPlainObject(want)) {
      const entries = Object.entries(want);
      if (entries.length === 0) return false;
      for (const [op, operand] of entries) {
        const fn = WHEN_OPS[op];
        if (!fn || !fn(params[key], operand)) return false;
      }
    } else if (params[key] !== want) {
      return false;
    }
  }
  return true;
}

// --- tree building ----------------------------------------------------------

const renders = (node) => {
  if (node.hidden) return false;
  if (node.kind !== "group") return true;
  if (node.presets && Object.keys(node.presets).length > 0) return true;
  return node.children.length > 0;
};

// Drop hidden nodes and groups left empty, and stamp a stable id on everything.
// Ids are positional, so they are stable across rebuilds of the same schema; an
// authored `id` replaces the last segment.
function assign(nodes, prefix) {
  const out = [];
  nodes.forEach((node, i) => {
    if (node.hidden) return;
    const id = node.id ?? (prefix ? `${prefix}/${i}` : String(i));
    if (node.kind !== "group") {
      out.push({ ...node, id });
      return;
    }
    const built = { ...node, id, children: assign(node.children ?? [], id) };
    if (renders(built)) out.push(built);
  });
  return out;
}

export const buildTree = (canonical) => assign(canonical ?? [], "");

// Depth-first flat walk of the control leaves. Used by the renderer, by lint's
// range checks, and by anything that needs "every parameter this panel binds".
export function controlNodes(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.kind === "group") walk(n.children);
      else if (n.kind === "control") out.push(n);
    }
  };
  walk(tree);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `nvm use && npx vitest run test/framework/panel/model.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/model.js test/framework/panel/model.test.js
git commit -m "Add panel/model.js: tree building, ids, and the condition evaluator"
```

---

### Task 4: `panel/widget-specs.js` — the type registry

This is the module that stops `rules-schema.js` from hand-maintaining field allow-lists.

**Files:**
- Create: `src/framework/panel/widget-specs.js`
- Create: `test/framework/panel/registry.test.js`

**Interfaces:**
- Consumes: nothing. **Must import nothing** — lint depends on it in Task 8.
- Produces: `WIDGET_SPECS` (array of `{ type, kind, fields }`), `specFor(type) -> spec | undefined`, `fieldsFor(type) -> string[]`, `WIDGET_TYPES -> string[]`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/registry.test.js`:

```js
import { expect, test } from "vitest";
import { WIDGET_SPECS, WIDGET_TYPES, specFor, fieldsFor } from "../../../src/framework/panel/widget-specs.js";

test("the registry covers exactly the types this phase supports", () => {
  expect(WIDGET_TYPES.sort()).toEqual(["checkbox", "number", "slider", "text", "textarea"]);
});

test("every spec declares a kind and a non-empty field list", () => {
  for (const spec of WIDGET_SPECS) {
    expect(spec.kind, `${spec.type}.kind`).toBe("control");
    expect(spec.fields.length, `${spec.type}.fields`).toBeGreaterThan(0);
  }
});

test("every numeric type accepts the legacy control fields", () => {
  // rules-schema.js's CONTROL_FIELDS, which the registry replaces. Losing one of
  // these makes unknown-control-field warn on a perfectly legitimate field.
  for (const f of ["key", "label", "unit", "min", "max", "step", "control", "hidden", "description"]) {
    expect(fieldsFor("slider"), `slider is missing "${f}"`).toContain(f);
  }
});

test("checkbox accepts the legacy toggle and feature fields", () => {
  for (const f of ["key", "label", "on", "hidden", "description"]) {
    expect(fieldsFor("checkbox"), `checkbox is missing "${f}"`).toContain(f);
  }
});

test("specFor returns undefined for an unknown type", () => {
  expect(specFor("nope")).toBeUndefined();
  expect(fieldsFor("nope")).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/panel/registry.test.js`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `src/framework/panel/widget-specs.js`**

```js
// The control-type registry. Declaring a type here is what makes it real: the
// renderer looks up its DOM factory by type, and partforge/lint derives its
// accepted-field list from `fields` instead of hardcoding one.
//
// Before this existed, rules-schema.js carried three hand-maintained allow-lists
// (CONTROL_FIELDS / FEATURE_FIELDS / TOGGLE_FIELDS) that had to be edited in
// lockstep with the renderer — and when they weren't, `unknown-control-field`
// warned on legitimate fields. Adding a type or a field is now one edit here.
//
// Imports nothing: lint consumes this and test/lint-purity.test.js requires a
// dependency-free closure.

// Fields every control node may carry, whatever its type.
const COMMON = ["key", "label", "description", "hidden", "when", "whenFalse", "control", "type"];
const NUMERIC = [...COMMON, "unit", "min", "max", "step"];

export const WIDGET_SPECS = [
  { type: "slider", kind: "control", fields: NUMERIC },
  { type: "number", kind: "control", fields: NUMERIC },
  { type: "text", kind: "control", fields: COMMON },
  { type: "textarea", kind: "control", fields: COMMON },
  { type: "checkbox", kind: "control", fields: [...COMMON, "on"] },
];

const BY_TYPE = new Map(WIDGET_SPECS.map((s) => [s.type, s]));

export const WIDGET_TYPES = WIDGET_SPECS.map((s) => s.type);
export const specFor = (type) => BY_TYPE.get(type);
export const fieldsFor = (type) => BY_TYPE.get(type)?.fields ?? [];
```

Note `"control"` and `"type"` are both in `COMMON`: `control` is the legacy field name and `type` the new one, and both must be accepted or `unknown-control-field` regresses in Task 8.

- [ ] **Step 4: Run the tests**

Run: `nvm use && npx vitest run test/framework/panel/registry.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/widget-specs.js test/framework/panel/registry.test.js
git commit -m "Add the widget-spec registry as the source of truth for control fields"
```

---

### Task 5: `panel/widgets/` — DOM factories per type

Pure code motion out of `controls.js`, reshaped to a uniform factory signature.

**Files:**
- Create: `src/framework/panel/widgets/numeric.js`, `src/framework/panel/widgets/text.js`, `src/framework/panel/widgets/checkbox.js`, `src/framework/panel/widgets/index.js`
- Modify: `test/framework/panel/registry.test.js` (add the coherence test)

**Interfaces:**
- Consumes: `attachInfo` from `panel/info.js`; `WIDGET_TYPES` from `panel/widget-specs.js`.
- Produces: `WIDGET_FACTORIES` — `{ [type]: (node, params, ctx) => ({ el, sync }) }`, where `ctx` is `{ onChange, info }`. `onChange()` is called after any user edit; `sync()` re-reads `params` into the widget and must never call `onChange`.

- [ ] **Step 1: Write the failing coherence test**

Append to `test/framework/panel/registry.test.js`:

```js
import { WIDGET_FACTORIES } from "../../../src/framework/panel/widgets/index.js";

test("every registered type has a DOM factory, and every factory a spec", () => {
  expect(Object.keys(WIDGET_FACTORIES).sort()).toEqual([...WIDGET_TYPES].sort());
  for (const type of WIDGET_TYPES) {
    expect(typeof WIDGET_FACTORIES[type], `${type} factory`).toBe("function");
  }
});
```

This is the test that stops the registry, the renderer, and the types from drifting the way the three schema walkers did.

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/panel/registry.test.js`
Expected: FAIL — unresolved `widgets/index.js`.

- [ ] **Step 3: Create `src/framework/panel/widgets/numeric.js`**

Move `makeSlider` from `controls.js:130-186` verbatim, renaming the parameter `def` → `node` and returning `{ el, sync }` instead of `{ wrap, sync }`.

```js
// slider + number: a range input (omitted for `number`) beside an editable value
// box. The box accepts exact values finer than `step`; typed values clamp to
// [min, max] on commit (blur/Enter).
import { attachInfo } from "../info.js";

// Short numeric string without float noise (4 dp max) for the value box.
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

export function clampToRange(raw, min, max) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function makeNumeric(node, params, { onChange, info }) {
  const numeric = node.type === "number";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);

  const val = el("div", "val");
  const box = document.createElement("input");
  box.type = "number";
  box.className = "num";
  box.min = node.min; box.max = node.max; box.step = node.step;
  box.value = numStr(params[node.key]);
  val.append(box);
  if (node.unit) val.append(el("span", "unit", node.unit));
  row.append(val);
  wrap.append(row);

  let slider = null;
  if (!numeric) {
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = node.min; slider.max = node.max; slider.step = node.step;
    slider.value = params[node.key];
    slider.addEventListener("input", () => {
      params[node.key] = +slider.value;
      box.value = numStr(+slider.value);
      onChange?.();
    });
    wrap.append(slider);
  }

  // live preview while typing (unclamped); clamp + reformat on commit
  box.addEventListener("input", () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    params[node.key] = v;
    if (slider) slider.value = v;
    onChange?.();
  });
  box.addEventListener("change", () => {
    const v = clampToRange(box.value, node.min, node.max);
    if (v == null) { box.value = numStr(params[node.key]); return; } // revert invalid input
    params[node.key] = v;
    box.value = numStr(v);
    if (slider) slider.value = v;
    onChange?.();
  });

  const sync = () => {
    box.value = numStr(params[node.key]);
    if (slider) slider.value = params[node.key];
  };
  return { el: wrap, sync };
}
```

- [ ] **Step 4: Create `src/framework/panel/widgets/text.js`**

Move `makeTextControl` from `controls.js:188-209` with the same rename.

```js
// text / textarea: a live-updating string field. Every edit writes params
// immediately so the existing rebuild loop previews the new string.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function makeText(node, params, { onChange, info }) {
  const multiline = node.type === "textarea";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  const field = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) field.type = "text";
  field.className = "text-input";
  field.value = String(params[node.key] ?? "");
  field.addEventListener("input", () => {
    params[node.key] = field.value;
    onChange?.();
  });
  wrap.append(field);

  const sync = () => { field.value = String(params[node.key] ?? ""); };
  return { el: wrap, sync };
}
```

- [ ] **Step 5: Create `src/framework/panel/widgets/checkbox.js`**

This unifies the two legacy checkbox behaviors. Both rendered `<label class="feat">` markup already, so the DOM is unchanged; only the write differs, keyed on `node.preserveOn`.

```js
// A bare on/off checkbox, writing `on` when ticked and 0 when cleared.
//
// `preserveOn` is the one behavioral difference between the two legacy shapes it
// replaces. A `features` checkbox only wrote `on` when the value wasn't already
// positive (controls.js:352), so re-ticking a feature restored the magnitude the
// user had dialled in. A `toggles` checkbox always wrote it (controls.js:286),
// because its `on` is a flag, not a magnitude.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function makeCheckbox(node, params, { onChange, info }) {
  const row = el("label", "feat");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = params[node.key] > 0;
  const lbl = el("span", "", node.label);
  attachInfo(lbl, node.description, info);
  row.append(box, lbl);

  box.addEventListener("change", () => {
    if (box.checked) {
      if (!node.preserveOn || !(params[node.key] > 0)) params[node.key] = node.on ?? 1;
    } else {
      params[node.key] = 0;
    }
    onChange?.();
  });

  const sync = () => { box.checked = params[node.key] > 0; };
  return { el: row, sync };
}
```

- [ ] **Step 6: Create `src/framework/panel/widgets/index.js`**

```js
// The DOM half of the widget registry. Its keys must match widget-specs.js
// exactly — test/framework/panel/registry.test.js proves they do.
import { makeNumeric } from "./numeric.js";
import { makeText } from "./text.js";
import { makeCheckbox } from "./checkbox.js";

export const WIDGET_FACTORIES = {
  slider: makeNumeric,
  number: makeNumeric,
  text: makeText,
  textarea: makeText,
  checkbox: makeCheckbox,
};
```

- [ ] **Step 7: Run the tests**

Run: `nvm use && npx vitest run test/framework/panel/registry.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add src/framework/panel/widgets/ test/framework/panel/registry.test.js
git commit -m "Extract the DOM widget factories, keyed by the registry"
```

---

### Task 6: `panel/panel-state.js` — the pure state pass

Mirrors `rail-state.js`: all the cross-cutting decisions in one pure function, so the renderer only applies them.

**Files:**
- Create: `src/framework/panel/panel-state.js`
- Create: `test/framework/panel/panel-state.test.js`

**Interfaces:**
- Consumes: `evalWhen`, `controlNodes` from `panel/model.js`.
- Produces: `computeState(tree, { params, relevant }) -> Map<id, { visible, disabled, dimmed }>`. `relevant` is a `Set` of keys, or any non-Set value (e.g. `RELEVANT_ALL`) meaning "show all". The `open` field is added in Task 10.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/panel-state.test.js`:

```js
import { expect, test } from "vitest";
import { buildTree } from "../../../src/framework/panel/model.js";
import { computeState } from "../../../src/framework/panel/panel-state.js";

const group = (over = {}) => ({ kind: "group", children: [], ...over });
const control = (key, over = {}) => ({ kind: "control", key, type: "slider", ...over });

const tree = () => buildTree([
  group({ id: "s", children: [
    control("gate", { type: "checkbox", on: 1 }),
    group({ id: "s/g", bare: true, when: { gate: { gt: 0 } }, children: [control("inner")] }),
    control("plain"),
  ] }),
]);

test("a control with no condition is visible and enabled", () => {
  const st = computeState(tree(), { params: { gate: 0, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/2")).toMatchObject({ visible: true, disabled: false, dimmed: false });
});

test("a group whose condition is false is not visible", () => {
  const st = computeState(tree(), { params: { gate: 0, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/g").visible).toBe(false);
});

test("a false group takes its subtree with it", () => {
  const st = computeState(tree(), { params: { gate: 0, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/g/0").visible).toBe(false);
});

test("flipping the gate reveals the group and its children", () => {
  const st = computeState(tree(), { params: { gate: 1, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/g").visible).toBe(true);
  expect(st.get("s/g/0").visible).toBe(true);
});

test("whenFalse:disable disables in place instead of hiding", () => {
  const t = buildTree([group({ id: "s", children: [
    control("a", { when: { m: "x" }, whenFalse: "disable" }),
  ] })]);
  const st = computeState(t, { params: { m: "y" }, relevant: null });
  expect(st.get("s/0")).toMatchObject({ visible: true, disabled: true });
});

test("relevance dims but never hides or disables", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["gate"]) });
  expect(st.get("s/0").dimmed).toBe(false);       // gate is relevant
  expect(st.get("s/2")).toMatchObject({ dimmed: true, visible: true, disabled: false });
});

test("a non-Set relevant value means everything is relevant", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: Symbol("all") });
  expect(st.get("s/2").dimmed).toBe(false);
});

test("a section is dimmed-hidden when every control in it is irrelevant", () => {
  // The .section-hidden behavior applyRelevance had at controls.js:24-27.
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["elsewhere"]) });
  expect(st.get("s").dimmed).toBe(true);
});

test("a section with at least one relevant control is not dimmed", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["plain"]) });
  expect(st.get("s").dimmed).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/panel/panel-state.test.js`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Implement `src/framework/panel/panel-state.js`**

```js
// Every cross-cutting decision the panel makes about a node, in one pure pass.
// The renderer does nothing but apply the result.
//
// This is the rail-state.js / rail.js split applied to the panel: the tangled
// part isn't drawing controls, it's deciding which are visible, which are
// disabled and which are dimmed — three mechanisms acting on the same nodes.
// Computing them together, without a DOM, is what makes their interaction
// testable and keeps render.js small.
//
// The two mechanisms are deliberately independent and MUST stay visually
// distinct (see the spec): `when` hides or disables, relevance only dims.
import { evalWhen, controlNodes } from "./model.js";

export function computeState(tree, { params, relevant }) {
  const state = new Map();
  const showAll = !(relevant instanceof Set);

  const walk = (nodes, parentVisible) => {
    for (const node of nodes) {
      const passes = evalWhen(node.when, params);
      const hideOnFail = node.whenFalse !== "disable";
      const visible = parentVisible && (passes || !hideOnFail);
      const disabled = !passes && !hideOnFail;

      if (node.kind === "group") {
        // A group is dimmed when nothing inside it is relevant — the
        // .section-hidden behavior, generalized from sections to any group.
        const keys = controlNodes([node]).map((c) => c.key);
        const dimmed = !showAll && keys.length > 0 && !keys.some((k) => relevant.has(k));
        state.set(node.id, { visible, disabled, dimmed });
        walk(node.children, visible);
      } else {
        state.set(node.id, { visible, disabled, dimmed: !showAll && !relevant.has(node.key) });
      }
    }
  };

  walk(tree, true);
  return state;
}
```

- [ ] **Step 4: Run the tests**

Run: `nvm use && npx vitest run test/framework/panel/panel-state.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/panel-state.js test/framework/panel/panel-state.test.js
git commit -m "Add panel-state.js: one pure pass for visibility, disabling and dimming"
```

---

### Task 7: `panel/render.js` — render from the tree

The load-bearing task. When it lands, `test/framework/controls.test.js` must pass **completely unmodified**.

**Files:**
- Create: `src/framework/panel/render.js`
- Modify: `src/framework/controls.js` (becomes a barrel)
- Test: `test/framework/controls.test.js` (existing, **unmodified**), `test/framework/mount.test.js` (existing, unmodified)

**Interfaces:**
- Consumes: `desugar` (Task 2), `buildTree`/`controlNodes` (Task 3), `WIDGET_FACTORIES` (Task 5), `computeState` (Task 6), `createInfoPopover` (Task 1).
- Produces: `buildControls(root, parameters, params, onDirty) -> { applyRelevance(relevant), syncValues(keys?), dispose() }` — the same handle `mount.js:487-530` already uses.

- [ ] **Step 1: Record the green baseline**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS, 27 tests. Note the count — it must be identical at the end.

- [ ] **Step 2: Implement `src/framework/panel/render.js`**

```js
// The DOM binder. Builds elements from the render tree, then applies whatever
// panel-state.js decided. Everything about WHAT to show lives in the model and
// state modules; this file only knows how to put it on screen.
import { desugar } from "./legacy.js";
import { buildTree } from "./model.js";
import { computeState } from "./panel-state.js";
import { WIDGET_FACTORIES } from "./widgets/index.js";
import { createInfoPopover, attachInfo } from "./info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function buildControls(root, parameters, params, onDirty) {
  const info = createInfoPopover();
  const tree = buildTree(desugar(parameters));

  const nodeEls = new Map();   // id -> the element whose visibility we toggle
  const syncFns = [];          // { key, sync } for every widget
  const rawSyncs = new Map();  // sectionId -> { key -> raw sync } for preset application
  let relevant = null;

  // Re-apply state after any change that could flip a condition. This is what
  // reproduces the legacy feature behavior generically: ticking a feature's
  // checkbox now simply makes its group's condition true.
  const applyState = () => {
    const state = computeState(tree, { params, relevant });
    for (const [id, node] of nodeEls) {
      const s = state.get(id);
      if (!s) continue;
      node.classList.toggle("hidden", !s.visible);
      node.classList.toggle("section-hidden", !!s.dimmedSection);
      node.classList.toggle("irrelevant", s.dimmed && !s.dimmedSection);
      node.classList.toggle("disabled", s.disabled);
      for (const input of node.querySelectorAll("input, select, textarea")) {
        input.disabled = s.disabled;
      }
      if (s.dimmed && !s.dimmedSection) node.title = "Doesn't affect the parts in the current view";
      else node.removeAttribute("title");
    }
  };

  const onEdit = () => { applyState(); onDirty?.(); };

  // --- build ---------------------------------------------------------------
  //
  // TWO DIFFERENT THINGS USE `.hidden`, and conflating them is a real bug:
  // conditions hide a node, and a disclosure closes a fold. `applyState` runs on
  // every param change (mount.js:510), so if it toggled `.hidden` on the fold
  // body, every slider drag would re-open a fold the user had closed.
  //
  // So: a titled group gets a WRAPPER. Conditions toggle the wrapper; the
  // disclosure toggles the body inside it. A bare group has no fold, so it keeps
  // the legacy `.feat-group.hidden` markup exactly and conditions own it.
  function renderGroup(node, container, sectionCtx) {
    if (node.bare) {
      const box = el("div", "feat-group");
      nodeEls.set(node.id, box);
      for (const child of node.children) renderNode(child, box, sectionCtx);
      container.append(box);
      return;
    }

    const wrap = el("div", "adv-wrap");
    const body = el("div", "adv hidden");   // starts closed — legacy parity
    const toggle = el("button", "adv-toggle", `${node.title} ▾`);
    toggle.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      toggle.textContent = nowHidden ? `${node.title} ▾` : `${node.title} ▴`;
    });
    for (const child of node.children) renderNode(child, body, sectionCtx);
    wrap.append(toggle, body);
    nodeEls.set(node.id, wrap);             // conditions act on the wrapper
    container.append(wrap);
  }

  function renderNode(node, container, sectionCtx) {
    if (node.kind === "group") { renderGroup(node, container, sectionCtx); return; }

    const factory = WIDGET_FACTORIES[node.type];
    if (!factory) return; // unknown type: lint reports it; the panel skips it
    const widget = factory(node, params, { onChange: onEdit, info });
    nodeEls.set(node.id, widget.el);
    container.append(widget.el);

    // The raw sync is what a PRESET application uses — it must not mark itself
    // Custom (controls.test.js:366). The registered sync is what an external
    // syncValues() uses, and for a preset-section control it does drop the
    // picker to Custom (controls.test.js:350), because a programmatic edit
    // diverges from the preset exactly as a user edit does.
    if (sectionCtx) rawSyncs.get(sectionCtx.id).set(node.key, widget.sync);
    syncFns.push({
      key: node.key,
      sync: () => {
        widget.sync();
        if (node.customOnSync && sectionCtx?.preset) sectionCtx.preset.value = "Custom";
      },
    });
  }

  for (const section of tree) {
    const secEl = el("div", "section");
    nodeEls.set(section.id, secEl);

    const title = el("div", "sec-title", section.title);
    attachInfo(title, section.description, info);
    secEl.append(title);

    const ctx = { id: section.id, preset: null };
    rawSyncs.set(section.id, new Map());

    const presetNames = section.presets ? Object.keys(section.presets) : [];
    if (presetNames.length) {
      const preset = document.createElement("select");
      preset.className = "preset";
      for (const name of [...presetNames, "Custom"]) {
        const o = document.createElement("option");
        o.value = name; o.textContent = name; preset.append(o);
      }
      preset.value = presetNames[0];
      preset.addEventListener("change", () => {
        const bundle = section.presets[preset.value];
        if (!bundle) return; // "Custom"
        Object.assign(params, bundle);
        for (const [key, sync] of rawSyncs.get(section.id)) if (key in params) sync();
        onEdit();
      });
      ctx.preset = preset;
      secEl.append(preset);
    }

    for (const child of section.children) renderNode(child, secEl, ctx);
    root.append(secEl);
  }

  applyState();

  return {
    applyRelevance: (next) => { relevant = next; applyState(); },
    syncValues: (keys) => {
      const only = keys && new Set(keys);
      for (const { key, sync } of syncFns) if (!only || only.has(key)) sync();
      applyState();
    },
    dispose: () => { info.dispose(); root.replaceChildren(); },
  };
}
```

- [ ] **Step 3: Teach `computeState` to distinguish a dimmed section from a dimmed control**

`applyState` above reads `s.dimmedSection`, which Task 6 didn't produce. Add it: a top-level group gets `dimmedSection: true` where an inner node gets `dimmed: true`, because `.section-hidden` is `display: none` while `.irrelevant` is only opacity.

In `panel-state.js`, replace the whole `walk` function and its call:

```js
  const walk = (nodes, parentVisible, isTop) => {
    for (const node of nodes) {
      const passes = evalWhen(node.when, params);
      const hideOnFail = node.whenFalse !== "disable";
      const visible = parentVisible && (passes || !hideOnFail);
      const disabled = !passes && !hideOnFail;

      if (node.kind === "group") {
        const keys = controlNodes([node]).map((c) => c.key);
        const dimmed = !showAll && keys.length > 0 && !keys.some((k) => relevant.has(k));
        // Only a TOP-LEVEL group gets `.section-hidden` (display:none). An inner
        // group merely dims, because collapsing an inner group out of the layout
        // on a relevance change makes the panel jump under the user's cursor.
        state.set(node.id, { visible, disabled, dimmed, dimmedSection: dimmed && isTop });
        walk(node.children, visible, false);
      } else {
        state.set(node.id, {
          visible, disabled, dimmedSection: false,
          dimmed: !showAll && !relevant.has(node.key),
        });
      }
    }
  };

  walk(tree, true, true);
```

Add the covering test to `test/framework/panel/panel-state.test.js`:

```js
test("only a TOP-LEVEL group reports dimmedSection — inner groups just dim", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["elsewhere"]) });
  expect(st.get("s").dimmedSection).toBe(true);
  expect(st.get("s/g").dimmedSection).toBe(false);
});
```

- [ ] **Step 4: Reduce `controls.js` to a barrel**

Replace the whole file:

```js
// The control panel's public entry point. The implementation lives in panel/:
//
//   panel/legacy.js       the original advanced/toggles/features shapes
//   panel/model.js        canonical nodes -> render tree, plus conditions
//   panel/widget-specs.js the control-type registry (shared with partforge/lint)
//   panel/panel-state.js  one pure pass for visibility/disabling/dimming
//   panel/widgets/        one DOM factory per type
//   panel/render.js       the DOM binder
//
// This file stays at its path because animation-controls.js imports the popover
// helpers from it, and because it is the documented import site.
export { buildControls } from "./panel/render.js";
export { popoverTop, createInfoPopover, attachInfo } from "./panel/info.js";
export { clampToRange } from "./panel/widgets/numeric.js";
export { visibleAdvanced, visibleFeatures, visibleToggles, sectionRenders } from "./panel/legacy.js";
```

- [ ] **Step 5: Run the existing panel tests — unmodified**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS, 27 tests, **with no edits to the test file**. Likely first-run failures and what they mean:

- *Preset picker doesn't drop to Custom on a user edit* — `onEdit` is shared by every widget, but only preset-section controls should set `Custom`. Check that `renderNode` passes `sectionCtx` down through `renderGroup` into nested groups.
- *A feature's sliders don't appear on tick* — `applyState` isn't running after the checkbox's `onChange`; confirm the factory receives `onEdit`, not `onDirty`.
- *`section-hidden` applied to inner groups* — the `isTop` threading in Step 3 is wrong.

- [ ] **Step 6: Run the whole suite**

Run: `nvm use && npx vitest run`
Expected: full PASS. `mount.test.js` exercises `setParams` → `syncValues` and `dispose()`; both must still work.

- [ ] **Step 7: Smoke-test a real app in Chromium**

Run: `nvm use && node scripts/check-app.mjs demo.html && node scripts/check-app.mjs planter.html`
Expected: both pass. `planter.html` is the one with a real `features` section (drainage), so it is the live proof the desugar is right.

- [ ] **Step 8: Commit**

```bash
git add src/framework/panel/render.js src/framework/panel/panel-state.js \
        src/framework/controls.js test/framework/panel/panel-state.test.js
git commit -m "Render the panel from the node tree; controls.js becomes a barrel"
```

---

## Phase 2 — Lint onto the shared model (Tasks 8–9)

### Task 8: `rules-schema.js` consumes the model

**Files:**
- Modify: `src/framework/lint/rules-schema.js:9-11` (delete the allow-lists), `:20-60` (replace `collectDescriptors` and the duplicated predicates)
- Test: `test/lint-schema.test.js` (existing, **unmodified**), `test/lint-purity.test.js` (existing, unmodified)

**Interfaces:**
- Consumes: `visibleFeatures` / `sectionRenders` from `panel/legacy.js`, `fieldsFor` from `panel/widget-specs.js`.
- Produces: no API change. All eight rule ids keep their exact spelling and severity.

**Do not replace `collectDescriptors` with `desugar`.** It is tempting — it looks
like the last duplicated walk — but lint findings carry a `path` rooted at the
`PartDefinition` (`parameters[1].features[0]`, `parameters[0].presets["M3"].od`),
which is documented in `types/lint.d.ts:28` and `AUTHORING-PARTS.md:1100` and is
what points an author at the line to fix. `desugar` output has no such paths, and
inventing them from node ids would produce paths that don't exist in the source
file. `collectDescriptors` stays; only the field lists and the copied predicates
go. Task 9's `paramRanges` *can* use the model, because it returns ranges rather
than findings and never needs a path.

- [ ] **Step 1: Record the green baseline**

Run: `nvm use && npx vitest run test/lint-schema.test.js test/lint-purity.test.js`
Expected: PASS, 19 + 3 tests.

- [ ] **Step 2: Replace the field allow-lists with registry lookups**

In `rules-schema.js`, delete lines 9–11 and import instead:

```js
import { fieldsFor } from "../panel/widget-specs.js";

// Legacy container descriptors aren't widget types, so they keep explicit lists.
const FEATURE_FIELDS = ["key", "label", "on", "sliders", "hidden", "description"];
```

`CONTROL_FIELDS` becomes `fieldsFor("slider")` and `TOGGLE_FIELDS` becomes `fieldsFor("checkbox")` at their use sites in `collectDescriptors`.

- [ ] **Step 3: Replace the duplicated visibility predicates**

Delete `rules-schema.js:46-60` (the hand-copied `visibleFeatures` / `sectionRenders`) and import the real ones:

```js
import { visibleFeatures, sectionRenders } from "../panel/legacy.js";
```

Replace the deleted comment block with a note recording why the duplication is gone:

```js
// These used to be hand-copied from controls.js, because importing it would have
// dragged `marked`/`dompurify` into partforge/lint and broken its zero-dependency
// guarantee. panel/legacy.js imports nothing, so lint can share the real
// implementation and the two can no longer drift.
```

- [ ] **Step 4: Run the lint tests — unmodified**

Run: `nvm use && npx vitest run test/lint-schema.test.js`
Expected: PASS, 19 tests, no edits to the test file.

Watch specifically for `unknown-control-field` regressions: the registry must accept `control` (legacy) as well as `type`, and `unit`/`min`/`max`/`step` on numeric types. `lint-schema.test.js:132` ("an unrecognised control field warns with a did-you-mean") is the canary.

- [ ] **Step 5: Prove lint is still dependency-free**

Run: `nvm use && npx vitest run test/lint-purity.test.js`
Expected: PASS, 3 tests. The third asserts `[...walk(ENTRY).bare]` is `[]` — if `panel/legacy.js` or `panel/widget-specs.js` grew an import, this fails here.

- [ ] **Step 6: Run the CLI against a real part end to end**

Run: `nvm use && npx partforge lint src/parts/planter.js && npx partforge lint src/parts/demo.js && npx partforge lint src/parts/bracket.js`
Expected: exit 0 for all three, with findings identical to before the change.

- [ ] **Step 7: Commit**

```bash
git add src/framework/lint/rules-schema.js
git commit -m "Lint reads control fields from the widget registry, not hardcoded lists"
```

---

### Task 9: `rules-animations.js` consumes `controlNodes`

**Files:**
- Modify: `src/framework/lint/rules-animations.js:25-41`
- Test: `test/lint-animations.test.js` (existing, **unmodified**)

**Interfaces:**
- Consumes: `desugar` from `panel/legacy.js`, `controlNodes` + `buildTree` from `panel/model.js`.
- Produces: `paramRanges(part) -> Map<key, {min, max}>` — same shape, same first-wins semantics.

- [ ] **Step 1: Record the green baseline**

Run: `nvm use && npx vitest run test/lint-animations.test.js`
Expected: PASS.

- [ ] **Step 2: Replace `paramRanges`**

Note the semantics being preserved: **first declaration wins** (`!ranges.has(d.key)`), and `toggles` are deliberately excluded because a toggle has no range. Keeping hidden controls matters too — an animation may drive a hidden parameter.

```js
import { desugar } from "../panel/legacy.js";
import { controlNodes } from "../panel/model.js";

// The control descriptor ranges, for value-in-range checks. Walks the shared
// panel model rather than re-implementing the schema walk — before that model
// existed this duplicated rules-schema.js's collectDescriptors by design, and
// the two could drift.
//
// desugar() is used directly, WITHOUT buildTree(): hidden controls must stay in,
// because an animation may legitimately drive a parameter with no visible UI.
function paramRanges(part) {
  const ranges = new Map();
  for (const c of controlNodes(desugar(part?.parameters))) {
    // A checkbox has no range; only numeric controls constrain a keyframe.
    if (c.type === "checkbox") continue;
    if (typeof c.key === "string" && !ranges.has(c.key)) ranges.set(c.key, { min: c.min, max: c.max });
  }
  return ranges;
}
```

`controlNodes` walks any node array, so passing `desugar(...)` output straight in works — it does not require `buildTree` to have run.

- [ ] **Step 3: Run the animation lint tests — unmodified**

Run: `nvm use && npx vitest run test/lint-animations.test.js`
Expected: PASS, no edits to the test file.

- [ ] **Step 4: Verify against the reference animation part**

Run: `nvm use && npx partforge lint src/parts/hinged-box.js`
Expected: exit 0. `hinged-box.js` is the `animations` reference part, so it is the real exercise of the keyframe range checks.

- [ ] **Step 5: Run the whole suite**

Run: `nvm use && npx vitest run`
Expected: full PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/lint/rules-animations.js
git commit -m "Animation range checks walk the shared panel model"
```

---

## Phase 3 — Collapsible sections (Tasks 10–12)

### Task 10: The auto-open rule, in pure state

**Files:**
- Modify: `src/framework/panel/panel-state.js`
- Test: `test/framework/panel/panel-state.test.js`

**Interfaces:**
- Consumes: the tree from Task 3.
- Produces: `computeState` entries gain `open: boolean`. New export `AUTO_OPEN_MAX_SECTIONS = 3`.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/panel/panel-state.test.js`:

```js
import { AUTO_OPEN_MAX_SECTIONS } from "../../../src/framework/panel/panel-state.js";

const sections = (n, over = {}) =>
  buildTree(Array.from({ length: n }, (_, i) =>
    group({ id: `s${i}`, collapsed: "auto", children: [control(`k${i}`)], ...over })));

const openOf = (tree) => {
  const st = computeState(tree, { params: {}, relevant: null });
  return tree.map((s) => st.get(s.id).open);
};

test("the threshold is three sections", () => {
  expect(AUTO_OPEN_MAX_SECTIONS).toBe(3);
});

test("a panel at or under the threshold opens every auto container", () => {
  expect(openOf(sections(1))).toEqual([true]);
  expect(openOf(sections(3))).toEqual([true, true, true]);
});

test("a panel over the threshold closes every auto container", () => {
  expect(openOf(sections(4))).toEqual([false, false, false, false]);
});

test("an explicit `collapsed` always beats the heuristic, both ways", () => {
  expect(openOf(sections(1, { collapsed: true }))).toEqual([false]);
  expect(openOf(sections(5, { collapsed: false })).slice(0, 1)).toEqual([true]);
});

test("nested auto groups follow the same panel-wide decision", () => {
  const tree = buildTree([group({ id: "s", collapsed: "auto", children: [
    group({ id: "s/a", title: "Advanced", collapsed: "auto", children: [control("x")] }),
  ] })]);
  const st = computeState(tree, { params: {}, relevant: null });
  expect(st.get("s").open).toBe(true);
  expect(st.get("s/a").open).toBe(true);
});

test("a bare group is always open — it has no disclosure of its own", () => {
  const tree = buildTree([group({ id: "s", children: [
    group({ id: "s/b", bare: true, children: [control("x")] }),
  ] })]);
  expect(computeState(tree, { params: {}, relevant: null }).get("s/b").open).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/panel/panel-state.test.js`
Expected: FAIL — `AUTO_OPEN_MAX_SECTIONS` is not exported.

- [ ] **Step 3: Implement the rule**

In `panel-state.js`:

```js
// A panel with a handful of sections should present itself fully, not make the
// user click three times to see it. Beyond this many, collapsing wins: the rail
// is a fixed-height column and an eight-section part scrolls forever.
//
// Counting SECTIONS rather than controls is deliberate — an author can predict
// it at a glance, which matters because the rule shapes what their panel looks
// like on first load.
export const AUTO_OPEN_MAX_SECTIONS = 3;

const resolveOpen = (node, autoOpen) => {
  if (node.bare) return true;                    // no disclosure to open
  if (node.collapsed === true) return false;
  if (node.collapsed === false) return true;
  return autoOpen;                               // "auto" or unset
};
```

Then, inside `computeState`, before the walk:

```js
  const autoOpen = tree.length <= AUTO_OPEN_MAX_SECTIONS;
```

and in the group branch, add `open: resolveOpen(node, autoOpen)` to the state entry. Give control entries `open: true` so consumers never read `undefined`.

- [ ] **Step 4: Run the tests**

Run: `nvm use && npx vitest run test/framework/panel/panel-state.test.js`
Expected: PASS, all tests including the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/panel-state.js test/framework/panel/panel-state.test.js
git commit -m "Add the small-panel auto-open rule to the state pass"
```

---

### Task 11: Section disclosure markup and styles

**Files:**
- Modify: `src/framework/panel/render.js`, `src/framework/app.css:67-70`
- Test: `test/framework/controls.test.js` (**this task may add tests, but must not change existing assertions except where noted**)

**Interfaces:**
- Consumes: `open` from Task 10.
- Produces: a section renders `<div class="section"><div class="sec-header"><button class="sec-title" aria-expanded="…">…</button>[ⓘ]</div><div class="sec-body">…</div></div>`.

**The nesting trap:** `attachInfo` appends a `<button class="info">`. Putting that inside `button.sec-title` is invalid HTML and the nested button will not receive clicks. The ⓘ must be a **sibling** of the title button, inside `.sec-header`.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/controls.test.js`:

```js
test("a section title is a disclosure button that toggles its body", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec()], { od: 5, secret: 0 }, () => {});
  const btn = root.querySelector("button.sec-title");
  expect(btn).toBeTruthy();
  expect(btn.getAttribute("aria-expanded")).toBe("true");   // 1 section → auto-open
  const body = root.querySelector(".sec-body");
  expect(body.classList.contains("hidden")).toBe(false);
  btn.click();
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(body.classList.contains("hidden")).toBe(true);
});

test("the section ⓘ is a sibling of the title button, not nested inside it", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec({ description: "about the body" })], { od: 5, secret: 0 }, () => {});
  const btn = root.querySelector("button.sec-title");
  expect(btn.querySelector(".info")).toBeNull();            // a button inside a button never gets clicks
  expect(root.querySelector(".sec-header .info")).toBeTruthy();
});

test("four sections start collapsed; three start open", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, title: `S${i}`, advanced: [{ key: `k${i}`, label: "K", min: 0, max: 9, step: 1 }],
  }));
  const params = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, 1]));

  const three = document.createElement("div");
  buildControls(three, mk(3), params, () => {});
  expect([...three.querySelectorAll("button.sec-title")].map((b) => b.getAttribute("aria-expanded")))
    .toEqual(["true", "true", "true"]);

  const four = document.createElement("div");
  buildControls(four, mk(4), params, () => {});
  expect([...four.querySelectorAll("button.sec-title")].map((b) => b.getAttribute("aria-expanded")))
    .toEqual(["false", "false", "false", "false"]);
});

test("the legacy Advanced fold opens with a small panel", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec()], { od: 5, secret: 0 }, () => {});
  expect(root.querySelector(".adv").classList.contains("hidden")).toBe(false);
  expect(root.querySelector(".adv-toggle").textContent).toBe("Advanced ▴");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: FAIL — `button.sec-title` is null (it is still a `div`).

- [ ] **Step 3: Update `render.js`**

Replace the section header construction in the `for (const section of tree)` loop:

```js
    const header = el("div", "sec-header");
    const title = el("button", "sec-title");
    title.type = "button";
    title.append(el("span", "sec-name", section.title ?? ""), el("span", "chev", "▾"));
    header.append(title);
    // The ⓘ is a SIBLING of the button, never a child: attachInfo appends a
    // <button>, and a button nested in a button is invalid HTML that never
    // receives clicks.
    attachInfo(header, section.description, info);
    secEl.append(header);

    const body = el("div", "sec-body");
    secEl.append(body);
```

Everything that previously appended to `secEl` (the preset select, the children) now appends to `body`. Wire the disclosure:

```js
    title.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      title.setAttribute("aria-expanded", String(!nowHidden));
    });
```

Add a second map alongside `nodeEls`, near the top of `buildControls`:

```js
  // Containers that own a disclosure: sections, and titled inner groups (the
  // legacy "Advanced" fold). `label` is set only for the inner groups, whose
  // button text carries the ▾/▴ instead of a chevron span.
  const disclosures = new Map(); // id -> { body, button, label }
```

Register the section in the loop, right after wiring its click handler:

```js
    disclosures.set(section.id, { body, button: title, label: null });
```

and register a titled inner group at the end of `renderGroup`'s non-bare branch:

```js
    disclosures.set(node.id, { body, button: toggle, label: node.title });
```

Then add the open pass and call it from `applyState`:

```js
  let openApplied = false;
  const applyOpenState = (state) => {
    if (openApplied) return;   // after the first pass, the user's clicks own it
    openApplied = true;
    for (const [id, d] of disclosures) {
      const open = state.get(id)?.open ?? true;
      d.body.classList.toggle("hidden", !open);
      d.button.setAttribute("aria-expanded", String(open));
      if (d.label) d.button.textContent = open ? `${d.label} ▴` : `${d.label} ▾`;
    }
  };
```

In `applyState`, capture the state once and call both:

```js
  const applyState = () => {
    const state = computeState(tree, { params, relevant });
    applyOpenState(state);
    for (const [id, node] of nodeEls) { /* …unchanged… */ }
  };
```

The `openApplied` latch is load-bearing. `applyState` runs on every param change (`mount.js:510`), so without it a section the user opened would snap shut on the next slider drag. Task 11's fourth test would catch a missing latch only indirectly — verify it by hand in Step 7.

- [ ] **Step 4: Add the CSS**

In `src/framework/app.css`, replace the `.sec-title` rule at `:67-70`:

```css
.sec-header { display: flex; align-items: center; gap: 4px; }
.sec-title {
  flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; margin: 0 0 9px; padding: 0; border: 0; background: transparent; cursor: pointer;
  text-align: left;
  font-family: var(--pf-mono); font-size: 10px; font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--pf-muted-2);
}
.sec-title:hover { color: var(--pf-text-2); }
.sec-title .chev { transition: transform 0.15s ease; }
.sec-title[aria-expanded="false"] .chev { transform: rotate(-90deg); }
.sec-body.hidden { display: none; }
```

Add `.sec-title` to the focus-ring group at `app.css:161-162`.

Also add the `whenFalse: "disable"` treatment, kept deliberately distinct from `.irrelevant` (opacity only) so the two mechanisms never look alike:

```css
/* `when` disabling. Distinct from .irrelevant (relevance dimming) on purpose:
   two mechanisms that look identical make the panel impossible to reason about. */
.disabled { opacity: 0.5; pointer-events: none; }

/* The wrapper a titled inner group renders into. Conditions hide the wrapper;
   the disclosure hides `.adv` inside it. Unused until `when` becomes authorable
   in phase 5, but the class exists from Task 7 and must have a rule. */
.adv-wrap.hidden { display: none; }
```

- [ ] **Step 5: Run the panel tests**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS, 31 tests (27 original + 4 new).

`controls.test.js:392` ("sections stay flat siblings so the rail can divide them with hairlines") must still pass untouched — `.section` elements remain direct children of `root`; the new `.sec-header` / `.sec-body` are *inside* each section.

- [ ] **Step 6: Run the whole suite and smoke-test**

Run: `nvm use && npx vitest run && node scripts/check-app.mjs demo.html && node scripts/check-app.mjs planter.html && node scripts/check-app.mjs filleted-box.html && node scripts/check-app.mjs text-smoke.html`
Expected: all pass. These four are exactly what CI runs.

- [ ] **Step 7: Look at it**

Run: `nvm use && npm run dev`, then open `/planter.html` and `/demo.html`.
Check: both parts have two sections, so every section and every Advanced fold should be **open on load**. Clicking a section title collapses it; the chevron rotates. Dragging a slider does not re-collapse anything.

- [ ] **Step 8: Commit**

```bash
git add src/framework/panel/render.js src/framework/app.css test/framework/controls.test.js
git commit -m "Make sections collapsible, open by default in small panels"
```

---

### Task 12: Types, docs, and the version bump

**Files:**
- Modify: `types/part.d.ts:58-133`, `package.json`, `docs/AUTHORING-PARTS.md`
- Test: `test/partforge.test-d.ts` (existing, unmodified)

**Interfaces:**
- Consumes: everything above.
- Produces: `GroupNode`, `ControlNode`, `WhenCondition`, `ControlType` exported from `types/part.d.ts`.

- [ ] **Step 1: Add the new types**

In `types/part.d.ts`, after `ControlKind` at `:58`:

```ts
/** Every control type the panel can render. */
export type ControlType = "slider" | "number" | "text" | "textarea" | "checkbox";

/** A declarative visibility condition, evaluated against raw parameters. */
export type WhenCondition =
  | { allOf: WhenCondition[] }
  | { anyOf: WhenCondition[] }
  | { not: WhenCondition }
  | Record<string, ParamValue | {
      gt?: number; gte?: number; lt?: number; lte?: number;
      ne?: ParamValue; in?: ParamValue[];
    }>;
```

Mark the legacy interfaces deprecated without removing them — `test/partforge.test-d.ts` imports `ControlDef` at `:15` and must keep compiling:

```ts
/** @deprecated Prefer a `controls` array of control nodes. Still fully supported. */
export interface ControlDef { /* unchanged */ }
```

Same one-line `@deprecated` on `FeatureDef` and `ToggleDef`.

- [ ] **Step 2: Type-check**

Run: `nvm use && npx vitest run test/partforge.test-d.ts`
Expected: PASS, unmodified.

- [ ] **Step 3: Document the collapse behavior**

In `docs/AUTHORING-PARTS.md`, at the end of the "Parameters: the control-panel schema" section (after `:545`), add:

```markdown
**Collapsing.** Each section is a disclosure. A panel with **three or fewer
sections opens every section and every Advanced fold on load**; beyond that they
all start closed, because the rail is a fixed-height column and a long part
otherwise scrolls forever. Set `collapsed: true` or `collapsed: false` on a
section to override the rule in either direction.
```

Do **not** document the node model yet — it is not authorable until the phase 4–6 plan lands, and documenting an unavailable shape is how a corpus gets poisoned.

- [ ] **Step 4: Bump the version**

In `package.json`, `"version": "0.46.4"` → `"version": "0.47.0"`. Minor, not patch: sections collapsing is a visible behavior change.

Forgetting this is the quiet failure mode described in `AGENTS.md` — the merge lands, the version already exists on npm, the publish workflow correctly does nothing, and the work never ships.

- [ ] **Step 5: Full verification**

Run: `nvm use && npm test && npm run check`
Expected: full suite PASS, all four smoke-tested apps PASS.

- [ ] **Step 6: Commit and open the PR**

```bash
git add types/part.d.ts package.json docs/AUTHORING-PARTS.md
git commit -m "Types, collapse docs, and bump to 0.47.0"
git push -u origin controls-panel-spec
```

PR description: plain-language summary of what changes for a user (sections now collapse, small panels open fully), then a short note that the schema refactor is invisible to existing parts and that authorable new capabilities land in a follow-up.

---

## What phases 4–6 will cover

Not planned here, deliberately: their code depends on exactly how the modules above land, and writing bite-sized steps against modules that don't exist yet produces the placeholder tasks this plan format forbids. Write that plan after Task 12 merges.

- **Phase 4 — Widgets.** `select`, `radio`, `checkbox` (authorable directly), `readout` as a `display` node kind, plus `scale: "log"`, `ticks`/`snap`, and `recommended: [lo, hi]`. Each arrives as one `widget-specs.js` entry, one factory in `widgets/`, one validator, and one type.
- **Phase 5 — Conditions, exposed.** `when` / `whenFalse` become authorable; `panel.refresh({ relevant, derived })`; lint rules `when-key-not-in-defaults`, `when-unknown-operator`, `select-options-missing`, `select-default-not-in-options`. The engine itself already ships in Task 3.
- **Phase 6 — Authoring surface.** Rewrite `AUTHORING-PARTS.md:446-545` around the node model; the structural rules `group-depth`, `section-too-many-controls`, `mixed-section-shape`, `presets-not-top-level`; `ERROR-PATTERNS.md` entries; enrich `bracket.js` and `planter.js`. The rest of the parts stay on legacy shapes as live proof compatibility holds.

**Carry this constraint forward:** no phase ships a schema capability without the lint rule that guards it. Every new field is a field an LLM can get wrong, so deferring validators to phase 6 would make authoring measurably worse in the interim.
