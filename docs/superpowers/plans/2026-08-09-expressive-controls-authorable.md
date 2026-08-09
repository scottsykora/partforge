# Expressive Control Panels — Authorable Shape, Widgets, Conditions, Authoring Surface (Phases 4–7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the node model authorable (`controls` arrays, nested groups, positionable presets), add the new widgets (`select`, `radio`, `readout`, slider refinements), expose conditions (`when`/`whenFalse`), and rewrite the authoring surface — so an LLM writing a part produces a clear, well-organized control panel by default.

**Architecture:** The foundation (0.47.0) landed the machinery: `panel/legacy.js` desugars old shapes to canonical nodes, `panel/model.js` builds the render tree and evaluates conditions, `panel/panel-state.js` is the pure state pass, `panel/render.js` binds DOM, and lint shares all of it. This plan adds a `panel/author.js` (the only code that knows the NEW authored shape, mirroring how `legacy.js` is the only code that knows the old one), routes `desugar` through it, extends lint's `collectDescriptors` to the new shape, and adds widgets as registry entries + factories + validators — one file each, per the registry design. Docs land LAST, in the same release as the capabilities they describe, so the downstream prompt corpus never sees an unavailable shape.

**Tech Stack:** Plain ESM, no build step, no new dependencies. Vitest (`happy-dom` for DOM tests, first line `// @vitest-environment happy-dom`). Node 24 — `source ~/.nvm/nvm.sh && nvm use` before anything.

**Source spec:** `docs/superpowers/specs/2026-08-09-expressive-controls-panel-design.md` (§1 node model, §2 sugar, §4 conditions, §5 widgets, §6 lint, §10 docs, §12 phasing). The foundation plan (`2026-08-09-expressive-controls-foundation.md`) documents what already landed.

## Global Constraints

