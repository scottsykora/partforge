# Text Controls and Cutaway Picking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add live single-line and multiline string controls to the generated panel, demonstrate them in the nameplate, and stop the cutaway translation affordance from masking rotation hits.

**Architecture:** Dispatch parameter controls by `def.control`, keeping the existing numeric implementation intact and adding one string-control implementation with the same `{ wrap, sync }` contract. Reorder cutaway picking so real proxy intersections are resolved before the semantic center fallback, preserving the existing geometry and depth ordering.

**Tech Stack:** Plain ESM, DOM APIs, three.js, Vitest with happy-dom, Vite.

---

### Task 1: Add live string controls

**Files:**
- Modify: `test/framework/controls.test.js`
- Modify: `src/framework/controls.js`
- Modify: `src/framework/app.css`

**Step 1: Write failing control tests**

Add tests that render an advanced section containing:

```js
{ key: "title", label: "Title", control: "text" }
{ key: "label", label: "Label", control: "textarea" }
```

Assert that `input[type="text"]` and `textarea` receive the initial string values.
Dispatch `input` events after changing `.value`; assert `params` receives the exact
strings (including `\n`) and `onDirty` fires once per event. Add a preset-section test
that verifies text editing selects `Custom` and applying a preset resynchronizes both
text fields.

**Step 2: Run the focused tests and verify RED**

Run:

```bash
nvm use
npx vitest run test/framework/controls.test.js
```

Expected: FAIL because both definitions still render numeric inputs and string edits
do not update parameters.

**Step 3: Implement the string control factory**

In `src/framework/controls.js`, add `makeTextControl(def, params, onChange, info)`.
It should:

```js
const multiline = def.control === "textarea";
const field = document.createElement(multiline ? "textarea" : "input");
if (!multiline) field.type = "text";
field.value = String(params[def.key] ?? "");
field.addEventListener("input", () => {
  params[def.key] = field.value;
  onChange?.();
});
const sync = () => { field.value = String(params[def.key] ?? ""); };
```

Use the existing `.slider`, label, description, and registration structure. Add a
small dispatcher used by both preset advanced controls and feature controls:

```js
const makeParameterControl = (def, params, onChange, info) =>
  def.control === "text" || def.control === "textarea"
    ? makeTextControl(def, params, onChange, info)
    : makeSlider(def, params, onChange, info);
```

Style the field with a dedicated class using existing panel variables. It should fill
the available width, retain the current focus ring, and give textareas a sensible
minimum height with vertical resizing.

**Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run test/framework/controls.test.js
```

Expected: all controls tests pass.

**Step 5: Commit**

```bash
git add src/framework/controls.js src/framework/app.css test/framework/controls.test.js
git commit -m "feat: add live text parameter controls"
```

### Task 2: Make the nameplate label editable

**Files:**
- Create: `test/nameplate-part.test.js`
- Modify: `src/parts/nameplate.js`

**Step 1: Write a failing nameplate test**

Import the part definition and assert `part.defaults.label` is a string. Build the
plate with a minimal recording kernel/shape stub and an overridden label such as
`"CUSTOM\nLABEL"`; assert the first argument passed to `k.text2d` is that string.

**Step 2: Run the test and verify RED**

Run:

```bash
npx vitest run test/nameplate-part.test.js
```

Expected: FAIL because the label is still the module-level `LABEL` constant.

**Step 3: Wire the string parameter through the example**

In the Lettering section, add:

```js
{
  key: "label",
  label: "Text",
  control: "textarea",
  description: "The text rendered on the nameplate. Line breaks create multiple lines.",
}
```

Move the current two-line label into `defaults.label`, remove the module constant,
and call `k.text2d(p.label, ...)`. Update the section description to describe editable
content rather than a fixed label.

**Step 4: Run the nameplate and controls tests**

Run:

```bash
npx vitest run test/nameplate-part.test.js test/framework/controls.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/parts/nameplate.js test/nameplate-part.test.js
git commit -m "feat: expose editable nameplate text"
```

### Task 3: Fix cutaway handle arbitration

**Files:**
- Modify: `test/framework/cutaway-gizmo.test.js`
- Modify: `src/framework/cutaway-gizmo.js`

**Step 1: Write failing picker regression tests**

Add a real-geometry test using the production pose. Move the pointer onto the inner
edge of the vertical rotation band inside the current 22-pixel center reserve and
assert hover selects `"rotate-x"`, not `"translate"`.

Add a deterministic arbitration test by spying on
`THREE.Raycaster.prototype.intersectObjects`:

```js
vi.spyOn(THREE.Raycaster.prototype, "intersectObjects")
  .mockReturnValue([{ object: gizmo.handles.rotateY }]);
```

Move at the projected center and assert the real intersection wins. Then return `[]`
and assert the same center position still selects translation through the semantic
fallback.

**Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/framework/cutaway-gizmo.test.js
```

Expected: the overlap tests fail because `pick()` returns translation before calling
the raycaster.

**Step 3: Reorder the picker**

Update `pick(event, ray)` to call `handleRoot.updateWorldMatrix` and resolve the first
real proxy intersection before computing the center fallback:

```js
handleRoot.updateWorldMatrix(true, true);
const intersection = raycaster.intersectObjects(hitProxies, false)[0];
const intersectedHandle = resolveHandle(intersection);
if (intersectedHandle) return intersectedHandle;
// existing projected-center fallback follows
```

Do not change proxy geometry, the fallback radius, or injected `pickHandle` behavior.

**Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run test/framework/cutaway-gizmo.test.js
```

Expected: all gizmo tests pass.

**Step 5: Commit**

```bash
git add src/framework/cutaway-gizmo.js test/framework/cutaway-gizmo.test.js
git commit -m "fix: prioritize real cutaway handle hits"
```

### Task 4: Document the schema and verify the release surface

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`

**Step 1: Update author documentation**

Document `control: "text"` and `control: "textarea"`, string-valued defaults, live
updates, multiline line breaks, and a short schema example. Keep numeric control
documentation unchanged.

**Step 2: Run complete verification**

Run:

```bash
nvm use
npm test
npm run build
npm run check
node scripts/check-app.mjs nameplate.html
```

Expected: 0 test failures, successful production build, and browser smokes reporting
`booted: true`, `hovered: true`, `cutaway: true` where supported, with `errors: 0`.

**Step 3: Inspect the final diff**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: no whitespace errors and only intentional follow-up files.

**Step 4: Commit documentation and any intentional lockfile synchronization**

```bash
git add docs/AUTHORING-PARTS.md package-lock.json
git commit -m "docs: document editable text controls"
```

**Step 5: Push and open the follow-up PR**

```bash
git push -u origin codex/text-controls-hit-testing
gh pr create --base main --head codex/text-controls-hit-testing --title "Add text controls and fix cutaway picking" --body-file <prepared-body>
```
