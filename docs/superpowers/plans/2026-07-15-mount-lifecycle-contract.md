# Mount Lifecycle Contract (0.12.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `mount()` a real embedding contract — `elements` refs, container-based sizing, a returned `{ ready, dispose() }` runtime handle, `onBuild`, and `onPick` — released as partforge 0.12.0.

**Architecture:** Bottom-up: each framework submodule (`geometry-service`, `regen-loop`, `status-ui`, `view-tabs`, `viewer-controls`, `controls`, `pick-toggle`, `viewer`) first gains element-ref inputs and/or a teardown function in its own commit (keeping `mount.js` green with minimal call-site tweaks), then `mount.js` is restructured once to resolve element defaults, return the runtime handle, and wire `onBuild`/`onPick`. `mount.js` is the only caller of every changed module (verified by grep), so no other call sites exist.

**Tech Stack:** Plain-JS ESM, three.js, vitest (+ happy-dom for DOM tests via `// @vitest-environment happy-dom`), no TypeScript, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-mount-lifecycle-contract-design.md` (approved).

## Global Constraints

- Node ≥ 24 (`engines` field; use `nvm use` if needed).
- No new runtime dependencies.
- Every task ends with the FULL suite green: `npx vitest run` (30 s timeout is configured; WASM tests are slow — expect ~1–2 min).
- Backward compatibility: `mount(part, { createWorker })` with the legacy global-ID host page must keep working; `container`/`controls` remain as deprecated aliases.
- `elements` defaults (from the spec, verbatim): viewer `#app`, controls `#controls`, status `#status`/`#busy`/`#phase`, tabs `#part`, exports `#download`/`#download-step`/`#download-3mf`, chrome `#pause`/`#reframe`/`#theme`.
- `onPick` payload keys (verbatim): `{ selection, label, prompt, token }`; label precedence: `selection.feature?.label` → `part.parts[subPart]?.label` → `subPart`.
- Pick-mode precedence: `onPick` > `?pick` > `?pickserver`; hover labels always on.
- Version bumps to `0.12.0` only in the final task.
- Commit messages: `feat:`/`test:`/`docs:` prefixes, matching repo history.

---

### Task 1: `geometry-service.terminate()`

**Files:**
- Modify: `src/framework/geometry-service.js`
- Test: `test/geometry-service.test.js`

**Interfaces:**
- Produces: `createGeometryService(...)` now returns `{ send(msg, backend?), terminate() }`. `terminate()` calls `.terminate()` on both workers. Task 9's `mount.dispose()` consumes this.

