# Viewer State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the viewer's play/pause, camera transform, and active view tab in `localStorage` so they survive browser reloads (notably Vite dev auto-refresh).

**Architecture:** A new pure module `src/framework/view-state.js` owns all `localStorage` access (global keys, guarded reads/writes) and is unit-tested in Node. `viewer.js` gains thin camera accessors. `mount.js` wires restore-on-load and save-on-change, reusing its existing view/pause/reframe handlers. Theme is already persisted and is left untouched.

**Tech Stack:** Vanilla ES modules, three.js (OrbitControls), Vitest (Node), `localStorage`.

## Global Constraints

- **Storage = `localStorage`, all keys global:** `partforge:rotating`, `partforge:camera`, `partforge:view`.
- **Persistence must never throw:** every `localStorage` read/write is `try/catch`-guarded; on failure reads return their documented default and writes are no-ops.
- **Theme is out of scope** — already persisted under the `theme` key; do not modify it.
- **The active tab is persisted**, which is what keeps a single global camera coherent across parts.
- **Tab switches still re-frame** (existing behavior); the saved camera is restored only once, on initial load.
- Tests run under **Node 24** (`nvm use` first; default shell Node is too old).
- Commit messages follow repo convention; end with the `Co-Authored-By:`/`Claude-Session:` trailers.

---

## Task 1: `view-state.js` persistence module

The pure, unit-testable seam. No DOM, no three.js — just guarded `localStorage` access.

**Files:**
- Create: `src/framework/view-state.js`
- Test: `test/view-state.test.js`

**Interfaces:**
- Produces:
  - `loadRotating() => boolean` (default `true` when absent/invalid)
  - `saveRotating(on: boolean) => void`
  - `loadCamera() => { pos:[x,y,z], target:[x,y,z] } | null` (null unless both are 3-element finite-number arrays)
  - `saveCamera(state: { pos:number[], target:number[] }) => void` (skips invalid input)
  - `loadView() => string | null` (raw stored name; caller validates existence)
  - `saveView(name: string) => void`

- [ ] **Step 1: Write the failing tests**

Create `test/view-state.test.js`:

```js
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  loadRotating, saveRotating, loadCamera, saveCamera, loadView, saveView,
} from "../src/framework/view-state.js";

function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

beforeEach(() => { globalThis.localStorage = mockStorage(); });
afterEach(() => { delete globalThis.localStorage; });

test("rotating round-trips true/false; defaults to true when absent", () => {
  expect(loadRotating()).toBe(true);     // absent → default true
  saveRotating(false);
  expect(loadRotating()).toBe(false);
  saveRotating(true);
  expect(loadRotating()).toBe(true);
});

test("camera round-trips pos/target; null when absent", () => {
  expect(loadCamera()).toBeNull();
  saveCamera({ pos: [1, 2, 3], target: [4, 5, 6] });
  expect(loadCamera()).toEqual({ pos: [1, 2, 3], target: [4, 5, 6] });
});

test("view round-trips a name; null when absent", () => {
  expect(loadView()).toBeNull();
  saveView("assembly");
  expect(loadView()).toBe("assembly");
});

test("corrupt camera JSON → loadCamera returns null", () => {
  globalThis.localStorage.setItem("partforge:camera", "{not json");
  expect(loadCamera()).toBeNull();
});

test("non-finite camera value → loadCamera returns null", () => {
  globalThis.localStorage.setItem("partforge:camera", '{"pos":[1,2,null],"target":[0,0,0]}');
  expect(loadCamera()).toBeNull();
});

test("saveCamera skips invalid input (no write, no throw)", () => {
  saveCamera({ pos: [1, 2, 3] });        // missing target
  expect(loadCamera()).toBeNull();
  saveCamera({ pos: [1, 2], target: [0, 0, 0] }); // wrong length
  expect(loadCamera()).toBeNull();
});

test("storage that throws → loads return defaults, saves are no-ops", () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  expect(loadRotating()).toBe(true);
  expect(loadCamera()).toBeNull();
  expect(loadView()).toBeNull();
  expect(() => {
    saveRotating(false);
    saveCamera({ pos: [1, 2, 3], target: [0, 0, 0] });
    saveView("x");
  }).not.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/view-state.test.js`
Expected: FAIL — cannot find module `../src/framework/view-state.js`.

- [ ] **Step 3: Implement the module**

Create `src/framework/view-state.js`:

```js
// Persist a little viewer UI state across browser reloads (notably Vite dev
// auto-refresh) in localStorage. All keys are global. Reads/writes are guarded:
// if localStorage is unavailable (private mode, disabled) or a value is corrupt,
// reads return the documented default and writes are no-ops — persistence never
// throws. Theme is persisted separately (in mount.js) and is not handled here.

const KEY = {
  rotating: "partforge:rotating",
  camera: "partforge:camera",
  view: "partforge:view",
};

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable — no-op */ }
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

export function loadRotating() {
  const raw = read(KEY.rotating);
  if (raw === "false") return false;
  if (raw === "true") return true;
  return true; // default: auto-rotate on (matches the viewer's default)
}

export function saveRotating(on) {
  write(KEY.rotating, on ? "true" : "false");
}

export function loadCamera() {
  const raw = read(KEY.camera);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed && isVec3(parsed.pos) && isVec3(parsed.target)) {
    return { pos: parsed.pos, target: parsed.target };
  }
  return null;
}

export function saveCamera(state) {
  if (!state || !isVec3(state.pos) || !isVec3(state.target)) return;
  write(KEY.camera, JSON.stringify({ pos: state.pos, target: state.target }));
}

export function loadView() {
  return read(KEY.view); // raw string or null; caller validates against available tabs
}

export function saveView(name) {
  if (typeof name === "string" && name) write(KEY.view, name);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/view-state.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `nvm use && npx vitest run`
Expected: PASS. (One pre-existing intermittent failure may appear in `test/cli-occt.test.js` under parallel run — a `render/` directory race unrelated to this work; it passes in isolation. If it appears, confirm `test/view-state.test.js` passes alone and proceed.)

- [ ] **Step 6: Commit**

```bash
git add src/framework/view-state.js test/view-state.test.js
git commit -m "feat: add view-state localStorage persistence module"
```

---

## Task 2: Wire persistence into the viewer and mount

Add camera accessors to `viewer.js`, then restore-on-load and save-on-change in `mount.js`. This is integration (three.js + DOM), verified by the unchanged unit suite, the app smoke check, and a manual checklist (browser behavior is not unit-testable in this repo — there is no jsdom/WebGL harness).

**Files:**
- Modify: `src/framework/viewer.js` (add accessors; extend the returned object — currently line 215)
- Modify: `src/framework/mount.js` (import; initial-view block ~45-47; `showView` ~63-67; pause/view handlers ~182-231)

**Interfaces:**
- Consumes (from Task 1): `loadRotating`, `saveRotating`, `loadCamera`, `saveCamera`, `loadView`, `saveView`.
- Produces (on the `createViewer` return object):
  - `getCameraState() => { pos:[x,y,z], target:[x,y,z] }`
  - `setCameraState({ pos:[x,y,z], target:[x,y,z] }) => void`
  - `onCameraEnd(cb: () => void) => void` (registers `cb` on the OrbitControls `end` event)

- [ ] **Step 1: Add the camera accessors to `viewer.js`**

In `src/framework/viewer.js`, just before the `dispose` function (currently around line 208, `// --- dispose ---`), add:

```js
  // --- camera state (read/write for persistence; mount.js owns storage) -------
  function getCameraState() {
    return {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
    };
  }
  function setCameraState({ pos, target }) {
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
  }
  function onCameraEnd(cb) { controls.addEventListener("end", cb); }
```

Then extend the returned object. The current last line is:

```js
  return { showAssembly, hideAssembly, setSubGeometry, resize, dispose, frame, setAutoRotate, setTheme, _subCache: subCache };
```

Change it to:

```js
  return { showAssembly, hideAssembly, setSubGeometry, resize, dispose, frame, setAutoRotate, setTheme, getCameraState, setCameraState, onCameraEnd, _subCache: subCache };
```

- [ ] **Step 2: Import the persistence module in `mount.js`**

In `src/framework/mount.js`, near the existing imports (after `import { createViewer } from "./viewer.js";`), add:

```js
import { loadRotating, saveRotating, loadCamera, saveCamera, loadView, saveView } from "./view-state.js";
```

- [ ] **Step 3: Restore the active view tab on load**

Replace the current initial-view line (mount.js:46):

```js
  let view = partSeg.querySelector("button.on")?.dataset.part ?? partSeg.querySelector("button")?.dataset.part;
```

with (validates the saved name against the actual buttons — no selector injection — and reflects it in the segmented control):

```js
  const defaultView = partSeg.querySelector("button.on")?.dataset.part ?? partSeg.querySelector("button")?.dataset.part;
  const savedView = loadView();
  const savedBtn = savedView ? [...partSeg.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === savedView) : null;
  let view = savedBtn ? savedView : defaultView;
  if (savedBtn) for (const b of partSeg.children) b.classList.toggle("on", b === savedBtn);
```

- [ ] **Step 4: Restore the camera once, on the first framed show**

Add a guard next to `framedView` (mount.js:47). The current line:

```js
  let framedView = null; // the view the camera was last framed to (null until first show)
```

becomes:

```js
  let framedView = null; // the view the camera was last framed to (null until first show)
  let cameraRestored = false; // saved camera applied once, on the first frame after load
```

Then update `showView` (mount.js:63-67). Current:

```js
  function showView(needed) {
    const frame = view !== framedView;
    viewer.showAssembly(needed, { frame });
    if (frame) framedView = view;
  }
```

becomes (after the first auto-frame, override it with the saved camera if any; only once, so tab switches keep re-framing):

```js
  function showView(needed) {
    const frame = view !== framedView;
    viewer.showAssembly(needed, { frame });
    if (frame) {
      framedView = view;
      if (!cameraRestored) {
        const cam = loadCamera();
        if (cam) viewer.setCameraState(cam);
        cameraRestored = true;
      }
    }
  }
```

