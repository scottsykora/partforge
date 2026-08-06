# Autoplay + Turntable Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the idle auto-rotate turntable (button + machinery + preference) and let a part mark one animation `autoplay: true`, started on first show and every view switch until the user manually interacts.

**Architecture:** Pure deletion of the turntable stack (viewer → chrome → persistence → smoke script), then a small `autoplayArmed` flag in the existing transport driver with a `autoplayKick()` handle method that mount calls from its two existing lifecycle points (first `ready`, tab `onChange`). One new lint rule.

**Tech Stack:** Plain ESM JS, vitest (`happy-dom` for DOM tests), Node 24.

**Spec:** `docs/superpowers/specs/2026-08-03-autoplay-turntable-removal-design.md`.

## Global Constraints

- **Node 24**: `source ~/.nvm/nvm.sh && nvm use` before any npm/vitest/node command.
- Plain ESM JS; lint purity unchanged (`animation.js` stays import-free).
- Never run the whole suite mid-task; full `npm test` + `npm run check` happen once, in Task 4.
- Line numbers below were verified on branch `claude/autoplay-turntable` at `1e6f763` — re-anchor by content if drifted.
- `autoplay` semantics: trigger on first ready + every view switch; ANY manual transport interaction (play button, scrub, picker, step prev/next, reset, every `runtime.animation` method) or `notifyUserEdit()` disarms for the session. `play()` while already `playing`/`intro` stays a no-op.

---

### Task 1: Remove the turntable

**Files:**
- Modify: `src/framework/viewer.js` (lines ~117-118, ~367-380, exports ~682-683), `src/framework/viewer-controls.js`, `src/framework/view-state.js`, `src/framework/animation-controls.js` (lines ~98, ~221), `src/framework/mount.js` (`els.chrome.pause` resolution), `scripts/check-app.mjs` (~401-405, ~577-580), all 9 `*.html` app pages (the `#pause` button line)
- Test: update `test/framework/viewer-controls.test.js`, `test/view-state.test.js`, `test/framework/animation-controls.test.js` (fake viewers + assertions), `test/framework/mount.test.js` if it references `chrome.pause`

**Interfaces:**
- Produces: viewer WITHOUT `setAutoRotate`/`suppressAutoRotate`; `attachViewerControls(viewer, { reframe, theme }, { tooltip })` (no `pause`); `view-state.js` without `loadRotating`/`saveRotating`. Task 2 relies on `animation-controls.js` no longer calling `suppressAutoRotate`.

- [ ] **Step 1: Delete in dependency order, updating tests as you go (red→green per file)**