- [ ] **Step 1: Write the failing test** — append to `test/geometry-service.test.js` (note: the existing `fakeWorkers()` helper's workers lack `terminate`; extend the helper):

```js
test("terminate() terminates both workers", () => {
  const terminated = [];
  const createWorker = (name) => ({
    postMessage: () => {},
    onmessage: null,
    terminate: () => terminated.push(name),
  });
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.terminate();
  expect(terminated.sort()).toEqual(["manifold", "occt"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/geometry-service.test.js`
Expected: FAIL — `s.terminate is not a function`

- [ ] **Step 3: Implement** — in `src/framework/geometry-service.js`, change the return:

```js
  return {
    send: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    terminate: () => { workers.manifold.terminate(); workers.occt.terminate(); },
  };
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run test/geometry-service.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry-service.js test/geometry-service.test.js
git commit -m "feat: geometry-service terminate() for mount dispose"
```

---

### Task 2: `regen-loop.dispose()`

**Files:**
- Modify: `src/framework/regen-loop.js`
- Test: `test/framework/regen-loop.test.js`

**Interfaces:**
- Produces: the loop object gains `dispose()` — clears the debounce timer and gates `kick()`/`ready()` off permanently. Task 9's `mount.dispose()` consumes this.

- [ ] **Step 1: Write the failing tests** — append to `test/framework/regen-loop.test.js` (it already has `makeLoop()` + fake timers in `beforeEach`):

```js
test("dispose() cancels a pending debounced kick", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  send.mockClear();
  loop.buildDone();
  loop.markDirty();       // queues a debounced kick
  loop.dispose();
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
});

test("after dispose(), ready() and kick() send nothing", () => {
  const { loop, send } = makeLoop();
  loop.dispose();
  loop.ready();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/regen-loop.test.js`
Expected: FAIL — `loop.dispose is not a function`

- [ ] **Step 3: Implement** — in `src/framework/regen-loop.js`, add a `disposed` flag and the method:

```js
export function createRegenLoop({ missingParts, send, debounceMs = 180 }) {
  let kernelReady = false;
  let generating = false;
  let disposed = false;
  let paramsVersion = 0; // bumped on every settings edit
  let genVersion = -1;   // the params version the in-flight build is building
  let timer = null;

  function kick() {
    if (disposed || !kernelReady || generating) return; // re-kicked when the current build finishes
    const missing = missingParts();
    if (missing.length === 0) return;
    generating = true;
    genVersion = paramsVersion;
    send(missing);
  }

  return {
    kick,
    ready() { if (disposed) return; kernelReady = true; kick(); },
    markDirty() {
      paramsVersion++;
      clearTimeout(timer);
      timer = setTimeout(kick, debounceMs);
    },
    // The build finished (meshes / needs-occt / error). Returns whether its result
    // is still current; the caller applies the meshes only on true, then kicks.
    buildDone() {
      generating = false;
      return genVersion === paramsVersion;
    },
    version: () => paramsVersion,
    // Terminal: cancel the pending debounce and refuse all future sends.
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/framework/regen-loop.test.js`
Expected: PASS (all tests, including the pre-existing invariants)

- [ ] **Step 5: Commit**

```bash
git add src/framework/regen-loop.js test/framework/regen-loop.test.js
git commit -m "feat: regen-loop dispose() cancels pending builds"
```

---

### Task 3: `status-ui` takes element refs

**Files:**
- Modify: `src/framework/status-ui.js`
- Modify: `src/framework/mount.js:32` (call-site only, keeps the app green)
- Test: `test/framework/status-ui.test.js` (rewrite call sites)

**Interfaces:**
- Produces: `createStatusUi({ status, busy, phase, exports = [] })` — element refs, no document queries. `exports` is an array of buttons; falsy entries are skipped. Return shape unchanged: `{ setStatus, showBusy, hideBusy, setExportEnabled, statusText }`.
- Consumes: nothing new.

- [ ] **Step 1: Rewrite the tests to pass refs** — replace the whole of `test/framework/status-ui.test.js`:

```js
// @vitest-environment happy-dom
// The status/busy/export-button chrome adapter. Element refs in, no document queries.
import { beforeEach, expect, test } from "vitest";
import { createStatusUi } from "../../src/framework/status-ui.js";

let els;
beforeEach(() => {
  document.body.innerHTML = `
    <div id="status"></div>
    <div id="busy"><div id="phase"></div></div>
    <button id="download"></button>
    <button id="download-step"></button>
    <button id="download-3mf"></button>`;
  els = {
    status: document.getElementById("status"),
    busy: document.getElementById("busy"),
    phase: document.getElementById("phase"),
    exports: ["download", "download-step", "download-3mf"].map((id) => document.getElementById(id)),
  };
});

test("setStatus writes the message and toggles the error class", () => {
  const ui = createStatusUi(els);
  ui.setStatus("928 triangles");
  expect(els.status.textContent).toBe("928 triangles");
  expect(els.status.classList.contains("err")).toBe(false);
  ui.setStatus("failed: boom", true);
  expect(els.status.classList.contains("err")).toBe(true);
  ui.setStatus("ok again");
  expect(els.status.classList.contains("err")).toBe(false);
});

test("showBusy shows the overlay with the phase; hideBusy hides it", () => {
  const ui = createStatusUi(els);
  ui.showBusy("generating");
  expect(els.phase.textContent).toBe("generating…");
  expect(els.busy.classList.contains("show")).toBe(true);
  ui.hideBusy();
  expect(els.busy.classList.contains("show")).toBe(false);
});

test("setExportEnabled toggles disabled on every export button", () => {
  const ui = createStatusUi(els);
  ui.setExportEnabled(true);
  for (const b of els.exports) expect(b.disabled).toBe(false);
  ui.setExportEnabled(false);
  for (const b of els.exports) expect(b.disabled).toBe(true);
});

test("missing (null) export buttons are skipped", () => {
  els.exports[2] = null; // page without the optional 3MF button
  const ui = createStatusUi(els);
  ui.setExportEnabled(true);
  expect(els.exports[0].disabled).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/status-ui.test.js`
Expected: FAIL — destructuring/undefined errors against the old `(doc = document)` signature

- [ ] **Step 3: Implement** — replace the whole of `src/framework/status-ui.js`:

```js
// The status line, busy overlay, and export-button enabling — mount's host-page
// chrome, as one small adapter. Element refs in (mount resolves defaults); no
// document queries here. status/busy/phase are required; export buttons are an
// array and any falsy entries are simply skipped.
export function createStatusUi({ status, busy, phase, exports = [] }) {
  const exportBtns = exports.filter(Boolean);

  return {
    setStatus(msg, isErr = false) { status.textContent = msg; status.classList.toggle("err", isErr); },
    showBusy(p) { phase.textContent = `${p}…`; busy.classList.add("show"); },
    hideBusy() { busy.classList.remove("show"); },
    setExportEnabled(on) { exportBtns.forEach((b) => { b.disabled = !on; }); },
    statusText: () => status.textContent,
  };
}
```

- [ ] **Step 4: Update the call site** — in `src/framework/mount.js`, replace line 32 (`const ui = createStatusUi();`) with:

```js
  const ui = createStatusUi({
    status: document.getElementById("status"),
    busy: document.getElementById("busy"),
    phase: document.getElementById("phase"),
    exports: ["download", "download-step", "download-3mf"].map((id) => document.getElementById(id)),
  });
```

(Temporary — Task 9 moves this lookup into the shared `elements` resolution.)

- [ ] **Step 5: Run the FULL suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/status-ui.js src/framework/mount.js test/framework/status-ui.test.js
git commit -m "feat: status-ui takes element refs instead of querying the document"
```

---

### Task 4: `view-tabs.detach()`

**Files:**
- Modify: `src/framework/view-tabs.js`
- Test: `test/framework/view-tabs.test.js`

**Interfaces:**
- Produces: `createViewTabs(el, part, { onChange })` return gains `detach()` — removes the click listener and, when the buttons were generated from `part.views`, empties the host element (host-owned elements are emptied, not removed). Return shape: `{ current, detach }`.

- [ ] **Step 1: Write the failing tests** — append to `test/framework/view-tabs.test.js` (fixtures `part`/`el` already exist):

```js
test("detach() stops click handling and empties generated buttons", () => {
  const onChange = vi.fn();
  const tabs = createViewTabs(el, part, { onChange });
  tabs.detach();
  expect(el.children.length).toBe(0);
  el.innerHTML = '<button data-part="drum"></button>'; // even a re-added button is inert
  el.querySelector("button").click();
  expect(onChange).not.toHaveBeenCalled();
});

test("detach() leaves hand-written buttons in place for a part without views", () => {
  el.innerHTML = '<button data-part="only" class="on">Only</button>';
  const tabs = createViewTabs(el, { views: undefined }, { onChange: () => {} });
  tabs.detach();
  expect(el.querySelector("button")).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/view-tabs.test.js`
Expected: FAIL — `tabs.detach is not a function`

- [ ] **Step 3: Implement** — in `src/framework/view-tabs.js`: capture a `generated` flag, name the click handler, and return `detach`:

```js
export function createViewTabs(el, part, { onChange }) {
  const generated = !!(el && part.views);
  if (generated) {
    el.innerHTML = Object.entries(part.views)
      .map(([key, v], i) => `<button data-part="${key}"${i === 0 ? ' class="on"' : ""}>${v?.label ?? key}</button>`)
      .join("");
  }

  const setActive = (btn) => { for (const b of el.children) b.classList.toggle("on", b === btn); };

  // Initial view: the saved one if it still matches a tab, else the active (first) tab.
  const defaultView = el.querySelector("button.on")?.dataset.part ?? el.querySelector("button")?.dataset.part;
  const saved = loadView();
  const savedBtn = saved ? [...el.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === saved) : null;
  let view = savedBtn ? saved : defaultView;
  if (savedBtn) setActive(savedBtn);

  const onClick = (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(view);
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

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/framework/view-tabs.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/view-tabs.js test/framework/view-tabs.test.js
git commit -m "feat: view-tabs detach() for mount dispose"
```

---

### Task 5: `viewer-controls` element refs + `detach()`

**Files:**
- Modify: `src/framework/viewer-controls.js`
- Modify: `src/framework/mount.js:234` (call-site only)
- Create: `test/framework/viewer-controls.test.js`

**Interfaces:**
- Produces: `attachViewerControls(viewer, { pause, reframe, theme } = {})` — element refs (all optional), returns `{ detach }`. `detach()` removes the three button listeners and the window `pagehide` listener.
- Consumes: `viewer.setTheme / setAutoRotate / frame / onCameraEnd / getCameraState` (unchanged viewer API).

- [ ] **Step 1: Write the failing tests** — create `test/framework/viewer-controls.test.js`:

```js
// @vitest-environment happy-dom
// The optional viewer-chrome buttons (pause / reframe / theme), now taking element
// refs and returning a detach() for mount dispose.
import { beforeEach, expect, test, vi } from "vitest";
import { attachViewerControls } from "../../src/framework/viewer-controls.js";

function fakeViewer() {
  return {
    setTheme: vi.fn(),
    setAutoRotate: vi.fn(),
    frame: vi.fn(),
    onCameraEnd: vi.fn(),
    getCameraState: vi.fn(() => ({ pos: [1, 2, 3], target: [0, 0, 0] })),
  };
}

let els;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<button id="pause"></button><button id="reframe"></button><button id="theme"></button>';
  els = {
    pause: document.getElementById("pause"),
    reframe: document.getElementById("reframe"),
    theme: document.getElementById("theme"),
  };
});

test("theme button toggles the page theme and the scene", () => {
  const viewer = fakeViewer();
  attachViewerControls(viewer, els);
  expect(viewer.setTheme).toHaveBeenCalledWith("dark"); // initial apply (default theme)
  els.theme.click();
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(viewer.setTheme).toHaveBeenLastCalledWith("light");
});

test("reframe button re-fits the camera", () => {
  const viewer = fakeViewer();
  attachViewerControls(viewer, els);
  els.reframe.click();
  expect(viewer.frame).toHaveBeenCalledTimes(1);
});

test("missing buttons are a no-op", () => {
  const viewer = fakeViewer();
  expect(() => attachViewerControls(viewer, {})).not.toThrow();
});

test("detach() removes button and pagehide listeners", () => {
  const viewer = fakeViewer();
  const chrome = attachViewerControls(viewer, els);
  chrome.detach();
  els.reframe.click();
  expect(viewer.frame).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem("partforge:camera")).toBeNull(); // camera not saved after detach
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/viewer-controls.test.js`
Expected: FAIL — buttons found via IDs are ignored under the old signature and `chrome.detach` is undefined (the old function returns nothing)

- [ ] **Step 3: Implement** — replace the whole of `src/framework/viewer-controls.js`:

```js
import { loadRotating, saveRotating, saveCamera, loadTheme, saveTheme } from "./view-state.js";

// Wire the optional viewer-chrome buttons (pause / reframe / theme) to the viewer,
// plus persist the camera pose. Element refs in (mount resolves defaults); each
// button is optional — pass nothing and its behavior is simply absent. Returns
// { detach } removing every listener this attached.
export function attachViewerControls(viewer, { pause: pauseBtn, reframe: reframeBtn, theme: themeBtn } = {}) {
  // Theme: toggle the page chrome (CSS vars keyed off <html data-theme>) and the
  // scene together; remember the choice across reloads.
  let theme = loadTheme();
  function applyTheme(mode) {
    theme = mode;
    document.documentElement.dataset.theme = mode;
    viewer.setTheme(mode);
    themeBtn?.classList.toggle("on", mode === "light");
    saveTheme(mode);
  }
  applyTheme(theme);
  const onThemeClick = () => applyTheme(theme === "light" ? "dark" : "light");
  themeBtn?.addEventListener("click", onThemeClick);

  // Pause/resume the idle auto-rotation.
  let rotating = loadRotating();
  viewer.setAutoRotate(rotating);
  const syncPause = () => {
    if (!pauseBtn) return;
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
  };
  syncPause();
  const onPauseClick = () => {
    rotating = !rotating;
    viewer.setAutoRotate(rotating);
    syncPause();
    saveRotating(rotating);
  };
  pauseBtn?.addEventListener("click", onPauseClick);

  // Re-fit the camera to the current view.
  const onReframeClick = () => viewer.frame();
  reframeBtn?.addEventListener("click", onReframeClick);

  // Persist the camera when the user finishes an orbit/zoom, and right before a
  // reload (captures the latest pose, including auto-rotation drift).
  viewer.onCameraEnd(() => saveCamera(viewer.getCameraState()));
  const onPageHide = () => saveCamera(viewer.getCameraState());
  window.addEventListener("pagehide", onPageHide);

  return {
    detach: () => {
      themeBtn?.removeEventListener("click", onThemeClick);
      pauseBtn?.removeEventListener("click", onPauseClick);
      reframeBtn?.removeEventListener("click", onReframeClick);
      window.removeEventListener("pagehide", onPageHide);
      // the onCameraEnd listener lives on the OrbitControls object, which
      // viewer.dispose() destroys — nothing to remove here
    },
  };
}
```

- [ ] **Step 4: Update the call site** — in `src/framework/mount.js`, replace line 234 (`attachViewerControls(viewer);`) with:

```js
  attachViewerControls(viewer, {
    pause: document.getElementById("pause"),
    reframe: document.getElementById("reframe"),
    theme: document.getElementById("theme"),
  });
```

(Temporary — Task 9 moves this into the shared `elements` resolution and keeps the handle for dispose.)

- [ ] **Step 5: Run the FULL suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/viewer-controls.js src/framework/mount.js test/framework/viewer-controls.test.js
git commit -m "feat: viewer-controls take element refs and return detach()"
```

---

### Task 6: `controls.js` — per-panel info popover + `dispose()`

**Files:**
- Modify: `src/framework/controls.js`
- Test: `test/framework/controls.test.js`

**Interfaces:**
- Produces: `buildControls(root, parameters, params, onDirty)` returns `{ applyRelevance, dispose }`. `dispose()` removes the panel's popover element, its document-level `click`/`keydown` listeners, and empties `root`. The popover becomes per-panel state (created in `buildControls`) instead of a module-level singleton with listeners registered at import time.
- Consumes: nothing new. `applyRelevance` is unchanged.

- [ ] **Step 1: Write the failing tests** — append to `test/framework/controls.test.js` (the file already imports `buildControls` and has a `buildPanel` helper around line 136; add these as standalone tests using a local root):

```js
test("info glyph toggles a popover; dispose removes it and its listeners", () => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  const panel = buildControls(
    root,
    [{ id: "b", title: "Body", description: "About the body",
       advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    { od: 5 },
    () => {},
  );

  const glyph = root.querySelector("button.info");
  glyph.click();
  const pop = document.body.querySelector(".popover");
  expect(pop.hidden).toBe(false);
  expect(glyph.getAttribute("aria-expanded")).toBe("true");

  glyph.click(); // toggle off
  expect(pop.hidden).toBe(true);

  panel.dispose();
  expect(document.body.querySelector(".popover")).toBeNull();
  expect(root.children.length).toBe(0);
});

test("Escape closes the popover; after dispose the document listener is gone", () => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  const panel = buildControls(
    root,
    [{ id: "b", title: "Body", description: "About the body",
       advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    { od: 5 },
    () => {},
  );
  root.querySelector("button.info").click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.body.querySelector(".popover").hidden).toBe(true);
  panel.dispose();
  // no popover left to act on — dispatching again must not throw or recreate one
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.body.querySelector(".popover")).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/controls.test.js`
Expected: FAIL — `panel.dispose is not a function` (and possibly popover asserts, since the old singleton popover isn't per-panel)

- [ ] **Step 3: Implement** — in `src/framework/controls.js`:

3a. DELETE the module-level popover block (current lines 50–74: `let popover`, `ensurePopover()`, `closePopover()`, and the `if (typeof document !== "undefined")` listener registration).

3b. ADD a per-panel factory in its place:

```js
// --- info glyph + per-panel popover -----------------------------------------
// One popover element per panel, shared by all its glyphs (only one open at a
// time). Document-level dismiss listeners are registered per panel and removed
// by panel.dispose().
function createInfoPopover() {
  const pop = el("div", "popover");
  pop.hidden = true;
  document.body.append(pop);
  let owner = null; // the glyph whose description is showing

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    if (owner) { owner.setAttribute("aria-expanded", "false"); owner = null; }
  }
  const onDocClick = (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.(".info")) close();
  };
  const onDocKeydown = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);

  return {
    toggle(glyph, description) {
      if (owner === glyph) { close(); return; } // toggle off
      close();
      pop.innerHTML = renderMarkdown(description);
      pop.hidden = false;
      owner = glyph;
      glyph.setAttribute("aria-expanded", "true");
      const r = glyph.getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.left = `${Math.max(8, r.left - 8)}px`;
    },
    dispose() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKeydown);
      pop.remove();
    },
  };
}
```

3c. Change `attachInfo` to take the popover instance (replacing its old body's `ensurePopover`/`closePopover` usage):

```js
// Append a focusable ⓘ glyph to `container` that toggles the panel's shared
// popover with `description` (Markdown). No-op when description is empty.
function attachInfo(container, description, info) {
  if (typeof description !== "string" || !description.trim()) return;
  const glyph = document.createElement("button");
  glyph.type = "button";
  glyph.className = "info";
  glyph.textContent = "ⓘ";
  glyph.setAttribute("aria-label", "More info");
  glyph.setAttribute("aria-expanded", "false");
  glyph.addEventListener("click", (e) => { e.stopPropagation(); info.toggle(glyph, description); });
  container.append(glyph);
}
```

3d. Thread `info` through the builders — signature changes only, logic untouched:
- `buildControls`: create `const info = createInfoPopover();` first; pass `info` to `attachInfo(title, sec.description, info)` and to both section builders; return `{ applyRelevance: ..., dispose: () => { info.dispose(); root.replaceChildren(); } }`.
- `buildPresetSection(section, sec, params, onDirty, register, info)` and `buildFeatureSection(section, sec, params, onDirty, register, info)`: accept and forward `info` to their `makeSlider`/`attachInfo` calls.
- `makeSlider(def, params, onChange, info)`: forward to `attachInfo(label, def.description, info)`.

The updated `buildControls`:

```js
export function buildControls(root, parameters, params, onDirty) {
  const info = createInfoPopover();
  const controls = []; // { key, el } per control element
  const sections = []; // { el, keys:Set } per rendered section
  for (const sec of parameters) {
    if (!sectionRenders(sec)) continue;
    const section = el("div", "section");
    const title = el("div", "sec-title", sec.title);
    attachInfo(title, sec.description, info);
    section.append(title);
    const keys = new Set();
    const register = (key, node) => { controls.push({ key, el: node }); keys.add(key); };
    if (sec.features) buildFeatureSection(section, sec, params, onDirty, register, info);
    else buildPresetSection(section, sec, params, onDirty, register, info);
    root.append(section);
    sections.push({ el: section, keys });
  }
  return {
    applyRelevance: (relevant) => applyRelevance(relevant, controls, sections),
    dispose: () => { info.dispose(); root.replaceChildren(); },
  };
}
```

- [ ] **Step 4: Run the FULL suite** (controls is used indirectly by other tests)

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/controls.js test/framework/controls.test.js
git commit -m "feat: per-panel info popover with dispose() on buildControls"
```

---

### Task 7: `attachPickToggle` returns `detach()`

**Files:**
- Modify: `src/framework/selection/pick-toggle.js`
- Test: `test/selection-pick-toggle.test.js` (create)

**Interfaces:**
- Produces: `attachPickToggle(viewer, { part, getContext })` returns `{ detach }` — removes the Pick button, the toast, the click listener (via the inner picker's `detach`), and clears the toast timer. Task 10's `mount.dispose()` consumes this.

- [ ] **Step 1: Write the failing test** — create `test/selection-pick-toggle.test.js`:

```js
// @vitest-environment happy-dom
// The ?pick clipboard toggle: detach() must remove its DOM and click listener.
import { afterEach, expect, test, vi } from "vitest";
import { attachPickToggle } from "../src/framework/selection/pick-toggle.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeViewer() {
  const domElement = document.createElement("div");
  document.body.append(domElement);
  return { domElement, camera: {}, _subMeshes: {}, flashPoint: vi.fn() };
}

test("detach() removes the button, toast, and click listener", () => {
  const viewer = fakeViewer();
  const toggle = attachPickToggle(viewer, { part: { parts: {} }, getContext: () => ({}) });
  expect(document.getElementById("pf-pick")).not.toBeNull();
  expect(document.getElementById("pf-pick-toast")).not.toBeNull();
  toggle.detach();
  expect(document.getElementById("pf-pick")).toBeNull();
  expect(document.getElementById("pf-pick-toast")).toBeNull();
  // an armed-then-detached picker must not react to clicks (no raycast → no throw)
  expect(() => viewer.domElement.click()).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/selection-pick-toggle.test.js`
Expected: FAIL — `toggle.detach is not a function` (old function returns undefined)

- [ ] **Step 3: Implement** — in `src/framework/selection/pick-toggle.js`, add at the end of the function (after the existing `btn.addEventListener` line):

```js
  return {
    detach: () => {
      picker.detach();
      clearTimeout(hideTimer);
      btn.remove();
      toast.remove();
    },
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/selection-pick-toggle.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/pick-toggle.js test/selection-pick-toggle.test.js
git commit -m "feat: pick-toggle detach() for mount dispose"
```

---

### Task 8: `viewer.js` — container sizing + `dispose()`

**Files:**
- Modify: `src/framework/viewer.js`

No unit test: `createViewer` needs a real WebGL context, which happy-dom cannot provide (there is no existing viewer unit test for the same reason). Coverage: the mount tests in Tasks 9–10 mock this module and assert `dispose()` is *called*; the final task's manual smoke verifies sizing/teardown behavior for real. `#app { position: fixed; inset: 0 }` in `app.css` means the dev app's container already has full-window dimensions, so container-based sizing is not a visual change there.

**Interfaces:**
- Produces: the viewer handle gains `dispose()`. Sizing now reads `container.clientWidth/clientHeight` via a retained `ResizeObserver`; the window `resize` listener and `innerWidth`/`innerHeight` reads are gone.
- Consumes: nothing new.

- [ ] **Step 1: Replace window sizing with container sizing** — in `src/framework/viewer.js`:

Line 90, replace `lineMaterial.resolution.set(innerWidth, innerHeight);` with:

```js
  lineMaterial.resolution.set(1, 1); // real size set by resize() below
```

Lines 206–215 (`// --- resize ---` block), replace with:

```js
  // --- resize ---------------------------------------------------------------
  // Size from the host container (not the window) so embedders control the pane.
  function resize() {
    const w = container.clientWidth || 300, h = container.clientHeight || 150;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    lineMaterial.resolution.set(w, h); // fat lines need the viewport size for px width
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
```

- [ ] **Step 2: Track flashPoint timers** — replace the `flashPoint` function:

```js
  // Transient marker at a world-space point — visual confirmation of a pick.
  const flashTimers = new Set();
  function flashPoint(world) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false })
    );
    dot.renderOrder = 999;
    dot.position.set(world[0], world[1], world[2]);
    scene.add(dot);
    const t = setTimeout(() => {
      flashTimers.delete(t);
      scene.remove(dot); dot.geometry.dispose(); dot.material.dispose();
    }, 1200);
    flashTimers.add(t);
  }
```

- [ ] **Step 3: Add `dispose()`** — before the return statement:

```js
  // Full teardown: render loop, observers, controls, timers, GPU resources, DOM.
  // Idempotent. Cached sub-part geometries and their edge lines are freed; the
  // shared and per-part cloned materials tolerate double-dispose.
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    ro.disconnect();
    renderer.setAnimationLoop(null);
    controls.dispose();
    for (const t of flashTimers) clearTimeout(t);
    flashTimers.clear();
    for (const n of names) {
      const g = subCache[n];
      if (g) { g.userData.edges?.dispose(); g.dispose(); subCache[n] = null; }
      subMesh[n].material?.dispose();
      subMesh[n].geometry?.dispose(); // the initial empty BufferGeometry, if never replaced
    }
    material.dispose();
    lineMaterial.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
```

And add `dispose` to the returned object (extend the existing return line):

```js
  return { showAssembly, hideAssembly, setSubGeometry, hasSubMesh, subTriangles, frame, setAutoRotate, setTheme, getCameraState, setCameraState, onCameraEnd, camera, domElement: renderer.domElement, _subMeshes: subMesh, flashPoint, dispose };
```

- [ ] **Step 4: Run the FULL suite** (nothing imports the viewer in tests, but confirm no syntax/regression)

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Quick visual check** — `npm run dev`, open the dev part page: canvas fills the window, orbit works, resizing the window resizes the canvas (now via ResizeObserver). Ctrl-C afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/framework/viewer.js
git commit -m "feat: viewer sizes from its container and exposes dispose()"
```

---

### Task 9: `mount()` contract — elements, runtime handle, `ready`, `onBuild`

**Files:**
- Modify: `src/framework/mount.js` (full restructure — complete file below)
- Modify: `src/framework/debug-overlay.js` (add `detach`)
- Create: `test/framework/mount.test.js`

**Interfaces:**
- Consumes: everything Tasks 1–8 produced: `service.terminate()`, `loop.dispose()`, `createStatusUi(refs)`, `tabs.detach()`, `attachViewerControls(viewer, refs) → { detach }`, `panel.dispose()`, `attachPickToggle → { detach }`, `viewer.dispose()`.
- Produces: `mount(part, { createWorker, elements, onBuild, onPick, container, controls })` returns `{ ready, dispose }`. This task lands elements + ready + onBuild + dispose; Task 10 adds `onPick` (the full file below already includes it — Task 10 only adds its tests).

- [ ] **Step 1: Write the failing tests** — create `test/framework/mount.test.js`:

```js
// @vitest-environment happy-dom
// The mount() embedding contract: element refs, { ready, dispose }, onBuild, onPick.
// The viewer and selection adapters are mocked (WebGL + raycasting are browser-only);
// everything else — status-ui, view-tabs, controls, regen-loop, mesh-cache,
// geometry-service — runs for real against fake workers.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fakeViewers = [];
vi.mock("../../src/framework/viewer.js", () => ({
  createViewer: vi.fn(() => {
    const built = new Set();
    const v = {
      domElement: document.createElement("div"),
      showAssembly: vi.fn(),
      hideAssembly: vi.fn(),
      setSubGeometry: vi.fn((name) => built.add(name)),
      hasSubMesh: (name) => built.has(name),
      subTriangles: () => 0,
      frame: vi.fn(),
      setAutoRotate: vi.fn(),
      setTheme: vi.fn(),
      getCameraState: vi.fn(() => ({ pos: [0, 0, 0], target: [0, 0, 0] })),
      setCameraState: vi.fn(),
      onCameraEnd: vi.fn(),
      camera: {},
      _subMeshes: {},
      flashPoint: vi.fn(),
      dispose: vi.fn(),
    };
    fakeViewers.push(v);
    return v;
  }),
}));

vi.mock("../../src/framework/selection/index.js", async (importOriginal) => {
  const real = await importOriginal(); // keep formatSelection real — the prompt text matters
  return {
    ...real,
    attachHoverLabels: vi.fn(() => ({ detach: vi.fn() })),
    attachPickToggle: vi.fn(() => ({ detach: vi.fn() })),
    attachPicker: vi.fn(() => ({ setActive: vi.fn(), detach: vi.fn() })),
  };
});

vi.mock("../../src/framework/pick-request/index.js", () => ({
  createPickRequestClient: vi.fn(() => ({ detach: vi.fn() })),
}));

import { mount } from "../../src/framework/mount.js";
import { attachPicker, attachPickToggle, attachHoverLabels } from "../../src/framework/selection/index.js";

const makePart = () => ({
  meta: { title: "Test Part", backend: "manifold" }, // pinned backend: no probe run
  defaults: { h: 4 },
  views: { main: { label: "Main" } },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box?.(p.h, p.h, p.h) } },
  parameters: [{ id: "size", title: "Size",
    advanced: [{ key: "h", label: "Height", min: 1, max: 10, step: 1 }] }],
});

function makeWorkers() {
  const workers = {};
  const createWorker = (name) => {
    const w = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null };
    workers[name] = w;
    return w;
  };
  return { workers, createWorker };
}

function makeElements() {
  const mk = (tag = "div") => document.createElement(tag);
  const els = {
    viewer: mk(), controls: mk(),
    status: { status: mk(), busy: mk(), phase: mk() },
    tabs: mk(),
    exports: { stl: mk("button"), step: mk("button"), threeMf: mk("button") },
    chrome: { pause: mk("button"), reframe: mk("button"), theme: mk("button") },
  };
  document.body.append(els.viewer, els.controls, els.tabs,
    els.status.status, els.status.busy, els.status.phase,
    els.exports.stl, els.exports.step, els.exports.threeMf,
    els.chrome.pause, els.chrome.reframe, els.chrome.theme);
  return els;
}

// Drive the fake manifold worker: kernel ready, then one successful build.
function finishFirstBuild(workers, ms = 42) {
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms } });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  fakeViewers.length = 0;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

test("ready resolves after the first successful build; no getElementById with full refs", () => {
  const spy = vi.spyOn(document, "getElementById");
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  expect(spy).not.toHaveBeenCalled();
  finishFirstBuild(workers);
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("ready rejects when the first build errors", () => {
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements() });
  workers.manifold.onmessage({ data: { type: "ready" } });
  workers.manifold.onmessage({ data: { type: "error", message: "boom" } });
  return expect(runtime.ready).rejects.toThrow("boom");
});

test("legacy host page: default IDs still resolve (no elements option)", () => {
  document.body.innerHTML = `
    <div id="app"></div><div id="controls"></div>
    <div id="status"></div><div id="busy"><div id="phase"></div></div>
    <div id="part"></div>
    <button id="download"></button><button id="download-step"></button>`;
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker });
  finishFirstBuild(workers);
  expect(document.getElementById("status").textContent).toContain("triangles");
  return expect(runtime.ready).resolves.toBeUndefined();
});

test("onBuild reports success with ms, and error with the message", () => {
  const onBuild = vi.fn();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onBuild });
  finishFirstBuild(workers, 42);
  expect(onBuild).toHaveBeenCalledWith({ status: "success", ms: 42 });
  workers.manifold.onmessage({ data: { type: "error", message: "later failure" } });
  expect(onBuild).toHaveBeenCalledWith({ status: "error", error: "later failure" });
});

