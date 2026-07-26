# Controls Rail Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn partforge's floating control panel into a resizable full-height rail on the right edge, set back from the 3D viewer, with full-bleed parameter sections and partforge-cloud's type/shape/shadow.

**Architecture:** `#app` becomes an in-flow flex viewer column that owns its floating chrome, and `#panel` becomes a flex-fixed rail beside it. A new class-based `chrome.css` (exported as `partforge/chrome.css`) holds the reusable layout so partforge-cloud can later drop its duplicated positioning; legacy id-only markup keeps its old floating look through `:not(.pf-*)` fallbacks in `app.css`. Resize is a pure state machine (`rail-state.js`) plus a thin DOM binding (`rail.js`) that writes `--pf-rail-w` straight onto `:root` during a drag.

**Tech Stack:** Plain ESM + plain CSS (no Tailwind in this package), Vite 8, Vitest 4 on happy-dom, Playwright/Chromium for the smoke check, `@fontsource-variable/*` for self-hosted Geist.

**Spec:** `docs/superpowers/specs/2026-07-26-controls-rail-layout-design.md` — read it before starting. Section references below (§1, §4.3, …) point at it.

## Global Constraints

- **Node 24 is required.** Run `nvm use` before `npm install`, any test, or the CLI — the default shell Node is too old and geometry/tests fail confusingly.
- **No Tailwind and no partforge-cloud dependency**, in either direction. Values are copied; code is not imported.
- **Part modules stay DOM-free and side-effect-free.** Nothing in this plan touches `src/parts/`.
- **Units are millimetres** throughout the framework; CSS lengths here are px and unrelated.
- **Every element `attachRail` touches is optional.** With no rail present it must be a silent no-op — `embed-test.html` passes explicit `elements`, has no `#panel`, and must keep working.
- **`--pf-*` is partforge's namespace.** Every new custom property added here is `--pf-`-prefixed; the cloud's disjoint shadcn names must not appear.
- Target version: **0.28.0** (bumped in Task 7).
- Commit after every task. Do not squash tasks together.

---

### Task 1: Design tokens and self-hosted Geist

**Files:**
- Modify: `src/framework/tokens.css`
- Modify: `src/framework/app.css:11-12` (the `html, body` font shorthand)
- Modify: `package.json` (devDependencies)
- Modify: `src/app-bracket.js`, `src/app-demo.js`, `src/app-faceted-vase.js`, `src/app-filleted-box.js`, `src/app-hull-sweep.js`, `src/app-nameplate.js`, `src/app-planter.js`, `src/app-text-smoke.js`
- Test: `test/tokens.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--pf-sans`, `--pf-rail-w` (default `288px`), `--pf-radius-control`, `--pf-radius-pill`, `--pf-shadow-float`, `--pf-shadow-rail`, `--pf-rail-pad`; `--pf-mono` gains `"Geist Mono Variable"` at the head of its stack. Tasks 3–6 consume all of these.

- [ ] **Step 1: Write the failing test**

Append to `test/tokens.test.js`:

```js
test("tokens.css defines the layout, shape, and type tokens the rail needs", () => {
  const css = read("tokens.css");
  for (const v of [
    "--pf-sans", "--pf-rail-w", "--pf-rail-pad",
    "--pf-radius-control", "--pf-radius-pill",
    "--pf-shadow-float", "--pf-shadow-rail",
  ]) expect(css, `tokens.css must define ${v}`).toContain(`${v}:`);
  // Geist first, system fallbacks retained, in both stacks.
  expect(css).toMatch(/--pf-sans:\s*"Geist Variable"/);
  expect(css).toContain("system-ui");
  expect(css).toMatch(/--pf-mono:\s*"Geist Mono Variable"/);
  expect(css).toContain("ui-monospace");
  // The rail shadow is INSET (the viewer casts onto the rail — see spec §2.4).
  expect(css).toMatch(/--pf-shadow-rail:\s*inset/);
});

test("tokens.css re-tunes the rail shadow for the light theme", () => {
  const css = read("tokens.css");
  const light = css.slice(css.indexOf('[data-theme="light"]'));
  expect(light, "light theme must override --pf-shadow-rail").toContain("--pf-shadow-rail:");
});

test("app.css sets the body font from the --pf-sans token, not a literal stack", () => {
  const css = read("app.css");
  expect(css).toContain("var(--pf-sans)");
  expect(css).not.toContain("-apple-system, system-ui, sans-serif");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && npx vitest run test/tokens.test.js
```

Expected: FAIL — `tokens.css must define --pf-sans`.

- [ ] **Step 3: Add the tokens**

In `src/framework/tokens.css`, inside the `:root` block, replace the existing `--pf-mono` line with:

```css
  --pf-sans: "Geist Variable", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --pf-mono: "Geist Mono Variable", ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  /* Layout + shape, matching partforge-cloud's control scale (--r-control /
     --r-pill) so a rail nested in the cloud editor reads as one product. */
  --pf-rail-w: 288px; --pf-rail-pad: 14px;
  --pf-radius-control: 7px; --pf-radius-pill: 12px;
  /* Floating pills: cloud's --shadow-editor. Larger and near-even, so a pill
     doesn't pool weight at its bottom edge the way a downward shadow does. */
  --pf-shadow-float: 0 0 6px rgb(0 0 0 / .04), 0 2px 14px rgb(0 0 0 / .072);
  /* The rail is SET BACK: the viewer casts onto it, so this is inset on the
     rail's left edge. An outer shadow would read as the rail floating above the
     viewer — the opposite. Deeper in dark, where black reads weaker. */
  --pf-shadow-rail: inset 9px 0 16px -10px rgb(0 0 0 / .38);
```

In the `:root[data-theme="light"]` block, append:

```css
  --pf-shadow-rail: inset 9px 0 14px -10px rgb(0 0 0 / .12);
```

- [ ] **Step 4: Point the body font at the token**

In `src/framework/app.css`, replace:

```css
html, body { margin: 0; height: 100%; overflow: hidden;
  font: 13px/1.4 -apple-system, system-ui, sans-serif; }
```

with:

```css
html, body { margin: 0; height: 100%; overflow: hidden;
  font: 13px/1.4 var(--pf-sans); }
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
nvm use && npx vitest run test/tokens.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 6: Install the fonts as devDependencies**

```bash
nvm use && npm i -D @fontsource-variable/geist @fontsource-variable/geist-mono
```

These are **dev**Dependencies on purpose: the published library ships no font files (spec §2.2). Verify they landed under `devDependencies` and not `dependencies`:

```bash
node -e "const p=require('./package.json'); console.log('dev:', Object.keys(p.devDependencies).filter(k=>k.includes('fontsource')), 'runtime:', Object.keys(p.dependencies).filter(k=>k.includes('fontsource')))"
```

Expected: `dev: [ '@fontsource-variable/geist', '@fontsource-variable/geist-mono' ] runtime: []`

- [ ] **Step 7: Import the fonts from each demo entry**

Add these two lines to the top of each of the eight `src/app-<part>.js` files, above the existing imports:

```js
// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
```

Do **not** add them to `src/app-embed-test.js` — it is a bare lifecycle harness with its own styling.

- [ ] **Step 8: Verify the fonts actually load in a browser**

```bash
nvm use && node scripts/check-app.mjs demo.html
```

Expected: exits 0 with no console errors. A missing font file would surface as a failed request.

- [ ] **Step 9: Commit**

```bash
git add src/framework/tokens.css src/framework/app.css src/app-*.js package.json package-lock.json test/tokens.test.js
git commit -m "feat(chrome): add rail layout tokens and self-host Geist for the demos"
```

---

### Task 2: Rail state machine (pure)

**Files:**
- Create: `src/framework/rail-state.js`
- Test: `test/rail-state.test.js`

**Interfaces:**
- Consumes: nothing (no DOM, no imports).
- Produces, all consumed by `rail.js` in Task 5:
  - `RAIL_DEFAULT_WIDTH = 288`, `RAIL_MIN_WIDTH = 240`, `RAIL_MAX_WIDTH = 560`, `RAIL_COLLAPSE_AT = 140`, `RAIL_REOPEN_AT = 200`, `RAIL_NARROW_BREAKPOINT = 720`, `RAIL_STORAGE_KEY = "partforge:rail"`
  - `railMaxWidth(shellWidth: number) => number`
  - `clampRailWidth(width: number, shellWidth: number) => number`
  - `resolveRailDrag(railX: number, state: {width, collapsed}, shellWidth: number) => {width, collapsed}`
  - `readRailPref(storage: Storage, shellWidth: number) => {width, collapsed}`
  - `writeRailPref(state: {width, collapsed}, storage: Storage) => void`

**Note on `railX`:** the rail is on the **right**, so callers convert a pointer position into an intended rail *width* (`shellRect.right - clientX`, grab-offset corrected) before calling `resolveRailDrag`. These functions never see a raw clientX. This is the mirror image of the cloud's left-hand pane.

- [ ] **Step 1: Write the failing test**

Create `test/rail-state.test.js`:

```js
import { describe, expect, test } from "vitest";
import {
  RAIL_COLLAPSE_AT, RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH,
  RAIL_REOPEN_AT, RAIL_STORAGE_KEY,
  clampRailWidth, railMaxWidth, readRailPref, resolveRailDrag, writeRailPref,
} from "../src/framework/rail-state.js";