- **Node 24.** `source ~/.nvm/nvm.sh && nvm use` in every shell before npm/npx/node. The default shell Node is too old and geometry/tests fail confusingly.
- **Zero new dependencies.** `test/lint-purity.test.js` asserts the entire `src/lint.js` import closure has no bare imports. Everything lint reaches — `panel/legacy.js`, `panel/author.js`, `panel/model.js`, `panel/widget-specs.js`, `src/framework/derive.js` — must import nothing bare. If a smoke check needs Playwright: `npm i --no-save playwright@1.61.0` (browsers are cached); never commit a package.json/package-lock.json change other than the version bump.
- **Legacy parts change NOTHING.** Every 0.47.0 behavior for legacy-shaped parts is frozen. `test/framework/controls.test.js` (31 tests), `test/lint-schema.test.js` (19), `test/lint-animations.test.js` (19), `test/lint-purity.test.js` (3), and `test/framework/mount.test.js` pass **unmodified** throughout. The panel test files created by the foundation plan (`test/framework/panel/*.test.js`) may gain tests in any task; their existing assertions may be amended ONLY where a task explicitly says so. The complete list: `test/framework/panel/registry.test.js`'s `WIDGET_TYPES` expected list (Task 7 adds select/radio, Task 8 adds readout), its per-spec `kind` assertion (Task 8: `["control","display"]`), and its factory-coherence assertion (Task 8: filter to `kind === "control"`). No other assertion in any existing test file may be edited.
- **Every rule-adding task appends its rule's row(s) to the `### Rule catalog` table in `docs/AUTHORING-PARTS.md` (~line 1132) in the SAME task and commit** — `test/lint-registry.test.js` asserts every rule id appears in the docs, and its full-suite gate runs inside each task. Task 14 only adds ERROR-PATTERNS entries and polishes catalog wording.
- **No capability without its guard rule.** Every field this plan makes authorable ships in the same task as (or before) the lint rule that validates it. This is the spec's standing constraint; do not defer a validator to a later task than its field.
- **Public exports of `controls.js` must not shrink**: `buildControls`, `popoverTop`, `createInfoPopover`, `attachInfo`, `clampToRange`, `sectionRenders`, `visibleAdvanced`, `visibleFeatures`, `visibleToggles`.
- **Lint findings carry source paths** (`parameters[0].controls[2].controls[1]`) rooted at the PartDefinition — never node ids. `collectDescriptors` extends; it is never replaced by `desugar` (same reasoning as the foundation plan's Task 8).
- **Version bump rides the branch.** Target **0.48.0**, bumped in the final task. Never `npm publish`, never push a tag — releasing is automatic on merge (AGENTS.md).
- **On any build, test, `measure`, or `verify` failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.**
- Work on the `expressive-controls-authorable` branch (already created from origin/main at 859ddc8). Don't commit to `main`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/framework/panel/author.js` | **Pure, zero-bare-import.** The only code that knows the NEW authored shape (`controls` arrays, `type:"group"/"preset"/"readout"` entries). Exports `authoredSection(sec) -> GroupNode`. |
| `src/framework/panel/widgets/select.js` | DOM factories for `select` (dropdown) and `radio` (segmented control), plus `normalizeOptions`. |
| `src/framework/panel/widgets/readout.js` | DOM factory for the `readout` display node: `(node, {info}) -> { el, update(derived) }`. |
| `test/framework/panel/author.test.js` | `authoredSection` unit tests, no DOM. |
| `test/framework/panel/widgets.test.js` | select/radio/readout/slider-refinement DOM tests (happy-dom). |
| `test/framework/docs-coherence.test.js` | Registry ↔ docs coherence: every widget type appears in AUTHORING-PARTS.md. |

**Modified:**

| File | Change |
|---|---|
| `src/framework/panel/legacy.js` | `desugar` routes `controls`-bearing sections to `authoredSection` (3 lines + import). |
| `src/framework/panel/widget-specs.js` | `authorFieldsFor`, new specs (`select`, `radio`, `readout`), refinement fields. |
| `src/framework/panel/widgets/numeric.js` | `scale:"log"`, `ticks`/`snap`, `recommended` band + warn tint. |
| `src/framework/panel/widgets/index.js` | New factories registered. |
| `src/framework/panel/render.js` | Multi-preset sections, per-id raw syncs, `aria-controls`, display updates, `refresh`. |
| `src/framework/mount.js` | `updateRelevance` → `panel.refresh({ relevant, derived })`. |
| `src/framework/oracle/cases.js` | `presetMap` walks the desugared tree for `kind === "preset"` nodes. |
| `src/framework/lint/rules-schema.js` | `collectDescriptors` learns the authored shape; new rules. |
| `src/framework/app.css` | `.hidden` coverage for condition-hidden nodes, select/radio/readout/band styles. |
| `types/part.d.ts` | `PanelNode` types, `NodeSection` union member, `ControlType` widened. |
| `docs/AUTHORING-PARTS.md` | Parameters section rewritten around the node model; legacy moved to a compatibility subsection; rule catalog rows. |
| `docs/ERROR-PATTERNS.md` | Entries for every new lint rule. |
| `src/parts/bracket.js`, `src/parts/planter.js` | Enriched to the new shape (live proof + corpus examples). |
| `package.json` | Version → 0.48.0 (final task). |

---

## Canonical node shapes (already landed — for reference)

`desugar(parameters)` produces these; `buildTree` drops `hidden` nodes and empty groups and assigns stable ids (authored `id` wins, else positional `"body/1/0"`).

```js
// Group (top-level groups are the sections)
{ kind: "group", id, title, description, collapsed /* true|false|"auto" */,
  bare, when, whenFalse, hidden, children: [] }
// Control
{ kind: "control", key, type, label, description, unit, min, max, step,
  on, preserveOn, marksCustom, when, whenFalse, hidden }
// Preset
{ kind: "preset", id, label, presets, when, whenFalse, hidden }
// Display — NEW in this plan (Task 8)
{ kind: "display", type: "readout", label, unit, derivedKey, when, whenFalse, hidden }
```

Parity facts that bind this plan: `marksCustom` controls drop their section's first preset picker to "Custom" on user edit or external `syncValues()`; preset application goes through RAW syncs and never self-Customs; conditions toggle `.hidden` on the node's element (`.adv-wrap` wrapper for titled groups); relevance dims control leaves only; `disabled` propagates through `computeState`.

**Authored-shape decisions locked in by this plan** (spec §1–§2 leaves them open; implementers follow these):

- In a `controls:` section, **every control node gets `marksCustom: true`** — uniform and predictable. (The legacy exemptions — feature sliders, toggles — encode legacy-renderer history, not a design principle. Preset application still uses raw syncs, so applying a preset never self-Customs.)
- Authored checkboxes get `preserveOn: false` (the toggle behavior). `preserveOn` stays internal — an author who wants restore-the-magnitude behavior writes a `when`-gated group, which is the new-shape idiom for a feature.
- A section may not mix `controls` with any legacy array (`advanced`/`toggles`/`features`/`presets`) — lint error `mixed-section-shape` (Task 5). `desugar` still survives the mix: `controls` wins, legacy arrays are ignored (mirrors the features-routing precedent).
- A preset entry with an empty/missing `presets` object is dropped at normalize time (a picker containing only "Custom" is useless — same rule as legacy).

---

## Phase 4 — The authorable shape (Tasks 1–6)

### Task 1: `panel/author.js` — normalize the authored shape

**Files:**
- Create: `src/framework/panel/author.js`
- Modify: `src/framework/panel/legacy.js` (3-line routing branch + import)
- Create: `test/framework/panel/author.test.js`

**Interfaces:**
- Consumes: nothing (zero-bare-import; only ever imported alongside `legacy.js`).
- Produces: `authoredSection(sec) -> GroupNode` — canonical nodes per the shapes above, hidden nodes RETAINED (buildTree drops them later, lint needs them). `desugar` now returns authored sections normalized through it.

- [ ] **Step 1: Write the failing test**

Create `test/framework/panel/author.test.js` (no `@vitest-environment` line — pure):

```js
import { expect, test } from "vitest";
import { desugar } from "../../../src/framework/panel/legacy.js";
import { authoredSection } from "../../../src/framework/panel/author.js";

test("a controls section normalizes controls, nested groups and presets in authored order", () => {
  const [sec] = desugar([{
    id: "body", title: "Body",
    controls: [
      { type: "preset", presets: { A: { od: 5 } } },
      { key: "profile", type: "select", label: "Profile",
        options: [{ value: "round", label: "Round" }, { value: "faceted", label: "Faceted" }] },
      { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1 },
      { type: "group", title: "Wall", collapsed: true,
        controls: [{ key: "wall", type: "slider", min: 0.8, max: 4, step: 0.1 }] },
    ],
  }]);
  expect(sec).toMatchObject({ kind: "group", id: "body", title: "Body", collapsed: "auto" });
  expect(sec.children.map((c) => c.kind)).toEqual(["preset", "control", "control", "group"]);
  expect(sec.children[1]).toMatchObject({ key: "profile", type: "select", marksCustom: true });
  expect(sec.children[3]).toMatchObject({ kind: "group", title: "Wall", collapsed: true });
  expect(sec.children[3].children[0]).toMatchObject({ key: "wall", type: "slider" });
});

test("type defaults to slider; when/whenFalse/hidden are copied through", () => {
  const sec = authoredSection({ id: "s", controls: [
    { key: "a", min: 0, max: 1, step: 1, when: { mode: "x" }, whenFalse: "disable", hidden: true },
  ] });
  expect(sec.children[0]).toMatchObject({
    kind: "control", type: "slider", when: { mode: "x" }, whenFalse: "disable", hidden: true,
  });
});

test("groups nest recursively and carry when conditions", () => {
  const sec = authoredSection({ id: "s", controls: [
    { type: "group", title: "Outer", when: { on: { gt: 0 } }, controls: [
      { type: "group", title: "Inner", bare: true, controls: [{ key: "x", min: 0, max: 1, step: 1 }] },
    ] },
  ] });
  const outer = sec.children[0];
  expect(outer).toMatchObject({ kind: "group", when: { on: { gt: 0 } } });
  expect(outer.children[0]).toMatchObject({ kind: "group", bare: true });
  expect(outer.children[0].children[0].key).toBe("x");
});

test("an authored checkbox is preserveOn:false with on defaulting to 1", () => {
  const sec = authoredSection({ id: "s", controls: [
    { key: "show", type: "checkbox", label: "Show" },
    { key: "big", type: "checkbox", on: 16 },
  ] });
  expect(sec.children[0]).toMatchObject({ type: "checkbox", on: 1, preserveOn: false });
  expect(sec.children[1]).toMatchObject({ on: 16 });
});

test("every control in a controls section marks Custom — uniform rule", () => {
  const sec = authoredSection({ id: "s", controls: [
    { key: "a", min: 0, max: 1, step: 1 },
    { key: "b", type: "checkbox" },
    { type: "group", controls: [{ key: "c", min: 0, max: 1, step: 1 }] },
  ] });
  expect(sec.children[0].marksCustom).toBe(true);
  expect(sec.children[1].marksCustom).toBe(true);
  expect(sec.children[2].children[0].marksCustom).toBe(true);
});

test("an empty or missing presets object drops the preset entry", () => {
  const sec = authoredSection({ id: "s", controls: [
    { type: "preset", presets: {} },
    { type: "preset" },
    { key: "a", min: 0, max: 1, step: 1 },
  ] });
  expect(sec.children.map((c) => c.kind)).toEqual(["control"]);
});

test("null entries are skipped, never a throw — lint walks broken parts", () => {
  expect(() => authoredSection({ id: "s", controls: [null, { key: "a" }] })).not.toThrow();
  expect(authoredSection({ id: "s", controls: [null, { key: "a" }] }).children).toHaveLength(1);
});

test("desugar routes a controls section through authoredSection and ignores legacy arrays beside it", () => {
  const [sec] = desugar([{
    id: "m", controls: [{ key: "a", min: 0, max: 1, step: 1 }],
    advanced: [{ key: "z", min: 0, max: 1, step: 1 }],
    toggles: [{ key: "t" }], presets: { P: {} },
  }]);
  // mixed-section-shape (Task 5) errors on this; desugar must still survive it:
  // `controls` wins, the legacy arrays contribute nothing.
  expect(sec.children).toHaveLength(1);
  expect(sec.children[0]).toMatchObject({ kind: "control", key: "a" });
});

test("a legacy section is untouched by the new path", () => {
  const [sec] = desugar([{ id: "m", toggles: [{ key: "show", label: "S" }] }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["control"]); // exactly as 0.47.0
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/framework/panel/author.test.js`
Expected: FAIL — unresolved import `panel/author.js`.

- [ ] **Step 3: Implement `src/framework/panel/author.js`**

```js
// The NEW authored parameter-schema shape — a section (or nested group) whose
// children live in a `controls: []` array — normalized to canonical nodes.
// This file is author.js's mirror of legacy.js: legacy.js is the only code that
// knows the OLD shapes, this is the only code that knows the new one. Hidden
// nodes are RETAINED (lint needs them; buildTree drops them).
//
// No bare imports: partforge/lint consumes this through desugar() and
// test/lint-purity.test.js requires a dependency-free closure.

const arr = (x) => (Array.isArray(x) ? x : []);

// Uniform rule for the new shape: every control marks Custom. The legacy
// exemptions (feature sliders, toggles) encoded legacy-renderer history, not a
// design principle — preset application still goes through raw syncs, so
// applying a preset never marks itself Custom.
function authoredControl(c) {
  return {
    kind: "control",
    key: c.key,
    type: c.type ?? "slider",
    label: c.label,
    description: c.description,
    unit: c.unit,
    min: c.min,
    max: c.max,
    step: c.step,
    on: c.type === "checkbox" ? (c.on ?? 1) : c.on,
    options: c.options,
    scale: c.scale,
    ticks: c.ticks,
    snap: c.snap,
    recommended: c.recommended,
    hidden: !!c.hidden,
    when: c.when,
    whenFalse: c.whenFalse,
    preserveOn: false,
    marksCustom: true,
  };
}

function authoredPreset(p) {
  const names = p.presets ? Object.keys(p.presets) : [];
  if (!names.length) return null; // a picker with only "Custom" in it is useless
  return {
    kind: "preset", id: p.id, label: p.label, presets: p.presets,
    hidden: !!p.hidden, when: p.when, whenFalse: p.whenFalse,
  };
}

function authoredGroup(g) {
  // No description on inner groups: the fold toggle is itself a button, so
  // there is nowhere to hang an info glyph. Sections keep theirs.
  return {
    kind: "group", id: g.id, title: g.title,
    collapsed: g.collapsed ?? "auto", bare: !!g.bare, hidden: !!g.hidden,
    when: g.when, whenFalse: g.whenFalse,
    children: authoredChildren(g.controls),
  };
}

function authoredChildren(list) {
  const out = [];
  for (const entry of arr(list)) {
    if (!entry) continue; // lint must be able to walk a broken part
    if (entry.type === "group") out.push(authoredGroup(entry));
    else if (entry.type === "preset") {
      const node = authoredPreset(entry);
      if (node) out.push(node);
    } else out.push(authoredControl(entry));
  }
  return out;
}

export function authoredSection(sec) {
  return {
    kind: "group", id: sec?.id, title: sec?.title, description: sec?.description,
    collapsed: sec?.collapsed ?? "auto", hidden: !!sec?.hidden,
    when: sec?.when, whenFalse: sec?.whenFalse,
    children: authoredChildren(sec?.controls),
  };
}
// NB until Task 8 lands: a `{ type: "readout" }` entry falls through
// authoredChildren's else-branch to authoredControl, yielding a keyless control
// node the renderer skips (no factory) — harmless in the intermediate commits.
// Authored `id` is honored on containers only; a control entry's `id` is
// dropped (positional ids serve) and lint warns on the unknown field.
```

- [ ] **Step 4: Route `desugar` through it**

In `src/framework/panel/legacy.js`, add at the top (after the header comment):

```js
import { authoredSection } from "./author.js";
```

and as the FIRST branch inside `desugar`'s `.map((sec) => { ... })`, before the features branch:

```js
    // The NEW shape: children live in `controls`. author.js owns it entirely;
    // when both `controls` and legacy arrays appear (a lint error,
    // mixed-section-shape), `controls` wins — same winner-takes-all routing the
    // features branch below applies to the legacy shapes.
    if (Array.isArray(sec?.controls)) return authoredSection(sec);
```

Update legacy.js's header comment: it no longer "imports nothing" — say it imports only `author.js`, which is equally dependency-free.

- [ ] **Step 5: Run the tests**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/framework/panel/author.test.js test/framework/panel/legacy.test.js`
Expected: PASS (9 new + 15 existing).

- [ ] **Step 6: Full suite, then commit**

Run: `npx vitest run`
Expected: full PASS — legacy behavior untouched.

```bash
git add src/framework/panel/author.js src/framework/panel/legacy.js test/framework/panel/author.test.js
git commit -m "Accept the authored controls shape: author.js normalizes it to nodes"
```

---

### Task 2: `render.js` — multiple pickers, per-node raw syncs, `aria-controls`

The authored shape lets a preset node sit anywhere in a section, and lets one section carry more than one. Two latent issues in `render.js` block that: `rawSyncs` is keyed by `node.key` (two controls sharing a key collapse to one entry), and a preset rendered before its section's controls captures an empty sync map only by luck of the late-read `sectionCtx`. Also fold in the accessibility carry-forward: `aria-controls` on disclosure buttons.

**Files:**
- Modify: `src/framework/panel/render.js`
- Test: `test/framework/panel/render.test.js` (append; existing tests unmodified)

**Interfaces:**
- Consumes: nodes from Task 1.
- Produces: unchanged public handle. Internal: `rawSyncs` becomes `Map<sectionId, Array<{ key, sync }>>`; disclosure buttons carry `aria-controls` pointing at their body's `id`.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/panel/render.test.js`:

```js
const twoPickerSec = () => ({ id: "body", title: "Body", controls: [
  { type: "preset", presets: { Small: { od: 3 }, Large: { od: 9 } } },
  { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1 },
  { type: "preset", presets: { Tall: { h: 20 } } },
  { key: "h", type: "slider", label: "H", min: 1, max: 30, step: 1 },
] });

test("a section renders every preset node, in authored order, among the controls", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [twoPickerSec()], { od: 5, h: 10 }, () => {});
  const kids = [...root.querySelectorAll(".sec-body > *")];
  const kinds = kids.map((el) => el.matches("select.preset") ? "preset" : "control");
  expect(kinds).toEqual(["preset", "control", "preset", "control"]);
});

test("applying a preset from the second picker syncs its keys and self-Customs nothing", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 5, h: 10 };
  buildControls(root, [twoPickerSec()], params, () => {});
  const [first, second] = root.querySelectorAll("select.preset");
  second.value = "Tall";
  second.dispatchEvent(new Event("change"));
  expect(params.h).toBe(20);
  expect([...root.querySelectorAll('input[type="range"]')][1].value).toBe("20");
  expect(second.value).toBe("Tall");           // no self-Custom
  expect(first.value).toBe("Small");           // other pickers untouched
});

test("editing any control drops the FIRST picker to Custom (first-picker-wins)", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 5, h: 10 };
  buildControls(root, [twoPickerSec()], params, () => {});
  const [first, second] = root.querySelectorAll("select.preset");
  const box = root.querySelector("input.num");
  box.value = "7"; box.dispatchEvent(new Event("input"));
  expect(first.value).toBe("Custom");
  expect(second.value).toBe("Tall");   // other pickers untouched (first-picker-wins)
});

test("disclosure buttons carry aria-controls naming their body element", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }], { od: 5 }, () => {});
  const secBtn = root.querySelector("button.sec-title");
  const secBody = root.querySelector(".sec-body");
  expect(secBody.id).toBeTruthy();
  expect(secBtn.getAttribute("aria-controls")).toBe(secBody.id);
  const advBtn = root.querySelector(".adv-toggle");
  const advBody = root.querySelector(".adv");
  expect(advBody.id).toBeTruthy();
  expect(advBtn.getAttribute("aria-controls")).toBe(advBody.id);
});
```

- [ ] **Step 2: Run and watch the new ones fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/framework/panel/render.test.js`
Expected: the four new tests FAIL (multi-preset order works only partially; aria-controls absent).

- [ ] **Step 3: Implement**

In `src/framework/panel/render.js`:

1. Change `rawSyncs` to hold arrays: `const rawSyncs = new Map(); // sectionId -> [{ key, sync }]`, initialize with `rawSyncs.set(section.id, [])`, register in `renderNode` with `if (sectionCtx) rawSyncs.get(sectionCtx.id).push({ key: node.key, sync: widget.sync });` (keep the existing null guard), and apply in `renderPreset`'s change handler:

```js
      Object.assign(params, bundle);
      for (const { key, sync } of rawSyncs.get(sectionCtx.id)) if (key in params) sync();
      onEdit();
```

(Behavior for legacy parts: the same syncs run in the same order, plus previously key-shadowed duplicates now both register — e.g. demo.js's `flange_d` checkbox AND slider. Both syncs are idempotent reads of `params`, so running both is a no-op difference.)

2. In `renderPreset`, render an authored `label` (legacy pickers have none and are unaffected) — a preset node's `label` field must not be silently dead:

```js
    if (node.label) {
      const row = el("div", "row");
      row.append(el("label", "", node.label));
      container.append(row);
    }
```

3. In the section loop, give the body an id and the button `aria-controls`:

```js
    const body = el("div", "sec-body");
    body.id = `pf-sec-${section.id.replaceAll("/", "-")}`;
    title.setAttribute("aria-controls", body.id);
```

4. In `renderGroup`'s non-bare branch:

```js
    body.id = `pf-fold-${node.id.replaceAll("/", "-")}`;
    toggle.setAttribute("aria-controls", body.id);
```

- [ ] **Step 4: Run the panel tests and the full suite**

Run: `npx vitest run test/framework/panel/render.test.js test/framework/controls.test.js && npx vitest run`
Expected: all PASS; `controls.test.js` (31) unmodified.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/render.js test/framework/panel/render.test.js
git commit -m "Render positionable and multiple preset pickers; stamp aria-controls"
```

---

### Task 3: `oracle/cases.js` walks preset nodes

**Files:**
- Modify: `src/framework/oracle/cases.js` (`presetMap`)
- Test: `test/verify-cases.test.js` — find the existing test file covering `expandCases` first (`grep -rl expandCases test/`); it exists and must pass unmodified. New coverage goes in `test/framework/panel/author.test.js` only if no oracle test file admits additions; otherwise append to the existing oracle cases test file.

**Interfaces:**
- Consumes: `desugar` from `../panel/legacy.js` (pure — the oracle worker graph stays DOM-free/`three`-free/`node:`-free; `test/worker-layering.test.js` enforces it and must stay green).
- Produces: `expandCases(part)` unchanged shape; presets now discovered from the desugared tree, so authored `preset` nodes get verify cases too.

- [ ] **Step 1: Write the failing test** (append to the oracle cases test file found above)

```js
test("expandCases sees presets declared as authored preset nodes", () => {
  const part = {
    defaults: { od: 5 },
    parameters: [{ id: "b", controls: [
      { type: "preset", presets: { Wide: { od: 9 } } },
      { key: "od", min: 1, max: 10, step: 1 },
    ] }],
  };
  const names = expandCases(part).map((c) => c.name);
  expect(names).toEqual(["defaults", "Wide"]);
});

test("a preset name repeated across sections still throws", () => {
  const part = {
    defaults: { od: 5 },
    parameters: [
      { id: "a", presets: { Dup: { od: 2 } }, advanced: [{ key: "od", min: 1, max: 10, step: 1 }] },
      { id: "b", controls: [{ type: "preset", presets: { Dup: { od: 3 } } }] },
    ],
  };
  expect(() => expandCases(part)).toThrow(/duplicate preset name/);
});
```

- [ ] **Step 2: Run and watch it fail**, then **Step 3: Implement**

Replace `presetMap` in `src/framework/oracle/cases.js`:

```js
import { desugar } from "../panel/legacy.js";

// Preset name -> overrides, discovered from the desugared node tree so both the
// legacy `presets:` field and authored `{ type: "preset" }` nodes count. The
// duplicate-name guard predates the duplicate-preset-name lint rule and stays:
// verify must fail loudly even on an unlinted part.
function presetMap(part) {
  const map = {};
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.kind === "preset") {
        for (const [name, overrides] of Object.entries(node.presets ?? {})) {
          if (name in map) throw new Error(`duplicate preset name across sections: "${name}"`);
          map[name] = overrides;
        }
      }
      if (node.kind === "group") walk(node.children);
    }
  };
  walk(desugar(part.parameters ?? []));
  return map;
}
```

- [ ] **Step 4: Gates**

Run: `npx vitest run <the oracle cases test file> test/worker-layering.test.js && npx vitest run`
Expected: all PASS. Then prove a real part still verifies: `npx partforge measure src/parts/planter.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/cases.js test/
git commit -m "Verify cases discover presets from the node tree"
```

---

### Task 4: lint's `collectDescriptors` learns the authored shape

**Files:**
- Modify: `src/framework/lint/rules-schema.js` (`collectDescriptors` + a new `collectPresetBundles`; rule bodies mostly untouched)
- Modify: `src/framework/panel/widget-specs.js` (`authorFieldsFor`)
- Test: `test/lint-schema.test.js` (existing 19, **unmodified**) + new tests appended to it? **No** — it is a pre-existing file. Create `test/lint-authored.test.js` for the new-shape coverage.

**Interfaces:**
- Consumes: `authorFieldsFor` (new), existing rule machinery.
- Produces: descriptors for authored controls with paths like `parameters[0].controls[2]` and `parameters[0].controls[3].controls[1]`; group/preset descriptors with their own field lists; `collectPresetBundles(part) -> [{ name, bundle, path }]` covering legacy `sec.presets` AND authored preset nodes, consumed by `preset-key-not-in-defaults` and `default-not-exposed`.

Field-list design (extends the A2 decision from the foundation): legacy descriptors keep the legacy lists exactly. Authored descriptors accept the new-shape fields:

```js
// widget-specs.js additions
const AUTHOR_COMMON = ["key", "type", "label", "description", "hidden", "when", "whenFalse"];
// per-type extras, applied to authored controls only:
//   slider/number: unit,min,max,step,scale,ticks,snap,recommended
//   text/textarea: (none beyond COMMON)
//   checkbox: on
//   select/radio: options            (specs land in Task 7)
//   readout: label,unit,derivedKey   (spec lands in Task 8)
export const authorFieldsFor = (type) => AUTHOR_FIELDS.get(type) ?? [];
export const GROUP_FIELDS = ["type", "id", "title", "collapsed", "bare", "when", "whenFalse", "hidden", "controls"];
// NB: no "description" — renderGroup has nowhere to hang an info glyph (the
// toggle is itself a button). Sections keep descriptions (SECTION_FIELDS).
export const PRESET_FIELDS = ["type", "id", "label", "presets", "when", "whenFalse", "hidden"];
```

Concretely, build `AUTHOR_FIELDS` as a Map alongside `WIDGET_SPECS`:

```js
const AUTHOR_EXTRAS = {
  slider: ["unit", "min", "max", "step", "scale", "ticks", "snap", "recommended"],
  number: ["unit", "min", "max", "step", "scale", "ticks", "snap", "recommended"],
  text: [],
  textarea: [],
  checkbox: ["on"],
};
const AUTHOR_FIELDS = new Map(Object.entries(AUTHOR_EXTRAS).map(
  ([type, extra]) => [type, [...AUTHOR_COMMON, ...extra]]));
