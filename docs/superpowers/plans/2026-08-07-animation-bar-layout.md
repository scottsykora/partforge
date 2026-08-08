# Animation Transport Bar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The animation transport bar's card is never shorter than the viewbar card, and never overlaps it — a ≥10px gap always holds, with the bar sliding left (and width-capping as a last resort) when the stage is too narrow for centered placement.

**Architecture:** A pure placement function (`planAnimBarPlacement`, exported from `animation-controls.js`) decides "centered / slide left / slide left + cap" from three numbers; `attachAnimationControls` wires it with a rAF-coalesced `ResizeObserver` pass that clears its own inline overrides, measures real rects, and re-applies — so chrome.css stays authoritative whenever centered fits. The height floor is pure CSS in app.css. Real-browser invariants are asserted in `scripts/check-app.mjs` against hinged-box.html.

**Tech Stack:** Vanilla JS (plain ESM), vitest + happy-dom for unit tests, Playwright Chromium via `scripts/check-app.mjs` for rendered-geometry checks.

**Spec:** `docs/superpowers/specs/2026-08-07-animation-bar-layout-design.md`

## Global Constraints

- **Node 24 required** — run `nvm use` in the repo root before any `npm`/`npx`/`node` command, or tests fail confusingly.
- Constants: gap = **10px**, stage left margin = **12px**, viewbar card height = **44px** (34px button + 2×4px padding + 2×1px border; **40px** under `@media (max-width: 360px)` where buttons are 30px). `app.css` sets `* { box-sizing: border-box; }` globally, so `min-height` values are border-box.
- CSS split rule (documented in chrome.css): **chrome.css owns placement, app.css owns appearance**. The `min-height` is appearance → app.css. The JS clamp writes inline styles only while constrained and clears them otherwise, so it never fights a host that re-anchors the bar.
- The narrow layout (≤719px viewport) lifts the bar to `bottom: 64px`, above the viewbar — the clamp must be a no-op there. This falls out of the "vertical bands intersect" guard; never key it off a width.
- Do not touch `#viewbar` markup or placement.
- All work on branch `animation-bar-layout`.

---

### Task 1: Pure placement function

**Files:**
- Modify: `src/framework/animation-controls.js` (add exported function near the top, after the `btn` helper)
- Test: `test/framework/animation-controls.test.js` (append tests)

**Interfaces:**
- Produces: `planAnimBarPlacement({ stageWidth, barWidth, viewbarLeft }, { gap = 10, margin = 12 } = {})` → `null` (centered CSS default stands) or `{ left: number, maxWidth?: number }` (inline overrides, px, stage-relative). `viewbarLeft` is the viewbar's left edge relative to the stage's left edge. Task 2 consumes this exact signature.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/animation-controls.test.js` (module-level import already exists for `attachAnimationControls`; extend it):

```js
import { attachAnimationControls, planAnimBarPlacement } from "../../src/framework/animation-controls.js";
```

(replace the existing import line), then append:

```js
// --- planAnimBarPlacement: pure clamp math ----------------------------------
// stage-relative px in, inline-override plan out. null = the CSS default
// (centered) already clears the viewbar.

test("placement: centered when there is room", () => {
  // centeredLeft 300 ≤ limit 800−10−400 = 390
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 800 })).toBeNull();
});

test("placement: exactly touching the gap is still centered", () => {
  // centeredLeft 300 === limit 710−10−400 = 300
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 710 })).toBeNull();
});

test("placement: slides left to hold the 10px gap", () => {
  // centeredLeft 300 > limit 700−10−400 = 290
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 700 }))
    .toEqual({ left: 290 });
});

test("placement: never crosses the 12px stage margin", () => {
  // limit 430−10−400 = 20 → still above margin
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 430 }))
    .toEqual({ left: 20 });
  // limit 415−10−400 = 5 → clamped to 12, and 400 > available 415−10−12 = 393 → capped
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 415 }))
    .toEqual({ left: 12, maxWidth: 393 });
});

test("placement: cap never goes negative", () => {
  // viewbar hugging the left edge: available 15−10−12 < 0 → cap at 0
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 15 }))
    .toEqual({ left: 12, maxWidth: 0 });
});