- [ ] **Step 5: Restore + save play/pause; save the view on tab switch**

Replace the pause init line (mount.js:225):

```js
  let rotating = true;
```

with (initialize from storage and reflect it in the viewer + button):

```js
  let rotating = loadRotating();
  viewer.setAutoRotate(rotating);
  if (pauseBtn) {
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
  }
```

Update the pause click handler (mount.js:226-231). Current:

```js
  pauseBtn?.addEventListener("click", () => {
    rotating = !rotating;
    viewer.setAutoRotate(rotating);
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
  });
```

becomes (persist the new state):

```js
  pauseBtn?.addEventListener("click", () => {
    rotating = !rotating;
    viewer.setAutoRotate(rotating);
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
    saveRotating(rotating);
  });
```

Update the view-tab click handler (mount.js:182-189). Current:

```js
  partSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    for (const b of partSeg.children) b.classList.toggle("on", b === btn);
    refreshView();  // instant if the view's parts are cached + current
    maybeGenerate(); // else auto-build the missing pieces
  });
```

becomes (persist the active view):

```js
  partSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(view);
    for (const b of partSeg.children) b.classList.toggle("on", b === btn);
    refreshView();  // instant if the view's parts are cached + current
    maybeGenerate(); // else auto-build the missing pieces
  });
```

- [ ] **Step 6: Save the camera on interaction-end and before unload**

At the end of `mount.js`, just before the closing brace of the `mount` function (after the reframe-button handler, currently mount.js:234), add:

```js
  // Persist the camera when the user finishes an orbit/zoom, and right before a
  // reload (captures the latest pose, including auto-rotation drift).
  viewer.onCameraEnd(() => saveCamera(viewer.getCameraState()));
  window.addEventListener("pagehide", () => saveCamera(viewer.getCameraState()));
```

- [ ] **Step 7: Run the full unit suite (no regressions, imports resolve)**

Run: `nvm use && npx vitest run`
Expected: PASS. (The pre-existing `cli-occt.test.js` parallel-run flake may appear; it is unrelated — confirm it passes in isolation with `npx vitest run test/cli-occt.test.js` and proceed.)

- [ ] **Step 8: Smoke-check that the app still boots (best effort)**

If Playwright + Chromium are installed (`npm i -D playwright && npx playwright install chromium`), run:

Run: `nvm use && node scripts/check-app.mjs demo.html`
Expected: the app loads and the kernel boots with **no console errors** — this exercises the new `mount.js` load path (view/rotating/camera restore) end-to-end. If Playwright/Chromium are not installed in this environment, skip this step and note it in the report; Step 9 (manual) is the authoritative behavior gate.

- [ ] **Step 9: Manual verification (authoritative behavior check)**

Run the dev server and verify persistence by hand:

```bash
nvm use && npm run dev
```

Then in the browser at the dev URL (e.g. `http://localhost:5173/demo.html`), confirm each:
1. **Play/pause:** click pause (rotation stops, button shows ▶). Reload the page → rotation is still paused and the button still shows ▶.
2. **Camera:** orbit/zoom to a distinct angle. Reload → the same angle is restored (not the default frame).
3. **View tab** (use a multi-view page, e.g. `filleted-box.html` if it has multiple tabs, otherwise `demo.html`): switch to a non-default tab. Reload → that tab is active and selected in the segmented control.
4. **Tab switch still reframes:** with a saved camera in place, click a different tab → the camera re-frames to that view (does NOT stay at the saved angle). Switch back → reframes again.
5. **Theme unaffected:** toggle light/dark, reload → theme persists exactly as before (regression check).
6. **Private-mode safety (optional):** open a private window where `localStorage` may be restricted → the app still loads and works (no console errors), just without persistence.

Record the results of steps 1-6 in the report.

- [ ] **Step 10: Commit**

```bash
git add src/framework/viewer.js src/framework/mount.js
git commit -m "feat: persist play/pause, camera, and active tab across reloads"
```

---

## Self-review notes

- **Spec coverage:** `view-state.js` module + tests (Task 1); camera accessors (Task 2 Step 1); import (Step 2); tab restore (Step 3); camera restore-once guard (Step 4); rotating restore + save, view save (Step 5); camera save on end + pagehide (Step 6); theme left untouched (not modified anywhere); testing split unit + smoke + manual (Steps 7-9). All spec sections covered.
- **Type consistency:** `getCameraState`/`setCameraState` use `{ pos:[x,y,z], target:[x,y,z] }` everywhere (viewer accessors, `loadCamera`/`saveCamera`, the restore/save call sites). `loadCamera()` returns that shape or `null`; callers null-check. `loadView()` returns a raw string validated against buttons before use.
- **Interaction guard:** `cameraRestored` ensures the saved camera overrides only the first auto-frame; subsequent tab switches re-frame (satisfies "switching tabs should still re-frame").
- **Behavior gate honesty:** browser/three wiring has no unit harness in this repo; Step 8 (smoke) is best-effort and Step 9 (manual checklist) is the authoritative gate — stated explicitly, not hidden.