```

(Tasks 7 and 8 extend `AUTHOR_EXTRAS` with `select`/`radio`/`readout` when those types land — the registry test added there pins it.)

- [ ] **Step 1: Write the failing tests**

Create `test/lint-authored.test.js`. Model its helpers on `test/lint-schema.test.js` (read that file's `goodPart()` fixture and `ids()` helper first and mirror them):

```js
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const authoredPart = () => ({
  meta: { id: "t", title: "T" },
  defaults: { od: 5, wall: 1.6, show: 0 },
  parameters: [{ id: "body", title: "Body", controls: [
    { type: "preset", presets: { A: { od: 7 } } },
    { key: "od", type: "slider", label: "OD", unit: "mm", min: 1, max: 10, step: 1 },
    { key: "show", type: "checkbox", label: "Show" },
    { type: "group", title: "Wall", controls: [
      { key: "wall", type: "slider", label: "Wall", min: 0.8, max: 4, step: 0.1 },
    ] },
  ] }],
  parts: { main: { views: ["main"], build: (k, p) => k.box({ size: [p.od, p.od, p.od] }) } },
  views: { main: { label: "Main" } },
});

test("a clean authored part lints clean", () => {
  const r = lintPart(authoredPart());
  expect(r.errors).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("an authored control key missing from defaults errors with a controls[] path", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].key = "odd";
  const r = lintPart(part);
  const f = r.errors.find((f) => f.rule === "control-key-not-in-defaults");
  expect(f.path).toBe("parameters[0].controls[1].key");
});

test("a nested control's path threads through the group", () => {
  const part = authoredPart();
  part.parameters[0].controls[3].controls[0].key = "wal";
  const f = lintPart(part).errors.find((f) => f.rule === "control-key-not-in-defaults");
  expect(f.path).toBe("parameters[0].controls[3].controls[0].key");
});

test("unknown fields warn on authored controls, groups, and presets", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].lable = "typo";
  part.parameters[0].controls[3].titel = "typo";
  part.parameters[0].controls[0].presests = {};
  const rules = ids(lintPart(part).warnings).filter((r) => r === "unknown-control-field");
  expect(rules).toHaveLength(3);
});

test("when/whenFalse are accepted fields on authored controls but not legacy ones", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { show: { gt: 0 } };
  expect(ids(lintPart(part).warnings)).not.toContain("unknown-control-field");
  const legacy = authoredPart();
  legacy.parameters.push({ id: "l", advanced: [
    { key: "od", label: "OD", min: 1, max: 10, step: 1, when: { show: 1 } }] });
  expect(ids(lintPart(legacy).warnings)).toContain("unknown-control-field");
});

test("an authored preset bundle with an unknown key errors with its node path", () => {
  const part = authoredPart();
  part.parameters[0].controls[0].presets = { A: { odd: 7 } };
  const f = lintPart(part).errors.find((f) => f.rule === "preset-key-not-in-defaults");
  expect(f.path).toBe('parameters[0].controls[0].presets["A"].odd');
});

test("default-not-exposed counts authored controls and preset bundles as exposure", () => {
  const part = authoredPart();
  part.defaults.orphan = 1;
  expect(ids(lintPart(part).warnings)).toContain("default-not-exposed");
  part.parameters[0].controls.push({ key: "orphan", type: "slider", min: 0, max: 2, step: 1, hidden: true });
  expect(ids(lintPart(part).warnings)).not.toContain("default-not-exposed");
});

test("slider-range-excludes-default fires on authored controls too", () => {
  const part = authoredPart();
  part.defaults.od = 99;
  expect(ids(lintPart(part).warnings)).toContain("slider-range-excludes-default");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/lint-authored.test.js`
Expected: FAIL — authored controls invisible to `collectDescriptors`.

- [ ] **Step 3: Implement**

In `widget-specs.js`, add `AUTHOR_COMMON`/`AUTHOR_EXTRAS`/`AUTHOR_FIELDS`/`authorFieldsFor`/`GROUP_FIELDS`/`PRESET_FIELDS` exactly as designed above.

In `rules-schema.js`:

1. Extend `collectDescriptors` with a recursive authored walk. Beside the existing legacy loops, add:

```js
    // The authored shape: children in `controls`, recursively. Field lists are
    // the authored ones (authorFieldsFor) — the legacy lists stay untouched so
    // `when` on a legacy descriptor still warns.
    function walkAuthored(list, base) {
      arr(list).forEach((entry, i) => {
        if (!entry) return;
        const path = `${base}[${i}]`;
        if (entry.type === "group") {
          out.push({ d: entry, path, fields: GROUP_FIELDS, container: true });
          walkAuthored(entry.controls, `${path}.controls`);
        } else if (entry.type === "preset") {
          out.push({ d: entry, path, fields: PRESET_FIELDS, container: true });
        } else {
          out.push({ d: entry, path, fields: authorFieldsFor(entry.type ?? "slider") });
        }
      });
    }
    if (Array.isArray(sec?.controls)) { walkAuthored(sec.controls, `parameters[${si}].controls`); return; }
```

(`return` before the legacy loops for a `controls` section — mirrors desugar's winner-takes-all routing.) Rules that read `d.key` must skip container descriptors: add `.filter(({ container }) => !container)` in `control-key-not-in-defaults`, `slider-range-excludes-default`, and `duplicate-control-key`; `default-not-exposed`'s exposure set likewise skips containers (containers have no `key`, so `filter(Boolean)` already covers it — verify). `unknown-control-field` runs on everything including containers, which is the point.

2. Add `collectPresetBundles(part)`:

```js
// Every preset bundle with its source path — the legacy `presets:` field and
// authored `{ type: "preset" }` nodes both count.
function collectPresetBundles(part) {
  const out = [];
  sections(part).forEach((sec, si) => {
    if (isPlainObject(sec?.presets) && !Array.isArray(sec?.controls)) {
      for (const [name, bundle] of Object.entries(sec.presets)) {
        out.push({ name, bundle, path: `parameters[${si}].presets` });
      }
    }
    const walk = (list, base) => arr(list).forEach((entry, i) => {
      if (!entry) return;
      if (entry.type === "group") walk(entry.controls, `${base}[${i}].controls`);
      else if (entry.type === "preset" && isPlainObject(entry.presets)) {
        for (const [name, bundle] of Object.entries(entry.presets)) {
          out.push({ name, bundle, path: `${base}[${i}].presets` });
        }
      }
    });
    walk(sec?.controls, `parameters[${si}].controls`);
  });
  return out;
}
```

3. Rewrite `preset-key-not-in-defaults` and the preset half of `default-not-exposed` to consume `collectPresetBundles`. Finding text unchanged; the path is `` `${path}[${JSON.stringify(name)}].${key}` `` — `JSON.stringify` supplies the quotes, do not add more (the expected form is `parameters[0].controls[0].presets["A"].odd`).

- [ ] **Step 4: Gates**

Run: `npx vitest run test/lint-authored.test.js test/lint-schema.test.js test/lint-purity.test.js && npx partforge lint src/parts/planter.js && npx partforge lint src/parts/demo.js && npx partforge lint src/parts/bracket.js && npx vitest run`
Expected: all PASS; lint-schema's 19 unmodified; CLI findings identical to before (all three parts are legacy-shaped).

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-schema.js src/framework/panel/widget-specs.js test/lint-authored.test.js
git commit -m "Lint walks the authored controls shape with source-rooted paths"
```

---

### Task 5: lint rules `mixed-section-shape`, `duplicate-preset-name`, `duplicate-node-id`

**Files:**
- Modify: `src/framework/lint/rules-schema.js` (three new rules appended to `SCHEMA_RULES`)
- Test: `test/lint-authored.test.js` (append)

**Interfaces:**
- Consumes: `collectPresetBundles` (Task 4), `desugar` + `buildTree` from the panel model (for id collisions — imported from `../panel/legacy.js` / `../panel/model.js`; both pure).
- Produces: rule ids exactly `mixed-section-shape` (error), `duplicate-preset-name` (error), `duplicate-node-id` (error).

- [ ] **Step 1: Write the failing tests** (append to `test/lint-authored.test.js`)

```js
test("mixing controls with any legacy array in one section is an error", () => {
  for (const extra of [
    { advanced: [{ key: "od", min: 1, max: 10, step: 1 }] },
    { toggles: [{ key: "show" }] },
    { features: [{ key: "show", on: 1, sliders: [] }] },
    { presets: { P: {} } },
  ]) {
    const part = authoredPart();
    Object.assign(part.parameters[0], extra);
    const f = lintPart(part).errors.find((f) => f.rule === "mixed-section-shape");
    expect(f, JSON.stringify(extra)).toBeTruthy();
    expect(f.path).toBe("parameters[0]");
  }
});

test("the same preset name twice in one part is an error, before verify would throw", () => {
  const part = authoredPart();
  part.parameters.push({ id: "more", controls: [
    { type: "preset", presets: { A: { wall: 2 } } },   // "A" already exists in section 0
  ] });
  const f = lintPart(part).errors.find((f) => f.rule === "duplicate-preset-name");
  expect(f).toBeTruthy();
  expect(f.path).toBe('parameters[1].controls[0].presets');
});

test("two nodes resolving to the same id is an error", () => {
  const part = authoredPart();
  part.parameters[0].controls[3].id = "body";      // collides with the section id
  const f = lintPart(part).errors.find((f) => f.rule === "duplicate-node-id");
  expect(f).toBeTruthy();
});

test("a clean authored part still lints clean after the new rules", () => {
  expect(lintPart(authoredPart()).errors).toEqual([]);
});
```

- [ ] **Step 2: Run and watch them fail**, then **Step 3: Implement** (append to `SCHEMA_RULES`)

```js
  {
    id: "mixed-section-shape",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        if (!Array.isArray(sec?.controls)) return;
        const legacy = ["advanced", "toggles", "features", "presets"].filter((k) => sec[k] != null);
        if (legacy.length) {
          out.push(err("mixed-section-shape",
            `section "${sec.id ?? si}" mixes \`controls\` with legacy ${legacy.map((k) => `\`${k}\``).join(", ")}`,
            "A section is either the new shape (everything in `controls`) or the legacy shape — mixing them would make the render order arbitrary. Move the legacy entries into `controls` (a toggle becomes a checkbox control, `advanced` becomes a nested group, `presets` becomes a `{ type: \"preset\" }` node), or drop `controls`.",
            `parameters[${si}]`));
        }
      });
      return out;
    },
  },
  {
    id: "duplicate-preset-name",
    run: ({ part }) => {
      const seen = new Map(); // name -> first path
      const out = [];
      for (const { name, path } of collectPresetBundles(part)) {
        if (seen.has(name)) {
          out.push(err("duplicate-preset-name",
            `preset "${name}" is declared more than once (first at ${seen.get(name)})`,
            "Preset names are global to the part: verify() expands one case per name and throws on a repeat, which is a worse place to find out. Rename one of them.",
            path));
        } else seen.set(name, path);
      }
      return out;
    },
  },
  {
    id: "duplicate-node-id",
    run: ({ part }) => {
      // Ids key the renderer's element/state/disclosure maps — a collision
      // silently cross-wires two nodes (one picker syncing another section's
      // widgets). Catch it statically: build the tree and look for repeats.
      const seen = new Map(); // id -> [sectionIndex, ...]
      const tree = buildTree(desugar(part?.parameters ?? []));
      tree.forEach((section, si) => {
        const walk = (nodes) => {
          for (const n of nodes ?? []) {
            if (!seen.has(n.id)) seen.set(n.id, []);
            seen.get(n.id).push(si);
            if (n.kind === "group") walk(n.children);
          }
        };
        seen.set(section.id, [...(seen.get(section.id) ?? []), si]);
        walk(section.children);
      });
      return [...seen].filter(([, secs]) => secs.length > 1).map(([id, secs]) =>
        err("duplicate-node-id",
          `two panel nodes share the id "${id}"`,
          "Node ids must be unique across the whole panel — the renderer keys its element and state maps on them, and a collision silently cross-wires the two nodes. Rename one `id` (or drop it to use the positional default).",
          `parameters[${secs[0]}]`));
    },
  },