a. `src/framework/viewer.js`:
   - Remove `controls.autoRotate = true;` and `controls.autoRotateSpeed = 1.6;` (117-118).
   - Replace the whole block at 367-380 (`let autoRotateRequested…` through `suppressAutoRotate`'s close) — `setCutawayEnabled` keeps its `cutaway.setEnabled` call but loses `syncAutoRotate()`:

```js
  function setCutawayEnabled(on) {
    return cutaway.setEnabled(on);
  }
```

   - Remove `setAutoRotate,` and `suppressAutoRotate,` from the returned object.

b. `src/framework/animation-controls.js`: delete `viewer.suppressAutoRotate(active);` from `syncUi()` (~98; the `active` const stays — the play button text uses it) and `viewer.suppressAutoRotate(false);` from `detach()` (~221). Update `test/framework/animation-controls.test.js`: remove `suppressAutoRotate` from both fake viewers and delete/adjust the assertions that reference it (the "play runs the intro tween" test asserts `suppressAutoRotate` was called — drop just that expectation; the "user orbit disarms cues" test asserts `lastCalledWith(false)` — drop that line).

c. `src/framework/viewer-controls.js`: remove the pause button entirely — the `pause: pauseBtn` destructure, `loadRotating`/`saveRotating` from the import, the `let rotating…` through `pauseBtn?.addEventListener…` block, the `pauseBtn` entries in the tooltip binding array and `detach()`. Update `test/framework/viewer-controls.test.js`: delete the pause/rotation test cases and the `setAutoRotate` key from its `fakeViewer()`.

d. `src/framework/view-state.js`: remove `loadRotating`/`saveRotating` (and their storage key); update `test/view-state.test.js` (delete the rotating round-trip test).

e. `src/framework/mount.js`: remove `pause: elements.chrome?.pause ?? byId("pause"),` from `els.chrome` and stop passing it (attachViewerControls receives the object as-is — just ensure no stale reference).

f. All 9 HTML pages (`demo.html bracket.html faceted-vase.html filleted-box.html hull-sweep.html nameplate.html hinged-box.html text-smoke.html planter.html`): delete the `<button id="pause" …>⏸</button>` line.

g. `scripts/check-app.mjs`: delete both pause-click blocks (the `const pauseButton…` `if…click()` at ~401-405 and its twin at ~577) and reword the adjacent comments — the canvas is static at idle now; the frame-wait + consecutive-identical-screenshot loops stay as cheap insurance.

- [ ] **Step 2: Run the affected tests**

Run: `npx vitest run test/framework/viewer-controls.test.js test/view-state.test.js test/framework/animation-controls.test.js test/framework/mount.test.js test/framework/viewer-active.test.js test/framework/viewer-cutaway.test.js`
Expected: PASS. Then one smoke: `node scripts/check-app.mjs demo.html` → exit 0.
Also: `grep -rn "autoRotate\|setAutoRotate\|suppressAutoRotate\|loadRotating\|saveRotating\|id=\"pause\"" src/ scripts/ *.html` → no hits.

- [ ] **Step 3: Commit**

```bash
git add -A src/ scripts/ test/ *.html
git commit -m "feat!: remove the idle auto-rotate turntable and its pause button"
```

---

### Task 2: Autoplay — engine flag, driver, mount wiring, example

**Files:**
- Modify: `src/framework/animation.js` (normalizeAnimation), `src/framework/animation-controls.js`, `src/framework/mount.js`, `src/parts/hinged-box.js`
- Test: `test/framework/animation.test.js`, `test/framework/animation-controls.test.js`

**Interfaces:**
- Consumes: Task 1's suppression-free driver.
- Produces: normalized `anim.autoplay` boolean; driver handle gains `autoplayKick()`; mount calls it on first `ready` and on tab `onChange`. Task 3's lint rule reads raw `spec.autoplay`.

- [ ] **Step 1: Failing tests**

Append to `test/framework/animation.test.js`:

```js
test("normalizeAnimation carries autoplay as a boolean, default false", () => {
  expect(normalizeAnimation("x", { duration: 1, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(false);
  expect(normalizeAnimation("x", { duration: 1, autoplay: true, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(true);
});
```

Append to `test/framework/animation-controls.test.js` (reuse its fixture style; add `autoplay: true` to a copy of the part):

```js
const autoPart = {
  animations: {
    open: part.animations.open,
    cycle: { label: "Cycle", duration: 2, loop: true, easing: "linear", autoplay: true,
      tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] } },
  },
};

test("autoplayKick selects and plays the autoplay animation", () => {
  const { ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  expect(ctl.runtime.state()).toMatchObject({ animation: "cycle", status: "playing" }); // no cue → straight to playing
});

test("autoplayKick while already playing is a no-op; re-kick after a view switch keeps the loop running", () => {
  const { ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  ctl.__viewer.frame(0.5);
  const t = ctl.runtime.state().t;
  ctl.autoplayKick(); // tab switch while looping
  expect(ctl.runtime.state().status).toBe("playing");
  expect(ctl.runtime.state().t).toBeCloseTo(t); // not restarted
});

test("manual interaction disarms autoplay for the session", () => {
  const { container, ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  container.querySelector(".pf-anim-play").click(); // user pauses
  ctl.autoplayKick(); // next tab switch
  expect(ctl.runtime.state().status).toBe("paused"); // stayed paused
});

test("a param edit that pauses playback also disarms autoplay", () => {
  const { ctl } = setup(autoPart); handles.push(ctl);
  ctl.autoplayKick();
  ctl.notifyUserEdit();
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("paused");
});

test("no autoplay animation → autoplayKick is a harmless no-op", () => {
  const { ctl } = setup(); handles.push(ctl); // original two-animation part, no autoplay
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("idle");
});
```

Run: `npx vitest run test/framework/animation.test.js test/framework/animation-controls.test.js` — new tests FAIL.

- [ ] **Step 2: Implement**

a. `src/framework/animation.js` — in `normalizeAnimation`'s returned object add `autoplay: !!spec.autoplay,` (beside `loop`).

b. `src/framework/animation-controls.js`:

```js
  // Autoplay: at most one animation declares it (lint-enforced). Armed until
  // the user manually touches the transport — after that, view switches stop
  // restarting it so it never fights the user.
  const autoplayAnim = animations.find((a) => a.autoplay) ?? null;
  let autoplayArmed = !!autoplayAnim;
  const disarmAutoplay = () => { autoplayArmed = false; };
```

Call `disarmAutoplay()` at the top of: `onPlayClick`, `onScrub`, `onPrev`, `onNext`, `onPick`, `doReset`, every `runtime` method (`play`, `pause`, `seek`, `stop`), and `notifyUserEdit`. Add to the returned handle (beside `notifyUserEdit`):

```js
    // Mount calls this on first ready and on every view/tab switch.
    autoplayKick() {
      if (!autoplayArmed || !autoplayAnim) return;
      if (current !== autoplayAnim) selectAnimation(autoplayAnim.name);
      const { status } = playback.state();
      if (status !== "playing" && status !== "intro") apply(playback.play());
    },
```

Note: `selectAnimation` and `doReset` run inside `autoplayKick` via the un-disarmed path — make sure `doReset` inside `selectAnimation` doesn't disarm when invoked from `autoplayKick` (simplest: `disarmAutoplay()` lives in the EVENT HANDLERS `onPick`/reset-button listener, not inside `selectAnimation`/`doReset` themselves; the runtime methods disarm explicitly).

c. `src/framework/mount.js` — two one-liners:
   - View tabs `onChange` (line ~215): append `animCtl?.autoplayKick();` after `loop.kick();`.
   - First ready (line ~387): after `resolveReady();` add `animCtl?.autoplayKick();` (inside the same `if (!readySettled)` branch).

d. `src/parts/hinged-box.js`: add `autoplay: true,` to the `cycle` animation.

- [ ] **Step 3: Run**

Run: `npx vitest run test/framework/animation.test.js test/framework/animation-controls.test.js test/framework/mount.test.js test/hinged-box-part.test.js`
Expected: PASS. Then `node scripts/check-app.mjs hinged-box.html` → exit 0 (the cycle now autostarts; the check's stabilization must still find a static baseline — the check pauses nothing anymore, so IF the stability loop fails on the looping canvas, the check clicks nothing… verify: the demo/planter pages have no autoplay so they're static; for hinged-box the baseline loop tolerates up to 15×200 ms — if it reports "never stabilized", add a transport pause click to check-app's capture check ONLY when `.pf-anim-play` shows ⏸ (mirror the removed #pause pattern with `.pf-anim-play`), and note it in the report).

- [ ] **Step 4: Commit**

```bash
git add src/ test/ 
git commit -m "feat(animation): autoplay: true — auto-start on first show and view switches"
```

---

### Task 3: Lint rule `animation-autoplay-invalid`

**Files:**
- Modify: `src/framework/lint/rules-animations.js`, `docs/AUTHORING-PARTS.md` (rule catalog "Animations block" entry)
- Test: `test/lint-animations.test.js`

- [ ] **Step 1: Failing tests** (append; reuse `base()`/`withAnim` fixtures):

```js
test("autoplay must be boolean and unique", () => {
  expect(ids(lintPart(withAnim({ ...valid, autoplay: "yes" })))).toContain("animation-autoplay-invalid");
  const two = { ...base(), animations: {
    a: { duration: 1, autoplay: true, tracks: { a: [[0, 0], [1, 1]] } },
    b: { duration: 1, autoplay: true, tracks: { a: [[0, 1], [1, 0]] } },
  } };
  expect(ids(lintPart(two))).toContain("animation-autoplay-invalid");
  expect(ids(lintPart(withAnim({ ...valid, autoplay: true }))).filter((i) => i === "animation-autoplay-invalid")).toEqual([]);
});
```

- [ ] **Step 2: Implement** (append to `ANIMATION_RULES`):

```js
  {
    id: "animation-autoplay-invalid",
    run: ({ part }) => {
      const out = [];
      let first = null;
      for (const [name, a] of animEntries(part)) {
        if (a.autoplay !== undefined && typeof a.autoplay !== "boolean") {
          out.push(err("animation-autoplay-invalid",
            `animation "${name}" \`autoplay\` is not a boolean`,
            "Use `autoplay: true` on the one animation that should start on its own.",
            `animations.${name}.autoplay`));
          continue;
        }
        if (a.autoplay !== true) continue;
        if (first == null) { first = name; continue; }
        out.push(err("animation-autoplay-invalid",
          `animations "${first}" and "${name}" both declare \`autoplay\``,
          "Only one animation can auto-start — remove `autoplay` from all but one.",
          `animations.${name}.autoplay`));
      }
      return out;
    },
  },