test("onBuild skips a stale build (param changed mid-flight)", () => {
  const onBuild = vi.fn();
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: els, onBuild });
  workers.manifold.onmessage({ data: { type: "ready" } }); // build 1 in flight
  // edit the Height param while the build is in flight → the result is stale
  const box = els.controls.querySelector("input.num");
  box.value = "7";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 9 } });
  expect(onBuild).not.toHaveBeenCalled(); // stale result discarded silently
  // the loop re-kicks; the redo build completes and reports
  workers.manifold.onmessage({ data: { type: "meshes", meshes: [{ name: "body" }], ms: 11 } });
  expect(onBuild).toHaveBeenCalledWith({ status: "success", ms: 11 });
});

test("dispose() tears everything down and is idempotent", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  runtime.dispose();
  runtime.dispose(); // idempotent
  expect(workers.manifold.terminate).toHaveBeenCalledTimes(1);
  expect(workers.occt.terminate).toHaveBeenCalledTimes(1);
  expect(fakeViewers[0].dispose).toHaveBeenCalledTimes(1);
  expect(attachHoverLabels.mock.results[0].value.detach).toHaveBeenCalled();
  expect(document.body.querySelector(".popover")).toBeNull(); // controls panel disposed
  expect(els.controls.children.length).toBe(0);               // host emptied, not removed
  expect(els.tabs.children.length).toBe(0);
  // export listeners removed: a click after dispose posts nothing
  workers.manifold.postMessage.mockClear();
  els.exports.stl.click();
  expect(workers.manifold.postMessage).not.toHaveBeenCalled();
});