```

with the imports at the top of `rules-schema.js`:

```js
import { desugar } from "../panel/legacy.js";
import { buildTree } from "../panel/model.js";
```

- [ ] **Step 4: Add the three rule-catalog rows** to `### Rule catalog` in `docs/AUTHORING-PARTS.md` (`test/lint-registry.test.js` requires every rule id in the docs; its gate runs next step).

- [ ] **Step 5: Gates**

Run: `npx vitest run test/lint-authored.test.js test/lint-schema.test.js test/lint-purity.test.js test/lint-registry.test.js && npx vitest run`
Expected: all PASS, lint-schema 19 unmodified, purity green (all new imports are pure).

- [ ] **Step 6: Commit**

```bash
git add src/framework/lint/rules-schema.js docs/AUTHORING-PARTS.md test/lint-authored.test.js
git commit -m "Lint: mixed-section-shape, duplicate-preset-name, duplicate-node-id"
```

---

### Task 6: types for the authored shape

**Files:**
- Modify: `types/part.d.ts`
- Test: `test/partforge.test-d.ts` — pre-existing; APPEND new positive cases only, change nothing existing. Run via `npm run typecheck` (the foundation's Task 12 confirmed that is the gate that compiles it).

**Interfaces:**
- Produces: `PanelControlEntry`, `PanelGroupEntry`, `PanelPresetEntry`, `PanelEntry` (their union), and `NodeSection`; `ParameterSection` widens to `PresetSection | FeatureSection | NodeSection`.
- Naming note: the spec (§9) sketched these as `GroupNode`/`ControlNode`. The `…Entry` names are deliberate — these types describe what an AUTHOR writes, and the internal canonical nodes (`kind: "group"` etc.) are a different shape; reusing "Node" for both invites confusion.

- [ ] **Step 1: Add the types** (in `types/part.d.ts`, after `WhenCondition`)

```ts
/** One entry in a `controls` array: a control, a nested group, or a preset picker. */
export type PanelEntry = PanelControlEntry | PanelGroupEntry | PanelPresetEntry;

/** A control bound to one key in `defaults`. `type` defaults to `"slider"`. */
export interface PanelControlEntry {
  key: string;
  type?: ControlType;
  label?: string;
  description?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** checkbox: the value written when ticked (default 1). */
  on?: number;
  /** select / radio: the choices. Strings are both value and label. */
  options?: Array<ParamValue | { value: ParamValue; label?: string; description?: string }>;
  /** slider: logarithmic response. Requires min > 0. */
  scale?: "log";
  /** slider: marked values on the track; `snap: true` makes the thumb prefer them. */
  ticks?: number[];
  snap?: boolean;
  /** slider: [lo, hi] band drawn on the track; outside it the value box takes a warning tint. */
  recommended?: [number, number];
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
  /** These two discriminate against the container entries. */
  controls?: undefined;
  presets?: undefined;
}

/** A nested group. `collapsed` defaults to `"auto"` (the small-panel auto-open rule). */
export interface PanelGroupEntry {
  type: "group";
  id?: string;
  title?: string;
  collapsed?: boolean | "auto";
  /** No title, no disclosure — just an indented block. */
  bare?: boolean;
  controls: PanelEntry[];
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
}

/** A preset picker, positionable anywhere among the controls. */
export interface PanelPresetEntry {
  type: "preset";
  id?: string;
  label?: string;
  /** Preset name -> the param overrides it applies. */
  presets: Record<string, Record<string, ParamValue>>;
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
}

/** The new section shape: everything in `controls`, in render order. */
export interface NodeSection extends SectionBase {
  controls: PanelEntry[];
  collapsed?: boolean | "auto";
  when?: WhenCondition;
  whenFalse?: "disable";
  /** Discriminators: a NodeSection carries none of the legacy arrays. */
  features?: undefined;
  advanced?: undefined;
  toggles?: undefined;
  presets?: undefined;
}
```

then widen the union: `export type ParameterSection = PresetSection | FeatureSection | NodeSection;` — and add `controls?: undefined;` to `PresetSection` and `FeatureSection` so the union still discriminates (`PresetSection` already carries `features?: undefined`; follow that established trick).

Update `ControlType` when Tasks 7–8 land (they say so); here it stays as-is.

- [ ] **Step 2: Append a compile case to `test/partforge.test-d.ts`**

```ts
// The authored controls shape typechecks.
const nodeSection: ParameterSection = {
  id: "body", title: "Body",
  controls: [
    { type: "preset", presets: { A: { od: 5 } } },
    { key: "od", type: "slider", min: 1, max: 10, step: 1, recommended: [2, 8] },
    { type: "group", title: "Wall", collapsed: "auto", controls: [
      { key: "wall", min: 0.8, max: 4, step: 0.1, when: { od: { gt: 2 } } },
    ] },
  ],
};
void nodeSection;
```

(Import `ParameterSection` alongside the file's existing type imports if it isn't already.)

- [ ] **Step 3: Gate + commit**

Run: `npm run typecheck && npx vitest run`
Expected: clean.

```bash
git add types/part.d.ts test/partforge.test-d.ts
git commit -m "Types for the authored panel shape"
```

---

## Phase 5 — Widgets (Tasks 7–10)

### Task 7: `select` and `radio`

**Files:**
- Create: `src/framework/panel/widgets/select.js`
- Modify: `src/framework/panel/widgets/index.js`, `src/framework/panel/widget-specs.js`, `src/framework/lint/rules-schema.js` (two validators), `src/framework/app.css`, `types/part.d.ts` (`ControlType`)
- Create: `test/framework/panel/widgets.test.js`; append lint tests to `test/lint-authored.test.js`
- Modify: `test/framework/panel/registry.test.js` — the "covers exactly the types this phase supports" list gains `"select"`/`"radio"` (this file is plan-created; amending that expected list is the intended change)

**Interfaces:**
- Consumes: `attachInfo`; the option field from Task 6's types.
- Produces: `normalizeOptions(options) -> [{ value, label, description? }]` (exported for lint); `makeSelect` / `makeRadio` factories `(node, params, { onChange, info }) -> { el, sync }`; lint rules `select-options-missing` (error), `select-default-not-in-options` (error).

- [ ] **Step 1: Write the failing widget tests**

Create `test/framework/panel/widgets.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const selectSec = (over = {}) => ({ id: "s", title: "S", controls: [
  { key: "profile", type: "select", label: "Profile",
    options: [{ value: "round", label: "Round" }, { value: "faceted", label: "Faceted" }] },
  ...(over.extra ?? []),
] });

test("select renders options, reflects params, writes on change, fires onDirty", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  let dirty = 0;
  const params = { profile: "round" };
  buildControls(root, [selectSec()], params, () => dirty++);
  const sel = root.querySelector("select.select-input");
  expect([...sel.options].map((o) => o.textContent)).toEqual(["Round", "Faceted"]);
  expect(sel.value).toBe("round");
  sel.value = "faceted"; sel.dispatchEvent(new Event("change"));
  expect(params.profile).toBe("faceted");
  expect(dirty).toBe(1);
});

test("select round-trips NUMERIC option values through the string-valued DOM", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { teeth: 12 };
  buildControls(root, [{ id: "s", controls: [
    { key: "teeth", type: "select", options: [8, 12, 16] },   // shorthand: value === label
  ] }], params, () => {});
  const sel = root.querySelector("select.select-input");
  expect(sel.value).toBe("12");
  sel.value = "16"; sel.dispatchEvent(new Event("change"));
  expect(params.teeth).toBe(16);                              // number, not "16"
});

test("radio renders a segmented control; clicking writes and marks .on", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { mode: "a" };
  buildControls(root, [{ id: "s", controls: [
    { key: "mode", type: "radio", label: "Mode", options: ["a", "b", "c"] },
  ] }], params, () => {});
  const seg = root.querySelector(".seg");
  const btns = [...seg.querySelectorAll("button")];
  expect(btns.map((b) => b.textContent)).toEqual(["a", "b", "c"]);
  expect(btns[0].classList.contains("on")).toBe(true);
  btns[2].click();
  expect(params.mode).toBe("c");
  expect(btns[2].classList.contains("on")).toBe(true);
  expect(btns[0].classList.contains("on")).toBe(false);
});

test("sync re-reads params into select and radio without firing onDirty", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  let dirty = 0;
  const params = { profile: "round", mode: "a" };
  const panel = buildControls(root, [
    selectSec(), { id: "r", controls: [{ key: "mode", type: "radio", options: ["a", "b"] }] },
  ], params, () => dirty++);
  Object.assign(params, { profile: "faceted", mode: "b" });
  panel.syncValues();
  expect(root.querySelector("select.select-input").value).toBe("faceted");
  const on = [...root.querySelectorAll(".seg button")].filter((b) => b.classList.contains("on"));
  expect(on.map((b) => b.textContent)).toEqual(["b"]);
  expect(dirty).toBe(0);
  panel.dispose();
});

test("editing a select in a preset section drops the picker to Custom", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { profile: "round" };
  buildControls(root, [{ id: "s", controls: [
    { type: "preset", presets: { P: { profile: "round" } } },
    { key: "profile", type: "select", options: ["round", "faceted"] },
  ] }], params, () => {});
  const sel = root.querySelector("select.select-input");
  sel.value = "faceted"; sel.dispatchEvent(new Event("change"));
  expect(root.querySelector("select.preset").value).toBe("Custom");
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/framework/panel/widgets.test.js`
Expected: FAIL — unresolved `widgets/select.js` path (via factories) / unknown type skipped.

- [ ] **Step 3: Implement `src/framework/panel/widgets/select.js`**

```js
// select: a dropdown over `options`. radio: the same data as a segmented
// control (reuses the app's existing `.seg` styling), for 2–4 options where
// seeing all of them matters. Option values may be strings or numbers; the DOM
// only speaks strings, so both widgets map String(value) back to the real
// value on the way out.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

import { normalizeOptions } from "../widget-specs.js";

function labeledRow(node, info) {
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);
  return wrap;
}

export function makeSelect(node, params, { onChange, info }) {
  const wrap = labeledRow(node, info);
  const opts = normalizeOptions(node.options);
  const byString = new Map(opts.map((o) => [String(o.value), o.value]));
  const select = document.createElement("select");
  select.className = "select-input";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.label;
    if (o.description) opt.title = o.description; // long-form option descriptions surface as tooltips
    select.append(opt);
  }
  select.value = String(params[node.key]);
  select.addEventListener("change", () => {
    params[node.key] = byString.get(select.value);
    onChange?.();
  });
  wrap.append(select);
  const sync = () => { select.value = String(params[node.key]); };
  return { el: wrap, sync };
}

export function makeRadio(node, params, { onChange, info }) {
  const wrap = labeledRow(node, info);
  const opts = normalizeOptions(node.options);
  const seg = el("div", "seg");
  const buttons = opts.map((o) => {
    const b = el("button", "", o.label);
    b.type = "button";
    if (o.description) b.title = o.description;
    b.addEventListener("click", () => {
      params[node.key] = o.value;
      paint();
      onChange?.();
    });
    seg.append(b);
    return { b, value: o.value };
  });
  const paint = () => {
    for (const { b, value } of buttons) b.classList.toggle("on", params[node.key] === value);
  };
  paint();
  wrap.append(seg);
  return { el: wrap, sync: paint };
}
```

Register in `widgets/index.js` (`select: makeSelect, radio: makeRadio`). In `widget-specs.js`: select/radio are new-shape-only types, so their `fields` are the AUTHORED lists — add `select: ["options"], radio: ["options"]` to `AUTHOR_EXTRAS`, and add two spec entries `{ type: "select", kind: "control", fields: [...AUTHOR_COMMON, "options"] }` (same for `radio`). `WIDGET_TYPES` extends automatically. In `types/part.d.ts`, widen: `export type ControlType = "slider" | "number" | "text" | "textarea" | "checkbox" | "select" | "radio";`

Update `test/framework/panel/registry.test.js`'s expected type list to `["checkbox", "number", "radio", "select", "slider", "text", "textarea"]` (sorted) — the one intended amendment in that file this task.

CSS in `app.css`, next to `select.preset`:

```css
select.select-input {
  width: 100%; background: var(--pf-input-bg); color: var(--pf-text-2);
  border: 1px solid var(--pf-border); border-radius: var(--pf-radius-control); padding: 7px 9px;
  font-family: var(--pf-mono); font-size: 11px;
}
```

(`.seg` styling already exists at the top of app.css — radio reuses it unchanged.)

- [ ] **Step 4: The validators.** Lint must stay DOM-free and `widgets/select.js` imports `info.js` (which pulls `markdown.js`), so lint may never import the widget file. `normalizeOptions` therefore LIVES in `widget-specs.js` (pure, already in lint's closure) — define and export it there:

```js
// Long form [{ value, label?, description? }] or shorthand ["round", 8, ...]
// where each entry is both value and label. Lives here rather than in the
// select widget because lint's validators consume it and must stay DOM-free.
export function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((o) => o != null)
    .map((o) => (typeof o === "object"
      ? { value: o.value, label: o.label ?? String(o.value), description: o.description }
      : { value: o, label: String(o) }));
}
```

In `rules-schema.js` add `import { normalizeOptions } from "../panel/widget-specs.js";`, then append to `SCHEMA_RULES`:

```js
  {
    id: "select-options-missing",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ d, container }) => !container && (d.type === "select" || d.type === "radio"))
      .filter(({ d }) => normalizeOptions(d.options).length === 0)
      .map(({ d, path }) => err("select-options-missing",
        `${d.type} "${d.key}" has no options`,
        "A `select` or `radio` needs an `options` array — either strings/numbers (value doubles as label) or `{ value, label }` objects. With none, the control renders empty and the parameter can never change.",
        `${path}.options`)),
  },
  {
    id: "select-default-not-in-options",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      return collectDescriptors(part)
        .filter(({ d, container }) => !container && (d.type === "select" || d.type === "radio"))
        .filter(({ d }) => {
          const opts = normalizeOptions(d.options);
          return opts.length > 0 && typeof d.key === "string" && d.key in part.defaults
            && !opts.some((o) => o.value === part.defaults[d.key]);
        })
        .map(({ d, path }) => err("select-default-not-in-options",
          `\`defaults.${d.key}\` is ${JSON.stringify(part.defaults[d.key])}, which is not one of the ${d.type}'s options`,
          "The default value must be selectable, or the panel opens showing a value the user can never get back to. Add it to `options` or change the default.",
          `${path}.options`)),
    },
  },
