# Per-View Animations + Animated Part Opacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move animations from the part level into their owning view (transport bar appears only on views that declare animations) and add per-sub-part `opacity` keyframe tracks so an animation can fade parts in/out (display-only, never affecting params/export/measure).

**Architecture:** The pure timeline model (`src/framework/animation.js`) gains per-view normalization (`viewAnimations`) and a second track type (`opacity`, evaluated by the same segment machinery as param tracks). The viewer gains a display-layer opacity override API (`setSubPartOpacity`/`clearSubPartOpacities`) riding the existing per-sub-part material machinery. The transport driver becomes view-aware (bar per view, reset on view switch), lint walks `views.<v>.animations.<name>` paths, and the CLI resolves `--animation` across views.

**Tech Stack:** Vanilla JS (ES modules), three.js viewer, vitest (`@vitest-environment happy-dom` for DOM tests), Node `util.parseArgs` CLI. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-10-per-view-animations-design.md` (in this repo). Read it before starting any task.

## Global Constraints

- **Clean break:** top-level `part.animations` is a lint ERROR (`animation-not-in-view`) and ignored at runtime (no bar, no crash). No legacy normalization path anywhere.
- **`animation.js` must stay pure and import-free** — `test/lint-purity.test.js` enforces it. No DOM, no three, no imports.
- **Opacity is display-only:** never touches params, export, measure, or verify. Values 0–1. `0` = fully hidden (mesh AND edge lines). Multiplies static `display.opacity`. Reset restores normal visibility.
- **Hold rule:** same as param tracks — a sub-part opacity-tracked in one step holds its nearest keyframe value in other steps; sub-parts never mentioned render normally.
- **One autoplay per VIEW** (was per part).
- **CLI:** the part-view disambiguator is the existing positional `view` argument. `--views` continues to mean camera angles — do NOT add a `--view` flag.
- Version bumps to **0.49.0** in this PR (Task 8), matching repo convention (release-worthy PRs bump `package.json` themselves).
- Run tests from the repo root of the worktree `.worktrees/per-view-animations`. Single file: `npx vitest run <path>`. Full suite: `npm test`.
- Commit after every task (steps say when). Work on branch `per-view-animations`.

---

### Task 1: Timeline model — per-view normalization + opacity tracks

**Files:**
- Modify: `src/framework/animation.js`
- Test: `test/framework/animation.test.js`, `test/framework/animation-state.test.js` (fixture updates only)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `normalizeAnimation(name, spec)` — unchanged signature. Normalized steps now each carry `opacity: {}` (from `s.opacity ?? {}`; in the bare single-phase form, from `spec.opacity ?? {}`). Normalized animation gains `opacityKeys: string[]` (keys with usable keyframes in any step, like `trackedKeys`).
  - `viewAnimations(part)` → `Map<viewName, NormalizedAnimation[]>` — one entry per view in `part.views`, malformed animation entries skipped (never thrown).
  - `normalizeAnimations(part)` is **deleted** (grep confirms only `animation-controls.js` and `test/hinged-box-part.test.js` import it; both are updated in later tasks — this task updates neither, so their tests break here and are fixed in Tasks 3 and 8; that is expected mid-plan).
  - `evaluate(anim, t)` → `{ stepIndex, values, opacity }` where `opacity` maps sub-part name → number.
  - `createPlayback` unchanged in shape; its snapshots spread `evaluate()`, so every snapshot now carries `opacity` for free.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/animation.test.js` (it currently imports from `../../src/framework/animation.js` — extend the import list with `viewAnimations`, and make sure `normalizeAnimation` and `evaluate` are in it):

```js
// --- opacity tracks + per-view normalization (spec 2026-08-10) --------------

const fadePart = {
  views: {
    box: { label: "Box" },
    assembly: {
      label: "Assembly",
      animations: {
        assemble: {
          label: "Assemble",
          steps: [
            { label: "Appear", duration: 1, easing: "linear",
              opacity: { lid: [[0, 0], [1, 1]] } },
            { label: "Lower", duration: 1, easing: "linear",
              tracks: { lidLift: [[0, 40], [1, 0]] } },
          ],
        },
        fade: { label: "Fade", duration: 2, easing: "linear",
          opacity: { base: [[0, 1], [1, 0]] } },
      },
    },
  },
};

test("viewAnimations maps each view to its own normalized set", () => {
  const byView = viewAnimations(fadePart);
  expect([...byView.keys()]).toEqual(["box", "assembly"]);
  expect(byView.get("box")).toEqual([]);
  expect(byView.get("assembly").map((a) => a.name)).toEqual(["assemble", "fade"]);
});

test("viewAnimations skips a malformed entry instead of throwing", () => {
  const bad = { views: { v: { label: "V", animations: { ok: { duration: 1, tracks: { x: [[0, 0], [1, 1]] } }, broken: null } } } };
  expect(viewAnimations(bad).get("v").map((a) => a.name)).toEqual(["ok"]);
});

test("top-level animations are ignored (clean break)", () => {
  const legacy = { views: { v: { label: "V" } }, animations: { open: { duration: 1, tracks: { x: [[0, 0], [1, 1]] } } } };
  expect(viewAnimations(legacy).get("v")).toEqual([]);
});

test("opacity tracks normalize and evaluate like param tracks", () => {
  const [assemble] = viewAnimations(fadePart).get("assembly");
  expect(assemble.opacityKeys).toEqual(["lid"]);
  expect(assemble.trackedKeys).toEqual(["lidLift"]);
  // mid step 1 (t=0.25 of the whole): lid fading in, linear → 0.5
  expect(evaluate(assemble, 0.25).opacity.lid).toBeCloseTo(0.5);
  // step 2 (t=0.75): lid holds its nearest keyframe (1); lidLift interpolates
  const r = evaluate(assemble, 0.75);
  expect(r.opacity.lid).toBe(1);
  expect(r.values.lidLift).toBeCloseTo(20);
});

test("bare single-phase form carries opacity (no steps wrapper)", () => {
  const fade = viewAnimations(fadePart).get("assembly")[1];
  expect(fade.steps).toHaveLength(1);
  expect(fade.opacityKeys).toEqual(["base"]);
  expect(evaluate(fade, 0.5).opacity.base).toBeCloseTo(0.5);
  expect(evaluate(fade, 1).opacity.base).toBe(0);
});

test("opacity tracked only in a LATER step holds its first keyframe earlier", () => {
  const lateFade = normalizeAnimation("x", { steps: [
    { label: "Wait", duration: 1, easing: "linear", tracks: { lidLift: [[0, 40], [1, 40]] } },
    { label: "Appear", duration: 1, easing: "linear", opacity: { lid: [[0, 0], [1, 1]] } },
  ] });
  expect(evaluate(lateFade, 0.25).opacity.lid).toBe(0); // hidden until its moment
});

test("an opacity-only animation is normalizable (no tracks anywhere)", () => {
  const fade = viewAnimations(fadePart).get("assembly")[1];
  expect(fade.trackedKeys).toEqual([]);
  expect(evaluate(fade, 0.3).values).toEqual({});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/animation.test.js`
Expected: FAIL — `viewAnimations` is not exported; `evaluate` result has no `opacity`.

- [ ] **Step 3: Implement in `src/framework/animation.js`**

In `normalizeAnimation`, add `opacity` to both step forms and compute `opacityKeys` beside `trackedKeys` (factor the shared key scan):