test("placement: honours custom gap and margin", () => {
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 700 }, { gap: 20, margin: 30 }))
    .toEqual({ left: 280 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/animation-controls.test.js -t "placement:"`
Expected: FAIL — `planAnimBarPlacement` is not exported (SyntaxError or undefined-call).

- [ ] **Step 3: Implement the function**

In `src/framework/animation-controls.js`, after the `btn` helper:

```js
// Where the transport bar may sit, given the stage width, the bar's natural
// width, and the viewbar's left edge (all px, viewbarLeft stage-relative).
// null → the CSS default (centered) already clears the viewbar. Otherwise
// inline overrides: `left` slides the bar toward the stage's `margin`, and
// when even that isn't enough, `maxWidth` caps the bar so the `gap` holds.
export function planAnimBarPlacement({ stageWidth, barWidth, viewbarLeft }, { gap = 10, margin = 12 } = {}) {
  const centeredLeft = (stageWidth - barWidth) / 2;
  const limit = viewbarLeft - gap - barWidth;
  if (centeredLeft <= limit) return null;
  const left = Math.max(margin, limit);
  const available = Math.max(0, viewbarLeft - gap - margin);
  return barWidth > available ? { left, maxWidth: available } : { left };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/animation-controls.test.js`
Expected: ALL PASS (new placement tests and the existing suite).

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js test/framework/animation-controls.test.js
git commit -m "Add pure placement clamp for the animation transport bar"
```

---

### Task 2: ResizeObserver wiring in attachAnimationControls

**Files:**
- Modify: `src/framework/animation-controls.js` (inside `attachAnimationControls`, after the `syncStructure(); syncUi();` pair and before `const runtime = {`; plus two lines in `detach()`)
- Test: `test/framework/animation-controls.test.js` (append test)

**Interfaces:**
- Consumes: `planAnimBarPlacement` from Task 1 (exact signature above).
- Produces: no new public surface. Behavior: the bar carries inline `left`/`transform`/`max-width` only while constrained; all three are cleared whenever centered placement fits or the bars' vertical bands don't intersect. `detach()` disconnects the observer.

Context for the implementer: `container` is the stage element (`els.viewer` in mount.js); `#viewbar` is host markup *inside* the stage (see hinged-box.html). `bar` is the transport bar element created earlier in this function, and `handle.detach()` near the bottom already removes listeners — extend it, don't replace it.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/animation-controls.test.js`:

```js
// --- placement wiring: ResizeObserver → measured clamp -----------------------
// happy-dom has no layout, so rects are stubbed; the viewer-pose tests use the
// same globalThis.ResizeObserver stub pattern.

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

test("placement wiring: clamps against the viewbar, clears when roomy, disconnects on detach", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  const observed = new Set();
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe(el) { observed.add(el); }
    disconnect() { disconnected = true; }
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    container.append(viewbar);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 });
    let viewbarLeft = 800;
    viewbar.getBoundingClientRect = () =>
      ({ left: viewbarLeft, right: viewbarLeft + 190, top: 650, bottom: 694, width: 190, height: 44 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}),
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 300, right: 700, top: 656, bottom: 692, width: 400, height: 36 });
    expect(observed.has(container)).toBe(true);
    expect(observed.has(bar)).toBe(true);
    expect(observed.has(viewbar)).toBe(true);

    // roomy: centeredLeft 300 ≤ limit 800−10−400 → no overrides
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("");

    // squeezed: limit 700−10−400 = 290 < centeredLeft 300 → slide left
    viewbarLeft = 700;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("290px");
    expect(bar.style.transform).toBe("none");
    expect(bar.style.maxWidth).toBe("");

    // roomy again → overrides cleared, chrome.css back in charge
    viewbarLeft = 800;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("");
    expect(bar.style.transform).toBe("");

    ctl.detach();
    expect(disconnected).toBe(true);
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("placement wiring: no-op when the bars' vertical bands do not intersect", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    container.append(viewbar);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 500, top: 0, bottom: 700, width: 500, height: 700 });
    // viewbar in the bottom band, bar lifted above it (narrow layout's bottom: 64px)
    viewbar.getBoundingClientRect = () =>
      ({ left: 100, right: 490, top: 650, bottom: 694, width: 390, height: 44 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}),
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 50, right: 450, top: 600, bottom: 636, width: 400, height: 36 });
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe(""); // would collide horizontally, but bands don't meet
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/animation-controls.test.js -t "placement wiring"`
Expected: FAIL — `observed.has(container)` is false (no observer wired yet).

- [ ] **Step 3: Implement the wiring**

In `attachAnimationControls`, right after the existing `syncStructure(); syncUi();` lines and before `const runtime = {`:

```js
  // --- placement: keep clear of the viewbar ---------------------------------
  // chrome.css centers the bar (left: 50% / translateX(-50%)), and nothing in
  // CSS can stop that centered position sliding under #viewbar when the stage
  // narrows — the viewbar's width is dynamic (cutaway's Flip/Reset appear and
  // disappear), so a static reservation would either overlap or waste centre
  // space. Measure instead: when the two bars' vertical bands intersect, clamp
  // the bar's left so a 10px gap to the viewbar holds, capping its width if
  // even the stage's 12px margin isn't enough. Overrides are inline and
  // cleared at the top of every pass, so chrome.css (or a host that
  // re-anchors either bar out of the shared band) stays authoritative the
  // moment the constraint stops binding. The clear-measure-apply sequence is
  // loop-safe: it settles within one frame, so ResizeObserver — which reports
  // rendered sizes at frame boundaries — never sees the intermediate state.
  const viewbarEl = container.querySelector("#viewbar");
  let placementRaf = 0;
  function applyPlacement() {
    placementRaf = 0;
    bar.style.left = "";
    bar.style.transform = "";
    bar.style.maxWidth = "";
    const vb = viewbarEl?.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    if (!vb || barRect.top >= vb.bottom || barRect.bottom <= vb.top) return;
    const stageRect = container.getBoundingClientRect();
    const plan = planAnimBarPlacement({
      stageWidth: stageRect.width,
      barWidth: barRect.width,
      viewbarLeft: vb.left - stageRect.left,
    });
    if (!plan) return;
    bar.style.left = `${plan.left}px`;
    bar.style.transform = "none";
    if (plan.maxWidth != null) bar.style.maxWidth = `${plan.maxWidth}px`;
  }
  function schedulePlacement() {
    if (typeof requestAnimationFrame !== "function") return applyPlacement();
    if (!placementRaf) placementRaf = requestAnimationFrame(applyPlacement);
  }
  // Observing the bar itself catches content-driven width changes (step label
  // text, animation switch); the viewbar, cutaway's actions; the stage, rail
  // drags and window resizes.
  const placementObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(schedulePlacement) : null;
  if (placementObserver) {
    placementObserver.observe(container);
    placementObserver.observe(bar);
    if (viewbarEl) placementObserver.observe(viewbarEl);
  }
  schedulePlacement();
```

In `detach()`, before `bar.remove()`:

```js
      placementObserver?.disconnect();
      if (placementRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(placementRaf);
```

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run test/framework/animation-controls.test.js`
Expected: ALL PASS — including the pre-existing tests, which prove the wiring degrades to a no-op when `ResizeObserver` is absent or rects are zero.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js test/framework/animation-controls.test.js
git commit -m "Clamp the animation transport bar clear of the viewbar"
```

---

### Task 3: Height floor CSS

**Files:**
- Modify: `src/framework/app.css` (the `.pf-anim-bar` appearance rule at ~line 222, and the existing `@media (max-width: 360px)` block at ~line 213)

**Interfaces:**
- Produces: `.pf-anim-bar` computed `min-height: 44px` (40px ≤360px). Task 4's check asserts `barHeight ≥ viewbarHeight` in a real browser.

- [ ] **Step 1: Add the min-height to the main rule**

In `src/framework/app.css`, the rule currently reads:

```css
.pf-anim-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-control); box-shadow: var(--pf-shadow-float);
}
```

Change it to:

```css
.pf-anim-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  /* Never shorter than #viewbar's card sharing the same bottom edge:
     34px button + 2×4px padding + 2×1px border (border-box). */
  min-height: 44px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-control); box-shadow: var(--pf-shadow-float);
}
```

- [ ] **Step 2: Match the ≤360px viewbar shrink**

Inside the existing `@media (max-width: 360px)` block (the one shrinking `#viewbar button` to 30px), append:

```css
  /* #viewbar's card is 40px here (30px buttons) — keep the floor in step. */
  .pf-anim-bar { min-height: 40px; }
```

- [ ] **Step 3: Eyeball it in the dev server (optional but cheap)**

Run: `npm run dev` and open `/hinged-box.html` — the transport bar and viewbar should read as equal-height cards on the stage's bottom edge. Ctrl-C when done.

- [ ] **Step 4: Commit**

```bash
git add src/framework/app.css
git commit -m "Match the animation transport bar's card height to the viewbar"
```

---

### Task 4: Real-browser check, full validation, version bump

**Files:**
- Modify: `scripts/check-app.mjs` (new `checkAnimBarLayout` function next to `checkRailLayout`, plus one invocation in the existing viewport-check block)
- Modify: `package.json` + `package-lock.json` (patch version bump)

**Interfaces:**
- Consumes: the rendered behavior from Tasks 1–3 (10px gap, 12px margin, slide-left, 44px floor) via hinged-box.html, the CI-checked app that declares animations.
- Produces: `checkAnimBarLayout(widths: number[])`, invoked as `await checkAnimBarLayout([1600, 1280, 1024]);`.

- [ ] **Step 1: Add the check function**

In `scripts/check-app.mjs`, after `checkRailLayout` (~line 210), add:

```js
// The animation transport bar (.pf-anim-bar) floats centered on the stage's
// bottom edge while #viewbar floats bottom-right in the same band —
// animation-controls.js clamps the bar left of the viewbar with a 10px gap
// and app.css floors its height at the viewbar's (see
// docs/superpowers/specs/2026-08-07-animation-bar-layout-design.md). Headless
// unit tests stub every rect, so the rendered invariants are asserted here:
// no overlap, the gap, the 12px left margin, the height floor, centered when
// roomy — and, at least once across the widths, that the clamp actually
// engaged (all-roomy widths would make this check prove nothing).
async function checkAnimBarLayout(widths) {
  if (!await page.locator(".pf-anim-bar").count()) return; // part declares no animations
  await pauseTransportIfPlaying(); // step-label text changes width mid-playback
  let sawSqueeze = false;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await sleep(50);
    const result = await page.evaluate(() => {
      const bar = document.querySelector(".pf-anim-bar");
      const stage = document.getElementById("app");
      const viewbar = document.getElementById("viewbar");
      if (!bar || !stage || !viewbar) return null;
      const b = bar.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const v = viewbar.getBoundingClientRect();
      const verticalHit = b.top < v.bottom && b.bottom > v.top;
      return {
        verticalHit,
        gap: v.left - b.right,
        leftMargin: b.left - s.left,
        barHeight: b.height,
        viewbarHeight: v.height,
        centerOffset: (b.left + b.right) / 2 - (s.left + s.right) / 2,
        // from measured widths, would the CSS-centered position collide?
        wouldCollideCentered: verticalHit && (s.width + b.width) / 2 > (v.left - s.left) - 10,
      };
    });
    if (!result) { errors.push(`anim bar ${width}px: missing .pf-anim-bar, #app, or #viewbar`); continue; }
    if (result.barHeight < result.viewbarHeight - 0.5) {
      errors.push(`anim bar ${width}px: bar is ${result.barHeight}px tall, shorter than #viewbar's ${result.viewbarHeight}px`);
    }
    if (!result.verticalHit) continue; // narrow layout lifts the bar above the viewbar
    if (result.gap < 9.5) {
      errors.push(`anim bar ${width}px: gap to #viewbar is ${Math.round(result.gap)}px, expected ≥ 10`);
    }
    if (result.leftMargin < 11.5) {
      errors.push(`anim bar ${width}px: bar sits ${Math.round(result.leftMargin)}px from the stage's left edge, expected ≥ 12`);
    }
    if (result.wouldCollideCentered) {
      sawSqueeze = true;
      if (result.centerOffset > -0.5) {
        errors.push(`anim bar ${width}px: centered placement would overlap #viewbar but the bar did not slide left`);
      }
    } else if (Math.abs(result.centerOffset) > 1) {
      errors.push(`anim bar ${width}px: bar is ${Math.round(result.centerOffset)}px off stage-centre with room to spare`);
    }
  }
  if (!sawSqueeze) {
    errors.push("anim bar: no tested width squeezed the bar — use a narrower width so the clamp path is exercised");
  }
}
```

Note: `pauseTransportIfPlaying` is defined lower in the file (~line 398) — function declarations hoist, so calling it from here is fine; if the executor prefers, move `checkAnimBarLayout` below it instead.

- [ ] **Step 2: Invoke it in the viewport block**

In the block that already runs the layout checks (~line 609), after `await checkNarrowPaneTabs(400, 1024);` and before `if (viewport) await page.setViewportSize(viewport);`:

```js
    await checkAnimBarLayout([1600, 1280, 1024]);
```

(Cutaway is still enabled from the toggle earlier in the flow, so the viewbar is at its widest — the stronger version of the test.)

- [ ] **Step 3: Run the smoke check against hinged-box**

Run: `nvm use && node scripts/check-app.mjs hinged-box.html`
Expected: PASS. If `anim bar: no tested width squeezed…` appears, the bar/viewbar geometry is roomier than estimated — replace `1024` with a narrower width (e.g. `900`, staying ≥ 720 so the wide layout still applies) until one width squeezes. If a `did not slide left` error appears, that's a real Task 2 bug — debug, don't loosen the check. Also run `node scripts/check-app.mjs demo.html` once to confirm the check self-skips on a part with no animations.

- [ ] **Step 4: Run the whole unit suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 5: Bump the version**

Run: `npm version patch --no-git-tag-version`
Expected: `package.json` and `package-lock.json` move 0.46.2 → 0.46.3 (per AGENTS.md, the bump rides the feature PR; tagging happens after merge, not now).

- [ ] **Step 6: Commit**

```bash
git add scripts/check-app.mjs package.json package-lock.json
git commit -m "check-app: assert the animation bar clears the viewbar; bump to 0.46.3"
```