test("deprecated container/controls aliases still work", () => {
  document.body.innerHTML = `
    <div id="status"></div><div id="busy"><div id="phase"></div></div><div id="part"></div>`;
  const viewerEl = document.createElement("div");
  const controlsEl = document.createElement("div");
  document.body.append(viewerEl, controlsEl);
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, container: viewerEl, controls: controlsEl });
  expect(controlsEl.querySelector("input.num")).not.toBeNull(); // panel built into the alias target
  finishFirstBuild(workers);
  return expect(runtime.ready).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/mount.test.js`
Expected: FAIL — `mount` returns undefined (`runtime.ready` of undefined), getElementById called, etc.

- [ ] **Step 3: Implement** — replace the whole of `src/framework/mount.js`:

```js
import "./app.css"; // shared chrome styles — every part-app gets them via mount
import { triggerDownload, downloadParts } from "./download.js";
import { createViewer } from "./viewer.js";
import { attachViewerControls } from "./viewer-controls.js";
import { loadCamera } from "./view-state.js";
import { buildControls } from "./controls.js";
import { relevantParamKeys } from "./param-deps.js";
import { createMeshCache } from "./mesh-cache.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./jobs.js";
import { resolveDerived } from "./derive.js";
import { detectBackend } from "./geometry/probe.js";
import { createDebugOverlay } from "./debug-overlay.js";
import { createRegenLoop } from "./regen-loop.js";
import { createStatusUi } from "./status-ui.js";
import { createViewTabs } from "./view-tabs.js";
import { attachPickToggle, attachHoverLabels, attachPicker, formatSelection } from "./selection/index.js";
import { createPickRequestClient } from "./pick-request/index.js";

