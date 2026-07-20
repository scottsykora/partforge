# Viewer Hover, Tooltips, and Lighting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add prioritized cutaway-gizmo hover feedback, shared accessible viewer tooltips, and brighter technical-CAD lighting without changing cutaway geometry or drag behavior.

**Architecture:** The gizmo owns handle hit-testing and visual emphasis, then publishes hover ownership through `cutaway.js` and the viewer API so feature hover can yield cleanly. A reusable tooltip presenter is injected into feature hover and both chrome controllers, while a small lighting factory keeps the three-light rig independently testable.

**Tech Stack:** JavaScript ESM, three.js, DOM Pointer/Focus Events, CSS custom properties, Vitest with happy-dom, Vite, Playwright smoke checks.

---

## Implementation rules

- Work in `/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge-cutaway` on `codex/viewer-cutaway`.
- Run `nvm use` before every npm/Vitest command; the repository requires Node 24.
- Use @superpowers:test-driven-development for each behavior change below.
- Preserve the gizmo's invisible hit-proxy dimensions and current pointer-drag math.
- Do not add tooltips to parameter-panel or export buttons; “all buttons” in this feature means all viewer chrome controls: Cutaway, Pause/Play, Re-frame, Theme, Flip, and Reset.
- Keep each commit limited to the task named in the plan.

### Task 1: Build the shared tooltip presenter and button binding

**Files:**
- Create: `src/framework/tooltip.js`
- Create: `test/framework/tooltip.test.js`
- Modify: `src/framework/app.css:237-253` (the existing `#pf-hover-tip` block; locate by selector if line numbers move)

**Step 1: Write the failing presenter tests**

Create happy-dom tests that establish the complete presentation contract:

```js
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import {
  attachButtonTooltips,
  createTooltipPresenter,
} from "../../src/framework/tooltip.js";

afterEach(() => { document.body.innerHTML = ""; });

test("presents pointer content with the existing feature tooltip structure", () => {
  const tooltip = createTooltipPresenter();
  tooltip.showPointer({ title: "Drainage hole", subtitle: "Planter" }, 20, 30);
  const element = document.getElementById("pf-hover-tip");
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Drainage hole");
  expect(element.querySelector(".pf-hover-sub").textContent).toBe("Planter");
  expect(element.style.left).toBe("34px");
  expect(element.style.top).toBe("44px");
  tooltip.dispose();
});

test("anchors button content and hides it on click", () => {
  const button = document.createElement("button");
  button.title = "Original title";
  button.setAttribute("aria-label", "Pause rotation");
  button.getBoundingClientRect = () => ({ left: 40, top: 10, right: 80, bottom: 34, width: 40, height: 24 });
  document.body.appendChild(button);
  const tooltip = createTooltipPresenter();
  const binding = attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(document.getElementById("pf-hover-tip").querySelector("b").textContent)
    .toBe("Pause rotation");
  expect(button.hasAttribute("title")).toBe(false);

  button.click();
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  binding.detach();
  expect(button.title).toBe("Original title");
  tooltip.dispose();
});
```

Add separate tests for:

- `focus` shows and `blur` hides the anchored tooltip;
- `pointerleave` hides it;
- a touch `pointerenter` does not show it;
- the label is read from `aria-label` at show time, so dynamic state is current;
- `detach()` removes listeners and restores the original `title`/`aria-label` attributes;
- `dispose()` is idempotent and removes the tooltip element.

**Step 2: Run the test to verify it fails**

Run:

```bash
nvm use && npx vitest run test/framework/tooltip.test.js
```

Expected: FAIL because `src/framework/tooltip.js` does not exist.

**Step 3: Implement the minimal presenter and button binding**

Implement this public shape:

```js
export function createTooltipPresenter() {
  const element = document.createElement("div");
  element.id = "pf-hover-tip";
  element.className = "pf-hover-tip";
  const title = document.createElement("b");
  const subtitle = document.createElement("span");
  subtitle.className = "pf-hover-sub";
  element.append(title, subtitle);
  document.body.appendChild(element);

  let disposed = false;
  function setContent(content) {
    title.textContent = content.title;
    subtitle.textContent = content.subtitle ?? "";
  }

  return {
    showPointer(content, x, y) {
      if (disposed) return;
      setContent(content);
      element.classList.remove("pf-tooltip-anchored");
      element.style.left = `${x + 14}px`;
      element.style.top = `${y + 14}px`;
      element.classList.add("show");
    },
    showAnchor(content, anchor) {
      if (disposed) return;
      setContent(content);
      const rect = anchor.getBoundingClientRect();
      element.classList.add("pf-tooltip-anchored", "show");
      element.style.left = `${rect.left + rect.width / 2}px`;
      element.style.top = `${rect.bottom + 8}px`;
    },
    hide() { if (!disposed) element.classList.remove("show"); },
    dispose() {
      if (disposed) return;
      disposed = true;
      element.remove();
    },
  };
}
```