```

Append covering tests to `test/lint-authored.test.js`:

```js
test("select with no options errors; default outside options errors", () => {
  const part = authoredPart();
  part.defaults.profile = "round";
  part.parameters[0].controls.push({ key: "profile", type: "select", options: [] });
  expect(ids(lintPart(part).errors)).toContain("select-options-missing");
  part.parameters[0].controls.at(-1).options = ["faceted", "hex"];
  expect(ids(lintPart(part).errors)).toContain("select-default-not-in-options");
  part.parameters[0].controls.at(-1).options = ["faceted", "round"];
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("select-options-missing");
  expect(ids(r.errors)).not.toContain("select-default-not-in-options");
});
```

- [ ] **Step 5: Gates**

Run: `npx vitest run test/framework/panel/widgets.test.js test/framework/panel/registry.test.js test/lint-authored.test.js test/lint-purity.test.js && npx vitest run`
Expected: all PASS (purity holds — `normalizeOptions` lives in the pure registry).

- [ ] **Step 6: Commit**

```bash
git add src/framework/panel/widgets/ src/framework/panel/widget-specs.js src/framework/lint/rules-schema.js src/framework/app.css types/part.d.ts docs/AUTHORING-PARTS.md test/framework/panel/ test/lint-authored.test.js
git commit -m "Add select and radio widgets with their validators"
```

(Per the Global Constraints, this commit includes the `select-options-missing` and `select-default-not-in-options` catalog rows in AUTHORING-PARTS.md — `test/lint-registry.test.js` gates on them.)

---

### Task 8: `readout` — the display kind, plus `panel.refresh`

A readout shows a `derive()` output; it is a `display` node, not a control (no key, never writes params, never in relevance). Its data arrives per param change via the new `refresh` handle, which mount already has a natural call site for.

**Files:**
- Create: `src/framework/panel/widgets/readout.js`
- Modify: `src/framework/panel/author.js` (readout entries → display nodes), `src/framework/panel/render.js` (display rendering + `refresh`), `src/framework/mount.js` (`updateRelevance` body), `src/framework/panel/widget-specs.js` (readout spec, `kind: "display"`), `src/framework/lint/rules-schema.js` (`readout-unknown-derived-key`), `types/part.d.ts` (readout entry type)
- Test: `test/framework/panel/widgets.test.js`, `test/framework/panel/author.test.js`, `test/lint-authored.test.js` (append); `test/framework/panel/registry.test.js` — amend the "every spec declares a kind" assertion from `toBe("control")` to `expect(["control", "display"]).toContain(spec.kind)` (**the explicitly authorized amendment** from the Global Constraints)

**Interfaces:**
- Consumes: `resolveDerived` from `src/framework/derive.js` (pure; already inside lint's closure via rules-animations).
- Produces: display node `{ kind: "display", type: "readout", label, unit, derivedKey, when, whenFalse, hidden }`; `makeReadout(node, { info }) -> { el, update(derived) }`; handle method `refresh({ relevant, derived })` with `applyRelevance(relevant)` delegating to it; mount passes `derived: resolveDerived(part, params)` on every param change; lint rule `readout-unknown-derived-key` (warn).

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/panel/author.test.js`:

```js
test("a readout entry becomes a display node, not a control", () => {
  const sec = authoredSection({ id: "s", controls: [
    { type: "readout", label: "Inner ø", derivedKey: "innerDia", unit: "mm" },
  ] });
  expect(sec.children[0]).toMatchObject({
    kind: "display", type: "readout", derivedKey: "innerDia", unit: "mm",
  });
  expect(sec.children[0].key).toBeUndefined();
});
```

Append to `test/framework/panel/widgets.test.js`:

```js
test("a readout renders, fills from refresh({derived}), and never syncs params", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 10 };
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "od", type: "slider", min: 1, max: 20, step: 1 },
    { type: "readout", label: "Inner ø", derivedKey: "innerDia", unit: "mm" },
  ] }], params, () => {});
  const val = root.querySelector(".readout .val");
  expect(val.textContent).toBe("—");                       // no derived yet
  panel.refresh({ derived: { innerDia: 8.4 } });
  expect(val.textContent).toContain("8.4");
  panel.refresh({ derived: { innerDia: 9 } });
  expect(val.textContent).toContain("9");
  panel.dispose();
});

test("refresh({relevant}) still drives dimming — applyRelevance delegates", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const panel = buildControls(root, [{ id: "s", title: "S", controls: [
    { key: "od", type: "slider", label: "OD", min: 1, max: 20, step: 1 },
    { key: "h", type: "slider", label: "H", min: 1, max: 20, step: 1 },
  ] }], { od: 5, h: 5 }, () => {});
  panel.refresh({ relevant: new Set(["od"]) });
  const wraps = [...root.querySelectorAll(".slider")];
  expect(wraps[0].classList.contains("irrelevant")).toBe(false);
  expect(wraps[1].classList.contains("irrelevant")).toBe(true);
  panel.applyRelevance(new Set(["h"]));                    // old name still works
  expect(wraps[1].classList.contains("irrelevant")).toBe(false);
  panel.dispose();
});
```

Append to `test/lint-authored.test.js`:

```js
test("a readout whose derivedKey no derive() group produces warns", () => {
  const part = authoredPart();
  part.derive = (p) => ({ innerDia: p.od - 2 * p.wall });
  part.parameters[0].controls.push({ type: "readout", label: "X", derivedKey: "nope" });
  const f = lintPart(part).warnings.find((f) => f.rule === "readout-unknown-derived-key");
  expect(f).toBeTruthy();
  part.parameters[0].controls.at(-1).derivedKey = "innerDia";
  expect(ids(lintPart(part).warnings)).not.toContain("readout-unknown-derived-key");
});
```

- [ ] **Step 2: Run, watch them fail. Step 3: Implement**

`author.js` — in `authoredChildren`, before the generic control branch:

```js
    else if (entry.type === "readout") out.push({
      kind: "display", type: "readout", label: entry.label, description: entry.description,
      unit: entry.unit, derivedKey: entry.derivedKey,
      hidden: !!entry.hidden, when: entry.when, whenFalse: entry.whenFalse,
    });
```

`model.js` and `panel-state.js` need NO changes: `buildTree` already passes non-group nodes through untouched, `controlNodes` already filters to `kind === "control"`, and the state pass's leaf branch already gives any non-control leaf `dimmed: false` while honoring `when`. Verify all three by reading before moving on. (Known quirk, deliberate: a section whose only leaves are readouts has zero control keys, so under any relevance `Set` it dims — the same pinned legacy behavior as a preset-only section. Ledger it; do not fix here.)

`widgets/readout.js`:

```js
// readout: a read-only display of one derive() output, named by `derivedKey`.
// A display node, not a control — it has no key, never writes params, and gets
// its value pushed via panel.refresh({ derived }), not pulled from params.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Same float-noise trim the numeric widgets use (4 dp max).
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

export function makeReadout(node, { info }) {
  const wrap = el("div", "slider readout");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  const val = el("div", "val", "—");
  row.append(label, val);
  wrap.append(row);
  const update = (derived) => {
    const v = derived?.[node.derivedKey];
    val.textContent = v == null ? "—"
      : typeof v === "number" ? numStr(v) + (node.unit ? ` ${node.unit}` : "")
      : String(v);
  };
  return { el: wrap, update };
}
```

`render.js` — add `import { makeReadout } from "./widgets/readout.js";`, a `const displayUpdates = new Map();`, and in `renderNode`, before the factory lookup:

```js
    if (node.kind === "display") {
      const widget = makeReadout(node, { info });
      nodeEls.set(node.id, widget.el);
      displayUpdates.set(node.id, widget.update);
      container.append(widget.el);
      return;
    }
```

and rework the handle:

```js
  let lastDerived = null;
  const refresh = ({ relevant: nextRelevant, derived } = {}) => {
    if (nextRelevant !== undefined) relevant = nextRelevant;
    if (derived !== undefined) {
      lastDerived = derived;
      for (const update of displayUpdates.values()) update(derived);
    }
    applyState();
  };
  return {
    refresh,
    applyRelevance: (next) => refresh({ relevant: next }),
    syncValues: /* unchanged */,
    dispose: /* unchanged */,
  };
```

`mount.js` — find `const updateRelevance = () => panel.applyRelevance(relevantParamKeys(part, view(), params));` and change the body to:

```js
    const updateRelevance = () => {
      // A throwing derive() must not break every slider drag — mount's pick
      // flow already guards its own resolveDerived call the same way
      // (mount.js ~:250). Readouts simply stay em-dashed.
      let derived = {};
      try { derived = resolveDerived(part, params); } catch { /* diagnosed by lint/build */ }
      panel.refresh({ relevant: relevantParamKeys(part, view(), params), derived });
    };
```

`resolveDerived` is already imported in mount.js (verify — it is used by the pick flow around line 250).

`widget-specs.js` — add `{ type: "readout", kind: "display", fields: ["type", "label", "description", "unit", "derivedKey", "hidden", "when", "whenFalse"] }` and the matching `AUTHOR_EXTRAS`/`AUTHOR_FIELDS` entry (readout's author fields ARE its spec fields). Three authorized registry-test amendments land here: (1) the kind assertion becomes `expect(["control", "display"]).toContain(spec.kind)`; (2) the `WIDGET_TYPES` expected list gains `"readout"` (sorted: `["checkbox","number","radio","readout","select","slider","text","textarea"]`); (3) the factory-coherence assertion filters to control kinds — readout's factory has a different signature and lives outside `WIDGET_FACTORIES` — i.e. compare against `WIDGET_SPECS.filter((s) => s.kind === "control").map((s) => s.type)`.

`rules-schema.js` — the rule (uses `resolveDerived` against defaults; wrap in try/catch — a throwing derive is another rule's problem):

```js
import { resolveDerived } from "../derive.js";
  {
    id: "readout-unknown-derived-key",
    run: ({ part }) => {
      let derivedKeys = null;
      try { derivedKeys = new Set(Object.keys(resolveDerived(part, { ...part?.defaults }))); }
      catch { return []; } // a throwing derive() is diagnosed elsewhere
      return collectDescriptors(part)
        .filter(({ d, container }) => !container && d.type === "readout")
        .filter(({ d }) => typeof d.derivedKey !== "string" || !derivedKeys.has(d.derivedKey))
        .map(({ d, path }) => warn("readout-unknown-derived-key",
          `readout names derived key "${d.derivedKey}", which derive() does not produce`,
          "A readout displays one output of `derive()`. Name a key a derive group returns, or add that key to `derive` — as it stands the readout shows an em-dash forever.",
          `${path}.derivedKey`));
    },
  },
```

`types/part.d.ts` — add to `PanelEntry` union:

```ts
/** A read-only display of one `derive()` output. Not bound to `defaults`. */
export interface PanelReadoutEntry {
  type: "readout";
  label?: string;
  description?: string;
  unit?: string;
  derivedKey: string;
  hidden?: boolean;
  when?: WhenCondition;
  whenFalse?: "disable";
  key?: undefined;
  controls?: undefined;
  presets?: undefined;
}
```

and widen `PanelEntry`. (`ControlType` does NOT gain "readout" — it is a display, not a control.)

- [ ] **Step 4: Gates**

Run: `npx vitest run test/framework/panel/ test/lint-authored.test.js test/lint-purity.test.js test/framework/mount.test.js && npm run typecheck && npx vitest run`
Expected: all PASS. mount.test.js unmodified — `applyRelevance` still exists and delegates.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/ src/framework/mount.js src/framework/lint/rules-schema.js types/part.d.ts docs/AUTHORING-PARTS.md test/
git commit -m "Add the readout display node and panel.refresh({relevant, derived})"
```

(Includes the `readout-unknown-derived-key` catalog row — the lint-registry gate requires it.)

---

### Task 9: `scale: "log"`

**Files:**
- Modify: `src/framework/panel/widgets/numeric.js`, `src/framework/lint/rules-schema.js` (one validator)
- Test: `test/framework/panel/widgets.test.js`, `test/lint-authored.test.js` (append)

**Interfaces:**
- Produces: sliders with `scale: "log"` map thumb position 0–1000 to `exp(ln(min) + t·(ln(max)−ln(min)))`; the value box stays linear and exact. Lint rule `log-scale-needs-positive-min` (error).

- [ ] **Step 1: Failing tests** (append to widgets.test.js)

```js
test("a log slider maps its track logarithmically and round-trips through sync", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { r: 1 };
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "r", type: "slider", label: "R", min: 0.1, max: 100, step: 0.1, scale: "log" },
  ] }], params, () => {});
  const slider = root.querySelector('input[type="range"]');
  expect(slider.min).toBe("0");
  expect(slider.max).toBe("1000");
  // position 500 is the geometric midpoint: sqrt(0.1 * 100) ≈ 3.1623.
  // No step-rounding on the log path — the value is the exact mapping.
  slider.value = "500"; slider.dispatchEvent(new Event("input"));
  expect(params.r).toBeCloseTo(Math.sqrt(0.1 * 100), 6);
  // syncing back after a programmatic change lands the thumb where the value is
  params.r = 100; panel.syncValues(["r"]);
  expect(slider.value).toBe("1000");
  params.r = 0.1; panel.syncValues(["r"]);
  expect(slider.value).toBe("0");
  panel.dispose();
});