```js
  const steps = spec.steps
    ? spec.steps.map((s, i) => ({
        label: s.label ?? `Step ${i + 1}`,
        duration: s.duration,
        easing: s.easing ?? spec.easing ?? DEFAULT_EASING,
        tracks: s.tracks ?? {},
        opacity: s.opacity ?? {},
        camera: s.camera ?? null,
      }))
    : [{
        label: null, duration: spec.duration,
        easing: spec.easing ?? DEFAULT_EASING,
        tracks: spec.tracks ?? {}, opacity: spec.opacity ?? {}, camera: null,
      }];
```

```js
  // Keys with at least one usable keyframe list in any step, for one field
  // ("tracks" or "opacity"). Shares usableKeyframes with segmentsFor — the
  // single rule both must agree on (see the comment on usableKeyframes).
  const keysOf = (field) => [...new Set(steps.flatMap((s) =>
    Object.entries(s[field]).filter(([, kf]) => usableKeyframes(kf)).map(([key]) => key)))];
  const trackedKeys = keysOf("tracks");
  const opacityKeys = keysOf("opacity");
```

Return `opacityKeys` in the normalized object. Generalize the segment walk to a field selector (default preserves current callers):

```js
function segmentsFor(anim, key, field = "tracks") {
  const out = [];
  anim.steps.forEach((step, i) => {
    const kf = step[field][key];
    if (!usableKeyframes(kf)) return;
    const start = anim.stepStarts[i];
    const end = i + 1 < anim.steps.length ? anim.stepStarts[i + 1] : 1;
    out.push({ start, end, keyframes: kf, easing: step.easing });
  });
  return out;
}

function evaluateTrack(anim, key, t, field = "tracks") {
  const segs = segmentsFor(anim, key, field);
  // …body unchanged…
```

```js
export function evaluate(anim, t) {
  const tc = clampT(t);
  const values = {};
  for (const key of anim.trackedKeys) values[key] = evaluateTrack(anim, key, tc, "tracks");
  const opacity = {};
  for (const key of anim.opacityKeys) opacity[key] = evaluateTrack(anim, key, tc, "opacity");
  return { stepIndex: stepIndexAt(anim, tc), values, opacity };
}
```

Replace `normalizeAnimations` with:

```js
// Per-view normalized animations (spec 2026-08-10-per-view-animations):
// Map(viewName -> NormalizedAnimation[]), one entry per declared view, [] for
// views without animations. Malformed entries are SKIPPED, not thrown — the
// runtime must degrade to "that animation doesn't exist" while lint reports
// the specifics. A legacy top-level `animations` key is deliberately ignored
// (clean break; lint's animation-not-in-view names the fix).
export function viewAnimations(part) {
  const out = new Map();
  const views = part?.views;
  if (views === null || typeof views !== "object" || Array.isArray(views)) return out;
  for (const [viewName, view] of Object.entries(views)) {
    const block = view?.animations;
    const entries = block !== null && typeof block === "object" && !Array.isArray(block)
      ? Object.entries(block)
      : [];
    const anims = [];
    for (const [name, spec] of entries) {
      try { anims.push(normalizeAnimation(name, spec)); } catch { /* lint reports */ }
    }
    out.set(viewName, anims);
  }
  return out;
}
```

- [ ] **Step 4: Run the animation model tests**

Run: `npx vitest run test/framework/animation.test.js test/framework/animation-state.test.js test/lint-purity.test.js`
Expected: `animation.test.js` PASS. If `animation-state.test.js` builds specs via `normalizeAnimation` directly it still passes; if any fixture broke, update ONLY its part shape (animations under a view) — the state machine API is unchanged. `lint-purity` must PASS (no new imports).

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation.js test/framework/animation.test.js test/framework/animation-state.test.js
git commit -m "feat(animation): per-view normalization (viewAnimations) + opacity tracks in the timeline model"
```

---

### Task 2: Viewer — display-layer sub-part opacity overrides

**Files:**
- Modify: `src/framework/viewer.js`
- Test: `test/framework/viewer-opacity.test.js` (new)

**Interfaces:**
- Consumes: nothing from Task 1 (pure viewer feature).
- Produces (Task 3 relies on these exact names on the viewer handle):
  - `setSubPartOpacity(name, value)` — `value` in `[0,1]`, or `null`/`undefined`/`>= 1` to clear the override. Unknown `name` is a silent no-op.
  - `clearSubPartOpacities()` — removes every override.
  - Semantics: override composes with `showAssembly`'s visibility (a part not in the shown set stays hidden regardless); `0` hides mesh + edge lines and drops the part from the cutaway's visible set; `0 < v < 1` renders the mesh on a cloned material (`transparent: true`, `depthWrite: false`, `opacity = (display.opacity ?? 1) * v`) and the lines on a cloned `LineMaterial` (`transparent: true`, `opacity = v`); clearing restores the part's base material.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewer-opacity.test.js`. Copy the harness top of `test/framework/viewer-pose.test.js` VERBATIM (the `@vitest-environment happy-dom` pragma, the `vi.hoisted` state, the `vi.mock("three", …)` FakeRenderer block, the `vi.mock("../../src/framework/cutaway.js", …)` block, `createFakeCutaway`, and its ResizeObserver stub / afterEach cleanup). Then:

```js
import { createViewer } from "../../src/framework/viewer.js";

const part = {
  meta: { title: "t" },
  parts: {
    base: { views: ["v"], build: () => {} },
    lid: { views: ["v"], build: () => {} },
    ghost: { views: ["v"], display: { opacity: 0.5 }, build: () => {} },
  },
  views: { v: { label: "V" } },
};

// A minimal worker-mesh payload: one triangle, enough for buildGeometry.
const payload = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  triangles: 1,
  edges: new Float32Array(0),
});

function setup() {
  state.cutaway = createFakeCutaway();
  const container = document.createElement("div");
  document.body.append(container);
  const viewer = createViewer(container, part);
  for (const n of ["base", "lid", "ghost"]) viewer.setSubGeometry(n, payload());
  viewer.showAssembly(["base", "lid", "ghost"]);
  return viewer;
}

test("fade clones the material; clear restores the shared one", () => {
  const viewer = setup();
  const mesh = viewer.__subMesh("lid"), lines = viewer.__subLines("lid");
  const baseMat = mesh.material;
  viewer.setSubPartOpacity("lid", 0.4);
  expect(mesh.visible).toBe(true);
  expect(mesh.material).not.toBe(baseMat);
  expect(mesh.material.transparent).toBe(true);
  expect(mesh.material.depthWrite).toBe(false);
  expect(mesh.material.opacity).toBeCloseTo(0.4);
  expect(lines.material.opacity).toBeCloseTo(0.4);
  viewer.setSubPartOpacity("lid", null);
  expect(mesh.material).toBe(baseMat);
  expect(mesh.visible).toBe(true);
});

test("opacity 0 hides mesh + lines and leaves the cutaway set", () => {
  const viewer = setup();
  const mesh = viewer.__subMesh("lid"), lines = viewer.__subLines("lid");
  viewer.setSubPartOpacity("lid", 0);
  expect(mesh.visible).toBe(false);
  expect(lines.visible).toBe(false);
  expect(state.cutaway.setVisible).toHaveBeenLastCalledWith(["base", "ghost"]);
  viewer.setSubPartOpacity("lid", 1);
  expect(mesh.visible).toBe(true);
  expect(state.cutaway.setVisible).toHaveBeenLastCalledWith(["base", "lid", "ghost"]);
});

test("fade multiplies a static display.opacity", () => {
  const viewer = setup();
  viewer.setSubPartOpacity("ghost", 0.5);
  expect(viewer.__subMesh("ghost").material.opacity).toBeCloseTo(0.25); // 0.5 authored × 0.5 animated
});

test("showAssembly keeps overrides; clearSubPartOpacities restores everything", () => {
  const viewer = setup();
  viewer.setSubPartOpacity("lid", 0);
  viewer.showAssembly(["base", "lid"]); // regen re-show mid-animation
  expect(viewer.__subMesh("lid").visible).toBe(false); // override survives the re-show
  viewer.clearSubPartOpacities();
  expect(viewer.__subMesh("lid").visible).toBe(true);
});

test("a part outside the shown set stays hidden regardless of override", () => {
  const viewer = setup();
  viewer.showAssembly(["base"]);
  viewer.setSubPartOpacity("lid", 0.7);
  expect(viewer.__subMesh("lid").visible).toBe(false);
});

test("unknown names are a no-op", () => {
  const viewer = setup();
  expect(() => viewer.setSubPartOpacity("nope", 0.5)).not.toThrow();
});
```