Implement `attachButtonTooltips(tooltip, entries)` with entries shaped as
`{ element, getLabel? }`. Default `getLabel` to the element's current
`aria-label`, falling back to its captured `title`. Capture and remove native
titles, attach `pointerenter`, `pointerleave`, `focus`, `blur`, and `click`, and
restore captured attributes on idempotent detach. Ignore pointer events whose
`pointerType` is `touch`.

Update the CSS so the existing styles apply to `.pf-hover-tip` (retain the ID for
compatibility), and add only the anchored transform:

```css
.pf-hover-tip { /* existing tooltip declarations */ }
.pf-hover-tip.show { display: block; }
.pf-hover-tip.pf-tooltip-anchored { transform: translateX(-50%); }
.pf-hover-tip .pf-hover-sub { /* existing secondary label declarations */ }
```

**Step 4: Run the focused tests**

Run:

```bash
nvm use && npx vitest run test/framework/tooltip.test.js test/selection-hover.test.js
```

Expected: PASS; the unchanged selection-hover tests confirm CSS/ID compatibility.

**Step 5: Commit**

```bash
git add src/framework/tooltip.js src/framework/app.css test/framework/tooltip.test.js
git commit -m "feat: add shared viewer tooltip presenter"
```

### Task 2: Add state-aware tooltips to every viewer button

**Files:**
- Modify: `src/framework/viewer-controls.js:1-55`
- Modify: `src/framework/cutaway-controls.js:1-125`
- Modify: `test/framework/viewer-controls.test.js`
- Modify: `test/framework/cutaway-controls.test.js`

**Step 1: Write failing viewer-control tests**

Pass a fake tooltip presenter to `attachViewerControls` and assert:

```js
const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
const chrome = attachViewerControls(viewer, els, { tooltip });
handles.push(chrome);

expect(els.pause.getAttribute("aria-label")).toBe("Pause rotation");
expect(els.reframe.getAttribute("aria-label")).toBe("Re-frame model");
expect(els.theme.getAttribute("aria-label")).toBe("Switch to light mode");

els.pause.click();
expect(els.pause.getAttribute("aria-label")).toBe("Resume rotation");
els.theme.click();
expect(els.theme.getAttribute("aria-label")).toBe("Switch to dark mode");
```

Dispatch `pointerenter` for Pause, Re-frame, and Theme and assert the presenter
receives each current accessible label. After `detach()`, verify pointer/focus
events no longer show a tooltip.

**Step 2: Write failing cutaway-control tests**

Update the supported fixture to pass `{ tooltip }` as the third argument. Assert
the primary button label is initially `Enable cutaway`, becomes `Disable
cutaway` after a click, and that the generated action buttons expose `Flip
cutaway direction` and `Reset cutaway plane`. Dispatch pointer/focus events to
all three buttons and verify presenter calls. Verify detach removes those
listeners and still restores the host button's original attributes.

**Step 3: Run tests to verify they fail**

Run:

```bash
nvm use && npx vitest run test/framework/viewer-controls.test.js test/framework/cutaway-controls.test.js
```

Expected: FAIL because the controllers do not accept a tooltip or maintain the
new action labels.

**Step 4: Implement viewer-control labels and bindings**

Import `attachButtonTooltips` and change the signature to:

```js
export function attachViewerControls(
  viewer,
  { pause: pauseBtn, reframe: reframeBtn, theme: themeBtn } = {},
  { tooltip } = {},
) { /* ... */ }
```

Keep dynamic labels synchronized with state:

```js
themeBtn?.setAttribute("aria-label", theme === "light"
  ? "Switch to dark mode"
  : "Switch to light mode");

pauseBtn?.setAttribute("aria-label", rotating
  ? "Pause rotation"
  : "Resume rotation");

reframeBtn?.setAttribute("aria-label", "Re-frame model");
```