// Mount a full parametric-part app from a PartDefinition. mount is WIRING: the
// pieces it composes each live (and are tested) in their own module — the viewer,
// the schema-driven control panel, the regenerate state machine (regen-loop.js),
// the view tabs (view-tabs.js), the status chrome (status-ui.js), the per-sub-part
// mesh-validity cache, and the geometry workers. The app supplies `createWorker(name)`
// so Vite can bundle the worker (see geometry-service.js).
//
// Embedding contract (0.12.0):
//   const runtime = mount(part, { createWorker, elements, onBuild, onPick });
//   await runtime.ready;   // first successful build of the default view
//   runtime.dispose();     // full teardown
// Every `elements` entry defaults to the legacy global-ID lookup (below), resolved
// exactly once here — submodules take element refs and never query the document.
// `container`/`controls` remain as deprecated aliases for elements.viewer/.controls.
export function mount(part, { createWorker, elements = {}, onBuild, onPick,
                              container: legacyContainer, controls: legacyControls } = {}) {
  // --- element resolution (the ONLY getElementById calls in the framework) ----
  const byId = (id) => document.getElementById(id);
  const els = {
    viewer: elements.viewer ?? legacyContainer ?? byId("app"),
    controls: elements.controls ?? legacyControls ?? byId("controls"),
    status: {
      status: elements.status?.status ?? byId("status"),
      busy: elements.status?.busy ?? byId("busy"),
      phase: elements.status?.phase ?? byId("phase"),
    },
    tabs: elements.tabs ?? byId("part"),
    exports: {
      stl: elements.exports?.stl ?? byId("download"),
      step: elements.exports?.step ?? byId("download-step"),
      threeMf: elements.exports?.threeMf ?? byId("download-3mf"),
    },
    chrome: {
      pause: elements.chrome?.pause ?? byId("pause"),
      reframe: elements.chrome?.reframe ?? byId("reframe"),
      theme: elements.chrome?.theme ?? byId("theme"),
    },
  };

  const viewer = createViewer(els.viewer, part);
  const hover = attachHoverLabels(viewer, { part }); // always-on hover inspection (no-op on touch-only devices)
  const ui = createStatusUi({ ...els.status, exports: [els.exports.stl, els.exports.step, els.exports.threeMf] });

  // ?backend=occt|manifold forces the backend; otherwise it's detected per part.
  let forcedBackend = new URLSearchParams(location.search).get("backend");
  if (forcedBackend !== "occt" && forcedBackend !== "manifold") forcedBackend = null;
  const backendFor = () => forcedBackend ?? detectBackend(part, params);

  // ?debug shows the cache debug overlay; ?debug&nocache starts with caching off.
  const qs = new URLSearchParams(location.search);
  const debug = qs.has("debug");
  let cachingOn = !(debug && qs.has("nocache"));
  let lastGen = { skipped: 0, rebuilt: 0 }; // Layer-1 counts for the most recent generate
  const dbg = debug
    ? createDebugOverlay({ initialCachingOn: cachingOn, onToggle: (on) => { cachingOn = on; forceRegen(); } })
    : null;

  // View tabs (generated from part.views) + live params. A tab switch shows the
  // cached assembly instantly if it's current, else auto-builds what's missing.
  const tabsCtl = createViewTabs(els.tabs, part, {
    onChange: () => { refreshView(); updateRelevance(); loop.kick(); },
  });
  const view = () => tabsCtl.current();
  const params = { ...part.defaults };

  // Current selection context for the pickers: the active view + live params +
  // derived values. Shared by every pick mode below.
  const getContext = () => {
    let derived = {};
    // A throwing derive must not crash the pick flow — proceed without derived context.
    try { derived = resolveDerived(part, { ...part.defaults, ...params }); } catch { /* derived stays {} */ }
    return { view: view(), params, derived };
  };

  // Click-to-select. Precedence (one click listener is ever live): the programmatic
  // onPick option, else the ?pick clipboard toggle, else the ?pickserver client.
  let picker = null;      // { setActive, detach } — armed permanently for onPick
  let pickToggle = null;  // { detach }
  let pickClient = null;  // { detach }
  if (onPick) {
    picker = attachPicker(viewer, {
      part, getContext,
      onPick: (selection) => onPick({
        selection,
        label: selection.feature?.label ?? part.parts[selection.subPart]?.label ?? selection.subPart,
        prompt: formatSelection(selection, { style: "prompt" }),
        token: formatSelection(selection, { style: "token" }),
      }),
    });
    picker.setActive(true);
  } else if (qs.has("pick")) {
    pickToggle = attachPickToggle(viewer, { part, getContext });
  } else if (qs.has("pickserver")) {
    // Agent-driven mode: arm the picker only when the local pick-server asks for a
    // click. `?pickserver` or `?pickserver=http://host:port`.
    const serverUrl = typeof qs.get("pickserver") === "string" && qs.get("pickserver")
      ? qs.get("pickserver") : "http://127.0.0.1:4518";
    pickClient = createPickRequestClient({ serverUrl, viewer, part, getContext });
  }

  let framedView = null; // the view the camera was last framed to (null until first show)
  let cameraRestored = false; // saved camera applied once, on the first frame after load

  // Per-sub-part cache-validity tracker (Layer 1): view/version/caching change over
  // time, so they're passed as getters; params is a stable in-place-mutated object.
  const cache = createMeshCache(part, viewer, {
    params,
    getView: view,
    getParamsVersion: () => loop.version(),
    isCaching: () => cachingOn,
  });
  const isCurrent = cache.isCurrent;
  const missingParts = () => viewSubParts(part, view(), params).filter((n) => !isCurrent(n));

  // The regenerate state machine (ready gating / debounce / stale-redo) lives in
  // regen-loop.js; this send callback is the one place a build job is dispatched.
  const loop = createRegenLoop({
    missingParts,
    send: (missing) => {
      const needed = viewSubParts(part, view(), params);
      lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length }; // for the overlay
      ui.showBusy("generating");
      service.send({ type: "generate", subparts: missing, view: view(), params, cache: cachingOn }, backendFor());
    },
  });

  // First-build readiness: resolves on the first accepted meshes result, rejects on
  // a first-build error. Guarded against unhandled rejection when never awaited.
  let readySettled = false;
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});

  // Reflect the active view. If every needed part is current, show it and enable
  // export. If stale (a regenerate is in flight), keep the old mesh visible so the
  // view doesn't flicker. If nothing's built yet, show nothing.
  // Show the assembly, framing the camera only the first time we show a given view
  // (initial load / tab switch) — never on a regenerate, so zoom/orbit are kept.
  function showView(needed) {
    const frame = view() !== framedView;
    viewer.showAssembly(needed, { frame });
    if (frame) {
      framedView = view();
      if (!cameraRestored) {
        const cam = loadCamera();
        if (cam) viewer.setCameraState(cam);
        cameraRestored = true;
      }
    }
  }

  function refreshView() {
    const needed = viewSubParts(part, view(), params);
    if (needed.every(isCurrent)) {
      showView(needed);
      ui.setExportEnabled(true);
      const tris = needed.reduce((s, n) => s + viewer.subTriangles(n), 0);
      ui.setStatus(`${tris.toLocaleString()} triangles`);
    } else if (needed.every((n) => viewer.hasSubMesh(n))) {
      showView(needed); // stale but present — keep it visible during regenerate
      ui.setExportEnabled(false);
    } else {
      viewer.hideAssembly();
      ui.setExportEnabled(false);
    }
  }

  ui.showBusy("booting kernel"); // visible from first paint until the kernel is ready

  // Bundle filename for a multi-part export (single parts download under their own name).
  const zipName = `${part.meta?.title ?? "parts"}.zip`.toLowerCase().replace(/\s+/g, "-");

  // --- shared message handler ------------------------------------------------
  function onWorkerMessage({ data }) {
    switch (data.type) {
      case "ready":
        loop.ready(); // auto-build the default view (keeps the busy spinner up)
        break;
      case "progress":
        ui.showBusy(data.phase);
        ui.setStatus(`${data.phase}…`);
        break;
      case "meshes": {
        if (loop.buildDone()) { // stale results (params changed mid-build) are discarded
          for (const m of data.meshes) {
            viewer.setSubGeometry(m.name, m); // disposes any previous mesh for this name
            cache.record(m.name);
          }
          ui.hideBusy();
          refreshView();
          if (data.ms && missingParts().length === 0) {
            ui.setStatus(`${ui.statusText()} · ${(data.ms / 1000).toFixed(1)} s`);
          }
          dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt });
          onBuild?.({ status: "success", ms: data.ms });
          if (!readySettled) { readySettled = true; resolveReady(); }
        }
        loop.kick(); // stale → rebuild; fresh → the view may still need parts (tab switched mid-build)
        break;
      }
      case "download-parts":
        ui.hideBusy();
        downloadParts(data, zipName);
        ui.setStatus(`${data.parts.length} part(s) downloaded`);
        break;
      case "download":
        ui.hideBusy();
        triggerDownload(data.data, data.filename, data.mime);
        ui.setStatus(`${data.filename} downloaded`);
        break;
      case "needs-occt":
        forcedBackend = "occt"; // probe missed; this part needs OCCT — stick to it
        loop.buildDone();
        loop.kick();
        break;
      case "error":
        loop.buildDone();
        ui.hideBusy();
        ui.setStatus(`failed: ${data.message}`, true);
        refreshView();
        onBuild?.({ status: "error", error: data.message });
        if (!readySettled) { readySettled = true; rejectReady(new Error(data.message)); }
        break;
    }
  }

  const service = createGeometryService({ createWorker, onMessage: onWorkerMessage });

  const panel = buildControls(els.controls, part.parameters, params, onParamChange);
  const updateRelevance = () => panel.applyRelevance(relevantParamKeys(part, view(), params));
  updateRelevance(); // initial view

  function onParamChange() {
    loop.markDirty(); // bump the version first: refreshView below must see the parts as stale
    refreshView();    // keep showing the now-stale mesh (no flicker); disable export
    updateRelevance();
  }

  // Re-run the active view under the current caching setting, so toggling the
  // ?debug switch updates the readout for the same design without a param change.
  function forceRegen() {
    for (const n of viewSubParts(part, view(), params)) cache.forget(n);
    refreshView();
    loop.kick();
  }

  const onStlClick = () => {
    ui.showBusy("exporting STL");
    service.send({ type: "export-stl", view: view(), params, quality: "print" }, backendFor());
  };
  els.exports.stl?.addEventListener("click", onStlClick);

  const onStepClick = () => {
    ui.showBusy("exporting STEP");
    service.send({ type: "export-step", view: view(), params }, "occt"); // STEP is always OCCT
  };
  els.exports.step?.addEventListener("click", onStepClick);

  const on3mfClick = () => {
    ui.showBusy("exporting 3MF");
    service.send({ type: "export-3mf", view: view(), params, quality: "print" }, backendFor());
  };
  els.exports.threeMf?.addEventListener("click", on3mfClick);

  // Optional host-page viewer chrome (pause / reframe / theme) + camera persistence.
  const chrome = attachViewerControls(viewer, els.chrome);

  // Full teardown of everything this mount created. Idempotent. A disposed runtime
  // can never surface a late build result (workers are terminated, the loop is
  // terminal), which is what makes cross-mount swap races safe for embedders.
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    picker?.detach();
    pickToggle?.detach();
    pickClient?.detach();
    hover.detach();
    loop.dispose();
    service.terminate();
    els.exports.stl?.removeEventListener("click", onStlClick);
    els.exports.step?.removeEventListener("click", onStepClick);
    els.exports.threeMf?.removeEventListener("click", on3mfClick);
    chrome.detach();
    tabsCtl.detach();
    panel.dispose();
    dbg?.detach();
    viewer.dispose();
  }

  return { ready, dispose };
}
```

Also add a minimal `detach` to `src/framework/debug-overlay.js` (it creates a `#pf-debug` node in `document.body`; the checkbox listener dies with the node) — extend its return object:

