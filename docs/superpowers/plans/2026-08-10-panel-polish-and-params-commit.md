# Panel Polish + onParamsCommit Implementation Plan (partforge)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clamp info popovers to the viewport, make collapsible section headers unmistakably clickable, and add an `onParamsCommit` mount option that fires when the user finishes editing a control.

**Architecture:** All changes live in the existing panel modules: `src/framework/panel/info.js` (popover), `src/framework/panel/render.js` + `src/framework/app.css` (section headers), the four widget files + `render.js` + `src/framework/mount.js` (commit notification). No new files except tests.

**Tech Stack:** Plain ESM, vitest with `@vitest-environment happy-dom` for panel tests.

**Spec:** `docs/superpowers/specs/2026-08-10-panel-polish-and-settings-commit-design.md`

## Global Constraints

- Node 24 required: run `nvm use` before anything (`.nvmrc` pins it; the default shell Node is too old and fails confusingly).
- Version bump to **0.49.0** happens in this PR (release process: bump on the feature branch; publish is automatic on merge — never run `npm publish`).
- Tests locate sections by `.sec-title` `textContent === title` — the chevron span must never carry text (glyph via CSS `::before` only).
- Two different things use `.hidden`: conditions hide a node, a disclosure closes a fold. Never conflate them (see the block comment in `render.js` above `renderGroup`).
- `onParamsCommit` fires ONLY for user panel edits — never from `setParams`, `syncValues`, or animation playback.
- Full suite: `npx vitest run test/framework/controls.test.js` for the fast loop, `npm test` before finishing.
- Work happens on the current branch (`claude/control-panel-ui-settings-883002`).

---

### Task 1: `popoverLeft` — clamp the info popover to the viewport

**Files:**
- Modify: `src/framework/panel/info.js` (add helper ~line 21, use it in `toggle` ~line 54)
- Modify: `src/framework/controls.js:13` (add `popoverLeft` to the re-export)
- Test: `test/framework/controls.test.js` (next to the existing `popoverTop` test, ~line 18)

**Interfaces:**
- Produces: `popoverLeft({ glyphLeft, popWidth, viewportWidth }) -> number` — exported from `partforge`'s `controls.js` barrel alongside `popoverTop`.

- [ ] **Step 1: Write the failing test**

In `test/framework/controls.test.js`, extend the import on line 3 to `import { clampToRange, popoverTop, popoverLeft } from "../../src/framework/controls.js";` and add below the `popoverTop` test:

```js
test("popoverLeft aligns near the glyph, clamps to a 10px margin at both edges", () => {
  // fits: aligned 8px left of the glyph
  expect(popoverLeft({ glyphLeft: 100, popWidth: 200, viewportWidth: 800 })).toBe(92);
  // glyph near the right edge: pulled left so the right edge sits 10px in
  expect(popoverLeft({ glyphLeft: 700, popWidth: 200, viewportWidth: 800 })).toBe(590);
  // popover wider than the viewport allows: the left margin wins
  expect(popoverLeft({ glyphLeft: 5, popWidth: 900, viewportWidth: 800 })).toBe(10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/framework/controls.test.js -t "popoverLeft"`
Expected: FAIL — `popoverLeft` is not exported.

- [ ] **Step 3: Implement**

In `src/framework/panel/info.js`, after `popoverTop` (line 21), add:

```js
// Popover left edge: aligned 8px left of the glyph when that fits, pulled
// left so the popover's right edge keeps a 10px margin from the viewport
// edge, and never past a 10px margin on the left (left margin wins when both
// would be violated). Pure, for direct unit testing — happy-dom reports zero
// layout metrics, same as popoverTop above.
export function popoverLeft({ glyphLeft, popWidth, viewportWidth }) {
  return Math.max(10, Math.min(glyphLeft - 8, viewportWidth - 10 - popWidth));
}
```

In `toggle()` (line 54), replace:

```js
      pop.style.left = `${Math.max(8, r.left - 8)}px`;
```

with:

```js
      pop.style.left = `${popoverLeft({ glyphLeft: r.left, popWidth: pop.offsetWidth, viewportWidth: window.innerWidth })}px`;
```

(`pop.offsetWidth` is valid here: the content is set and `hidden` already cleared a few lines up, same ordering the top calculation relies on.)