Do not assign dynamic `title` values. Attach all present buttons through
`attachButtonTooltips`, and detach that binding inside the existing `detach()`.

**Step 5: Implement cutaway-control labels and bindings**

Change the signature similarly:

```js
export function attachCutawayControls(
  viewer,
  { cutaway: button } = {},
  { tooltip } = {},
) { /* ... */ }
```

Make `actionButton` assign `aria-label` rather than relying on `title`. In
`sync()`, set the primary button label to `Enable cutaway` or `Disable cutaway`.
For an unsupported context use the existing explanation as the accessible
label/description. Bind the primary, Flip, and Reset buttons to the shared
presenter. Detach the binding before restoring captured host attributes.

**Step 6: Run focused tests**

Run:

```bash
nvm use && npx vitest run test/framework/tooltip.test.js test/framework/viewer-controls.test.js test/framework/cutaway-controls.test.js
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/framework/viewer-controls.js src/framework/cutaway-controls.js test/framework/viewer-controls.test.js test/framework/cutaway-controls.test.js
git commit -m "feat: add viewer control tooltips"
```

### Task 3: Add hover emphasis and drag locking to the cutaway gizmo

**Files:**
- Modify: `src/framework/cutaway-gizmo.js:37-197,300-493,522-548`
- Modify: `test/framework/cutaway-gizmo.test.js`

**Step 1: Write failing passive-hover tests**

Add `onHandleHoverChange` to the fixture overrides and use a mutable
`pickHandle` stub. Test this sequence:

```js
let picked = "rotate-x";
const onHandleHoverChange = vi.fn();
const { domElement, gizmo } = createFixture({
  onHandleHoverChange,
  pickHandle: () => picked,
});
gizmo.setVisible(true);

pointer(domElement, "pointermove");
expect(onHandleHoverChange).toHaveBeenLastCalledWith("rotate-x");
expect(gizmo.handleVisuals.rotateX.scale.x).toBeCloseTo(1.12);
expect(gizmo.handleVisuals.translate.scale.x).toBe(1);

picked = null;
pointer(domElement, "pointermove", { x: 20, y: 20 });
expect(onHandleHoverChange).toHaveBeenLastCalledWith(null);
```

Also record the hovered material's color before/after and assert it moves closer
to white. Assert the corresponding hit proxy scale remains `[1, 1, 1]`.

**Step 2: Write failing drag/cleanup tests**

Cover these cases:

- pressing a handle emphasizes it even without a prior move;
- while dragging, changing `pickHandle` does not change emphasized handle;
- pointer release preserves emphasis only until the next passive move;
- `pointerleave`, `setVisible(false)`, window blur, and `dispose()` publish `null`;
- setting the same hovered handle repeatedly does not publish duplicate events;
- changing theme or active/idle appearance preserves the hovered handle's scale
  and brightness advantage.

**Step 3: Run the test to verify it fails**

Run:

```bash
nvm use && npx vitest run test/framework/cutaway-gizmo.test.js
```

Expected: FAIL because the callback and `handleVisuals` do not exist.

**Step 4: Group visible arrow geometry without moving hit proxies**

Create `translateVisualRoot`, add `shaft` and `cone` to it, and leave
`translateHit` directly under `handleRoot`. Keep both rings separate from their
hit meshes. Expose this test/debug mapping:

```js
const handleVisuals = {
  translate: translateVisualRoot,
  rotateX: ringX,
  rotateY: ringY,
};
```

Do not change the geometries or scales of `handles`/`hitProxies`.

**Step 5: Implement the hover state machine**

Add `onHandleHoverChange = () => {}` to the constructor. Maintain
`hoveredHandle`, active/idle state, and the current theme. Centralize appearance
so `setTheme`, `setActiveAppearance`, and hover changes cannot overwrite one
another:

```js
const HOVER_SCALE = 1.12;
const HOVER_WHITE_MIX = 0.28;

function setHoveredHandle(next) {
  const normalized = next === "translate" || next === "rotate-x" || next === "rotate-y"
    ? next : null;
  if (hoveredHandle === normalized) return;
  hoveredHandle = normalized;
  syncHandleAppearance();
  onHandleHoverChange(hoveredHandle);
}
```