Note the two test hooks `__subMesh(name)` / `__subLines(name)` — add them to the viewer handle in Step 3 (pattern precedent: `attachAnimationControls`'s `__viewer` test hook).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/viewer-opacity.test.js`
Expected: FAIL — `setSubPartOpacity` is not a function.

- [ ] **Step 3: Implement in `src/framework/viewer.js`**

After the `subLines` block (~line 178), add state + helpers:

```js
  // --- animated per-sub-part opacity (display-only) ---------------------------
  // Overrides from the animation driver (spec 2026-08-10-per-view-animations):
  // absent = normal, 0 = fully hidden (mesh AND lines), 0<v<1 = faded on cloned
  // materials. Never touches geometry, params, or exports — this is the display
  // half of "fade a part in, then animate it into place".
  const animOpacity = new Map();     // name -> value in [0, 1)
  const baseMats = Object.fromEntries(names.map((n) => [n, subMesh[n].material]));
  const fadeMats = new Map();        // name -> lazily cloned MeshStandardMaterial
  const fadeLineMats = new Map();    // name -> lazily cloned LineMaterial
  let lastShown = [];                // names last passed to showAssembly

  const effectiveVisible = () => lastShown.filter((n) => (animOpacity.get(n) ?? 1) > 0);

  function fadeMatFor(name) {
    let m = fadeMats.get(name);
    if (!m) {
      m = baseMats[name].clone();
      m.transparent = true;
      m.depthWrite = false;
      fadeMats.set(name, m);
    }
    return m;
  }
  function fadeLineMatFor(name) {
    let m = fadeLineMats.get(name);
    if (!m) {
      m = lineMaterial.clone();
      m.transparent = true;
      m.resolution.copy(lineMaterial.resolution);
      fadeLineMats.set(name, m);
    }
    return m;
  }

  // Re-derive one sub-part's material + visibility from (shown, override).
  function applySubOpacity(name) {
    const mesh = subMesh[name], lines = subLines[name];
    if (!mesh) return;
    const shown = lastShown.includes(name);
    const v = animOpacity.get(name);
    if (v === undefined) {
      mesh.material = baseMats[name];
      lines.material = lineMaterial;
      mesh.visible = shown;
      lines.visible = shown;
      return;
    }
    if (v <= 0) {
      mesh.visible = false;
      lines.visible = false;
      return;
    }
    const staticOpacity = part.parts[name].display?.opacity ?? 1;
    const fm = fadeMatFor(name);
    fm.opacity = staticOpacity * v;
    mesh.material = fm;
    const flm = fadeLineMatFor(name);
    flm.opacity = v;
    lines.material = flm;
    mesh.visible = shown;
    lines.visible = shown;
  }

  function setSubPartOpacity(name, value) {
    if (!subMesh[name]) return;
    const wasZero = (animOpacity.get(name) ?? 1) <= 0;
    if (value == null || !(value < 1)) animOpacity.delete(name); // null/undefined/NaN/>=1 clear
    else animOpacity.set(name, Math.max(0, value));
    applySubOpacity(name);
    const isZero = (animOpacity.get(name) ?? 1) <= 0;
    if (wasZero !== isZero) cutaway.setVisible(effectiveVisible());
  }

  function clearSubPartOpacities() {
    if (!animOpacity.size) return;
    const touched = [...animOpacity.keys()];
    animOpacity.clear();
    for (const n of touched) applySubOpacity(n);
    cutaway.setVisible(effectiveVisible());
  }
```

Rework `showAssembly` / `hideAssembly` to route through the override state:

```js
  function showAssembly(visibleNames, { frame = false } = {}) {
    lastShown = [...visibleNames];
    for (const name of names) {
      if (visibleNames.includes(name)) {
        subMesh[name].geometry = subCache[name]; // cached geometries reused, not disposed
        subLines[name].geometry = subCache[name].userData.edges;
        applySubOpacity(name); // shown, but an active 0-override keeps it hidden
      } else {
        subMesh[name].visible = false;
        subLines[name].visible = false;
      }
    }
    if (frame) frameTo(visibleNames);
    cutaway.setVisible(effectiveVisible());
  }

  function hideAssembly() {
    lastShown = [];
    for (const m of Object.values(subMesh)) m.visible = false;
    for (const l of Object.values(subLines)) l.visible = false;
    cutaway.setVisible([]);
  }
```

Keep the clones coherent with the live chrome:
- In `resize()`, after `lineMaterial.resolution.set(w, h);` add: `for (const m of fadeLineMats.values()) m.resolution.set(w, h);`
- In `setTheme()`, after `lineMaterial.color.set(t.line);` add: `for (const m of fadeLineMats.values()) m.color.set(t.line);`
- In the viewer's `dispose()` (find where `material`/`lineMaterial` are disposed), dispose every entry of `fadeMats` and `fadeLineMats` and clear both maps.

Export on the returned viewer handle (find the `return {` at the bottom of `createViewer`): add `setSubPartOpacity, clearSubPartOpacities,` and the test hooks `__subMesh: (n) => subMesh[n], __subLines: (n) => subLines[n],`.

- [ ] **Step 4: Run the viewer tests**

Run: `npx vitest run test/framework/viewer-opacity.test.js test/framework/viewer-pose.test.js test/framework/viewer-cutaway.test.js test/framework/viewer-active.test.js test/framework/viewer-capture-view.test.js test/framework/assembly.test.js`
Expected: all PASS (the showAssembly rework must not change behavior when no overrides exist).

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js test/framework/viewer-opacity.test.js
git commit -m "feat(viewer): display-layer per-sub-part opacity overrides for animations"
```

---

### Task 3: Transport driver — per-view bar, opacity application, view-switch reset

**Files:**
- Modify: `src/framework/animation-controls.js`
- Test: `test/framework/animation-controls.test.js`, `test/framework/animation-transport-idempotent-ui.test.js` (fixture updates + new tests)

**Interfaces:**
- Consumes: `viewAnimations` (Task 1); `viewer.setSubPartOpacity` / `viewer.clearSubPartOpacities` (Task 2, called optional-chained).
- Produces (Task 4 relies on these):
  - `attachAnimationControls(viewer, part, { container, applyValues, getParamValues, getView })` — new required `getView: () => string` option. Returns `null` when NO view declares a valid animation.
  - Handle gains `viewChanged()` — resets the outgoing animation (params snapshot restored, opacities cleared, tween cancelled) and rebuilds the bar for `getView()`'s animation set, hiding the bar when that set is empty.
  - `runtime.state()` gains `view` (the active view name); `animation` is `null` while the active view has no animations.
  - `runtime.play(name)` resolves `name` within the ACTIVE view only.
  - `autoplayKick()` plays the ACTIVE view's `autoplay` animation (if armed).

- [ ] **Step 1: Update fixtures and write the failing tests**

In `test/framework/animation-controls.test.js`:

1. Change the shared `part` fixture to the per-view shape and add an animation-free view plus an opacity animation:

```js
const part = {
  parts: {
    base: { views: ["box", "solo"], build: () => {} },
    lid: { views: ["box"], build: () => {} },
  },
  views: {
    box: {
      label: "Box",
      animations: {
        open: { label: "Open lid", camera: "front", duration: 2, easing: "linear",
          description: "Opens the **lid**.", tracks: { lidAngle: [[0, 0], [1, 110]] } },
        assemble: { label: "Assemble", steps: [
          { label: "Appear", duration: 1, easing: "linear", opacity: { lid: [[0, 0], [1, 1]] } },
          { label: "Lower", duration: 1, easing: "linear", tracks: { lidLift: [[0, 40], [1, 0]] } },
        ] },
      },
    },
    solo: { label: "Solo" },
  },
};
```

2. Extend `fakeViewer()` with `setSubPartOpacity: vi.fn()` and `clearSubPartOpacities: vi.fn()`.

3. In `setup()`, add view plumbing:

```js
function setup(defn = part) {
  const container = document.createElement("div");
  document.body.append(container);
  const params = { lidAngle: 5, lidLift: 0 };
  const applied = [];
  let activeView = "box";
  const ctl = attachAnimationControls(fakeViewer(), defn, {
    container,
    applyValues: (v) => { applied.push({ ...v }); Object.assign(params, v); },
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
    getView: () => activeView,
  });
  const switchView = (name) => { activeView = name; ctl.viewChanged(); };
  return { container, params, applied, ctl, switchView, viewer: ctl.__viewer };
}
```

4. Keep every existing test (they exercise the "box" view, which is the initial view). Add:

```js
test("returns null only when NO view declares animations", () => {
  const container = document.createElement("div");
  const none = { views: { v: { label: "V" } }, parts: {} };
  expect(attachAnimationControls(fakeViewer(), none, {
    container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "v",
  })).toBeNull();
  expect(container.children).toHaveLength(0);
});

test("top-level animations are ignored — clean break", () => {
  const container = document.createElement("div");
  const legacy = { views: { v: { label: "V" } }, parts: {},
    animations: { open: { duration: 1, tracks: { x: [[0, 0], [1, 1]] } } } };
  expect(attachAnimationControls(fakeViewer(), legacy, {
    container, applyValues: () => {}, getParamValues: () => ({}), getView: () => "v",
  })).toBeNull();
});

test("switching to a view without animations hides the bar; back shows it", () => {
  const { container, ctl, switchView } = setup(); handles.push(ctl);
  const bar = container.querySelector(".pf-anim-bar");
  expect(bar.style.display).not.toBe("none");
  switchView("solo");
  expect(bar.style.display).toBe("none");
  expect(ctl.runtime.state()).toMatchObject({ view: "solo", animation: null });
  switchView("box");
  expect(bar.style.display).not.toBe("none");
  expect(ctl.runtime.state()).toMatchObject({ view: "box", animation: "open" });
});

test("a view switch resets: snapshot restored, opacities cleared, position zeroed", () => {
  const { applied, ctl, switchView } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();          // takes snapshot { lidAngle: 5 }
  viewer.frame(1);             // t=0.5, lidAngle 55
  switchView("solo");
  expect(applied.at(-1)).toEqual({ lidAngle: 5 });            // snapshot restored
  expect(viewer.clearSubPartOpacities).toHaveBeenCalled();
  switchView("box");
  expect(ctl.runtime.state().t).toBe(0);
});

test("opacity tracks drive viewer.setSubPartOpacity each frame", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  ctl.runtime.play();
  viewer.frame(0.5); // mid step 1: lid at 0.5
  const calls = viewer.setSubPartOpacity.mock.calls;
  expect(calls.at(-1)[0]).toBe("lid");
  expect(calls.at(-1)[1]).toBeCloseTo(0.5);
});