test("the value box on a log slider stays linear and clamps as usual", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { r: 1 };
  buildControls(root, [{ id: "s", controls: [
    { key: "r", type: "slider", min: 0.1, max: 100, step: 0.1, scale: "log" },
  ] }], params, () => {});
  const box = root.querySelector("input.num");
  box.value = "250"; box.dispatchEvent(new Event("change"));
  expect(params.r).toBe(100);   // clamped to max, linear semantics untouched
});
```

and to lint-authored.test.js:

```js
test("scale:log with a non-positive min errors", () => {
  const part = authoredPart();
  part.parameters[0].controls.push({ key: "wall", type: "slider", min: 0, max: 4, step: 0.1, scale: "log" });
  expect(ids(lintPart(part).errors)).toContain("log-scale-needs-positive-min");
});
```

- [ ] **Step 2: Run, fail. Step 3: Implement**

In `makeNumeric`, branch on `node.scale === "log"`. Keep every existing linear path byte-identical; the log path substitutes the slider's min/max/step and the two conversion points:

```js
  const LOG_STEPS = 1000;
  const log = node.scale === "log" && node.min > 0;
  const toValue = (t) => Math.exp(Math.log(node.min) + (t / LOG_STEPS) * (Math.log(node.max) - Math.log(node.min)));
  const toPos = (v) => Math.round(LOG_STEPS * (Math.log(v) - Math.log(node.min)) / (Math.log(node.max) - Math.log(node.min)));
```

- slider setup: `slider.min = log ? 0 : node.min; slider.max = log ? LOG_STEPS : node.max; slider.step = log ? 1 : node.step; slider.value = log ? toPos(params[node.key]) : params[node.key];`
- slider input handler: `const v = log ? toValue(+slider.value) : +slider.value;` — **no step-rounding on either branch**: the linear path stays byte-identical to today (it writes `+slider.value` exactly), and a log track's whole point is resolution that varies with magnitude (`numStr` already trims display noise).
- box input/change handlers: after writing params, `if (slider) slider.value = log ? toPosSafe(v) : v;` where `toPosSafe` guards the unclamped live-typed value — `toPos(0)` is `-Infinity` and a non-finite assignment makes the browser snap the thumb to mid-track:

```js
  const toPosSafe = (v) => {
    if (!(v > 0)) return 0;
    const t = toPos(v);
    return Math.max(0, Math.min(LOG_STEPS, Number.isFinite(t) ? t : 0));
  };
```

- `sync`: `slider.value = log ? toPosSafe(params[node.key]) : params[node.key];`

Validator in rules-schema.js:

```js
  {
    id: "log-scale-needs-positive-min",
    run: ({ part }) => collectDescriptors(part)
      .filter(({ d, container }) => !container && d.scale === "log" && !(typeof d.min === "number" && d.min > 0))
      .map(({ d, path }) => err("log-scale-needs-positive-min",
        `"${d.key}" uses scale:"log" with min ${d.min}`,
        "A logarithmic track needs min > 0 — log(0) is -Infinity and the mapping breaks. Raise `min` (e.g. 0.1) or drop `scale`.",
        `${path}.scale`)),
  },
```

- [ ] **Step 4: Gates + commit**

Run: `npx vitest run test/framework/panel/widgets.test.js test/framework/controls.test.js test/lint-authored.test.js && npx vitest run`
Expected: PASS; the linear path untouched (controls.test.js 31 unmodified).

```bash
git add src/framework/panel/widgets/numeric.js src/framework/lint/rules-schema.js docs/AUTHORING-PARTS.md test/
git commit -m "Logarithmic slider scale, guarded by lint"
```

(Includes the `log-scale-needs-positive-min` catalog row.)

---

### Task 10: `ticks`/`snap` and the `recommended` band

**Files:**
- Modify: `src/framework/panel/widgets/numeric.js`, `src/framework/app.css`, `src/framework/lint/rules-schema.js` (one validator)
- Test: `test/framework/panel/widgets.test.js`, `test/lint-authored.test.js` (append)

**Interfaces:**
- Produces: `ticks: number[]` renders a `<datalist>` bound via the slider's `list` attribute; `snap: true` quantizes slider input to the nearest tick. `recommended: [lo, hi]` draws a band on the track (CSS vars `--band-lo`/`--band-hi` as percentages on the wrap, class `has-band`) and toggles `warn` on the value box when the value sits outside the band. Lint rule `slider-refinement-invalid` (warn) — ticks outside [min,max], or a malformed/inverted `recommended`.

- [ ] **Step 1: Failing tests** (append to widgets.test.js)

```js
test("ticks render a datalist; snap quantizes slider input to the nearest tick", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { n: 6 };
  buildControls(root, [{ id: "s", controls: [
    { key: "n", type: "slider", min: 0, max: 12, step: 1, ticks: [0, 6, 12], snap: true },
  ] }], params, () => {});
  const slider = root.querySelector('input[type="range"]');
  const dl = root.querySelector("datalist");
  expect(dl).toBeTruthy();
  expect(slider.getAttribute("list")).toBe(dl.id);
  expect([...dl.querySelectorAll("option")].map((o) => o.value)).toEqual(["0", "6", "12"]);
  slider.value = "8"; slider.dispatchEvent(new Event("input"));
  expect(params.n).toBe(6);        // snapped to the nearest tick
  slider.value = "10"; slider.dispatchEvent(new Event("input"));
  expect(params.n).toBe(12);
});

test("recommended draws a band and warns the value box outside it", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { wall: 1.6 };
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "wall", type: "slider", min: 0.8, max: 4, step: 0.1, recommended: [1.2, 4] },
  ] }], params, () => {});
  const wrap = root.querySelector(".slider");
  const box = root.querySelector("input.num");
  expect(wrap.classList.contains("has-band")).toBe(true);
  expect(wrap.style.getPropertyValue("--band-lo")).toBe("12.5%");   // (1.2-0.8)/(4-0.8)
  expect(wrap.style.getPropertyValue("--band-hi")).toBe("100%");
  expect(box.classList.contains("warn")).toBe(false);
  box.value = "0.9"; box.dispatchEvent(new Event("input"));
  expect(box.classList.contains("warn")).toBe(true);
  params.wall = 2; panel.syncValues(["wall"]);
  expect(box.classList.contains("warn")).toBe(false);
  panel.dispose();
});
```

and to lint-authored.test.js:

```js
test("out-of-range ticks and an inverted recommended band warn", () => {
  const part = authoredPart();
  part.parameters[0].controls.push(
    { key: "wall", type: "slider", min: 0.8, max: 4, step: 0.1, ticks: [0.5, 2] },
    { key: "od", type: "slider", min: 1, max: 10, step: 1, recommended: [9, 2] },
  );
  const found = ids(lintPart(part).warnings).filter((r) => r === "slider-refinement-invalid");
  expect(found).toHaveLength(2);
});
```

- [ ] **Step 2: Run, fail. Step 3: Implement**

In `makeNumeric` (linear path; ticks/band are not offered on log sliders — document in the spec fields, lint stays silent since a log slider with ticks simply ignores them... **no, be strict**: fold "ticks/recommended on a log slider" into `slider-refinement-invalid` as a third case):

Place this AFTER the `if (!numeric) { ... }` block that creates `slider` — a `type: "number"` control has `slider === null` and must skip ticks entirely:

```js
  // ticks: native datalist marks; snap quantizes input to the nearest tick.
  // The datalist id derives from the node id (assigned by buildTree before
  // factories run) — stable across re-renders, no randomness.
  if (slider && !log && Array.isArray(node.ticks) && node.ticks.length) {
    const dl = document.createElement("datalist");
    dl.id = `pf-ticks-${node.id.replaceAll("/", "-")}`;
    for (const t of node.ticks) {
      const o = document.createElement("option");
      o.value = String(t);
      dl.append(o);
    }
    wrap.append(dl);
    slider.setAttribute("list", dl.id);
  }
  const snapTo = (v) => {
    if (!node.snap || !Array.isArray(node.ticks) || !node.ticks.length) return v;
    return node.ticks.reduce((best, t) => Math.abs(t - v) < Math.abs(best - v) ? t : best);
  };
```

Apply `snapTo` in the slider input handler only (typed values stay exact — the box accepts values finer than step by design). Band setup after `wrap` exists:

```js
  const band = !log && Array.isArray(node.recommended) && node.recommended.length === 2
    ? node.recommended : null;
  if (band) {
    wrap.classList.add("has-band");
    const pct = (v) => `${Math.max(0, Math.min(100, ((v - node.min) / (node.max - node.min)) * 100))}%`;
    wrap.style.setProperty("--band-lo", pct(band[0]));
    wrap.style.setProperty("--band-hi", pct(band[1]));
  }
  const paintWarn = () => {
    if (band) box.classList.toggle("warn", params[node.key] < band[0] || params[node.key] > band[1]);
  };
```

Call `paintWarn()` at the end of construction, in every handler that writes `params[node.key]`, and in `sync`.

CSS (app.css, by the range-slider block):

```css
/* recommended band: a tinted span of the track between --band-lo and --band-hi */
.slider.has-band input[type="range"]::-webkit-slider-runnable-track {
  background: linear-gradient(to right,
    var(--pf-border) var(--band-lo),
    color-mix(in oklab, var(--pf-accent) 30%, var(--pf-border)) var(--band-lo),
    color-mix(in oklab, var(--pf-accent) 30%, var(--pf-border)) var(--band-hi),
    var(--pf-border) var(--band-hi));
}
.slider.has-band input[type="range"]::-moz-range-track {
  background: linear-gradient(to right,
    var(--pf-border) var(--band-lo),
    color-mix(in oklab, var(--pf-accent) 30%, var(--pf-border)) var(--band-lo),
    color-mix(in oklab, var(--pf-accent) 30%, var(--pf-border)) var(--band-hi),
    var(--pf-border) var(--band-hi));
}
/* value box outside the recommended band */
.row .num.warn { border-color: var(--pf-err); color: var(--pf-err); }
```

Validator:

```js
  {
    id: "slider-refinement-invalid",
    run: ({ part }) => {
      const out = [];
      for (const { d, path, container } of collectDescriptors(part)) {
        if (container) continue;
        const numeric = typeof d.min === "number" && typeof d.max === "number";
        if (Array.isArray(d.ticks) && numeric && d.ticks.some((t) => t < d.min || t > d.max)) {
          out.push(warn("slider-refinement-invalid",
            `"${d.key}" has ticks outside its ${d.min}..${d.max} range`,
            "Every tick must sit inside [min, max] — an out-of-range tick renders nowhere and, with snap, drags the value out of range.",
            `${path}.ticks`));
        }
        if (Array.isArray(d.recommended)
            && (d.recommended.length !== 2 || !(d.recommended[0] < d.recommended[1]))) {
          out.push(warn("slider-refinement-invalid",
            `"${d.key}" has a malformed recommended band`,
            "`recommended` is [lo, hi] with lo < hi — the tinted span of the track the DFM checks consider safe.",
            `${path}.recommended`));
        }
        if (d.scale === "log" && (d.ticks || d.recommended)) {
          out.push(warn("slider-refinement-invalid",
            `"${d.key}" combines scale:"log" with ticks/recommended`,
            "Ticks and the recommended band render on a linear track only; on a log slider they are ignored. Drop one or the other.",
            `${path}.scale`));
        }
      }
      return out;
    },
  },