```js
  return {
    update({ ms, hits = 0, misses = 0, skipped = 0, rebuilt = 0 } = {}) {
      const l2 = cb.checked ? `${hits} hit / ${misses} miss` : "off";
      readout.textContent =
        `build: ${ms != null ? Math.round(ms) + " ms" : "—"}\n` +
        `L2 ops: ${l2}\n` +
        `L1 parts: ${skipped} skipped / ${rebuilt} rebuilt`;
    },
    detach: () => box.remove(),
  };
```

(mount's dispose calls it as `dbg?.detach()` — the overlay only exists under `?debug`.)

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run test/framework/mount.test.js`
Expected: PASS — except the two `onPick` tests which don't exist yet (Task 10). All Task 9 tests above pass.

If `finishFirstBuild` leaves `missingParts()` non-empty (ready never resolves), debug by checking that `cache.record("body")` marks the part current — the mesh-cache is real; the fake viewer's `hasSubMesh` must return true after `setSubGeometry` (it does, via the `built` set).

- [ ] **Step 5: Run the FULL suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js src/framework/debug-overlay.js test/framework/mount.test.js
git commit -m "feat: mount() embedding contract — elements, ready, dispose, onBuild"
```

---

### Task 10: `onPick` + pick-mode precedence

**Files:**
- Modify: `test/framework/mount.test.js` (the implementation already landed in Task 9's full-file rewrite)

**Interfaces:**
- Consumes: Task 9's mount internals; the mocked `attachPicker` from the test file.
- Produces: verified `onPick` payload `{ selection, label, prompt, token }` and precedence `onPick` > `?pick` > `?pickserver`.

- [ ] **Step 1: Write the tests** — append to `test/framework/mount.test.js`:

```js
test("onPick arms the picker permanently and delivers label/prompt/token", () => {
  const onPick = vi.fn();
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick });

  expect(attachPicker).toHaveBeenCalledTimes(1);
  const pickerHandle = attachPicker.mock.results[0].value;
  expect(pickerHandle.setActive).toHaveBeenCalledWith(true); // always-on

  // simulate a click resolving to a Selection (the picker core is tested elsewhere)
  const armed = attachPicker.mock.calls[0][1];
  armed.onPick({ subPart: "body", point: [0, 0, 1.5], normal: [0, 0, -1],
                 params: { h: 4 }, feature: { label: "Drainage hole" } });

  expect(onPick).toHaveBeenCalledTimes(1);
  const payload = onPick.mock.calls[0][0];
  expect(payload.label).toBe("Drainage hole"); // feature label wins
  expect(payload.prompt).toBe(
    "On sub-part **body**, the user pointed at **Drainage hole**, local point (0, 0, 1.5), normal -Z, with params {h: 4}."
  );
  expect(payload.token).toBe("@body · Drainage hole · pt(0,0,1.5) n(-Z) · {h:4}");
  expect(payload.selection.subPart).toBe("body");
});

test("label falls back to the sub-part label, then the sub-part name", () => {
  const onPick = vi.fn();
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick });
  const armed = attachPicker.mock.calls[0][1];

  armed.onPick({ subPart: "body", point: [0, 0, 0], normal: [0, 0, 1], params: {} });
  expect(onPick.mock.calls[0][0].label).toBe("Body"); // part.parts.body.label

  armed.onPick({ subPart: "ghost", point: [0, 0, 0], normal: [0, 0, 1], params: {} });
  expect(onPick.mock.calls[1][0].label).toBe("ghost"); // unknown sub-part → name
});

test("onPick wins over ?pick and ?pickserver (one click listener ever live)", async () => {
  vi.stubGlobal("location", { search: "?pick&pickserver" });
  const { createPickRequestClient } = await import("../../src/framework/pick-request/index.js");
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn() });
  expect(attachPicker).toHaveBeenCalledTimes(1);
  expect(attachPickToggle).not.toHaveBeenCalled();
  expect(createPickRequestClient).not.toHaveBeenCalled();
});

test("without onPick, ?pick still enables the clipboard toggle", () => {
  vi.stubGlobal("location", { search: "?pick" });
  const { createWorker } = makeWorkers();
  mount(makePart(), { createWorker, elements: makeElements() });
  expect(attachPickToggle).toHaveBeenCalledTimes(1);
  expect(attachPicker).not.toHaveBeenCalled();
});

test("dispose() detaches the onPick picker", () => {
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: makeElements(), onPick: vi.fn() });
  runtime.dispose();
  expect(attachPicker.mock.results[0].value.detach).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the mount tests**

Run: `npx vitest run test/framework/mount.test.js`
Expected: PASS (implementation landed in Task 9; these tests pin it). If `vi.stubGlobal("location", ...)` fails under happy-dom, use `window.happyDOM.setURL("http://localhost/?pick")` instead — one of the two works; keep whichever passes.

- [ ] **Step 3: Run the FULL suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add test/framework/mount.test.js
git commit -m "test: pin onPick payload, label precedence, and pick-mode precedence"
```

---

### Task 11: Docs, version bump, smoke, release

**Files:**
- Modify: `README.md`
- Modify: `package.json` (version only)

- [ ] **Step 1: Document the contract in README.md** — in the section that documents `mount` usage (find it with `grep -n "mount" README.md`), add/replace with:

```markdown
### Embedding (0.12.0+)

`mount()` returns a runtime handle and accepts element references, so an
embedding app (React, iframe, multiple mounts) can size, await, and tear down
the viewer without global IDs:

    const runtime = mount(part, {
      createWorker,
      elements: {
        viewer, controls,                       // canvas host + param-panel host
        status: { status, busy, phase },        // status chrome
        tabs,                                   // view-tab segmented control
        exports: { stl, step, threeMf },        // export buttons
        chrome: { pause, reframe, theme },      // viewer buttons
      },
      onBuild: ({ status, ms, error }) => {},   // per accepted build: "success" | "error"
      onPick: ({ selection, label, prompt, token }) => {}, // programmatic click-to-select
    });
    await runtime.ready;   // first successful build (rejects on a first-build error)
    runtime.dispose();     // stops loops, workers, observers, listeners; frees GPU resources

Every `elements` entry defaults to the legacy global ID (`#app`, `#controls`,
`#status`/`#busy`/`#phase`, `#part`, `#download`/`#download-step`/`#download-3mf`,
`#pause`/`#reframe`/`#theme`), so a classic host page needs no changes. The viewer
sizes from its container via ResizeObserver — no window coupling.

`onPick` arms click-to-select permanently: `label` is the feature label (falling
back to the sub-part label/name) for compact UI, `prompt` is the LLM-ready
sentence, `token` the compact form, `selection` the raw object. When `onPick` is
set, the `?pick` / `?pickserver` URL modes are ignored (one click listener ever
live); hover labels stay always-on.
```

- [ ] **Step 2: Bump the version** — in `package.json`, change `"version": "0.11.0"` to `"version": "0.12.0"`.

- [ ] **Step 3: Full suite + build**

Run: `npx vitest run && npm run build`
Expected: all tests PASS; Vite build succeeds.

- [ ] **Step 4: Manual smoke (dev app)** — `npm run dev`, open the served part page and verify: part renders and fills the window; window resize resizes the canvas; param slider regenerates; hover labels show; theme/pause/reframe/export buttons work; `?pick` still shows the Pick toggle. Ctrl-C afterwards.

- [ ] **Step 5: Consumer smoke (Drum Machine)** — Drum Machine pins partforge ≥0.10.0 and uses the legacy host page. From the partforge repo: `npm pack` (produces `partforge-0.12.0.tgz`). In `../Drum Machine/`: `nvm use && npm install ../partforge/partforge-0.12.0.tgz && npm run dev` — verify the app renders and params work, then `git checkout package.json package-lock.json && npm install` to restore its pinned dep. Delete the tarball afterwards.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json
git commit -m "docs: embedding contract in README; bump to 0.12.0"
```

- [ ] **Step 7: Publish (user gate)** — `npm publish` requires the user's npm auth (possibly OTP). **Ask the user to run it or to confirm you should.** After publishing, verify: `npm view partforge version` → `0.12.0`.

---

## Verification (whole plan)

- `npx vitest run` — full suite green.
- `npm run build` — clean.
- Spec acceptance: repeated mount/dispose cycles leave no workers, render loops, observers, listeners, or timers alive (pinned by mount dispose test + module detach tests); `ready` resolves/rejects on the first build; `onPick` payload and precedence pinned by tests; legacy host pages unaffected (default-ID test + both manual smokes).