```

Add the id to the "Animations block" rule-catalog entry in `docs/AUTHORING-PARTS.md` (the lint-registry test greps it).

- [ ] **Step 3: Run + commit**

Run: `npx vitest run test/lint-animations.test.js test/lint-registry.test.js test/lint-parts.test.js` — PASS (hinged-box has exactly one autoplay). `npx partforge lint src/parts/hinged-box.js` → clean.

```bash
git add src/framework/lint/rules-animations.js docs/AUTHORING-PARTS.md test/lint-animations.test.js
git commit -m "feat(lint): animation-autoplay-invalid — one boolean autoplay per part"
```

---

### Task 4: Docs sweep, version, full verification

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (Animations section: document `autoplay`; sweep turntable/pause/auto-rotate references repo-docs-wide), `README.md` (same sweep + autoplay mention), `src/framework/mount.js` (embedding-contract comment → 0.44.0, note `animation` autoplay behavior in one line), `package.json` (0.43.0 → 0.44.0)

- [ ] **Step 1: Edits**

- AUTHORING-PARTS Animations rules list, add: `- \`autoplay: true\` (optional, one animation at most) starts that animation on first show and again on each view switch, until the user touches the transport. Lint: \`animation-autoplay-invalid\`.`
- `grep -rn "turntable\|auto-rotat\|Pause rotation\|pause button" docs/ README.md src/` — update every stale reference (ERROR-PATTERNS wording included if it mentions the turntable).
- package.json → `0.44.0`; mount.js contract comment → `(0.44.0)`.

- [ ] **Step 2: Full verification**

```bash
npm test
npm run check
```
Expected: both green.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: autoplay contract + turntable removal sweep; bump 0.44.0"
```

## Out of scope

Per-view autoplay; autoplay delay/once modes; re-arm UI; partforge-cloud updates.