test("reset clears opacity overrides", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  ctl.runtime.play();
  viewer.frame(0.5);
  ctl.runtime.stop();
  expect(viewer.clearSubPartOpacities).toHaveBeenCalled();
});

test("runtime.play resolves names in the ACTIVE view only", () => {
  const { ctl, switchView } = setup(); handles.push(ctl);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  switchView("solo");
  ctl.runtime.play("open"); // exists in "box", not here
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown animation"));
  expect(ctl.runtime.state().status).toBe("idle");
  warn.mockRestore();
});
```

Also update `test/framework/animation-transport-idempotent-ui.test.js`: move its fixture's `animations` under a view the same way and pass `getView` in its attach call (mechanical; assertions unchanged).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/framework/animation-controls.test.js`
Expected: FAIL — old code imports the now-deleted `normalizeAnimations`, has no `getView`/`viewChanged`.

- [ ] **Step 3: Rework `src/framework/animation-controls.js`**

Structural changes (keep everything not named here as-is — the bubble, placement, WebKit textSetter machinery is untouched):

1. Import `viewAnimations` instead of `normalizeAnimations`. Attach-time setup:

```js
export function attachAnimationControls(viewer, part, { container, applyValues, getParamValues, getView }) {
  // A malformed animations block must degrade to "no transport bar", never a
  // crashed mount — lint reports the specifics; the viewer just goes without.
  let byView;
  try { byView = viewAnimations(part); } catch { byView = new Map(); }
  if (![...byView.values()].some((a) => a.length)) return null;

  const animsFor = (view) => byView.get(view) ?? [];
  let animations = animsFor(getView());
  let current = animations[0] ?? null;
  let playback = current ? createPlayback(current) : null;
```

2. Autoplay becomes per-view: replace `autoplayAnim`/`autoplayArmed` with

```js
  const autoplayFor = (view) => animsFor(view).find((a) => a.autoplay) ?? null;
  let autoplayArmed = [...byView.values()].some((set) => set.some((a) => a.autoplay)) && !reducedMotion;
```

(`disarmAutoplay` unchanged — one touch disarms it globally for the session, exactly as before.)

3. The bar's DOM is built once. Append BOTH `pick` and `title` (drop the `paged ? pick : title` choice) and always create the pagers; `syncStructure()` decides what shows for the CURRENT view's set:

```js
  function syncStructure() {
    bar.style.display = current ? "" : "none";
    hideChapterBubble();
    if (!current) return;
    const paged = animations.length > 1;
    pick.style.display = paged ? "" : "none";
    title.style.display = paged ? "none" : "";
    if (prevAnimBtn) prevAnimBtn.style.display = paged ? "" : "none";
    if (nextAnimBtn) nextAnimBtn.style.display = paged ? "" : "none";
    pick.replaceChildren(...animations.map((a) => {
      const o = document.createElement("option");
      o.value = a.name; o.textContent = a.label;
      return o;
    }));
    pick.value = current.name;
    title.textContent = current.label;
    if (paged) { /* pager aria labels — keep the existing at()/setBtnLabel block */ }
    /* infoSlot + tick rebuild — keep the existing block */
  }
```

(Since the pagers now always exist, create them unconditionally: `const prevAnimBtn = btn("pf-anim-page", "‹", "Previous animation");` etc., and drop the `paged` const from the DOM-construction section.)