// A Storage stand-in. `throws` models private-mode / disabled storage, which
// must degrade to defaults rather than propagate (see view-state.js).
function fakeStorage({ initial = null, throws = false } = {}) {
  let value = initial;
  return {
    getItem() { if (throws) throw new Error("denied"); return value; },
    setItem(_k, v) { if (throws) throw new Error("denied"); value = v; },
    read: () => value,
  };
}

const WIDE = 1600; // shell wide enough that RAIL_MAX_WIDTH, not shellWidth/2, is the cap

describe("railMaxWidth", () => {
  test("caps at RAIL_MAX_WIDTH on a wide shell", () => {
    expect(railMaxWidth(WIDE)).toBe(RAIL_MAX_WIDTH);
  });
  test("gives the rail at most half a narrow shell", () => {
    expect(railMaxWidth(900)).toBe(450);
  });
  test("never returns less than RAIL_MIN_WIDTH, so max >= min always holds", () => {
    expect(railMaxWidth(300)).toBe(RAIL_MIN_WIDTH);
    expect(railMaxWidth(0)).toBe(RAIL_MIN_WIDTH);
  });
  test("falls back to RAIL_MAX_WIDTH for a non-finite measurement", () => {
    expect(railMaxWidth(NaN)).toBe(RAIL_MAX_WIDTH);
    expect(railMaxWidth(undefined)).toBe(RAIL_MAX_WIDTH);
  });
});

describe("clampRailWidth", () => {
  test("passes an in-range width through, rounded", () => {
    expect(clampRailWidth(320.4, WIDE)).toBe(320);
  });
  test("floors at RAIL_MIN_WIDTH", () => {
    expect(clampRailWidth(10, WIDE)).toBe(RAIL_MIN_WIDTH);
  });
  test("ceilings at RAIL_MAX_WIDTH", () => {
    expect(clampRailWidth(9000, WIDE)).toBe(RAIL_MAX_WIDTH);
  });
  test("ceilings at half the shell when that is smaller", () => {
    expect(clampRailWidth(9000, 900)).toBe(450);
  });
  test("falls back to the default for a non-finite width", () => {
    expect(clampRailWidth(NaN, WIDE)).toBe(RAIL_DEFAULT_WIDTH);
  });
});

describe("resolveRailDrag", () => {
  const open = { width: 400, collapsed: false };
  const shut = { width: 400, collapsed: true };

  // One case per cell of spec §4.3's snap table.
  test("open: below the collapse threshold snaps shut, keeping the last width", () => {
    expect(resolveRailDrag(RAIL_COLLAPSE_AT - 1, open, WIDE)).toEqual({ width: 400, collapsed: true });
  });
  test("open: inside the hysteresis band it resists at the minimum", () => {
    expect(resolveRailDrag(RAIL_COLLAPSE_AT + 1, open, WIDE)).toEqual({ width: RAIL_MIN_WIDTH, collapsed: false });
    expect(resolveRailDrag(RAIL_REOPEN_AT + 1, open, WIDE)).toEqual({ width: RAIL_MIN_WIDTH, collapsed: false });
  });
  test("open: at or above the minimum it follows the pointer", () => {
    expect(resolveRailDrag(340, open, WIDE)).toEqual({ width: 340, collapsed: false });
  });
  test("collapsed: stays shut until the far threshold", () => {
    expect(resolveRailDrag(RAIL_COLLAPSE_AT - 1, shut, WIDE)).toBe(shut);
    expect(resolveRailDrag(RAIL_REOPEN_AT - 1, shut, WIDE)).toBe(shut);
  });
  test("collapsed: reopens at the minimum once past the far threshold", () => {
    expect(resolveRailDrag(RAIL_REOPEN_AT, shut, WIDE)).toEqual({ width: RAIL_MIN_WIDTH, collapsed: false });
  });
  test("collapsed: reopens and follows the pointer above the minimum", () => {
    expect(resolveRailDrag(400, shut, WIDE)).toEqual({ width: 400, collapsed: false });
  });

  // The hysteresis exists so a shaky hand can't flap the rail. Travelling in
  // through the band must not reopen, and travelling out must not re-collapse.
  test("the band is directional: 170px stays shut coming from shut, stays open coming from open", () => {
    const mid = (RAIL_COLLAPSE_AT + RAIL_REOPEN_AT) / 2;
    expect(resolveRailDrag(mid, shut, WIDE).collapsed).toBe(true);
    expect(resolveRailDrag(mid, open, WIDE).collapsed).toBe(false);
  });
});