`syncHandleAppearance()` must reset all three materials to the selected theme,
apply active/idle opacity, then mix only the hovered material toward white and
set only its visible root to `HOVER_SCALE`.

On passive pointer move, create the ray, call existing `pick`, and publish the
result. During drag, retain `drag.handle`. On pointer down, publish the picked
handle before capture. Add explicit leave/blur handlers that end the drag and
clear hover. Clear hover from `setVisible(false)` and `dispose()`.

**Step 6: Run focused gizmo tests**

Run:

```bash
nvm use && npx vitest run test/framework/cutaway-gizmo.test.js
```

Expected: PASS, including all existing depth, drag, camera-scaling, and theme
tests.

**Step 7: Commit**

```bash
git add src/framework/cutaway-gizmo.js test/framework/cutaway-gizmo.test.js
git commit -m "feat: emphasize hovered cutaway handles"
```

### Task 4: Publish gizmo hover ownership and suppress model hover

**Files:**
- Modify: `src/framework/cutaway.js:27-150,327-355`
- Modify: `src/framework/viewer.js:113-124,332-356`
- Modify: `src/framework/selection/hover.js:30-143`
- Modify: `test/framework/cutaway.test.js`
- Modify: `test/framework/viewer-cutaway.test.js`
- Modify: `test/selection-hover.test.js`

**Step 1: Write failing cutaway subscription tests**

In `cutaway.test.js`, subscribe through the returned controller and simulate the
gizmo callback using the existing `createCutawayGizmo` mock/spies. Assert:

- the subscriber immediately receives current state (`null` initially);
- `rotate-y` is forwarded once;
- duplicate values are not re-emitted;
- unsubscribe stops delivery; and
- disable/dispose publish or leave the state at `null` and clear subscribers.

Use this intended controller API:

```js
const unsubscribe = cutaway.onHandleHoverChange(listener);
```

**Step 2: Write the failing viewer forwarding test**

In `viewer-cutaway.test.js`, verify the public viewer return object exposes:

```js
viewer.onCutawayHandleHover(listener);
```

and that the function delegates to the cutaway controller's subscription.

**Step 3: Write failing feature-hover suppression tests**

Extend `makeViewer()` in `selection-hover.test.js` with a listener registry:

```js
let cutawayHoverListener = () => {};
viewer.onCutawayHandleHover = vi.fn((listener) => {
  cutawayHoverListener = listener;
  listener(null);
  return vi.fn();
});
viewer.emitCutawayHover = (handle) => cutawayHoverListener(handle);
```

Then assert that after a normal feature hover, emitting `rotate-x` immediately
hides the tooltip and overlay. Further canvas moves while suppressed must not
show them. Emitting `null` alone must not perform a stale raycast; the next move
shows the feature again. Add a queued-frame case proving a gizmo hover emission
invalidates work already scheduled. Verify detach unsubscribes exactly once.

**Step 4: Run tests to verify they fail**

Run:

```bash
nvm use && npx vitest run test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js test/selection-hover.test.js
```

Expected: FAIL because no hover subscription APIs exist.

**Step 5: Implement event forwarding**

In `cutaway.js`, maintain the current handle and a `Set` of listeners. Pass a
private setter to `createCutawayGizmo`:

```js
function setHoveredHandle(handle) {
  if (hoveredHandle === handle) return;
  hoveredHandle = handle;
  for (const listener of hoverListeners) listener(handle);
}

function onHandleHoverChange(listener) {
  if (disposed) return () => {};
  hoverListeners.add(listener);
  listener(hoveredHandle);
  return () => hoverListeners.delete(listener);
}
```

Expose `onHandleHoverChange` from cutaway and
`onCutawayHandleHover: cutaway.onHandleHoverChange` from viewer. Clear the state
when disabled and clear the listener set during disposal.

**Step 6: Implement feature-hover suppression**

Track a boolean `gizmoOwnsHover` inside `attachHoverLabels`. Subscribe when the
viewer API exists. When it becomes true, set `pending = null`, invalidate queued
work using the same lifecycle guard as pointer leave, and call `hide()`. In both
`onMove` and the scheduled callback, bail out while suppressed. Unsubscribe
during idempotent detach.

Do not import cutaway code into the selection module and do not call gizmo
raycasting from feature hover.

**Step 7: Run focused tests**

Run:

```bash
nvm use && npx vitest run test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js test/framework/cutaway-gizmo.test.js test/selection-hover.test.js
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/framework/cutaway.js src/framework/viewer.js src/framework/selection/hover.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js test/selection-hover.test.js
git commit -m "feat: prioritize cutaway gizmo hover"
```

### Task 5: Share one tooltip through the mounted viewer lifecycle

**Files:**
- Modify: `src/framework/selection/hover.js:30-143`
- Modify: `src/framework/mount.js:1-19,61-66,289-316`
- Modify: `test/selection-hover.test.js`
- Modify: `test/framework/mount.test.js`

**Step 1: Write the failing injected-presenter test**

In `selection-hover.test.js`, create a fake presenter and pass it to
`attachHoverLabels`:

```js
const tooltip = {
  showPointer: vi.fn(),
  hide: vi.fn(),
};
const hover = attachHoverLabels(viewer, { part, schedule: sync, tooltip });
move(viewer.domElement, 100, 100);
expect(tooltip.showPointer).toHaveBeenCalledWith({
  title: "Drainage hole",
  subtitle: "Planter",
}, 100, 100);
hover.detach();
```

Assert detach does not dispose an injected presenter. Preserve one compatibility
test where no presenter is supplied: `attachHoverLabels` creates and owns a
presenter so standalone framework consumers continue to work.

**Step 2: Write the failing mount composition test**

Mock `createTooltipPresenter` in `mount.test.js`. Verify the same presenter is
passed to `attachCutawayControls`, `attachHoverLabels`, and
`attachViewerControls`; verify mount disposal calls its `dispose()` exactly once
after the three consumer detach calls.

**Step 3: Run tests to verify they fail**

Run:

```bash
nvm use && npx vitest run test/selection-hover.test.js test/framework/mount.test.js
```

Expected: FAIL because feature hover still owns raw tooltip DOM and mount does
not create a shared presenter.

**Step 4: Refactor feature hover to consume the presenter**

Import `createTooltipPresenter`. Accept optional `tooltip`; create one only when
missing and remember ownership. Replace direct DOM mutation with:

```js
tooltip.showPointer({
  title: hit.feature?.label ?? subLabel(hit.subPart),
  subtitle: hit.feature ? subLabel(hit.subPart) : "",
}, x, y);
```

Call `tooltip.hide()` from current hide paths. Dispose only an internally-owned
presenter; otherwise only hide it during detach.

**Step 5: Compose and dispose the shared presenter in mount**

Create the presenter immediately after viewer creation, then inject it:

```js
const viewer = createViewer(els.viewer, part);
const tooltip = createTooltipPresenter();
const cutawayChrome = attachCutawayControls(viewer, {
  cutaway: els.chrome.cutaway,
}, { tooltip });
const hover = attachHoverLabels(viewer, { part, tooltip });
// Later:
const chrome = attachViewerControls(viewer, els.chrome, { tooltip });
```

On mount disposal, detach all consumers before `tooltip.dispose()`, then dispose
the viewer as before.

**Step 6: Run focused tests**

Run:

```bash
nvm use && npx vitest run test/framework/tooltip.test.js test/framework/viewer-controls.test.js test/framework/cutaway-controls.test.js test/selection-hover.test.js test/framework/mount.test.js
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/framework/selection/hover.js src/framework/mount.js test/selection-hover.test.js test/framework/mount.test.js
git commit -m "refactor: share viewer tooltip lifecycle"
```

### Task 6: Add the brighter technical-CAD light rig

**Files:**
- Create: `src/framework/viewer-lighting.js`
- Create: `test/framework/viewer-lighting.test.js`
- Modify: `src/framework/viewer.js:1-8,35-39`

**Step 1: Write the failing light-rig test**

Create a pure three.js test:

```js
import { expect, test } from "vitest";
import * as THREE from "three";
import { addViewerLights } from "../../src/framework/viewer-lighting.js";

test("adds a bright technical CAD key, hemisphere, and opposite fill", () => {
  const scene = new THREE.Scene();
  const lights = addViewerLights(scene);
  expect(scene.children).toEqual([lights.hemisphere, lights.key, lights.fill]);
  expect(lights.hemisphere).toBeInstanceOf(THREE.HemisphereLight);
  expect(lights.key).toBeInstanceOf(THREE.DirectionalLight);
  expect(lights.fill).toBeInstanceOf(THREE.DirectionalLight);
  expect(lights.hemisphere.groundColor.getHex()).not.toBe(0x202024);
  expect(lights.hemisphere.intensity).toBeGreaterThan(1.1);
  expect(lights.key.intensity).toBeGreaterThan(lights.fill.intensity);
  expect(lights.key.position.dot(lights.fill.position)).toBeLessThan(0);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
nvm use && npx vitest run test/framework/viewer-lighting.test.js
```