```

- [ ] **Step 4: Gates + commit**

Run: `npx vitest run test/framework/panel/widgets.test.js test/framework/controls.test.js test/lint-authored.test.js && npx vitest run`

```bash
git add src/framework/panel/widgets/numeric.js src/framework/app.css src/framework/lint/rules-schema.js docs/AUTHORING-PARTS.md test/
git commit -m "Slider ticks, snap, and the recommended band"
```

(Includes the `slider-refinement-invalid` catalog row.)

---

## Phase 6 — Conditions, exposed (Tasks 11–12)

The engine itself shipped in 0.47.0 (`evalWhen`, `WHEN_OPS`, hide/disable in `computeState`) and Task 1 already lets authors write `when`/`whenFalse`. What phase 6 adds is the guard rails and the missing presentation pieces.

### Task 11: lint rules `when-key-not-in-defaults` and `when-unknown-operator`

**Files:**
- Modify: `src/framework/lint/rules-schema.js`
- Test: `test/lint-authored.test.js` (append)

**Interfaces:**
- Consumes: `WHEN_OPS` from `../panel/model.js` (the operator table IS the grammar — the did-you-mean list derives from its keys, so a new operator can never leave lint behind); `suggest` from `../geometry/op-options.js` (already imported).
- Produces: rules `when-key-not-in-defaults` (error), `when-unknown-operator` (error), covering `when` on every authored node — controls, groups, presets, readouts, and sections.

- [ ] **Step 1: Failing tests** (append to `test/lint-authored.test.js`)

```js
test("a when condition naming a key not in defaults errors, on any node kind", () => {
  const part = authoredPart();
  part.parameters[0].controls[3].when = { nope: { gt: 0 } };            // group
  part.parameters[0].controls[1].when = { missing: 1 };                 // control
  const errs = lintPart(part).errors.filter((f) => f.rule === "when-key-not-in-defaults");
  expect(errs).toHaveLength(2);
  expect(errs.map((f) => f.path).sort()).toEqual([
    "parameters[0].controls[1].when", "parameters[0].controls[3].when",
  ]);
});

test("allOf/anyOf/not recurse; keys inside them are checked too", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { allOf: [{ show: 1 }, { not: { ghost: 1 } }] };
  const errs = lintPart(part).errors.filter((f) => f.rule === "when-key-not-in-defaults");
  expect(errs).toHaveLength(1);           // `ghost` only — `show` is real
});

test("an unknown operator errors with a did-you-mean", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { show: { gte1: 1 } };
  const f = lintPart(part).errors.find((f) => f.rule === "when-unknown-operator");
  expect(f).toBeTruthy();
  expect(f.hint).toMatch(/Recognised: gt, gte/);   // the operator list comes from WHEN_OPS
});

test("a valid condition produces no when findings", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { show: { gt: 0 }, wall: { in: [1, 2] } };
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("when-key-not-in-defaults");
  expect(ids(r.errors)).not.toContain("when-unknown-operator");
});
```

- [ ] **Step 2: Run, fail. Step 3: Implement**

`collectDescriptors` already yields every authored node (controls AND containers) with its path. Sections need covering too: in the authored branch of `collectDescriptors`, also push the section itself when it carries a `when`: `out.push({ d: sec, path: `parameters[${si}]`, fields: SECTION_FIELDS, container: true })` — define `SECTION_FIELDS = ["id", "title", "description", "hidden", "collapsed", "when", "whenFalse", "controls"]` in widget-specs.js and let `unknown-control-field` skip legacy sections as it always has (legacy sections are not descriptors).

```js
import { WHEN_OPS } from "../panel/model.js";

// Walk one WhenCondition, calling out(keyPath) for every param key and
// op(op) for every operator object entry.
function walkWhen(cond, onKey, onOp) {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return;
  for (const [key, want] of Object.entries(cond)) {
    if (key === "allOf" || key === "anyOf") {
      for (const c of Array.isArray(want) ? want : []) walkWhen(c, onKey, onOp);
    } else if (key === "not") {
      walkWhen(want, onKey, onOp);
    } else {
      onKey(key);
      if (want !== null && typeof want === "object" && !Array.isArray(want)) {
        for (const op of Object.keys(want)) onOp(op);
      }
    }
  }
}

  {
    id: "when-key-not-in-defaults",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      const out = [];
      for (const { d, path } of collectDescriptors(part)) {
        if (!d.when) continue;
        walkWhen(d.when, (key) => {
          if (!known.has(key)) {
            const hint = suggest(key, [...known]);
            out.push(err("when-key-not-in-defaults",
              `\`when\` references "${key}", which is not in \`defaults\``,
              `Conditions read raw parameter keys only${hint ? ` — did you mean "${hint}"?` : "."} A key defaults doesn't have always reads undefined, so the condition is always false and the node never shows.`,
              `${path}.when`));
          }
        }, () => {});
      }
      return out;
    },
  },
  {
    id: "when-unknown-operator",
    run: ({ part }) => {
      const ops = Object.keys(WHEN_OPS);
      const out = [];
      for (const { d, path } of collectDescriptors(part)) {
        if (!d.when) continue;
        walkWhen(d.when, () => {}, (op) => {
          if (!ops.includes(op)) {
            const hint = suggest(op, ops);
            out.push(err("when-unknown-operator",
              `\`when\` uses unknown operator "${op}"`,
              `evalWhen treats an unknown operator as false, so the node silently never shows. Recognised: ${ops.join(", ")}${hint ? ` — did you mean "${hint}"?` : "."}`,
              `${path}.when`));
          }
        });
      }
      return out;
    },
  },
```

- [ ] **Step 4: Gates + commit**

Run: `npx vitest run test/lint-authored.test.js test/lint-schema.test.js test/lint-purity.test.js && npx vitest run`

```bash
git add src/framework/lint/rules-schema.js src/framework/panel/widget-specs.js docs/AUTHORING-PARTS.md test/lint-authored.test.js
git commit -m "Lint validates when conditions: keys against defaults, operators against WHEN_OPS"
```

(Includes the `when-key-not-in-defaults` and `when-unknown-operator` catalog rows.)

---

### Task 12: condition presentation — CSS coverage and the disabled `<select>`

Two carry-forwards from the 0.47.0 final review, both of which become user-visible the moment authors write `when`.

**Files:**
- Modify: `src/framework/app.css`, `src/framework/panel/render.js`
- Test: `test/framework/panel/render.test.js` (append)

- [ ] **Step 1: Failing tests** (append to render.test.js)

```js
test("a condition-hidden control and section carry .hidden, and a disabled preset select gets the attribute", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { mode: 0, od: 5 };
  const panel = buildControls(root, [
    { id: "a", title: "A", controls: [
      { key: "mode", type: "checkbox", label: "Mode" },
      { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1, when: { mode: { gt: 0 } } },
      { type: "preset", presets: { P: { od: 5 } }, when: { mode: { gt: 0 } }, whenFalse: "disable" },
    ] },
    { id: "b", title: "B", when: { mode: { gt: 0 } }, controls: [
      { key: "od2", type: "slider", min: 1, max: 10, step: 1 },
    ] },
  ], { ...params, od2: 3 }, () => {});
  const odWrap = [...root.querySelectorAll(".slider")].find((w) => w.querySelector("label")?.textContent === "OD");
  expect(odWrap.classList.contains("hidden")).toBe(true);
  const sections = [...root.querySelectorAll(".section")];
  expect(sections[1].classList.contains("hidden")).toBe(true);
  const preset = root.querySelector("select.preset");
  expect(preset.classList.contains("disabled")).toBe(true);
  expect(preset.disabled).toBe(true);                       // the ATTRIBUTE, not just the class
  const box = root.querySelector('input[type="checkbox"]');
  box.checked = true; box.dispatchEvent(new Event("change"));   // the file's established idiom
  expect(odWrap.classList.contains("hidden")).toBe(false);
  expect(preset.disabled).toBe(false);
  panel.dispose();
});
```

- [ ] **Step 2: Run, fail on the select attribute (the classes already toggle). Step 3: Implement**

`render.js` — in `applyState`'s disabled block, handle an element that IS a form control (the preset `<select>` has no wrapper):

```js
      if (!isGroup && lastDisabled.get(id) !== s.disabled) {
        if (node.matches?.("input, select, textarea")) node.disabled = s.disabled;
        for (const input of node.querySelectorAll("input, select, textarea")) {
          input.disabled = s.disabled;
        }
        lastDisabled.set(id, s.disabled);
      }
```

`app.css` — one rule, beside `.feat-group.hidden`:

```css
/* Condition-hidden nodes. Disclosure state uses `.hidden` on `.adv` /
   `.sec-body` (rules above); everything else carrying `.hidden` inside the
   panel is a `when` that evaluated false. */
.section.hidden, .slider.hidden, .feat.hidden, select.preset.hidden { display: none; }
```

- [ ] **Step 4: Hand-check in the dev server**

Run `npm run dev`, open `/planter.html` (still legacy — nothing changes) and confirm nothing visual regressed: sections open, drainage tick reveals, dimming intact.

- [ ] **Step 5: Gates + commit**

Run: `npx vitest run test/framework/panel/render.test.js test/framework/controls.test.js && npx vitest run`

```bash
git add src/framework/app.css src/framework/panel/render.js test/framework/panel/render.test.js
git commit -m "Condition-hidden CSS coverage; disabled reaches the preset select"
```

---

## Phase 7 — The authoring surface (Tasks 13–16)

### Task 13: structural rules `group-depth` and `section-too-many-controls`

The LLM-facing rules: they push toward a panel that is *organized*, which field validation cannot do.

**Files:**
- Modify: `src/framework/lint/rules-schema.js`
- Test: `test/lint-authored.test.js` (append)

- [ ] **Step 1: Failing tests**

```js
test("nesting groups past two levels warns", () => {
  const part = authoredPart();
  part.parameters[0].controls = [{ type: "group", title: "L1", controls: [
    { type: "group", title: "L2", controls: [
      { type: "group", title: "L3", controls: [{ key: "od", min: 1, max: 10, step: 1 }] },
    ] },
  ] }];
  const found = lintPart(part).warnings.filter((f) => f.rule === "group-depth");
  expect(found).toHaveLength(2);                          // L2 (depth 2) and L3 (depth 3)
  expect(found[0].path).toBe("parameters[0].controls[0].controls[0]");
});

test("a section showing more than twelve visible controls warns", () => {
  const part = authoredPart();
  part.parameters[0].controls = Array.from({ length: 13 }, (_, i) => (
    { key: `k${i}`, type: "slider", min: 0, max: 1, step: 1 }));
  for (let i = 0; i < 13; i++) part.defaults[`k${i}`] = 0;
  expect(ids(lintPart(part).warnings)).toContain("section-too-many-controls");
  part.parameters[0].controls[12].hidden = true;            // 12 visible → fine
  expect(ids(lintPart(part).warnings)).not.toContain("section-too-many-controls");
});

test("a legacy section is measured too — features and toggles count as controls", () => {
  const part = authoredPart();
  part.parameters[0] = { id: "big", advanced: Array.from({ length: 13 }, (_, i) => (
    { key: `k${i}`, min: 0, max: 1, step: 1 })) };
  for (let i = 0; i < 13; i++) part.defaults[`k${i}`] = 0;
  expect(ids(lintPart(part).warnings)).toContain("section-too-many-controls");
});
```

- [ ] **Step 2: Run, fail. Step 3: Implement** — both rules work on the desugared tree, so legacy and authored sections are measured with one ruler:

```js
export const SECTION_CONTROL_BUDGET = 12; // a guess, deliberately a warning — revisit against real LLM-authored parts

  {
    id: "group-depth",
    run: ({ part }) => {
      // Depth counts AUTHORED nesting only, so it needs source paths — walk the
      // raw sections, not the desugared tree (which adds the legacy Advanced
      // group an author never wrote).
      const out = [];
      sections(part).forEach((sec, si) => {
        const walk = (list, base, depth) => arr(list).forEach((entry, i) => {
          if (!entry || entry.type !== "group") return;
          const path = `${base}[${i}]`;
          if (depth >= 2) {
            out.push(warn("group-depth",
              `group "${entry.title ?? i}" is nested ${depth + 1} levels deep`,
              "Two levels (a section, one fold inside it) is as deep as a 300px rail stays readable. Flatten: promote the inner group to its own section, or fold its controls into the parent.",
              path));
          }
          walk(entry.controls, `${path}.controls`, depth + 1);
        });
        walk(sec?.controls, `parameters[${si}].controls`, 1);
      });
      return out;
    },
  },
  {
    id: "section-too-many-controls",
    run: ({ part }) => {
      const out = [];
      const countControls = (nodes) => {
        let n = 0;
        for (const node of nodes ?? []) {
          if (node.hidden) continue;
          if (node.kind === "group") n += countControls(node.children);
          else if (node.kind === "control") n += 1;
        }
        return n;
      };
      desugar(part?.parameters ?? []).forEach((sec, si) => {
        if (sec.hidden) return;
        const n = countControls(sec.children);
        if (n > SECTION_CONTROL_BUDGET) {
          out.push(warn("section-too-many-controls",
            `section "${sec.id ?? si}" shows ${n} controls`,
            `More than ${SECTION_CONTROL_BUDGET} visible controls in one section reads as a wall. Group related controls (\`{ type: "group", collapsed: "auto" }\`), split the section, or hide internals (\`hidden: true\`).`,
            `parameters[${si}]`));
        }
      });
      return out;
    },
  },