In `src/framework/controls.js` line 13, change the re-export to:

```js
export { popoverTop, popoverLeft, createInfoPopover, attachInfo } from "./panel/info.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/controls.test.js`
Expected: PASS (all tests in the file — the existing popover DOM tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/info.js src/framework/controls.js test/framework/controls.test.js
git commit -m "Clamp info popovers to the viewport's right edge"
```

---

### Task 2: Section header markup — chevron first, `.collapsed` class

**Files:**
- Modify: `src/framework/panel/render.js` (~lines 43, 61–67, 229–254)
- Test: `test/framework/controls.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `.section` elements gain/lose a `collapsed` class in lockstep with the disclosure; inside `.sec-title` the `.chev` span now PRECEDES `.sec-name`. Task 3's CSS relies on both.

- [ ] **Step 1: Write the failing test**

Add to `test/framework/controls.test.js` (after the `sectionByTitle` helper, which this test reuses):

```js
test("section header: chevron precedes the title; .collapsed tracks the disclosure", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  // "Shut" uses the NEW authored shape (`controls:`) because legacy desugar
  // hard-sets `collapsed: "auto"` on legacy-shaped sections (legacy.js:105) —
  // only author.js honors an explicit `collapsed: true` (author.js:82).
  buildControls(root, [
    { id: "open", title: "Open", advanced: [{ key: "a", label: "A", min: 0, max: 1, step: 1 }] },
    { id: "shut", title: "Shut", collapsed: true,
      controls: [{ type: "slider", key: "b", label: "B", min: 0, max: 1, step: 1 }] },
  ], { a: 0, b: 0 }, () => {});

  const openSec = sectionByTitle(root, "Open");
  const shutSec = sectionByTitle(root, "Shut");
  const title = openSec.querySelector(".sec-title");
  expect(title.firstElementChild.className).toBe("chev"); // chevron leads
  expect(title.textContent).toBe("Open");                 // …and carries no text

  // initial open state → class matches
  expect(openSec.classList.contains("collapsed")).toBe(false);
  expect(shutSec.classList.contains("collapsed")).toBe(true);

  // clicking toggles both the body and the class
  shutSec.querySelector(".sec-title").click();
  expect(shutSec.classList.contains("collapsed")).toBe(false);
  expect(shutSec.querySelector(".sec-body").classList.contains("hidden")).toBe(false);
  openSec.querySelector(".sec-title").click();
  expect(openSec.classList.contains("collapsed")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/framework/controls.test.js -t "chevron precedes"`
Expected: FAIL — `firstElementChild.className` is `"sec-name"` today, and no `.collapsed` class exists.

- [ ] **Step 3: Implement in `render.js`**

Three edits:

(a) Line ~236 — swap the span order (the chev span still carries NO text; the exact-textContent contract holds):

```js
    title.append(el("span", "chev"), el("span", "sec-name", section.title ?? ""));
```

(b) The section click handler (~line 249) — add the class toggle:

```js
    title.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      title.setAttribute("aria-expanded", String(!nowHidden));
      secEl.classList.toggle("collapsed", nowHidden);
    });
```

(c) `applyOpenState` + the `disclosures` entries. Extend the map's shape comment (~line 40) to mention `el`, set `el` on both registration sites, and mirror the class in `applyOpenState`:

```js
  // Containers that own a disclosure: sections, and titled inner groups (the
  // legacy "Advanced" fold). `label` is set only for the inner groups, whose
  // button text carries the ▾/▴ instead of a chevron span. `el` is set only
  // for sections: the section element mirrors the disclosure with a
  // `.collapsed` class so CSS can draw the closed-band affordance.
  const disclosures = new Map(); // id -> { body, button, label, el }
```

Section registration (~line 253): `disclosures.set(section.id, { body, button: title, label: null, el: secEl });`
Fold registration (~line 149): `disclosures.set(node.id, { body, button: toggle, label: node.title, el: null });`

In `applyOpenState` (~line 61), inside the loop after the aria-expanded line:

```js
      if (d.el) d.el.classList.toggle("collapsed", !open);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/controls.test.js`
Expected: PASS — including every pre-existing `sectionByTitle` lookup (the chev span is text-free, so `textContent === title` still matches).

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/render.js test/framework/controls.test.js
git commit -m "Lead section titles with the chevron; mirror disclosure in a .collapsed class"
```

---

### Task 3: Section header CSS — size, hover, collapsed rule

**Files:**
- Modify: `src/framework/app.css:68-79`

**Interfaces:**
- Consumes: the `.collapsed` class and chev-first ordering from Task 2.

- [ ] **Step 1: Replace the header block**

In `src/framework/app.css`, replace lines 68–79 (from `.sec-header {` through the `.chev` rotate rule; do NOT touch `.sec-body.hidden` on line 80) with:

```css
/* Section disclosure header: the whole row is the click target. Hover tint
   and pill padding live on .sec-header; the negative horizontal margins
   cancel the padding so the title keeps the rail's text alignment. */
.sec-header {
  display: flex; align-items: center; gap: 4px;
  margin: 0 -6px 6px; padding: 4px 6px; border-radius: 6px;
}
.sec-header:hover { background: var(--pf-surface-2); }
.sec-title {
  flex: 1; display: flex; align-items: center; gap: 8px;
  width: 100%; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer;
  text-align: left;
  font-family: var(--pf-mono); font-size: 12px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--pf-text-2);
}
.sec-header:hover .sec-title { color: var(--pf-text); }
/* Disclosure triangle: leads the title (the chev span is first in the
   button) and is sized up from the label so the affordance reads at a
   glance. Glyph via ::before — the span must stay text-free (tests match
   .sec-title by exact textContent). */
.sec-title .chev {
  display: inline-block; font-size: 13px; line-height: 1; color: var(--pf-muted-2);
  transition: transform 0.15s ease;
}
.sec-title .chev::before { content: "▾"; }
.sec-title[aria-expanded="false"] .chev { transform: rotate(-90deg); }
/* Collapsed section: a rule under the header marks the closed band as
   clickable. Drawn inside the header — not on .section — so it can never
   double up with the inter-section border-top above. */
.section.collapsed .sec-header {
  margin-bottom: 0; padding-bottom: 9px;
  border-bottom: 1px solid var(--pf-border);
  border-radius: 6px 6px 0 0;
}
```

Note the old `.sec-title:hover { color: var(--pf-text-2); }` rule (line 76) is replaced by the `.sec-header:hover .sec-title` rule — do not leave both.

- [ ] **Step 2: Check the focus ring still applies**

Line ~199 has `.sec-title:focus-visible` in a shared rule — leave it untouched; verify it still exists after your edit:

Run: `grep -n "sec-title:focus-visible" src/framework/app.css`
Expected: one match.

- [ ] **Step 3: Run the suite + smoke check**

Run: `npx vitest run test/framework/controls.test.js && node scripts/check-app.mjs demo.html`
Expected: tests PASS; smoke check boots the demo app clean (requires Playwright Chromium — `npx playwright install chromium` if missing).

- [ ] **Step 4: Visual check**

Run `npm run dev`, open `/planter.html` (richest panel). Verify: triangle leads each section title at 13px; titles read at 12px; hovering any header (open or collapsed) tints the row; collapsing a section draws a rule under its header with no doubled hairline against the next section's top border; below-720px narrow layout unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/framework/app.css
git commit -m "Make section headers read as clickable: bigger chevron+title, hover tint, collapsed rule"
```

---

### Task 4: `onCommit` through the widgets and `buildControls`

**Files:**
- Modify: `src/framework/panel/render.js` (signature + widget ctx + preset)
- Modify: `src/framework/panel/widgets/numeric.js`, `checkbox.js`, `select.js`, `text.js`
- Test: `test/framework/controls.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildControls(root, parameters, params, onDirty, onCommit)` — 5th positional arg, `onCommit(keys: string[])`, wrapped so a throwing handler never breaks the panel. Widget factories now receive `{ onChange, onCommit, info }` where `onCommit()` takes no args (render.js binds the key). Task 5 consumes the 5th arg from mount.

- [ ] **Step 1: Write the failing tests**

Add to `test/framework/controls.test.js`:

```js
test("onCommit fires on slider release (change), not during drag (input)", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5 };
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    params, () => {}, (keys) => commits.push(keys));
  const slider = root.querySelector('input[type="range"]');
  slider.value = "7";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(params.od).toBe(7);
  expect(commits).toEqual([]);            // mid-drag: no commit
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["od"]]);      // release: one commit, the key
});

test("number box commits on change (blur/Enter), including after live typing", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5 };
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    params, () => {}, (keys) => commits.push(keys));
  const box = root.querySelector('input[type="number"]');
  box.value = "8";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  expect(commits).toEqual([]);            // live preview: no commit
  box.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["od"]]);
  // an invalid entry reverts and must NOT commit
  box.value = "abc";
  box.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["od"]]);
});

test("checkbox and preset commits: a preset carries every key it wrote", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5, h: 2, show: 0 };
  buildControls(root, [
    { id: "b", title: "Body", presets: { Tall: { od: 3, h: 9 } },
      advanced: [
        { key: "od", label: "OD", min: 1, max: 10, step: 1 },
        { key: "h", label: "H", min: 1, max: 10, step: 1 },
      ] },
    { id: "m", title: "Motor", toggles: [{ key: "show", label: "Show", on: 1 }] },
  ], params, () => {}, (keys) => commits.push(keys));

  root.querySelector('input[type="checkbox"]')
    .dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["show"]]);

  const preset = root.querySelector("select.preset");
  preset.value = "Tall";
  preset.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["show"], ["od", "h"]]);
  expect(params).toMatchObject({ od: 3, h: 9 });
});

test("syncValues never commits; a throwing commit handler never breaks the panel", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5 };
  const panel = buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    params, () => {}, (keys) => { commits.push(keys); throw new Error("host boom"); });
  params.od = 9;
  panel.syncValues(["od"]);               // programmatic: no commit
  expect(commits).toEqual([]);
  const slider = root.querySelector('input[type="range"]');
  slider.value = "7";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(() => slider.dispatchEvent(new Event("change", { bubbles: true }))).not.toThrow();
  expect(commits).toEqual([["od"]]);      // dispatched despite the throw
  expect(params.od).toBe(7);              // the panel kept working
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/controls.test.js -t "commit"`
Expected: FAIL — commits array stays empty (no wiring exists).

- [ ] **Step 3: Implement**

`src/framework/panel/render.js`:

(a) Signature (line 27): `export function buildControls(root, parameters, params, onDirty, onCommit) {`

(b) After the `onEdit` definition (~line 113), add:

```js
  // A commit = the user FINISHED an interaction (slider released, box
  // committed, checkbox ticked, preset applied). Distinct from onDirty, which
  // fires on every input event mid-drag. Wrapped: a throwing host handler
  // must never break the panel.
  const commit = (keys) => {
    if (!onCommit) return;
    try { onCommit(keys); } catch { /* host's problem, not the panel's */ }
  };
```

(c) The widget factory call (~line 204) gains the bound callback:

```js
    const widget = factory(node, params, {
      onChange: () => { markCustom(); onEdit(); },
      onCommit: () => commit([node.key]),
      info,
    });
```

(d) `renderPreset`'s change listener (~line 170): after `onEdit();` add `commit(Object.keys(bundle));`

`src/framework/panel/widgets/numeric.js` — destructure `onCommit` (`{ onChange, onCommit, info }`) and:
- after the slider's `input` listener, add: `slider.addEventListener("change", () => onCommit?.());`
- in the box's existing `change` listener, add `onCommit?.();` as the last line of the VALID branch only (after `onChange?.()`; the `v == null` revert path returns early and must not commit).

`src/framework/panel/widgets/checkbox.js` — destructure `onCommit`; in the `change` listener add `onCommit?.();` after `onChange?.()`.

`src/framework/panel/widgets/select.js` — destructure `onCommit` in BOTH factories; `makeSelect`: add `onCommit?.();` after `onChange?.()` in the change listener. `makeRadio`: add `onCommit?.();` after `onChange?.()` in each button's click listener.

`src/framework/panel/widgets/text.js` — destructure `onCommit`; keep the `input` listener as is, and add:

```js
  field.addEventListener("change", () => onCommit?.());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/controls.test.js`
Expected: PASS, including all pre-existing tests (they pass `undefined` for the new 5th arg — every commit call site is optional-chained or guarded).

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/render.js src/framework/panel/widgets/numeric.js src/framework/panel/widgets/checkbox.js src/framework/panel/widgets/select.js src/framework/panel/widgets/text.js test/framework/controls.test.js
git commit -m "Widgets report a commit when the user finishes an edit"
```

---

### Task 5: `onParamsCommit` mount option

**Files:**
- Modify: `src/framework/mount.js` (option destructure ~line 145, doc comment ~line 94–139, buildControls call ~line 487)
- Test: `test/framework/mount.test.js`

**Interfaces:**
- Consumes: Task 4's 5th `buildControls` arg.
- Produces: `mount(part, { ..., onParamsCommit })` where `onParamsCommit({ changed, params })` receives the changed-key array and a SNAPSHOT COPY of params. This is the surface partforge-cloud consumes.

- [ ] **Step 1: Write the failing test**

Add to `test/framework/mount.test.js` (reuse the file's `makePart`, `makeWorkers`, `makeElements` helpers):

```js
test("onParamsCommit fires on a finished panel edit with a snapshot, never from setParams", () => {
  const { createWorker } = makeWorkers();
  const els = makeElements();
  const commits = [];
  const runtime = mount(makePart(), { createWorker, elements: els,
    onParamsCommit: (p) => commits.push(p) });

  const slider = els.controls.querySelector('input[type="range"]');
  slider.value = "6";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(commits).toEqual([]);                       // mid-drag
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toHaveLength(1);
  expect(commits[0].changed).toEqual(["h"]);
  expect(commits[0].params).toMatchObject({ h: 6, tilt: 0 });

  // the payload is a snapshot: a later edit must not mutate it
  runtime.setParams({ h: 9 });
  expect(commits[0].params.h).toBe(6);
  expect(commits).toHaveLength(1);                   // setParams never commits
  runtime.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/framework/mount.test.js -t "onParamsCommit"`
Expected: FAIL — commits stays empty.

- [ ] **Step 3: Implement**

In `src/framework/mount.js`:

(a) Add `onParamsCommit` to the destructure at line 145 (after `onViewChange`).

(b) The `buildControls` call (~line 487) gains the 5th arg:

```js
    const panel = buildControls(els.controls, part.parameters, params, () => {
      animCtl?.notifyUserEdit();
      onParamChange();
    }, onParamsCommit
      ? (changed) => onParamsCommit({ changed, params: { ...params } })
      : undefined);
```

(c) In the mount-contract doc comment (the block starting ~line 94), add one entry alongside the other callbacks:

```js
//   onParamsCommit({ changed, params })   // the user FINISHED editing a panel control (slider
//                                         // released, box committed, checkbox ticked, preset
//                                         // applied): `changed` lists the keys written, `params`
//                                         // is a snapshot copy. Never fired by setParams or
//                                         // animation playback — hosts call setParams from their
//                                         // own undo/reset, and firing here would loop.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/mount.test.js test/framework/controls.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount.js test/framework/mount.test.js
git commit -m "mount: onParamsCommit tells the host when a panel edit lands"
```

---

### Task 6: Version bump, docs coherence, full suite

**Files:**
- Modify: `package.json:3` (`"version": "0.48.0"` → `"0.49.0"`)
- Possibly modify: `docs/AUTHORING-PARTS.md` (only if docs-coherence flags it)

- [ ] **Step 1: Bump the version**

In `package.json` line 3: `"version": "0.49.0",`

- [ ] **Step 2: Docs coherence + full suite**

Run: `npx vitest run test/framework/docs-coherence.test.js && npm test`
Expected: PASS. If docs-coherence fails on the new mount option or renamed CSS hooks, fix the doc it names (it reports the exact file/claim) and re-run.

- [ ] **Step 3: Smoke check all CI apps**

Run: `npm run check`
Expected: clean boot for demo/planter/filleted-box/text-smoke.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "Bump to 0.49.0"
```

---

## After this plan

Merging the PR publishes 0.49.0 automatically. Verify with `npm view partforge version`, then execute the companion plan in partforge-cloud: `docs/superpowers/plans/2026-08-10-panel-settings-save.md` (cloud repo). Its final task bumps cloud's dep to `^0.49.0`.