4. Guard every playback access: `playback` may be null while the active view has no animations. The cheapest uniform guard: at the top of `apply`, `guarded`-wrapped producers, `doReset`, `syncUi`, `onScrub`, `onScrubKeydown`, `onPlayClick`, `cycleAnimation`, `autoplayKick` — early-return when `!current`.

5. Opacity application in `apply(r)` (after `applyValues`):

```js
      if (Object.keys(r.values).length) {
        if (snapshot == null) snapshot = getParamValues(current.trackedKeys);
        applyValues(r.values);
      }
      for (const [n, v] of Object.entries(r.opacity ?? {})) viewer.setSubPartOpacity?.(n, v);
```

(The existing `snapshot == null && Object.keys(r.values).length` line is replaced by this block — an opacity-only animation never snapshots and never calls `applyValues`, so it can't dirty the regen loop.)

6. `doReset` clears overrides:

```js
  function doReset() {
    playback?.reset();
    viewer.cancelCameraTween();
    viewer.clearSubPartOpacities?.();
    if (snapshot) { applyValues(snapshot); snapshot = null; }
    syncUi();
  }
```

7. New `viewChanged` on the handle, and `runtime`/`autoplayKick` updates:

```js
    // Mount calls this from the view-tab onChange, BEFORE it refreshes the
    // view: the outgoing animation's params and opacity overrides must be
    // restored before the incoming view composes its assembly.
    viewChanged() {
      doReset();
      animations = animsFor(getView());
      current = animations[0] ?? null;
      playback = current ? createPlayback(current) : null;
      syncStructure();
      invalidateUi();
      if (current) syncUi();
    },
```

```js
    state: () => ({
      view: getView(),
      animation: current?.name ?? null,
      ...(playback ? playback.state() : { status: "idle", t: 0, stepIndex: 0 }),
    }),
```

```js
    autoplayKick() {
      if (!autoplayArmed) return;
      const target = autoplayFor(getView());
      if (!target) return;
      if (current !== target) selectAnimation(target.name);
      const { status } = playback.state();
      if (status !== "playing" && status !== "intro") guarded(() => playback.play());
    },
```

`runtime.play(name)` / `selectAnimation` / `cycleAnimation` already operate on the module-level `animations` array, which is now per-view — no further change beyond the null guards. `detach()` additionally calls `viewer.clearSubPartOpacities?.()`.

- [ ] **Step 4: Run the driver tests**

Run: `npx vitest run test/framework/animation-controls.test.js test/framework/animation-transport-idempotent-ui.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js test/framework/animation-controls.test.js test/framework/animation-transport-idempotent-ui.test.js
git commit -m "feat(transport): per-view animation bar with opacity application and view-switch reset"
```

---

### Task 4: Mount wiring

**Files:**
- Modify: `src/framework/mount.js`
- Test: `test/framework/mount.test.js` (only if its fixtures declare animations — check; likely no change)

**Interfaces:**
- Consumes: `attachAnimationControls(viewer, part, { …, getView })` + `viewChanged()` (Task 3).
- Produces: no new surface — `runtime.animation` stays `animCtl?.runtime ?? null`.

- [ ] **Step 1: Wire the view into the driver**

In `mount()` (~line 544), pass the active view:

```js
    animCtl = attachAnimationControls(viewer, part, {
      container: els.viewer,
      applyValues: applyAnimationValues,
      getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
      getView: view,
    });
```

In the view-tabs `onChange` (~line 236), reset the animation FIRST — its snapshot restore must land before the incoming view composes — keeping `autoplayKick` last:

```js
      onChange: (name) => {
        animCtl?.viewChanged();
        pendingPosed.clear(); cutawayChrome.reset(); refreshView(); updateRelevance(); loop.kick(); animCtl?.autoplayKick();
        onViewChange?.(name);
      },
```

Update the embedding-contract comment block (~line 125): `runtime.animation` is "null when NO view declares animations"; `state()` now includes `view`; `play(name)` resolves within the active view. Same doc touch in `makeHandle`'s comment (~line 35).

- [ ] **Step 2: Run the mount + integration-adjacent tests**

Run: `npx vitest run test/framework/mount.test.js test/framework/mount-capture-view.test.js test/export-mount-wiring.test.js test/mount-capture.test.js`
Expected: PASS (update any fixture that declares `animations` at the part level to the view-owned shape — grep those test files for `animations:` first).

- [ ] **Step 3: Commit**

```bash
git add src/framework/mount.js test/framework/mount.test.js
git commit -m "feat(mount): view-scoped animation driver wiring"
```

---

### Task 5: Lint — per-view walk, opacity rules, clean-break error

**Files:**
- Modify: `src/framework/lint/rules-animations.js`
- Test: `test/lint-animations.test.js`

**Interfaces:**
- Consumes: nothing new (lint stays a static walk; `EASINGS` import unchanged).
- Produces rule ids (Task 8's docs name them): existing ids unchanged; new `animation-not-in-view`, `animation-opacity-unknown-part`, `animation-opacity-range`. All finding paths move to `views.<view>.animations.<name>…`.

- [ ] **Step 1: Update fixtures and write the failing tests**

`test/lint-animations.test.js` builds parts with top-level `animations`. Mechanical pass first: wrap every fixture's animations into `views: { v: { label: "V", animations: {…} } }` (fixtures that already declare `views`/`parts` get the block merged into their first view) and update every expected `path` from `animations.…` to `views.v.animations.…`. Then add:

```js
test("animation-not-in-view: top-level animations are an error", () => {
  const part = base({ animations: { open: { duration: 1, tracks: { w: [[0, 0], [1, 1]] } } } });
  const f = findingsFor(part, "animation-not-in-view");
  expect(f).toHaveLength(1);
  expect(f[0].severity).toBe("error");
  expect(f[0].path).toBe("animations");
  expect(f[0].hint).toMatch(/views\.<name>\.animations/);
});

test("animation-opacity-unknown-part: opacity keys must be sub-parts of the owning view", () => {
  // lid exists but is not in view "v"; ghost doesn't exist at all
  const part = base({
    parts: { base: { views: ["v"], build: () => {} }, lid: { views: ["other"], build: () => {} } },
    views: {
      v: { label: "V", animations: { a: { duration: 1, opacity: { lid: [[0, 0], [1, 1]], ghost: [[0, 0], [1, 1]] } } } },
      other: { label: "O" },
    },
  });
  const f = findingsFor(part, "animation-opacity-unknown-part");
  expect(f.map((x) => x.path)).toEqual([
    "views.v.animations.a.opacity.lid",
    "views.v.animations.a.opacity.ghost",
  ]);
});

test("animation-opacity-range: values outside 0..1 are an error", () => {
  const part = withAnim("v", { a: { duration: 1, opacity: { base: [[0, 0], [1, 1.5]] } } });
  expect(findingsFor(part, "animation-opacity-range")).toHaveLength(1);
});

test("opacity keyframe SHAPE problems reuse animation-keyframes-invalid", () => {
  const part = withAnim("v", { a: { duration: 1, opacity: { base: [[0.2, 0], [1, 1]] } } }); // doesn't start at 0
  const f = findingsFor(part, "animation-keyframes-invalid");
  expect(f.map((x) => x.path)).toContain("views.v.animations.a.opacity.base");
});

test("an opacity-only animation is NOT 'animates nothing'", () => {
  const part = withAnim("v", { a: { duration: 1, opacity: { base: [[0, 0], [1, 1]] } } });
  expect(findingsFor(part, "animation-tracks-or-steps")).toHaveLength(0);
});

test("a step with only opacity is legal; a step with nothing is not", () => {
  const part = withAnim("v", { a: { steps: [
    { label: "Fade", duration: 1, opacity: { base: [[0, 0], [1, 1]] } },
    { label: "Empty", duration: 1 },
  ] } });
  const f = findingsFor(part, "animation-tracks-or-steps");
  expect(f).toHaveLength(1);
  expect(f[0].path).toBe("views.v.animations.a.steps[1].tracks");
});

test("autoplay is per view: two views may each declare one", () => {
  const part = base({
    views: {
      a: { label: "A", animations: { x: { duration: 1, autoplay: true, tracks: { w: [[0, 0], [1, 1]] } } } },
      b: { label: "B", animations: { y: { duration: 1, autoplay: true, tracks: { w: [[0, 0], [1, 1]] } } } },
    },
  });
  expect(findingsFor(part, "animation-autoplay-invalid")).toHaveLength(0);
});
```

(`base(…)`/`withAnim(view, anims)`/`findingsFor(part, id)` — follow whatever helper shape the existing file uses; if it calls `lintPart` and filters by id, keep that.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/lint-animations.test.js`
Expected: FAIL — old walk finds nothing under `views`, new rules don't exist.

- [ ] **Step 3: Rework `src/framework/lint/rules-animations.js`**

1. Replace the entry walk. Every rule's `for (const [name, a] of animEntries(part))` loop becomes a walk over view-scoped entries carrying their path prefix:

```js
// [{ view, name, a, base }] pairs, only when blocks are well-shaped enough to
// walk; `base` is the finding-path prefix `views.<view>.animations.<name>`.
const animEntries = (part) => {
  const out = [];
  if (!isPlainObject(part?.views)) return out;
  for (const [view, v] of Object.entries(part.views)) {
    if (!isPlainObject(v) || !isPlainObject(v.animations)) continue;
    for (const [name, a] of Object.entries(v.animations)) {
      if (isPlainObject(a)) out.push({ view, name, a, base: `views.${view}.animations.${name}` });
    }
  }
  return out;
};
```

Then mechanically: destructure `{ view, name, a, base }`, and every path template swaps its `animations.${name}` prefix for `${base}`.

2. `animations-not-object` splits into two concerns: the new clean-break rule, and per-view shape checks:

```js
  {
    id: "animation-not-in-view",
    run: ({ part }) => (part?.animations === undefined ? [] : [
      err("animation-not-in-view",
        "`animations` moved into views — a top-level block is ignored at runtime",
        "Declare each animation under its owning view: `views.<name>.animations = { <anim>: { … } }`. The transport bar shows only the active view's animations.",
        "animations"),
    ]),
  },
```

and `animations-not-object` re-targets `views.<v>.animations` (non-object block; non-object entries), with paths `views.${view}.animations` / `views.${view}.animations.${name}`.

3. `animation-tracks-or-steps` learns opacity. In its body: `const hasSingle = a.tracks !== undefined || a.opacity !== undefined;` replaces `hasTracks` in the XOR check (message: "A single-phase animation declares `tracks` and/or `opacity` with a `duration`; a stepped one declares `steps: […]`. Never both forms, never neither."). The animates-nothing check becomes `const animated = (s) => (isPlainObject(s.tracks) && Object.keys(s.tracks).length > 0) || (isPlainObject(s.opacity) && Object.keys(s.opacity).length > 0);` — at least one step must satisfy it, and a per-step finding fires only when a step has no tracks, no opacity, AND no camera.

4. `animation-keyframes-invalid` walks BOTH fields: wrap its inner loop as `for (const field of ["tracks", "opacity"])` over `Object.entries(isPlainObject(s[field]) ? s[field] : {})`, path `…steps[${i}].${field}.${key}`.

5. New opacity rules:

```js
  {
    id: "animation-opacity-unknown-part",
    run: ({ part }) => {
      const out = [];
      for (const { view, name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.opacity) ? s.opacity : {})) {
            const sub = isPlainObject(part?.parts) ? part.parts[key] : undefined;
            const inView = isPlainObject(sub) && Array.isArray(sub.views) && sub.views.includes(view);
            if (!inView) {
              out.push(err("animation-opacity-unknown-part",
                `animation "${name}" fades "${key}", which is not a sub-part of view "${view}"`,
                `Opacity tracks name sub-parts of the owning view — add "${view}" to \`parts.${key}.views\`, or correct the key.`,
                `${base}${a.steps ? `.steps[${i}]` : ""}.opacity.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-opacity-range",
    run: ({ part }) => {
      const out = [];
      for (const { name, a, base } of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.opacity) ? s.opacity : {})) {
            if (!validKeyframes(kf)) continue; // keyframes rule already reported it
            if (kf.some(([, v]) => v < 0 || v > 1)) {
              out.push(err("animation-opacity-range",
                `animation "${name}" opacity track "${key}" has values outside 0..1`,
                "Opacity is 0 (fully hidden) to 1 (normal); it multiplies any static `display.opacity`.",
                `${base}${a.steps ? `.steps[${i}]` : ""}.opacity.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
```

6. `animation-autoplay-invalid`: track `first` per VIEW (`const firstByView = new Map()`), message "…both declare `autoplay` in view "${view}"".

7. `animation-track-rebuilds` / `classifyTrack`: pass the owning `view` down and probe only that view's sub-parts (drop the outer `for (const view of Object.keys(part.views))` loop; keep the body against the single owning view). Signature: `classifyTrack(part, p, key, v0, v1, view)`.

8. `rawSteps` bare-form synthesis keeps opacity: `[{ ...a, label: null }]` already carries `a.opacity` through — no change, but verify `animation-unknown-param`/`-param-not-numeric`/`-value-out-of-range` still read `s.tracks` only (they must NOT walk opacity — opacity keys are sub-parts, not params).

- [ ] **Step 4: Run the lint tests**

Run: `npx vitest run test/lint-animations.test.js test/lint-registry.test.js test/lint-purity.test.js`
Expected: PASS. If `lint-registry` pins the rule-id list, add the two new ids where it says to.

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-animations.js test/lint-animations.test.js test/lint-registry.test.js
git commit -m "feat(lint): view-owned animation paths, opacity rules, clean-break animation-not-in-view"
```

---

### Task 6: CLI + headless render

**Files:**
- Modify: `bin/cli.js` (the `render` command), `src/testing/render.js`
- Test: `test/render-animation-cli.test.js`

**Interfaces:**
- Consumes: `viewAnimations`, `evaluate` (Task 1).
- Produces: `renderViews(kernel, part, view, opts)` gains `opts.opacity` (`Record<subPartName, number>`, default `{}`): a mesh at `0` is skipped entirely (faces and edges); `0 < v < 1` blends the part's shaded color toward the background by `1 - v` (a z-buffered approximation — the faded part still occludes; documented in a code comment).

- [ ] **Step 1: Update fixtures and write the failing tests**

`test/render-animation-cli.test.js` drives the CLI against a fixture part. Move that fixture's animations under views per the new shape, and give it TWO views to exercise resolution — one with an `assemble` animation carrying an opacity fade step. Add:

```js
test("--animation resolves its owning view when the name is unique", async () => {
  // fixture: animation "open" lives in view "assembly", NOT the default view
  const { stdout } = await runCli(["render", fixturePath, "--animation", "open", "--at", "1", "--out", outDir]);
  // written filenames carry the view slug — assert the owning view's, not the default's
  expect(stdout).toMatch(/-assembly-/);
});

test("--animation with a name shared by two views demands the positional view", async () => {
  const { code, stderr } = await runCli(["render", ambiguousFixturePath, "--animation", "shared", "--out", outDir]);
  expect(code).toBe(1);
  expect(stderr).toMatch(/ambiguous/i);
  expect(stderr).toMatch(/positional/i);
});

test("positional view + --animation not in that view is an error naming the owner", async () => {
  const { code, stderr } = await runCli(["render", fixturePath, "box", "--animation", "open", "--out", outDir]);
  expect(code).toBe(1);
  expect(stderr).toMatch(/view "assembly"/);
});

test("a still mid-fade renders the faded part dimmer; at opacity 0 it is absent", async () => {
  // Bypass the CLI for this one: call renderViews directly with an opacity map
  // and compare total non-background luminance — absent < faded < full. This
  // pins the renderViews contract the CLI feeds evaluate()'s opacity into.
  const { renderViews } = await import("../src/testing/render.js");
  const luminance = (file) => {
    const png = PNG.sync.read(readFileSync(file));
    let sum = 0;
    for (let i = 0; i < png.data.length; i += 4) sum += png.data[i] + png.data[i + 1] + png.data[i + 2];
    return sum;
  };
  const opts = { views: ["front"], out: outDir, size: [200, 150] };
  const [hidden] = await renderViews(kernel, part, "assembly", { ...opts, tag: "o0", opacity: { lid: 0 } });
  const [faded] = await renderViews(kernel, part, "assembly", { ...opts, tag: "o5", opacity: { lid: 0.5 } });
  const [full] = await renderViews(kernel, part, "assembly", { ...opts, tag: "o1", opacity: {} });
  expect(luminance(hidden)).toBeLessThan(luminance(faded));
  expect(luminance(faded)).toBeLessThan(luminance(full));
});
```

(Adapt helper names — `runCli`, fixture paths — to what the file actually uses; the four behaviors above are what must be pinned.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/render-animation-cli.test.js`
Expected: FAIL — CLI still reads `part.animations`.

- [ ] **Step 3: Implement**

`bin/cli.js` — import `viewAnimations` alongside the existing animation imports; replace the `render` command's animation resolution (current lines ~196–200):

```js
      // Resolve --animation across views: a unique name implies its owning
      // view (overriding the default-view rule); an ambiguous one needs the
      // positional view argument. NOT a --view flag: --views already means
      // camera angles.
      const byView = viewAnimations(part);
      const owners = [...byView.entries()]
        .filter(([, anims]) => anims.some((x) => x.name === flags.animation))
        .map(([v]) => v);
      let animView;
      if (view !== undefined) {
        if (!owners.includes(view)) {
          throw new Error(owners.length
            ? `animation "${flags.animation}" is not in view "${view}" — it lives in view ${owners.map((v) => `"${v}"`).join(", ")}`
            : `unknown animation "${flags.animation}" (declared: ${[...byView.values()].flat().map((x) => x.name).join(", ") || "none"})`);
        }
        animView = view;
      } else if (owners.length === 1) {
        animView = owners[0];
      } else if (owners.length > 1) {
        die(`--animation "${flags.animation}" is ambiguous (views ${owners.map((v) => `"${v}"`).join(", ")}) — pass the positional view argument\n${usage}`);
      } else {
        throw new Error(`unknown animation "${flags.animation}" (declared: ${[...byView.values()].flat().map((x) => x.name).join(", ") || "none"})`);
      }
      const anim = byView.get(animView).find((x) => x.name === flags.animation);
```

and the frame loop passes the owning view + opacity through:

```js
      for (const frame of frames) {
        const { values, opacity } = evaluate(anim, frame.t);
        const cue = cueAt(anim, frame.cueT ?? frame.t);
        const frameViews = views ?? (cue ? [cue.view] : undefined);
        const files = await renderViews(kernel, part, animView, {
          views: frameViews, out: outDir, params: { ...baseParams, ...values }, tag: frame.tag, opacity,
        });
        for (const f of files) console.log(`wrote ${f}`);
      }
```

(`anim` is already normalized by `viewAnimations` — delete the old `normalizeAnimation` call here; keep the import only if the non-render commands use it, else drop it.)

`src/testing/render.js` — thread names + opacity:

```js
export async function renderViews(kernel, part, view = Object.keys(part.views)[0], {
  views = ["iso", "front", "top"], out = "render", size = [800, 600], edges = true, params = {}, tag = "", opacity = {},
} = {}) {
  …
  // keep names: opacity is keyed by sub-part
  const built = buildView(kernel, part, view, params);
  const meshes = built
    .filter((b) => (opacity[b.name] ?? 1) > 0)      // fully hidden: absent from the still
    .map((b) => ({ name: b.name, mesh: b.mesh }));
```

Bounds/`kernel.cleanup` loops iterate `meshes.map((x) => x.mesh)`. In the per-angle raster loop, fade by pre-blending the part's base + edge colors toward `bg` (a z-buffered approximation — a faded part still occludes what's behind it; full transparency sorting is out of scope for a software rasterizer, and stills only need "reads as faded"):

```js
    for (const { name, mesh: m } of meshes) {
      const v = Math.min(1, opacity[name] ?? 1);
      const faded = v < 1
        ? base.map((c, i) => Math.round(c * v + bg[i] * (1 - v)))
        : base;
      …rasterTri(sp, inten, faded, color, zbuf, W, H);
    }
    if (edges) {
      for (const { name, mesh: m } of meshes) {
        const v = Math.min(1, opacity[name] ?? 1);
        const fadedEdge = v < 1
          ? edgeColor.map((c, i) => Math.round(c * v + bg[i] * (1 - v)))
          : edgeColor;
        …drawLine(…, fadedEdge, …);
      }
    }
```

- [ ] **Step 4: Run the CLI/render tests**

Run: `npx vitest run test/render-animation-cli.test.js test/render.test.js test/render-angles.test.js test/cli.test.js test/lint-cli.test.js`
Expected: PASS (render/cli suites that build fixture parts may need the same fixture-shape move — grep them for `animations:`).

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js src/testing/render.js test/render-animation-cli.test.js
git commit -m "feat(cli): cross-view --animation resolution + faded/hidden parts in headless stills"
```

---

### Task 7: Types

**Files:**
- Modify: `types/part.d.ts`, `types/index.d.ts`
- Test: `test/types-surface.test.js` (run as-is; extend only if it pins the moved members)

**Interfaces:**
- Consumes: the shapes locked in Tasks 1–3.
- Produces: the public TS contract other repos (partforge-cloud) compile against.

- [ ] **Step 1: Update `types/part.d.ts`**

- `AnimationStep` gains:

```ts
  /**
   * Sub-part name → opacity keyframes (values 0–1; 0 = fully hidden, mesh and
   * edge lines both; multiplies any static `display.opacity`). Same keyframe
   * rules as `tracks`; the same hold rule applies across steps. Display-only:
   * never affects params, export, measure, or verify.
   */
  opacity?: Record<string, Keyframes>;
```

- The single-phase arm of `AnimationSpec` becomes "tracks and/or opacity, at least one" (a union of the two ways to satisfy it):

```ts
export type AnimationSpec =
  | (AnimationSpecCommon & {
      /** Seconds — the whole animation's duration in the single-phase form. */
      duration: number;
      /** Param key -> keyframes. */
      tracks: Record<string, Keyframes>;
      /** Sub-part name -> opacity keyframes (see AnimationStep.opacity). */
      opacity?: Record<string, Keyframes>;
      steps?: never;
    })
  | (AnimationSpecCommon & {
      duration: number;
      tracks?: Record<string, Keyframes>;
      /** An opacity-only animation is legal — a pure fade. */
      opacity: Record<string, Keyframes>;
      steps?: never;
    })
  | (AnimationSpecCommon & {
      /** The multi-step form; each step carries its own relative `duration`. */
      steps: AnimationStep[];
      tracks?: never;
      opacity?: never;
      duration?: never;
    });
```

- `AnimationSpecCommon.autoplay` doc: "At most one animation per VIEW may set this".
- `ViewDefinition` gains `animations?: Record<string, AnimationSpec>` with a doc comment pointing at the spec; `PartDefinition.animations` is REMOVED (clean break — leave a `@deprecated`-free absence, the lint error is the migration message).

- [ ] **Step 2: Update `types/index.d.ts`**

- `AnimationState` gains `view: string`; its doc notes `animation: string | null` while the active view has none (adjust the field if it's currently non-nullable).
- `AnimationRuntime.play` doc: resolves within the ACTIVE view.
- `PartRuntime.animation` doc: "null when no view declares an `animations` block".

- [ ] **Step 3: Run the types test**

Run: `npx vitest run test/types-surface.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add types/part.d.ts types/index.d.ts
git commit -m "feat(types): view-owned animations + opacity tracks in the public contract"
```

---

### Task 8: Reference part, docs, version bump, full suite

**Files:**
- Modify: `src/parts/hinged-box.js`, `test/hinged-box-part.test.js`, `docs/AUTHORING-PARTS.md`, `package.json`
- Check (modify only if a grep hits): `docs/ERROR-PATTERNS.md`, `skills/`, `src/app-hinged-box.js`, `test/framework/docs-coherence.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: the shipped documentation the downstream prompt corpus regenerates from.

- [ ] **Step 1: Update the failing reference-part test first**

`test/hinged-box-part.test.js` — swap the `normalizeAnimations` import for `viewAnimations` and pin the new shape, including the fade step:

```js
import { viewAnimations, evaluate } from "../src/framework/animation.js";

test("animations are view-owned: box view carries all three", () => {
  const byView = viewAnimations(part);
  expect([...byView.keys()]).toEqual(["box"]);
  const [open, cycle, assemble] = byView.get("box");
  expect(open.cues).toEqual([{ t: 0, view: "front" }]);
  expect(cycle.loop).toBe(true);
  expect(assemble.steps.map((s) => s.label)).toEqual(
    ["Lid appears", "Lower the lid", "Open to check clearance"]);
  expect(evaluate(open, 1).values.lidAngle).toBe(110);
});

test("assemble fades the lid in, then moves it", () => {
  const assemble = viewAnimations(part).get("box").find((a) => a.name === "assemble");
  expect(assemble.opacityKeys).toEqual(["lid"]);
  expect(evaluate(assemble, 0).opacity.lid).toBe(0);        // absent at the start
  expect(evaluate(assemble, 1 / 3).opacity.lid).toBe(1);    // fully in when motion starts
  expect(evaluate(assemble, 1).opacity.lid).toBe(1);        // holds through later steps
});
```

Run: `npx vitest run test/hinged-box-part.test.js` — Expected: FAIL.

- [ ] **Step 2: Restructure `src/parts/hinged-box.js`**

Move the `animations` block inside the view and add the fade-in step (three steps total, equal-ish durations; the lid starts hidden, appears, lowers, opens):

```js
  views: {
    box: {
      label: "Box",
      animations: {
        open: {
          label: "Open lid",
          description: "Swings the lid to **110°** about the rear hinge line.\n\nPose-only: playback runs at frame rate with no geometry rebuild.",
          camera: "front",
          duration: 1.2,
          tracks: { lidAngle: [[0, 0], [1, 110]] },
        },
        cycle: {
          label: "Open / close",
          duration: 2.4,
          loop: true,
          easing: "linear",
          autoplay: true,
          tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] },
        },
        assemble: {
          label: "Assemble",
          description: "How the parts come together: the lid fades in above the base, drops on, then swings open to check hinge clearance.",
          steps: [
            { label: "Lid appears", camera: "iso", duration: 0.8,
              opacity: { lid: [[0, 0], [1, 1]] },
              tracks: { lidLift: [[0, 40], [1, 40]] } },
            { label: "Lower the lid", camera: "left", duration: 1.0,
              tracks: { lidLift: [[0, 40], [1, 0]] } },
            { label: "Open to check clearance", camera: "iso", duration: 1.0,
              tracks: { lidAngle: [[0, 0], [1, 110]] } },
          ],
        },
      },
    },
  },
```

(The `lidLift` hold-track in step 1 pins the lift at 40 while the lid fades in, so step 2's drop starts from where the fade showed it — without it the lift would hold step 2's FIRST keyframe, which is also 40, but stating it makes the pose explicit and survives someone retuning step 2. Header comment: update the file's top comment to say the animations demonstrate view ownership + opacity fade.)

Run: `npx vitest run test/hinged-box-part.test.js` then `npx vitest run test/lint-authored.test.js test/lint-parts.test.js` (the authored-parts lint suite must stay clean against the new shape). Expected: PASS.

- [ ] **Step 3: Rewrite the docs**

`docs/AUTHORING-PARTS.md`:
- The `views:` line in the default-export sketch (~line 88) becomes: `views: { <name>: { label, default?, animations? } },  // view tabs; a view may own animations (below)`.
- The "Animations" section: declare under `views.<name>.animations`; the transport bar appears only on views that declare animations, listing exactly that view's set; a view switch resets playback. Document `opacity` beside `tracks`: keyed by sub-part of the owning view, values 0–1, same keyframe + hold rules, 0 hides mesh and edge lines, multiplies static `display.opacity`, display-only (contrast with the existing "exporting while paused exports the posed state" note — opacity never exports), pure-fade animations legal, autoplay one-per-view. Update the worked example to the new hinged-box shape (paste the real block). Update the headless paragraph: `--animation` implies its owning view; an ambiguous name needs the positional view argument.
- Grep for stragglers: `grep -n "part.animations\|animations:" docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md skills/ -r` — update any hit that still teaches the top-level shape (ERROR-PATTERNS' `animation-plays-choppy` fix text references the section by name only; leave unless it states the shape).

- [ ] **Step 4: Version bump + full suite**

- `package.json` → `"version": "0.49.0"`.
- Run: `npm test`
  Expected: PASS across the board. Chase any suite still building parts with top-level `animations` (grep `test/ -rn "animations:"` and move fixtures to the view-owned shape).
- Run: `npx vitest run test/framework/docs-coherence.test.js` — PASS (extend its keyword list only if it names animation keywords).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(animations)!: view-owned animations with opacity fades; hinged-box + docs; 0.49.0

BREAKING CHANGE: part-level \`animations\` moved to \`views.<name>.animations\`;
lint reports animation-not-in-view and the runtime ignores the old key."
```

---

## Post-merge follow-up (separate repo, not part of this plan)

partforge-cloud: bump the `partforge` dependency to 0.49.0, then `npm run docs:generate && npm run prompt:generate` and READ the prompt diff (repo convention — this is how the authoring LLM learns the new contract, including the `views:` sketch line that now carries `animations`). The compact prompt's inline default-export sketch should show `animations?` under views after regeneration; verify `tests/unit/doc-corpus.test.js` and `tests/unit/authoring-prompt.test.js` pass there.