Expected: FAIL because the lighting module does not exist.

**Step 3: Implement the light factory and wire the viewer**

Use neutral/cool initial values intended for manual tuning:

```js
import * as THREE from "three";

export function addViewerLights(scene) {
  const hemisphere = new THREE.HemisphereLight(0xdce9ff, 0x687586, 1.35);
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(8, 14, 10);
  const fill = new THREE.DirectionalLight(0xe5efff, 0.65);
  fill.position.set(-10, 6, -8);
  scene.add(hemisphere, key, fill);
  return { hemisphere, key, fill };
}
```

Import `addViewerLights` into `viewer.js` and replace the inline hemisphere/key
setup with `addViewerLights(scene)`. Do not change part materials, tone mapping,
backgrounds, or theme switching.

**Step 4: Run focused viewer tests**

Run:

```bash
nvm use && npx vitest run test/framework/viewer-lighting.test.js test/framework/viewer-cutaway.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/framework/viewer-lighting.js src/framework/viewer.js test/framework/viewer-lighting.test.js
git commit -m "feat: brighten viewer CAD lighting"
```

### Task 7: Verify behavior in the browser and run the full quality gate

**Files:**
- Modify only if manual inspection finds a concrete issue in files already
  touched above.

**Step 1: Run all focused feature tests together**

Run:

```bash
nvm use && npx vitest run test/framework/tooltip.test.js test/framework/viewer-controls.test.js test/framework/cutaway-controls.test.js test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js test/framework/viewer-lighting.test.js test/selection-hover.test.js test/framework/mount.test.js
```

Expected: all focused tests PASS with no unhandled errors.

**Step 2: Start or reuse the local server**

Run:

```bash
nvm use && npm run dev -- --host 127.0.0.1
```

Expected: Vite serves `http://127.0.0.1:5173/`. Keep the process running.

**Step 3: Perform browser interaction checks**

Open `/demo.html` and `/planter.html`, then verify:

- each visible gizmo component brightens and enlarges independently;
- the green arrow and both arcs still depth-sort and drag correctly;
- hovering a gizmo component immediately removes feature hover behind it;
- leaving the gizmo allows feature hover to resume without a stale flash;
- tooltips appear for Cutaway, Pause/Play, Re-frame, Theme, Flip, and Reset;
- Pause, Theme, and Cutaway tooltip text changes with state;
- keyboard focus shows the same tooltip and Escape still exits cutaway;
- no duplicate native title tooltip appears after waiting;
- dark and light themes both show readable undersides and cavities; and
- the key/fill balance preserves visible curvature rather than flattening parts.

If lighting needs tuning, change only constants in `viewer-lighting.js`, update
the light test when the contract changes, and rerun its test before proceeding.

**Step 4: Run the complete automated gate**

Use @superpowers:verification-before-completion, then run:

```bash
nvm use && npm test
nvm use && npm run build
nvm use && node scripts/check-app.mjs demo.html
nvm use && node scripts/check-app.mjs planter.html
nvm use && node scripts/check-app.mjs filleted-box.html
```

Expected:

- the full Vitest suite passes;
- Vite production build succeeds;
- all three Chromium smoke checks report success.

If a failure occurs, first grep `docs/ERROR-PATTERNS.md` for its literal error,
then use @superpowers:systematic-debugging before changing code.

**Step 5: Inspect the final diff and status**

Run:

```bash
git diff origin/main...HEAD --stat
git status --short
```

Expected: only the intended cutaway branch changes are present and the worktree
is clean after the final commit.

**Step 6: Commit any final test-backed tuning**

If Step 3 required changes:

```bash
git add src/framework test
git commit -m "fix: polish viewer hover feedback"
```

Otherwise, do not create an empty commit.

**Step 7: Request review before branch completion**

Use @superpowers:requesting-code-review, address any actionable findings with
@superpowers:receiving-code-review, rerun the affected tests, and then use
@superpowers:finishing-a-development-branch to update the existing draft PR.