describe("readRailPref", () => {
  test("defaults when storage is empty", () => {
    expect(readRailPref(fakeStorage(), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("defaults when storage throws", () => {
    expect(readRailPref(fakeStorage({ throws: true }), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("defaults on corrupt JSON", () => {
    expect(readRailPref(fakeStorage({ initial: "{not json" }), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("defaults on a non-object payload", () => {
    expect(readRailPref(fakeStorage({ initial: "42" }), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("round-trips a stored value", () => {
    const storage = fakeStorage({ initial: JSON.stringify({ width: 400, collapsed: true }) });
    expect(readRailPref(storage, WIDE)).toEqual({ width: 400, collapsed: true });
  });
  test("re-clamps a width saved on a wider monitor", () => {
    const storage = fakeStorage({ initial: JSON.stringify({ width: 540, collapsed: false }) });
    expect(readRailPref(storage, 900)).toEqual({ width: 450, collapsed: false });
  });
  test("treats a non-boolean collapsed as open", () => {
    const storage = fakeStorage({ initial: JSON.stringify({ width: 300, collapsed: "yes" }) });
    expect(readRailPref(storage, WIDE).collapsed).toBe(false);
  });
});

describe("writeRailPref", () => {
  test("writes width and collapsed under the partforge-namespaced key", () => {
    const storage = fakeStorage();
    writeRailPref({ width: 320, collapsed: false }, storage);
    expect(JSON.parse(storage.read())).toEqual({ width: 320, collapsed: false });
    expect(RAIL_STORAGE_KEY).toBe("partforge:rail");
  });
  test("is a no-op when storage throws", () => {
    expect(() => writeRailPref({ width: 320, collapsed: false }, fakeStorage({ throws: true }))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && npx vitest run test/rail-state.test.js
```

Expected: FAIL — cannot resolve `../src/framework/rail-state.js`.

- [ ] **Step 3: Write the implementation**

Create `src/framework/rail-state.js`:

```js
// Pure state for the controls rail: width clamping, the drag state machine
// (including snap-to-collapsed), and the stored preference. No DOM here on
// purpose — this is the part worth testing exhaustively, and a pointer drag in a
// headless DOM proves very little (scripts/check-app.mjs covers that path in
// real Chromium).
//
// Mirror image of partforge-cloud's left-hand chat pane: this rail is on the
// RIGHT, so callers convert a pointer position into an intended rail WIDTH
// (shellRect.right - clientX, grab-offset corrected) before calling in. Nothing
// here ever sees a raw clientX.
export const RAIL_DEFAULT_WIDTH = 288;
export const RAIL_MIN_WIDTH = 240; // a slider label + its numeric field, still readable
export const RAIL_MAX_WIDTH = 560;
// Two thresholds rather than one: the 60px between them is hysteresis, so a
// shaky hand at the boundary can't flap the rail open and shut. Kept
// PROPORTIONAL to RAIL_MIN_WIDTH (58%-83%) rather than copying the cloud's
// literals, which are sized against its wider 280px floor.
export const RAIL_COLLAPSE_AT = 140;
export const RAIL_REOPEN_AT = 200;
// Below this the rail stacks under the viewer and resize is absent entirely.
export const RAIL_NARROW_BREAKPOINT = 720;
export const RAIL_STORAGE_KEY = "partforge:rail";

// The rail may never take more than half the shell, so the viewer can't be
// squeezed narrower than the rail. Floored at RAIL_MIN_WIDTH so the function
// stays total (and max >= min) for a transient zero-width measurement.
export function railMaxWidth(shellWidth) {
  const half = Number.isFinite(shellWidth) ? Math.floor(shellWidth / 2) : RAIL_MAX_WIDTH;
  return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, half));
}

export function clampRailWidth(width, shellWidth) {
  const w = Number.isFinite(width) ? Math.round(width) : RAIL_DEFAULT_WIDTH;
  return Math.min(railMaxWidth(shellWidth), Math.max(RAIL_MIN_WIDTH, w));
}

// railX is the pointer's intended rail width. Returns the SAME state object
// when nothing changes, so a caller can cheaply skip redundant DOM writes.
export function resolveRailDrag(railX, state, shellWidth) {
  const open = () => ({ collapsed: false, width: clampRailWidth(railX, shellWidth) });
  if (state.collapsed) {
    // Reopening takes a deliberate push past the far threshold.
    return railX < RAIL_REOPEN_AT ? state : open();
  }
  // Collapsing keeps the last open width, so the toggle restores it later.
  if (railX < RAIL_COLLAPSE_AT) return { collapsed: true, width: state.width };
  return open();
}

export function readRailPref(storage, shellWidth) {
  const fallback = { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  let raw;
  try { raw = storage.getItem(RAIL_STORAGE_KEY); } catch { return fallback; }
  if (!raw) return fallback;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  if (!parsed || typeof parsed !== "object") return fallback;
  return {
    // Re-clamp on read: a width saved on a wide monitor must not leave a laptop
    // with a 560px rail and no room for the viewer.
    width: clampRailWidth(parsed.width, shellWidth),
    collapsed: parsed.collapsed === true,
  };
}

export function writeRailPref(state, storage) {
  try {
    storage.setItem(RAIL_STORAGE_KEY, JSON.stringify({
      width: state.width,
      collapsed: state.collapsed,
    }));
  } catch { /* storage unavailable — no-op, matching view-state.js */ }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
nvm use && npx vitest run test/rail-state.test.js
```

Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/rail-state.js test/rail-state.test.js
git commit -m "feat(chrome): add the rail width/collapse state machine"
```

---

### Task 3: The rail layout — chrome.css, app.css, and the demo markup

This task must land atomically: the CSS and the markup change together, or nothing renders correctly.

**Files:**
- Create: `src/framework/chrome.css`
- Modify: `src/framework/app.css` (the `#app` / `#panel` / `#topbar` / `#viewbar` / media-query blocks)
- Modify: `package.json` (`exports`)
- Modify: `bracket.html`, `demo.html`, `faceted-vase.html`, `filleted-box.html`, `hull-sweep.html`, `nameplate.html`, `planter.html`, `text-smoke.html`
- Modify: `scripts/check-app.mjs`

**Interfaces:**
- Consumes: `--pf-rail-w`, `--pf-rail-pad`, `--pf-radius-pill`, `--pf-shadow-float`, `--pf-shadow-rail` (Task 1).
- Produces: the classes `.pf-shell`, `.pf-stage`, `.pf-rail`, `.pf-rail-head`, `.pf-rail-body`, `.pf-rail-foot`, `.pf-float-tabs`, `.pf-float-viewbar`, and the `data-dragging` / `data-key-resizing` shell flags that Task 5 sets. `.pf-rail-seam` is styled here but created by Task 5.

**Why classes, not ids:** partforge-cloud's host builds its own DOM (`#viewer`, `#pfc-controls`) and could never reuse an id-keyed sheet. Legacy id-only markup keeps its old floating look via `:not(.pf-*)` fallbacks in `app.css` — the class is what opts a page into the new layout, so nothing breaks and there are no specificity fights between an id rule and a class rule.

- [ ] **Step 1: Write the failing smoke assertion**

In `scripts/check-app.mjs`, add this function immediately after `checkCompactLayout`:

```js
// Wide-layout geometry: the rail is a full-height right edge and the viewer
// column owns its floating chrome. checkCompactLayout only runs below the 720px
// breakpoint, where the rail is stacked, so it can't see any of this.
async function checkRailLayout(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(() => {
    const panel = document.getElementById("panel");
    const app = document.getElementById("app");
    const viewbar = document.getElementById("viewbar");
    if (!panel || !app) return { problems: ["missing #panel or #app"] };
    const rail = panel.getBoundingClientRect();
    const stage = app.getBoundingClientRect();
    const bar = viewbar?.getBoundingClientRect();
    const problems = [];
    if (Math.abs(rail.right - window.innerWidth) > 1) problems.push("rail is not flush to the right edge");
    if (Math.abs(rail.height - window.innerHeight) > 1) problems.push(`rail height ${Math.round(rail.height)} != viewport ${window.innerHeight}`);
    if (Math.abs(rail.left - stage.right) > 1) problems.push("rail does not sit flush against the viewer column");
    if (rail.width < 200) problems.push(`rail collapsed unexpectedly (${Math.round(rail.width)}px)`);
    if (bar && bar.right > stage.right + 1) problems.push("#viewbar escapes the viewer column");
    if (bar && bar.bottom > stage.bottom + 1) problems.push("#viewbar escapes the viewer column vertically");
    return { problems };
  });
  for (const problem of result.problems) errors.push(`rail layout ${width}px: ${problem}`);
}
```

Then add the calls immediately before the existing `await checkCompactLayout(601);`:

```js
    await checkRailLayout(1280);
    await checkRailLayout(1024);
```

- [ ] **Step 2: Run the smoke check to verify it fails**

```bash
nvm use && node scripts/check-app.mjs demo.html
```

Expected: FAIL, reporting `rail layout 1280px: rail is not flush to the right edge` (the panel is still a floating card at top-left).

- [ ] **Step 3: Create the reusable chrome stylesheet**

Create `src/framework/chrome.css`:

```css
/* Reusable chrome LAYOUT for a partforge app: the shell, the viewer column
   ("stage"), the full-height controls rail, its resize seam, and the two
   floating pill groups. Appearance of the controls INSIDE the rail stays in
   app.css; this file is only about where things sit.

   Class-based on purpose. partforge-cloud's sandbox builds its own DOM
   (#viewer / #pfc-controls) and could never reuse an id-keyed sheet, so the
   layout is expressed as .pf-* classes and exported standalone as
   "partforge/chrome.css". app.css keeps :not(.pf-*) fallbacks so legacy
   id-only markup renders its previous floating look untouched.

   See docs/superpowers/specs/2026-07-26-controls-rail-layout-design.md. */

/* ---- shell: viewer column + rail, side by side --------------------------- */
.pf-shell {
  display: flex;
  /* containing block for the absolutely-positioned seam */
  position: relative;
  overflow: hidden;
}

/* ---- stage: the viewer column, which owns its floating chrome ------------
   min-width: 0 lets the column shrink past the canvas's intrinsic width, so
   dragging the rail wider actually narrows the viewer instead of overflowing. */
.pf-stage {
  flex: 1;
  position: relative;
  min-width: 0;
  background: var(--pf-bg);
}

/* ---- rail: a full-height right edge, set back from the viewer ------------
   Square-cornered: it is an edge, not a card. The shadow is INSET on its left
   side — the viewer casts onto the rail, which is what makes the rail read as
   set back. An outer shadow would read as floating above the viewer. */
.pf-rail {
  flex: none;
  width: var(--pf-rail-w);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--pf-surface);
  border-left: 1px solid var(--pf-border);
  box-shadow: var(--pf-shadow-rail);
  color: var(--pf-text);
  /* Discrete changes (toggle, Home/End, double-click) animate; a drag never
     does — an animated width fights the pointer and costs an extra WebGL
     buffer reallocation every frame. */
  transition: width .15s ease;
}
.pf-rail[inert] { border-left-width: 0; }

/* Head and foot are flex-fixed rather than sticky, so the scroll container is
   exactly .pf-rail-body. On a full-height rail the export buttons must never
   scroll out of reach. */
.pf-rail-head, .pf-rail-foot { flex: none; }
.pf-rail-head { padding: 12px var(--pf-rail-pad); border-bottom: 1px solid var(--pf-border); }
.pf-rail-foot { padding: 12px var(--pf-rail-pad); border-top: 1px solid var(--pf-border); }
.pf-rail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ---- resize seam --------------------------------------------------------
   An OVERLAY, not a flex item. partforge-cloud's seam is a real 12px column
   because its card is inset from the window with a gutter to live in; this rail
   is flush against the viewer behind a hairline, so a flex item would open a
   visible stripe of page background.

   max(0px, …) is what parks the seam flush at the window edge when the rail is
   collapsed, so a fresh drag can pull it back out. The element is created by
   rail.js — no host markup declares it. */
.pf-rail-seam {
  position: absolute;
  top: 0; bottom: 0;
  right: max(0px, calc(var(--pf-rail-w) - 6px));
  z-index: 20;
  width: 12px;
  display: flex; align-items: center; justify-content: center;
  touch-action: none;
  cursor: ew-resize;
}
/* Collapsed, the only legal direction is left. */
.pf-rail-seam[data-collapsed] { cursor: w-resize; }
.pf-rail-seam:focus-visible { outline: none; }
/* Invisible at rest; the affordance is a short centred pill that appears only
   on hover, keyboard focus, or during a drag. */
.pf-rail-seam > span {
  pointer-events: none;
  width: 3px; height: 100px; border-radius: 999px;
  background: transparent;
  transition: background-color .12s ease;
}
.pf-rail-seam:hover > span,
.pf-rail-seam:focus-visible > span,
[data-dragging] .pf-rail-seam > span { background: var(--pf-muted); }

/* While dragging, the cursor must stay correct even when the pointer is out
   over the viewer, and the viewer must not react to it. Pointer capture keeps
   the events coming; these two rules are the second belt. */
[data-dragging] { cursor: ew-resize; user-select: none; }
[data-dragging] .pf-stage { pointer-events: none; }
[data-dragging] .pf-rail,
[data-key-resizing] .pf-rail { transition: none; }

/* ---- floating chrome: PLACEMENT ONLY, absolute within the stage ----------
   Deliberately no appearance here. partforge-cloud's sandbox.css re-anchors
   #viewbar's position with its own rules but inherits the pill's chrome
   (background/border/radius/shadow) from app.css, so that chrome must live in
   app.css ungated — not be duplicated into a class the cloud never sets. This
   file owns where things sit; app.css owns what they look like. */
.pf-float-tabs, .pf-float-viewbar { position: absolute; z-index: 15; }
.pf-float-tabs { top: 12px; left: 50%; transform: translateX(-50%); }
.pf-float-viewbar { bottom: 12px; right: 12px; }

/* ---- stacked layout: no room for a rail beside the viewer ----------------
   The seam is hidden and resize is absent at this width (rail.js also refuses
   to start a drag); the #rail-toggle still collapses and restores. */
@media (max-width: 719px) {
  .pf-shell { flex-direction: column; }
  .pf-rail {
    width: auto; height: 45vh;
    border-left: 0; border-top: 1px solid var(--pf-border);
    box-shadow: none;
  }
  .pf-rail-seam { display: none; }
}

/* ---- reduced motion -----------------------------------------------------
   Collapsing the rail slides 288px of layout across the screen — the first
   layout-scale animation in the framework, and the kind of movement a
   vestibular-sensitive user actually feels. Honour the preference: the rail
   still collapses and still resizes, it just arrives instead of travelling.
   Scoped to what this layout introduces; the pre-existing busy spinner is a
   state indicator and is left alone. */
@media (prefers-reduced-motion: reduce) {
  .pf-rail, .pf-rail-seam > span { transition: none; }
}
```

- [ ] **Step 4: Rework the layout blocks in `app.css`**

At the top of `src/framework/app.css`, add the import immediately after the existing tokens import:

```css
@import "./chrome.css";  /* reusable layout; also exported as partforge/chrome.css */
```

Replace the `#app` rule:

```css
#app { position: fixed; inset: 0; background: var(--pf-bg); }
```

with the legacy-only fallback (the class is what opts a page into the new layout):

```css
/* Legacy fallback: a page whose markup predates .pf-stage keeps the old
   full-window viewer. :not() rather than a plain #app rule because an id would
   outrank .pf-stage's positioning and win the cascade. */
#app:not(.pf-stage) { position: fixed; inset: 0; background: var(--pf-bg); }
```

Replace the whole `#panel { … }` rule with the same treatment:

```css
/* Legacy fallback: the pre-rail floating card, for markup without .pf-rail. */
#panel:not(.pf-rail) {
  position: fixed; top: 12px; left: 12px; width: 256px;
  max-height: calc(100vh - 24px); overflow-y: auto; z-index: 10;
  background: var(--pf-surface); border: 1px solid var(--pf-border); border-radius: 16px;
  padding: 14px; color: var(--pf-text);
  box-shadow: var(--pf-shadow-float);
}
```

Replace the `#topbar` block. **Placement** moves to `.pf-float-tabs`; the pill's **appearance** stays here, ungated:

```css
/* part tabs (placement: .pf-float-tabs; legacy markup keeps the old float) */
#topbar:not(.pf-float-tabs) { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 15; }
#topbar .seg {
  margin: 0; padding: 4px; background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-pill);
  box-shadow: var(--pf-shadow-float);
}
#topbar .seg button { min-width: 70px; padding: 7px 10px; }
```

Replace the `#viewbar` container rule the same way — and note the split matters
here for a concrete reason. partforge-cloud's `sandbox.css` re-anchors
`#viewbar`'s *position* (`#viewer #viewbar { position: absolute; bottom: 12px; … }`)
but sets no `display`/`gap`/`padding`/`background`/`border`/`box-shadow` of its
own: it inherits all of that from this rule. So the pill's appearance must stay
ungated on `#viewbar`, or the cloud's viewbar loses its chrome. Only the
placement gets a `:not()` fallback:

```css
/* viewer controls. APPEARANCE is ungated: partforge-cloud re-anchors #viewbar's
   position in sandbox.css but inherits this pill chrome, so gating it on a class
   the cloud never sets would strip the editor's viewbar. PLACEMENT comes from
   .pf-float-viewbar; the :not() keeps legacy markup's old top-right float. */
#viewbar {
  display: flex; gap: 4px; padding: 4px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-pill);
  box-shadow: var(--pf-shadow-float);
}
#viewbar:not(.pf-float-viewbar) { position: fixed; top: 12px; right: 12px; z-index: 15; }
```

Keep every `#viewbar button` rule exactly as it is.

Update `#busy` so it fills the stage rather than the window, and keep the legacy fallback:

```css
#busy {
  position: absolute; inset: 0; z-index: 20; pointer-events: none;
  display: none; flex-direction: column; align-items: center;
  justify-content: center; gap: 14px;
}
```

(`#busy` is a child of `#app`, which is `position: relative` under `.pf-stage`, so `absolute` resolves against the stage. Under the legacy fallback `#app` is `position: fixed`, which is also a containing block, so `absolute` is correct there too — no `:not()` needed.)

Keep the rail clear of the body-appended pick banner by replacing its `left`:

```css
#pf-pick-banner {
  position: fixed; top: 78px; left: calc(50% - var(--pf-rail-w) / 2); transform: translateX(-50%);
```

Delete the entire `@media (max-width: 680px)` block. `#viewbar` is bottom-right inside the viewer column at every width now, and `chrome.css`'s 719px block owns the stacked layout.

Also normalise the control radii to the token — replace every literal in these rules:

| Rule | Was | Now |
|---|---|---|
| `.seg` | `border-radius: 10px` | `var(--pf-radius-control)` |
| `.seg button` | `8px` | `var(--pf-radius-control)` |
| `select.preset` | `8px` | `var(--pf-radius-control)` |
| `.row .num` | `6px` | `var(--pf-radius-control)` |
| `.text-input` | `6px` | `var(--pf-radius-control)` |
| `button.action` | `8px` | `var(--pf-radius-control)` |
| `.dl-row button` | `8px` | `var(--pf-radius-control)` |
| `#viewbar button` | `10px` | `var(--pf-radius-control)` |
| `.popover` | `14px` | `var(--pf-radius-pill)` |
| `#pf-pick-banner` | `14px` | `var(--pf-radius-pill)` |
| `.popover`, `#pf-pick-banner` box-shadow | the `0 4px 6px -1px …` literal | `var(--pf-shadow-float)` |

- [ ] **Step 5: Add the `./chrome.css` export**

In `package.json`, add to `exports` after the `./tokens.css` entry:

```json
    "./chrome.css": "./src/framework/chrome.css"
```

- [ ] **Step 6: Restructure the eight demo pages**

For each of `bracket.html`, `demo.html`, `faceted-vase.html`, `filleted-box.html`, `hull-sweep.html`, `nameplate.html`, `planter.html`, `text-smoke.html`: put `class="pf-shell"` on `<body>`, move `#topbar`, `#viewbar` and `#busy` inside `#app`, add the layout classes, and split the panel's contents into head / body / foot. Using `demo.html` as the worked example — its `<body>` becomes:

```html
  <body class="pf-shell">
    <div id="app" class="pf-stage">
      <div id="topbar" class="pf-float-tabs">
        <!-- view tabs are generated by mount from part.views — leave empty -->
        <div class="seg" id="part"></div>
      </div>

      <div id="viewbar" class="pf-float-viewbar">
        <button id="cutaway" title="Cutaway section" aria-label="Toggle cutaway section">◩</button>
        <button id="pause" title="Pause rotation">⏸</button>
        <button id="reframe" title="Reframe">⛶</button>
        <button id="theme" title="Toggle light/dark">◐</button>
      </div>

      <div id="busy"><div class="ring"></div><div class="phase" id="phase">booting kernel…</div></div>
    </div>

    <div id="panel" class="pf-rail">
      <div class="pf-rail-head">
        <h1>Spacer</h1>
        <p class="sub">Demo part · framework example</p>
      </div>

      <div class="pf-rail-body">
        <div id="controls"></div>
      </div>

      <div class="pf-rail-foot">
        <div class="dl">
          <div class="dl-head">Download</div>
          <div class="dl-row">
            <button id="download-step" disabled>STEP</button>
            <button id="download" disabled>STL</button>
            <button id="download-3mf" disabled>3MF</button>
          </div>
        </div>
        <div id="status">booting kernel…</div>
        <p class="hint">Drag to orbit · scroll to zoom. A minimal one-part example.</p>
      </div>
    </div>

    <script type="module" src="/src/app-demo.js"></script>
  </body>
```

Each other page keeps its own `<h1>`, `.sub`, `.hint` copy and its own `#download-*` button set verbatim — only the structure changes. Note `.pf-rail-head` and `.pf-rail-foot` supply the padding, so the `.sub` rule's own `margin-bottom`/`padding-bottom`/`border-bottom` now double up with the head's border; drop those three declarations from `.sub` in `app.css`:

```css
#panel .sub {
  font-family: var(--pf-mono); color: var(--pf-muted); font-size: 10px;
  letter-spacing: 0.04em; text-transform: uppercase;
  margin: 2px 0 0;
}
```

Leave `index.html` (the standalone landing page, no app) and `embed-test.html` (its own harness markup, no rail — it deliberately proves `mount` has no hidden document queries) untouched.

- [ ] **Step 7: Run the smoke check to verify it passes**

```bash
nvm use && node scripts/check-app.mjs demo.html
```

Expected: exits 0, no `rail layout` errors.

- [ ] **Step 8: Check every demo page and the whole suite**

```bash
nvm use && npm run check && npm test
```

Expected: all three checked apps pass; the full vitest suite is green. `test/framework/mount.test.js` and `controls.test.js` build their own fixtures rather than loading the demo HTML, so they should be unaffected — if either fails, it is asserting on the old chrome and the assertion needs updating to the new structure, not the structure reverting.

- [ ] **Step 9: Commit**

```bash
git add src/framework/chrome.css src/framework/app.css package.json *.html scripts/check-app.mjs
git commit -m "feat(chrome): lay the controls panel out as a full-height right rail"
```

---

### Task 4: Full-bleed sections

**Files:**
- Modify: `src/framework/app.css` (`.section`, `.feat-group`, the range-thumb rules)
- Test: `test/framework/controls.test.js`

**Interfaces:**
- Consumes: `--pf-rail-pad` (Task 1), `.pf-rail-body` (Task 3).
- Produces: no new API. Control-panel *behavior* is unchanged — `sectionRenders`, `visibleAdvanced`, `applyRelevance` and the `Advanced ▾` fold are all untouched (spec §3).

- [ ] **Step 1: Write the failing test**

`controls.js` builds `.section` divs; the change is purely presentational, so the test guards the structural contract that must survive it. Append to `test/framework/controls.test.js`:

This reuses the file's existing `presetSec` / `featureSec` fixtures and its
already-imported `buildControls` — add no new imports:

```js
test("sections stay flat siblings so the rail can divide them with hairlines", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec(), featureSec()], { od: 5, secret: 0, flange_d: 16, hf: 0 }, () => {});
  const sections = [...root.children].filter((el) => el.classList.contains("section"));
  expect(sections).toHaveLength(2);
  // No nesting: a full-bleed divider between siblings only reads correctly if
  // sections really are siblings, not boxes inside boxes.
  for (const section of sections) {
    expect(section.querySelector(".section")).toBeNull();
    expect(section.parentElement).toBe(root);
  }
  // The Advanced fold survives — this task changes appearance, not behavior.
  expect(sections[0].querySelector(".adv-toggle")).not.toBeNull();
  expect(sections[0].querySelector(".adv.hidden")).not.toBeNull();
});
```

`buildControls(root, sections, params, onDirty)` is the signature `mount` calls
it with (`buildControls(els.controls, part.parameters, params, onParamChange)`).

- [ ] **Step 2: Run the test**

```bash
nvm use && npx vitest run test/framework/controls.test.js
```

Expected: PASS immediately — this is a regression guard for behavior that already holds, not a red test. Its job is to fail loudly if Step 3 is over-applied into `controls.js`.

- [ ] **Step 3: Make the sections full-bleed**

In `src/framework/app.css`, replace:

```css
.section {
  border: 1px solid var(--pf-border); border-radius: 10px; padding: 10px;
  margin-bottom: 8px; background: var(--pf-surface-2);
}
```

with:

```css
/* Full-bleed rows: the divider spans the rail's whole width while the content
   sits at the rail's own padding, so each slider gains the ~22px the old box
   border + padding used to take from both sides. */
.section {
  padding: 11px var(--pf-rail-pad);
  border-top: 1px solid var(--pf-border);
}
.section:first-child { border-top: 0; }
```

Thin the feature-group nesting rule (it marks real structure, so it stays — just quieter):

```css
.feat-group { margin: 2px 0 8px; padding-left: 10px; border-left: 1px solid var(--pf-border); }
```

Then re-target the range thumb's border. It currently keys off `--pf-surface-2`, which *was* the section background; with sections transparent the thumb must key off the rail's surface or every handle draws a mismatched ring:

```css
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5.5px;
  border-radius: 50%; background: var(--pf-accent); border: 2px solid var(--pf-surface); box-shadow: 0 0 0 1px var(--pf-accent);
  transition: box-shadow .12s ease;
}
input[type="range"]::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%; background: var(--pf-accent);
  border: 2px solid var(--pf-surface); box-shadow: 0 0 0 1px var(--pf-accent);
}
```

`#controls` sits directly inside `.pf-rail-body`, which supplies the scroll; sections need no margin of their own.

- [ ] **Step 4: Verify in a real browser**

```bash
nvm use && npx vitest run test/framework/controls.test.js && node scripts/check-app.mjs planter.html
```

Expected: test PASS, smoke check exits 0. `planter.html` is the rich part (features, presets, verify), so it exercises every section shape.

- [ ] **Step 5: Look at it**

```bash
nvm use && npm run dev
```

Open `/planter.html` and confirm: no boxes around sections, hairline dividers running the full rail width, slider thumb rings matching the rail surface in **both** themes (click ◐), and the `Advanced ▾` folds still opening. The thumb ring is the easy thing to get wrong and only shows up by eye.

- [ ] **Step 6: Commit**

```bash
git add src/framework/app.css test/framework/controls.test.js
git commit -m "feat(chrome): full-bleed parameter sections in the rail"
```

---

### Task 5: `attachRail` — seam, drag, keyboard, persistence

**Files:**
- Create: `src/framework/rail.js`
- Modify: `src/framework/mount.js:68-88` (element resolution) and `:89-104` (the attach block)
- Modify: `test/setup/happy-dom-patches.js`
- Modify: `scripts/check-app.mjs`
- Test: `test/framework/rail.test.js`

**Interfaces:**
- Consumes: every export of `rail-state.js` (Task 2); the `.pf-rail-seam` / `[data-dragging]` / `[data-key-resizing]` styling from `chrome.css` (Task 3).
- Produces: `attachRail({ rail, toggle, shell, storage }) => { detach: () => void }`. `shell` defaults to `rail.parentElement`; `storage` defaults to `globalThis.localStorage`. Returns a no-op `detach` when `rail` is falsy. Task 6 supplies `toggle`.

- [ ] **Step 1: Stub `setPointerCapture` for happy-dom**

happy-dom implements neither `setPointerCapture` nor `releasePointerCapture`. Append to `test/setup/happy-dom-patches.js`:

```js
// happy-dom does not implement the Pointer Capture API. The rail's drag path
// calls it, so stub it to a no-op — this makes the pointer path EXERCISED, not
// proven. Proof lives in scripts/check-app.mjs, which drags for real in
// Chromium (no headless DOM models an iframe consuming pointer events).
if (typeof Element !== "undefined") {
  Element.prototype.setPointerCapture ??= function () {};
  Element.prototype.releasePointerCapture ??= function () {};
  Element.prototype.hasPointerCapture ??= function () { return false; };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/framework/rail.test.js`:

```js
import { beforeEach, expect, test, vi } from "vitest";
import { attachRail } from "../../src/framework/rail.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH } from "../../src/framework/rail-state.js";

function fakeStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_k, v) => { value = v; }, read: () => value };
}

// happy-dom gives every element a zero-size box, so the shell width the state
// machine clamps against has to be stubbed.
function setup({ withToggle = false, shellWidth = 1600 } = {}) {
  document.body.innerHTML = `
    <div class="pf-shell">
      <div class="pf-stage"></div>
      <div class="pf-rail"></div>
    </div>`;
  const shell = document.querySelector(".pf-shell");
  const rail = document.querySelector(".pf-rail");
  shell.getBoundingClientRect = () => ({ left: 0, right: shellWidth, width: shellWidth, top: 0, bottom: 720, height: 720 });
  const toggle = withToggle ? document.createElement("button") : undefined;
  if (toggle) document.body.append(toggle);
  const storage = fakeStorage();
  const handle = attachRail({ rail, shell, toggle, storage });
  return { shell, rail, toggle, storage, handle, seam: shell.querySelector(".pf-rail-seam") };
}

const railWidth = () => document.documentElement.style.getPropertyValue("--pf-rail-w");
const key = (seam, k, init = {}) => seam.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

beforeEach(() => {
  document.documentElement.style.removeProperty("--pf-rail-w");
  document.body.innerHTML = "";
  vi.useRealTimers();
});

test("creates the seam with separator semantics and the live width", () => {
  const { seam } = setup();
  expect(seam).not.toBeNull();
  expect(seam.getAttribute("role")).toBe("separator");
  expect(seam.getAttribute("aria-orientation")).toBe("vertical");
  expect(seam.getAttribute("aria-label")).toBe("Resize controls");
  expect(seam.tabIndex).toBe(0);
  expect(seam.getAttribute("aria-valuenow")).toBe(String(RAIL_DEFAULT_WIDTH));
  expect(seam.getAttribute("aria-valuemin")).toBe("0");
  // The affordance pill is a child, not a background on the seam itself.
  expect(seam.querySelector("span")).not.toBeNull();
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("is a no-op without a rail, so embed hosts are unaffected", () => {
  expect(() => attachRail({}).detach()).not.toThrow();
  expect(document.querySelector(".pf-rail-seam")).toBeNull();
});

test("ArrowLeft widens the rail and ArrowRight narrows it", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 16}px`);
  key(seam, "ArrowRight");
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("Shift multiplies the keyboard step", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft", { shiftKey: true });
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 64}px`);
});

test("Home and End jump to the clamped min and max", () => {
  const { seam } = setup({ shellWidth: 900 });
  key(seam, "Home");
  expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  key(seam, "End");
  expect(railWidth()).toBe("450px"); // half of a 900px shell
});

test("arrow keys never collapse — they clamp at the minimum", () => {
  const { seam, rail } = setup();
  for (let i = 0; i < 40; i++) key(seam, "ArrowRight");
  expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  expect(rail.hasAttribute("inert")).toBe(false);
});

test("Enter collapses: width 0, rail inert, seam still mounted and re-cursored", () => {
  const { seam, rail, shell } = setup();
  key(seam, "Enter");
  expect(railWidth()).toBe("0px");
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(seam.hasAttribute("data-collapsed")).toBe(true);
  expect(seam.getAttribute("aria-valuenow")).toBe("0");
  // Recovery depends on the seam surviving collapse.
  expect(shell.contains(seam)).toBe(true);
});

test("Space toggles back open at the remembered width", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  const widened = railWidth();
  key(seam, " ");
  expect(railWidth()).toBe("0px");
  key(seam, " ");
  expect(railWidth()).toBe(widened);
});

test("double-click resets to the default width", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  seam.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("a drag writes the width live and persists once on pointerup", () => {
  const { seam, shell, storage } = setup();
  seam.getBoundingClientRect = () => ({ left: 1600 - RAIL_DEFAULT_WIDTH - 6, right: 1600 - RAIL_DEFAULT_WIDTH + 6, width: 12 });
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 1600 - RAIL_DEFAULT_WIDTH }));
  expect(shell.hasAttribute("data-dragging")).toBe(true);
  expect(storage.read()).toBeNull(); // nothing persisted mid-drag
  seam.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 1200 }));
  expect(railWidth()).toBe("400px");
  seam.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 1200 }));
  expect(shell.hasAttribute("data-dragging")).toBe(false);
  expect(JSON.parse(storage.read())).toEqual({ width: 400, collapsed: false });
});

test("a stored preference is restored on attach", () => {
  document.body.innerHTML = `<div class="pf-shell"><div class="pf-stage"></div><div class="pf-rail"></div></div>`;
  const shell = document.querySelector(".pf-shell");
  shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600 });
  const storage = fakeStorage();
  storage.setItem("partforge:rail", JSON.stringify({ width: 420, collapsed: false }));
  attachRail({ rail: document.querySelector(".pf-rail"), shell, storage });
  expect(railWidth()).toBe("420px");
});

test("an optional toggle button collapses and restores, tracking state in its label", () => {
  const { toggle, rail } = setup({ withToggle: true });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide controls");
  expect(toggle.textContent).toBe("⇥");

  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(railWidth()).toBe("0px");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show controls");
  expect(toggle.textContent).toBe("⇤");
  expect(toggle.classList.contains("on")).toBe(true);

  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(false);
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

test("the toggle still works when the seam refuses to drag (stacked layout)", () => {
  const { toggle, seam } = setup({ withToggle: true });
  // chrome.css hides the seam below 720px and onPointerDown bails there, so the
  // toggle is the only affordance left. It must not depend on drag state.
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10 }));
  toggle.click();
  expect(railWidth()).toBe("0px");
});

test("detach removes the seam and stops responding", () => {
  const { seam, shell, handle } = setup();
  handle.detach();
  expect(shell.querySelector(".pf-rail-seam")).toBeNull();
  key(seam, "ArrowLeft");
  expect(railWidth()).toBe(""); // property cleaned up, listener gone
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
nvm use && npx vitest run test/framework/rail.test.js
```

Expected: FAIL — cannot resolve `../../src/framework/rail.js`.

- [ ] **Step 4: Write the implementation**

Create `src/framework/rail.js`:

```js
import {
  RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_NARROW_BREAKPOINT,
  clampRailWidth, railMaxWidth, readRailPref, resolveRailDrag, writeRailPref,
} from "./rail-state.js";

const KEY_STEP = 16;
const KEY_STEP_SHIFT = 64;
// A held arrow-key repeat must not animate either, so the suppression flag
// covers the whole repeat window rather than just the instant of a keydown.
const KEY_SETTLE_MS = 200;

// Make the controls rail resizable and collapsible, with partforge-cloud's seam
// affordance: a 12px hit target holding a pill that is invisible until hover,
// keyboard focus, or a drag.
//
// The seam is created here, so no host markup declares it. Width is written
// straight onto :root as --pf-rail-w during a drag with no state layer in
// between: every width change resizes the viewer, whose ResizeObserver
// reallocates the WebGL drawing buffer. One reallocation per frame is inherent
// to live resizing; anything on top of it is not.
//
// Everything is optional. With no rail this returns a no-op, so hosts that lay
// the framework out themselves (see embed-test.html) are unaffected.
export function attachRail({ rail, toggle, shell = rail?.parentElement, storage = globalThis.localStorage } = {}) {
  if (!rail || !shell) return { detach: () => {} };

  const root = document.documentElement;
  const shellBox = () => shell.getBoundingClientRect();
  const shellWidth = () => shellBox().width;
  let state = readRailPref(storage, shellWidth());

  const seam = document.createElement("div");
  seam.className = "pf-rail-seam";
  seam.setAttribute("role", "separator");
  seam.setAttribute("aria-orientation", "vertical");
  seam.setAttribute("aria-label", "Resize controls");
  seam.setAttribute("aria-valuemin", "0");
  seam.tabIndex = 0;
  seam.append(document.createElement("span")); // the hover/focus affordance
  rail.before(seam);

  function apply({ persist = false } = {}) {
    const width = state.collapsed ? 0 : clampRailWidth(state.width, shellWidth());
    root.style.setProperty("--pf-rail-w", `${width}px`);
    rail.toggleAttribute("inert", state.collapsed);
    seam.toggleAttribute("data-collapsed", state.collapsed);
    seam.setAttribute("aria-valuenow", String(width));
    seam.setAttribute("aria-valuemax", String(railMaxWidth(shellWidth())));
    if (toggle) {
      toggle.textContent = state.collapsed ? "⇤" : "⇥";
      const label = state.collapsed ? "Show controls" : "Hide controls";
      toggle.setAttribute("aria-expanded", String(!state.collapsed));
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      toggle.classList.toggle("on", state.collapsed);
    }
    if (persist) writeRailPref(state, storage);
  }

  // --- discrete changes: animate, and commit immediately ---
  let keyTimer = 0;
  function settleKeys() {
    clearTimeout(keyTimer);
    shell.removeAttribute("data-key-resizing");
  }
  function commit(next) {
    settleKeys(); // a discrete change interrupting a key repeat animates normally
    state = next;
    apply({ persist: true });
  }
  const toggleCollapsed = () => commit({ collapsed: !state.collapsed, width: state.width });

  // --- keyboard: move the SEPARATOR (standard role="separator" semantics), so
  // ArrowLeft widens a right-hand rail. Arrows clamp at the minimum and never
  // collapse; Enter/Space is the collapse gesture.
  function onKeyDown(e) {
    const from = state.collapsed ? 0 : state.width;
    const step = e.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    let width;
    switch (e.key) {
      case "ArrowLeft": width = from + step; break;
      case "ArrowRight": width = from - step; break;
      case "Home": width = RAIL_MIN_WIDTH; break;
      case "End": width = railMaxWidth(shellWidth()); break;
      case "Enter": case " ": e.preventDefault(); toggleCollapsed(); return;
      default: return;
    }
    e.preventDefault();
    state = { collapsed: false, width: clampRailWidth(width, shellWidth()) };
    shell.toggleAttribute("data-key-resizing", true);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      shell.removeAttribute("data-key-resizing");
      writeRailPref(state, storage);
    }, KEY_SETTLE_MS);
    apply();
  }

  const onDoubleClick = () => commit({ collapsed: false, width: RAIL_DEFAULT_WIDTH });
  const onToggleClick = () => toggleCollapsed();

  // --- drag ---
  let grabOffset = 0;
  function onPointerDown(e) {
    if (e.button !== 0) return;
    // Stacked layout: the rail is under the viewer, so there is no vertical seam
    // to drag (chrome.css hides it). The toggle still works.
    if (window.innerWidth < RAIL_NARROW_BREAKPOINT) return;
    e.preventDefault();
    // setPointerCapture is load-bearing: without it the pointer crosses into the
    // viewer (an iframe, in the cloud editor) whose document eats the move
    // events, and the drag dies the moment it reaches the thing being resized.
    seam.setPointerCapture?.(e.pointerId);
    const box = seam.getBoundingClientRect();
    // Where inside the 12px seam the grab landed, so the rail edge doesn't jump.
    grabOffset = e.clientX - (box.left + box.width / 2);
    shell.toggleAttribute("data-dragging", true);
  }
  function onPointerMove(e) {
    if (!shell.hasAttribute("data-dragging")) return;
    const railX = shellBox().right - (e.clientX - grabOffset);
    state = resolveRailDrag(railX, state, shellWidth());
    apply();
  }
  function onPointerUp(e) {
    if (!shell.hasAttribute("data-dragging")) return;
    seam.releasePointerCapture?.(e.pointerId);
    shell.removeAttribute("data-dragging");
    apply({ persist: true });
  }

  seam.addEventListener("pointerdown", onPointerDown);
  seam.addEventListener("pointermove", onPointerMove);
  seam.addEventListener("pointerup", onPointerUp);
  seam.addEventListener("pointercancel", onPointerUp);
  seam.addEventListener("keydown", onKeyDown);
  seam.addEventListener("dblclick", onDoubleClick);
  toggle?.addEventListener("click", onToggleClick);
  // A window resize can invalidate the clamp (max is half the shell).
  const onResize = () => apply();
  window.addEventListener("resize", onResize);

  apply();

  return {
    detach: () => {
      settleKeys();
      seam.removeEventListener("pointerdown", onPointerDown);
      seam.removeEventListener("pointermove", onPointerMove);
      seam.removeEventListener("pointerup", onPointerUp);
      seam.removeEventListener("pointercancel", onPointerUp);
      seam.removeEventListener("keydown", onKeyDown);
      seam.removeEventListener("dblclick", onDoubleClick);
      toggle?.removeEventListener("click", onToggleClick);
      window.removeEventListener("resize", onResize);
      seam.remove();
      shell.removeAttribute("data-dragging");
      rail.removeAttribute("inert");
      root.style.removeProperty("--pf-rail-w");
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
nvm use && npx vitest run test/framework/rail.test.js
```

Expected: PASS (14 tests).

- [ ] **Step 6: Wire it into `mount`**

In `src/framework/mount.js`, add the import beside the other chrome imports:

```js
import { attachRail } from "./rail.js";
```

In the `els` object, add a `rail` entry after `controls`:

```js
    rail: elements.rail ?? byId("panel"),
```

In the attach block, after the `attachCutawayControls` / `cleanup.defer` pair, add:

```js
    // Resizable/collapsible controls rail. No-ops when the host lays out the
    // framework itself (no #panel / no elements.rail).
    const railChrome = attachRail({ rail: els.rail, toggle: els.chrome.railToggle });
    cleanup.defer(() => railChrome.detach());
```

- [ ] **Step 7: Add the real-browser drag assertion**

This is the part a headless DOM cannot prove. In `scripts/check-app.mjs`, append to `checkRailLayout` (after the existing `for (const problem …)` loop):

```js
  // Drag the seam across the viewer and assert the rail followed. Pointer
  // capture is what makes this work; without it the pointer reaches the canvas
  // and the drag dies. happy-dom cannot model this, so it is proven here.
  const seam = await page.$(".pf-rail-seam");
  if (!seam) {
    errors.push(`rail layout ${width}px: no .pf-rail-seam to drag`);
    return;
  }
  const box = await seam.boundingBox();
  const before = await page.evaluate(() => document.getElementById("panel").getBoundingClientRect().width);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const after = await page.evaluate(() => document.getElementById("panel").getBoundingClientRect().width);
  if (after <= before + 40) {
    errors.push(`rail layout ${width}px: drag did not widen the rail (${Math.round(before)} -> ${Math.round(after)})`);
  }
  // Leave the rail at its default so later checks and pages start clean.
  await page.evaluate(() => { try { localStorage.removeItem("partforge:rail"); } catch {} });
  await page.evaluate(() => document.documentElement.style.setProperty("--pf-rail-w", "288px"));
```

- [ ] **Step 8: Run the smoke check and the full suite**

```bash
nvm use && node scripts/check-app.mjs demo.html && npm test
```

Expected: smoke exits 0 (including the drag assertion at both 1280px and 1024px); vitest green.

- [ ] **Step 9: Drive it by hand**

```bash
nvm use && npm run dev
```

Open `/planter.html` and confirm each affordance: the pill is invisible at rest and appears on hover; the cursor is `ew-resize`; dragging left widens the rail and the viewer re-renders as it narrows; dragging hard right past ~140px snaps the rail shut and the seam parks at the window edge; dragging back left past ~200px reopens it **within the same gesture**; the drag keeps working while the pointer is out over the 3D canvas; Tab reaches the seam and shows the pill; arrows/Home/End/Enter work; double-click resets; a reload restores the width.

- [ ] **Step 10: Commit**

```bash
git add src/framework/rail.js src/framework/mount.js test/framework/rail.test.js test/setup/happy-dom-patches.js scripts/check-app.mjs
git commit -m "feat(chrome): make the controls rail resizable and collapsible"
```

---

### Task 6: The `#rail-toggle` viewbar button

Collapse without a visible control is a discoverability hole — a fully collapsed rail would only be recoverable from a 12px seam. This closes it.

**Files:**
- Modify: `src/framework/mount.js:82-88` (the `chrome` element block)
- Modify: `bracket.html`, `demo.html`, `faceted-vase.html`, `filleted-box.html`, `hull-sweep.html`, `nameplate.html`, `planter.html`, `text-smoke.html`
- Test: `test/framework/mount.test.js`

**Interfaces:**
- Consumes: `attachRail`'s `toggle` option (Task 5 — the behavior and its unit tests already landed there; this task is only the element's resolution and its markup).
- Produces: `elements.chrome.railToggle`, defaulting to `byId("rail-toggle")`. Optional, like every other `chrome` entry.

- [ ] **Step 1: Write the failing test**

`attachRail` already handles a `toggle` it is handed (Task 5). What does not exist
yet is `mount` finding one. Append to `test/framework/mount.test.js`, mirroring
the existing "legacy host page resolves the #cutaway fallback" test:

```js
test("legacy host page resolves the #rail-toggle fallback and it collapses the rail", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>
    <div id="panel"></div>
    <button id="rail-toggle"></button>`;
  const { createWorker } = makeWorkers();

  mount(makePart(), { createWorker });
  const toggle = document.getElementById("rail-toggle");
  // attachRail labels the button on attach — proof mount handed it over.
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  toggle.click();
  expect(document.getElementById("panel").hasAttribute("inert")).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--pf-rail-w")).toBe("0px");
});

test("mount works without a #rail-toggle — every chrome control stays optional", () => {
  // A host driving the rail from its own UI (partforge-cloud hides #theme for
  // exactly this reason) must not be forced to supply this button.
  const els = makeElements();
  const { createWorker } = makeWorkers();
  expect(() => mount(makePart(), { createWorker, elements: els })).not.toThrow();
});
```

Also add `railToggle: mk("button")` to `makeElements()`'s `chrome` block and
include `els.chrome.railToggle` in its `document.body.append(...)` call, so the
rest of the suite exercises the wired-up path.

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && npx vitest run test/framework/mount.test.js
```

Expected: FAIL — `expected null to be "true"` on `aria-expanded`, because `mount`
does not yet resolve `#rail-toggle` and so never passes it to `attachRail`.

- [ ] **Step 3: Resolve the toggle in `mount`**

In `src/framework/mount.js`, add to the `chrome` block:

```js
      railToggle: elements.chrome?.railToggle ?? byId("rail-toggle"),
```

- [ ] **Step 4: Add the button to the eight demo pages**

In each page's `#viewbar`, add `#rail-toggle` as the **last** button so it sits nearest the rail it controls. `attachRail` sets the glyph, `title` and `aria-label` on attach, so the markup only needs a fallback label:

```html
        <button id="rail-toggle" aria-label="Hide controls">⇥</button>
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
nvm use && npx vitest run test/framework/mount.test.js
```

Expected: PASS. If the "works without a #rail-toggle" case fails, `attachRail`'s
`toggle` handling is not guarding with `?.` somewhere — fix that rather than
making the button required.

- [ ] **Step 6: Run the tests and the smoke check**

```bash
nvm use && npm test && node scripts/check-app.mjs demo.html
```

Expected: vitest green, smoke exits 0.

- [ ] **Step 7: Check the affordance by hand**

```bash
nvm use && npm run dev
```

Open `/demo.html`, click the `⇥` button: the rail collapses, the glyph flips to `⇤`, the button lights up, and the viewer takes the full width. Click again to restore the previous width. Then resize the browser below 720px and confirm the button still collapses the stacked rail.

- [ ] **Step 8: Commit**

```bash
git add src/framework/mount.js *.html test/framework/mount.test.js
git commit -m "feat(chrome): add a viewbar toggle for the controls rail"
```

---

### Task 7: Documentation and release

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (the app-wiring section)
- Modify: `package.json` (version)
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Document the markup convention**

In `docs/AUTHORING-PARTS.md`, find the app-wiring section (the three-glue-files description) and add the rail layout to it. Include: `<body class="pf-shell">`; chrome living inside `#app class="pf-stage"`; the `#panel class="pf-rail"` head/body/foot split; that `#rail-toggle` is optional chrome resolved like `#pause`/`#theme`; that legacy id-only markup keeps the old floating card through `app.css`'s `:not(.pf-*)` fallbacks; and that `partforge/chrome.css` is exported for hosts that build their own DOM. Reference `demo.html` as the canonical copy-me page.

- [ ] **Step 2: Note the new tokens**

In the same file's styling/tokens discussion, list `--pf-sans`, `--pf-rail-w`, `--pf-rail-pad`, `--pf-radius-control`, `--pf-radius-pill`, `--pf-shadow-float`, `--pf-shadow-rail`, and state that Geist is self-hosted by the *demos* only — a consumer that loads no fonts falls through to system stacks by design.

- [ ] **Step 3: Update `AGENTS.md`**

Add `chrome.css` to the `src/framework/` bullet, alongside `app.css`, and mention `rail.js` / `rail-state.js` as the rail's DOM binding and pure state.

- [ ] **Step 4: Bump the version**

Set `"version": "0.28.0"` in `package.json`. Minor, not patch: the demo markup convention changed and `partforge/chrome.css` is a new public export.

- [ ] **Step 5: Full verification**

```bash
nvm use && npm test && npm run check && npm run build
```

Expected: vitest green; all three checked apps pass; the production build succeeds. The build matters here because `chrome.css` is a new `@import` and the demo pages changed shape.

- [ ] **Step 6: Commit**

```bash
git add docs/AUTHORING-PARTS.md AGENTS.md package.json
git commit -m "docs: document the controls rail layout; release 0.28.0"
```

---

## Verification checklist

Run before opening the PR:

```bash
nvm use && npm test && npm run check && npm run build
```

Then by hand, at a wide window on `/planter.html`, in **both** themes:

- [ ] Rail is full-height, flush right, square-cornered, with an inset shadow on its left edge (reads as set back, not floating).
- [ ] Sections are full-bleed with hairline dividers; no boxes; slider thumb rings match the rail surface.
- [ ] `Advanced ▾` folds still open and close.
- [ ] View tabs top-centre and the viewbar bottom-right, both inset from the rail.
- [ ] Seam pill invisible at rest, visible on hover and on keyboard focus.
- [ ] Drag widens/narrows live; survives the pointer crossing the 3D canvas.
- [ ] Snap shut past ~140px; reopen past ~200px in the same gesture.
- [ ] `#rail-toggle` collapses and restores the previous width.
- [ ] Reload restores width and collapsed state.
- [ ] Below 720px the rail stacks under the viewer, the seam is gone, the toggle still works.
- [ ] `/embed-test.html` still mounts, disposes, and cycles cleanly — it has no rail and must be untouched.

## Out of scope

Per spec §7 and §9, do **not** do these here: moving `#status` to a bottom-centre pill; porting the cloud's concentric-corner radii; changing accordion behavior; or any edit inside the `partforge-cloud` repo. §9's cloud follow-up is a separate PR in a separate repo.