```

- [ ] **Step 4: Gates + commit**

Run: `npx vitest run test/lint-authored.test.js test/lint-schema.test.js && npx partforge lint src/parts/planter.js && npx vitest run`
Expected: PASS; the nine in-repo parts stay clean (none exceeds the budget).

```bash
git add src/framework/lint/rules-schema.js docs/AUTHORING-PARTS.md test/lint-authored.test.js
git commit -m "Structural lint: group-depth and section-too-many-controls"
```

(Includes the `group-depth` and `section-too-many-controls` catalog rows.)

---

### Task 14: ERROR-PATTERNS entries and the rule catalog

**Files:**
- Modify: `docs/ERROR-PATTERNS.md`, `docs/AUTHORING-PARTS.md` (rule catalog section, `### Rule catalog` near line 1132)

- [ ] **Step 1: Read both files' existing formats first.** ERROR-PATTERNS is one `##` per pattern mapping literal symptom → cause → fix; the rule catalog is a table. Match them exactly.

- [ ] **Step 2: Polish the rule-catalog rows the earlier tasks appended.** Each rule task added its own row(s) as it landed (the lint-registry gate forces that); this step reads the full catalog for consistency — same voice, severity column correct (errors: mixed-section-shape, duplicate-preset-name, duplicate-node-id, select-options-missing, select-default-not-in-options, log-scale-needs-positive-min, when-key-not-in-defaults, when-unknown-operator; warns: readout-unknown-derived-key, slider-refinement-invalid, group-depth, section-too-many-controls) — and tightens wording where rows were written in haste.

- [ ] **Step 3: Add ERROR-PATTERNS entries.** `test/error-patterns.test.js` enforces the format: each entry is a kebab-case `##` heading with `Symptom` / `Cause` / `Fix` in order, and every id must be appended to that test's `BASELINE_IDS` list (ids are permanent). Add four entries with exactly these ids, and append the four ids to `BASELINE_IDS`:

- `## duplicate-preset-name-throws` — Symptom: `duplicate preset name across sections: "..."` thrown from verify/measure. Cause: the same preset name declared twice (legacy field or preset node). Fix: rename one; `npx partforge lint` reports `duplicate-preset-name` before verify ever runs.
- `## when-condition-never-true` — Symptom: a control with `when` never appears, no error anywhere. Cause: the condition references a key not in `defaults` (reads undefined, always false) or a typo'd operator (evalWhen treats unknown operators as false). Fix: run lint — `when-key-not-in-defaults` / `when-unknown-operator` name the key/operator.
- `## readout-shows-em-dash` — Symptom: a readout renders "—" forever. Cause: `derivedKey` names a key no `derive()` group produces. Fix: name a produced key or add it to `derive`; lint warns via `readout-unknown-derived-key`.
- `## select-default-unreachable` — Symptom: the panel opens showing a value the select/radio can never get back to. Cause: `defaults[key]` is not among the options (watch value types — `12` ≠ `"12"`). Fix: add the default to `options` or change the default; lint errors via `select-default-not-in-options`.

- [ ] **Step 4: Commit**

```bash
git add docs/ERROR-PATTERNS.md docs/AUTHORING-PARTS.md
git commit -m "Document the new lint rules in the catalog and error patterns"
```

---

### Task 15: rewrite the Parameters authoring guide

The LLM-facing payoff. `docs/AUTHORING-PARTS.md` "Parameters: the control-panel schema" (`## Parameters: the control-panel schema` at ~line 454 through the `---` before `## Designing the control panel`) gets rewritten around the node model; the legacy shapes move to a clearly-marked compatibility subsection at the end of it. "Designing the control panel" gains when-to-reach-for guidance.

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Create: `test/framework/docs-coherence.test.js`

- [ ] **Step 1: Write the coherence test first** (it pins the rewrite's completeness):

```js
// Registry ↔ docs coherence: a control type that exists but is undocumented is
// how the downstream prompt corpus rots — partforge-cloud regenerates its
// prompts from this file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { WIDGET_SPECS } from "../../src/framework/panel/widget-specs.js";

const guide = readFileSync(
  fileURLToPath(new URL("../../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");

test("every widget type in the registry appears in the authoring guide", () => {
  for (const spec of WIDGET_SPECS) {
    expect(guide.includes(`"${spec.type}"`) || guide.includes(`\`${spec.type}\``),
      `AUTHORING-PARTS.md never mentions type "${spec.type}"`).toBe(true);
  }
});

test("the guide documents the node-model keywords", () => {
  for (const kw of ["controls", "type: \"group\"", "type: \"preset\"", "when", "whenFalse",
                    "collapsed", "recommended", "derivedKey"]) {
    expect(guide.includes(kw), `guide is missing ${kw}`).toBe(true);
  }
});
```

- [ ] **Step 2: Rewrite the Parameters section.** Structure (write real prose, not this outline — the outline is the required content):

1. **Lead with the node shape.** A section is `{ id, title, description, controls: [...] }`; authored order is render order. One complete worked example (adapt the spec §1 example — profile select, conditional facets slider, a Wall group with `recommended` and a readout). State the three entry kinds (control / `type:"group"` / `type:"preset"`) and that groups nest (two levels max — `group-depth` warns).
2. **Control types table**: slider (default), number, text, textarea, checkbox, select, radio — one row each with their fields; readout documented as a display, explicitly "not a control: no `key`, shows a `derive()` output named by `derivedKey`".
3. **Slider refinements**: `scale:"log"` (min must be > 0), `ticks`/`snap`, `recommended: [lo, hi]` with the DFM framing (the visual companion to min-wall checks).
4. **Conditions**: the `when` grammar (equality, gt/gte/lt/lte/ne/in, allOf/anyOf/not, multiple keys AND), raw-defaults-keys-only rule, `whenFalse: "disable"` vs the default hide, and the relevance-dimming distinction (auto-computed, dims; `when` is authored, hides/disables — they are different mechanisms and look different on purpose).
5. **Collapsing**: keep the existing 0.47.0 paragraph, extended: `collapsed` on sections and groups, the ≤3-sections auto-open rule.
6. **Presets as nodes**: positionable, more than one per section, names global to the part (verify expands one case per preset).
7. **Guidance for a good panel** (fold into "Designing the control panel"): few controls visible first — groups for the rest; a `select` when values are discrete, a `radio` when 2–4 and seeing all matters, a checkbox for booleans; `when` for controls that only apply in one mode; every control gets a `description`; ≤12 visible controls per section (`section-too-many-controls` warns).
8. **Legacy compatibility subsection** at the end: the old `presets`/`advanced`/`toggles`/`features` arrays keep working forever, one desugar-mapping table (from the spec §2), and "new parts should write `controls`". Do NOT delete the legacy documentation — downstream parts still use it — but demote it.

- [ ] **Step 3: Update the `@deprecated` JSDoc** in `types/part.d.ts` on `ControlDef`/`FeatureDef`/`ToggleDef` — the wording ("Prefer a `controls` array") is now TRUE; verify it reads correctly against the shipped surface and leave it.

- [ ] **Step 4: Gates + commit**

Run: `npx vitest run test/framework/docs-coherence.test.js && npx vitest run`

```bash
git add docs/AUTHORING-PARTS.md types/part.d.ts test/framework/docs-coherence.test.js
git commit -m "Rewrite the Parameters guide around the node model"
```

---

### Task 16: enrich `bracket.js` and `planter.js`, bump to 0.48.0, final gates

Two in-repo parts move to the new shape as live proof and corpus examples; the other seven stay legacy deliberately, as proof compatibility holds.

**Files:**
- Modify: `src/parts/bracket.js`, `src/parts/planter.js`, `package.json`
- Test: existing suites; smoke checks

- [ ] **Step 1: bracket.js** — convert the "Shape ops" section (currently a `clip` toggle + a `clearance` advanced slider) to the new shape; the other two sections stay legacy:

```js
    {
      id: "shape",
      title: "Shape ops",
      controls: [
        { key: "clip", type: "radio", label: "Arm tips",
          options: [{ value: 0, label: "Square" }, { value: 1, label: "Clipped" }],
          description: "**Intersect** the cross with a circle so the four arm tips are rounded off to a common radius." },
        { key: "clearance", type: "slider", label: "Print-clearance offset", unit: "mm",
          min: 0, max: 1, step: 0.1,
          description: "**Offset** the whole outline outward (round corners) for a looser slip fit. 0 = none." },
      ],
    },
```

(`defaults.clip` is numeric 0/1 already — the radio's numeric option values bind to it exactly. Verify against the file before editing; keep any fields the section carries that this snippet doesn't mention.)

- [ ] **Step 2: planter.js** — Body section to the new shape: preset node first, the four headline sliders, then a Wall group with the `recommended` band and an inner-diameter readout. Drainage stays a legacy `features` section ON PURPOSE (live proof both shapes coexist in one part). Add `innerDia` to `derive` (it already computes the wall inset — expose the value):

```js
    {
      id: "body",
      title: "Body",
      description:
        "The faceted vessel. Pick a preset to start, or dial exact dimensions below — " +
        "**Facets** and **Twist** are pure styling; open **Wall** for the one that decides whether it prints cleanly.",
      controls: [
        { type: "preset", presets: { /* the existing three presets, unchanged */ } },
        { key: "facets", type: "slider", label: "Facets", min: 3, max: 12, step: 1, description: "…" },
        { key: "dia", type: "slider", label: "Diameter", unit: "mm", min: 30, max: 150, step: 1, description: "…" },
        { key: "height", type: "slider", label: "Height", unit: "mm", min: 20, max: 200, step: 1, description: "…" },
        { key: "taper", type: "slider", label: "Top taper", min: 0.6, max: 1.4, step: 0.02, description: "…" },
        { key: "twist", type: "slider", label: "Twist", unit: "°", min: 0, max: 180, step: 5, description: "…" },
        { type: "group", title: "Wall", collapsed: "auto", controls: [
          { key: "wall", type: "slider", label: "Wall thickness", unit: "mm",
            min: 0.8, max: 4, step: 0.1, recommended: [1.2, 4], description: "…existing description…" },
          { type: "readout", label: "Inner diameter", derivedKey: "innerDia", unit: "mm",
            description: "Clear inside width at the base, after the walls." },
          { key: "floor", type: "slider", label: "Floor thickness", unit: "mm",
            min: 1, max: 6, step: 0.5, hidden: true, description: "…existing…" },
        ] },
      ],
    },
```

Copy every existing description verbatim (the `…` markers above mean "the current text, unchanged"). In `derive`, add `innerDia` to the returned object — read the function first; it computes an inner radius for the shell, so `innerDia` is `2 *` that value (or `p.dia - 2 * p.wall` if no inner radius exists — match the geometry, don't guess: the readout must agree with what `build` constructs).

- [ ] **Step 3: Per-part gates**

Run: `npx partforge lint src/parts/bracket.js && npx partforge lint src/parts/planter.js && npx partforge measure src/parts/bracket.js && npx partforge measure src/parts/planter.js`
Expected: lint clean, measure exit 0 with the same numbers as before the edit (geometry untouched — capture before/after and compare).

- [ ] **Step 4: Bump the version**

`package.json` `"version": "0.47.0"` → `"0.48.0"`. Minor: new authorable surface. This is the ONLY package.json change on the branch. Forgetting it is the repo's quiet failure mode (AGENTS.md) — the merge lands and nothing ships.

- [ ] **Step 5: Full verification**

Run: `npm test && npm run check`
Expected: full suite PASS; smoke apps PASS (text-smoke's bare-run "cutaway control: missing" is pre-existing on main — CI passes it with `--allow-no-cutaway`; only that exact failure is ignorable).

Then look at it: `npm run dev`, open `/planter.html` — the Wall group folds, the band tints the wall track, the readout updates while dragging Diameter; `/bracket.html` — the segmented Arm tips control switches the clip. Drag sliders; nothing snaps shut.

- [ ] **Step 6: Commit**

```bash
git add src/parts/bracket.js src/parts/planter.js package.json
git commit -m "Enrich bracket and planter to the authored shape; bump to 0.48.0"
```

Do not push and do not open a PR — report and wait for the go-ahead.

---

## Risks

- **The `refresh`/`applyRelevance` seam (Task 8) touches mount's hot path.** `resolveDerived` runs per param change; it is pure and cheap (the spec says so explicitly), but verify with the planter drag test that nothing stutters. If a part's derive were expensive, that's the part's bug — same position the relevance prober already takes.
- **`select` value identity.** Params hold numbers and strings; the DOM only speaks strings. Every read back through `byString` — never `select.value` raw. The numeric round-trip test is the canary; keep it.
- **`snap` fights the box.** Snapping applies to slider drags only; typed values stay exact. If a reviewer flags the asymmetry, it is deliberate — the box has always accepted values finer than `step`.
- **Enrichment must not change geometry.** Task 16's parts keep every default, key, and build path; only the panel schema moves. `measure` before/after equality is the gate.
- **Doc drift is the real failure mode.** The docs-coherence test (Task 15) is the mechanical guard; the human-judgment half — does the guide TEACH well? — lands in review of Task 15, which should be read by a reviewer as prose, not just diffed.

## What this plan does NOT do

- No layout DSL, no color/vector/stepper widgets (spec non-goals).
- No persistence of user collapse choices (derived fresh per load, spec non-goal).
- No removal or deprecation-warning of legacy shapes at runtime — they work indefinitely; only the docs demote them.
- `.disabled` class is not renamed (collision-risk note from the 0.47.0 review) — revisit if a host ever reports a clash.
