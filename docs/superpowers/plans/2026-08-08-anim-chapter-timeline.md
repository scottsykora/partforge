# Chapter Hover-Reveal Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transport bar's step label + step-paging buttons with a chapter-name bubble revealed along the scrubber timeline, and add whole-animation `‹`/`›` pagers bookending the card for multi-animation parts.

**Architecture:** All UI changes live in `src/framework/animation-controls.js` (the transport bar) plus its CSS in `src/framework/app.css`. Chapter lookup reuses `stepIndexAt(anim, t)` already exported by `src/framework/animation.js` — the playback state machine is untouched. A small exported pure helper (`clampBubbleX`) makes the bubble's clamping unit-testable, following the file's existing `planAnimBarPlacement` pattern.

**Tech Stack:** Vanilla JS (plain ESM), vitest + happy-dom for unit tests, Playwright Chromium via `scripts/check-app.mjs` for the final smoke run.

**Spec:** `docs/superpowers/specs/2026-08-08-anim-chapter-timeline-design.md`

## Global Constraints

- **Node 24 required** — prefix every `node`/`npm`/`npx` command with `nvm use && ` (default shell Node is v16; shell state does not persist between commands).
- **Bubble appears only when `current.steps.length > 1`;** the animation pager renders only when `animations.length > 1`. Single-step / single-animation parts see neither.
- **Text-write rule (documented at the top of `syncUi` in animation-controls.js):** any element whose text can change while the user might be pressing it must go through `textSetter`, and per-frame renderers early-leave when their value is unchanged. The bubble is non-interactive (`pointer-events: none`, `aria-hidden`), so plain `textContent` is fine there; `aria-valuetext` is an attribute write (safe), but must still skip unchanged values per the early-leave rule.
- **The placement clamp must keep working:** the bubble is out-of-flow (`position: absolute`) so it never changes the bar's size; nothing in this plan touches `applyPlacement` / `planAnimBarPlacement`.
- CSS split: appearance in `app.css`, placement in `chrome.css` — everything here is appearance (the bubble is anchored inside the bar), so **only app.css changes**.
- `PageUp` seeks **forward** (next chapter start), `PageDown` **backward** — matching native slider key direction.
- Pager cycles **with wrap-around** through `selectAnimation` (which already updates `pick.value`).
- Scrubber width: `.pf-anim-scrub-wrap` 140px → **220px**.
- Version bump to **0.47.0** (0.46.4 published on PR #110's merge; this is a visible feature). Bump in the final task only.
- All work on branch `anim-chapter-timeline`.

---

### Task 1: Chapter bubble replaces the step label and step-paging buttons

**Files:**
- Modify: `src/framework/animation-controls.js` (DOM block ~81-108, `syncStructure` ~111-125, renderers ~145-174, listeners ~252-272, `detach` ~372-385, import line 8)
- Modify: `src/framework/app.css` (`.pf-anim-step` rule ~243-247, `.pf-anim-scrub-wrap` width ~248)
- Test: `test/framework/animation-controls.test.js`

**Interfaces:**
- Consumes: `stepIndexAt(anim, t)` from `./animation.js` (already exported): step index containing t, boundaries belong to the later step, t clamps to [0,1].
- Produces: `clampBubbleX(fraction, wrapWidth, bubbleWidth)` → center-x px, exported from animation-controls.js. Internal functions Tasks 2-3 build on: `showChapterBubble(fraction, { transient })`, `hideChapterBubble()`, and the bubble element `chapterBubble` (class `pf-anim-chapter`, visibility = `pf-show` class). Task 2 also relies on `chapterIndexAt` NOT existing — chapter lookup is `stepIndexAt(current, f)` inline.

- [ ] **Step 1: Write the failing tests**

In `test/framework/animation-controls.test.js`, replace the existing test `"stepped animation shows step chrome and step ticks"` (~line 97) with the tests below, and extend the import line to include the new helper:

```js
import { attachAnimationControls, planAnimBarPlacement, clampBubbleX } from "../../src/framework/animation-controls.js";
```

```js
test("stepped animation shows ticks but no step label or step buttons", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  expect(container.querySelector(".pf-anim-step")).toBeNull();
  expect(container.querySelectorAll(".pf-anim-tick")).toHaveLength(1); // one interior boundary
});

test("chapter bubble follows hover over the scrubber and names the chapter", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  const wrap = container.querySelector(".pf-anim-scrub-wrap");
  wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
  const bubble = container.querySelector(".pf-anim-chapter");
  expect(bubble.classList.contains("pf-show")).toBe(false);
  // assemble: steps Lower (0..0.5) and Open (0.5..1). Hover at 25% → Lower.
  wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 55, bubbles: true }));
  expect(bubble.classList.contains("pf-show")).toBe(true);
  expect(bubble.textContent).toBe("Lower");
  // Hover at 75% → Open.
  wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 165, bubbles: true }));
  expect(bubble.textContent).toBe("Open");
  wrap.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
  expect(bubble.classList.contains("pf-show")).toBe(false);
});

test("scrub input reveals the bubble at the playhead and it fades after the hold", () => {
  vi.useFakeTimers();
  try {
    const { container, ctl } = setup(); handles.push(ctl);
    container.querySelector(".pf-anim-pick").value = "assemble";
    container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
    const scrub = container.querySelector(".pf-anim-scrub");
    const bubble = container.querySelector(".pf-anim-chapter");
    scrub.value = "750";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bubble.classList.contains("pf-show")).toBe(true);
    expect(bubble.textContent).toBe("Open");
    vi.advanceTimersByTime(1100);
    expect(bubble.classList.contains("pf-show")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("single-step animation never shows a bubble", () => {
  const { container, ctl } = setup(); handles.push(ctl); // default animation "open" has one step
  const wrap = container.querySelector(".pf-anim-scrub-wrap");
  wrap.getBoundingClientRect = () => ({ left: 0, right: 220, top: 0, bottom: 14, width: 220, height: 14 });
  wrap.dispatchEvent(new PointerEvent("pointermove", { clientX: 110, bubbles: true }));
  expect(container.querySelector(".pf-anim-chapter").classList.contains("pf-show")).toBe(false);
});

// --- clampBubbleX: pure center-x clamp --------------------------------------
test("clampBubbleX centers, clamps at both ends, and degrades on a too-narrow wrap", () => {
  expect(clampBubbleX(0.5, 220, 60)).toBe(110);   // free middle
  expect(clampBubbleX(0, 220, 60)).toBe(30);      // clamped at the left end
  expect(clampBubbleX(1, 220, 60)).toBe(190);     // clamped at the right end
  expect(clampBubbleX(0.9, 220, 60)).toBe(190);   // clamp engages before the end
  expect(clampBubbleX(0.5, 40, 60)).toBe(20);     // bubble wider than wrap → center it
});
```

Note: happy-dom supports `PointerEvent`; if `new PointerEvent(...)` throws in this environment, fall back to `new MouseEvent("pointermove", ...)` — the handler only reads `clientX`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/animation-controls.test.js`
Expected: FAIL — `clampBubbleX` not exported; `.pf-anim-chapter` not found; the old `"stepped animation shows step chrome"` test is gone (replaced).

- [ ] **Step 3: Implement**

In `src/framework/animation-controls.js`:

3a. Extend the animation.js import (line 8):

```js
import { normalizeAnimations, createPlayback, stepIndexAt } from "./animation.js";
```

3b. After `planAnimBarPlacement`, add the pure helper:

```js
// Center-x for the chapter bubble, in px within the scrub wrap: the bubble
// tracks `fraction` along the timeline but never hangs past either end. A
// wrap narrower than the bubble has no legal band — park it in the middle.
export function clampBubbleX(fraction, wrapWidth, bubbleWidth) {
  if (wrapWidth <= bubbleWidth) return wrapWidth / 2;
  const half = bubbleWidth / 2;
  return Math.min(Math.max(fraction * wrapWidth, half), wrapWidth - half);
}
```

3c. In the DOM block: delete the `prevBtn`, `stepLabel`, `nextBtn` declarations (lines 96-98) and remove them from the `bar.append(...)` call (line 107, which becomes `bar.append(infoSlot, playBtn, scrubWrap, resetBtn);`). After `scrubWrap.append(scrub);` add:

```js
  // Chapter bubble: floats above the scrubber naming the chapter under the
  // pointer (hover) or playhead (scrub). Out-of-flow so it never changes the
  // bar's size — the placement ResizeObserver must not see it. Non-interactive
  // and aria-hidden: the accessible chapter channel is the scrubber's
  // aria-valuetext, not this flag.
  const chapterBubble = el("span", "pf-anim-chapter");
  chapterBubble.setAttribute("aria-hidden", "true");
  scrubWrap.append(chapterBubble);
```

3d. After the DOM block (before `syncStructure`), the bubble machinery:

```js
  // transient = a keyboard/scrub reveal with no pointerleave to end it — it
  // fades on its own instead. A hover reveal stays until the pointer leaves.
  let bubbleFadeTimer = 0;
  function showChapterBubble(fraction, { transient = false } = {}) {
    if (current.steps.length <= 1) return;
    const f = Math.min(1, Math.max(0, fraction));
    chapterBubble.textContent = current.steps[stepIndexAt(current, f)].label;
    const wrapWidth = scrubWrap.clientWidth;
    chapterBubble.style.left = `${clampBubbleX(f, wrapWidth, chapterBubble.offsetWidth)}px`;
    chapterBubble.classList.add("pf-show");
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = 0;
    if (transient) bubbleFadeTimer = setTimeout(hideChapterBubble, 1000);
  }
  function hideChapterBubble() {
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = 0;
    chapterBubble.classList.remove("pf-show");
  }
  const onWrapPointerMove = (e) => {
    const rect = scrubWrap.getBoundingClientRect();
    if (!rect.width) return;
    showChapterBubble((e.clientX - rect.left) / rect.width);
  };
  scrubWrap.addEventListener("pointermove", onWrapPointerMove);
  scrubWrap.addEventListener("pointerleave", hideChapterBubble);
```

3e. In `syncStructure`: delete the line `prevBtn.hidden = nextBtn.hidden = stepLabel.hidden = !stepped;` and add `hideChapterBubble();` right after `title.textContent = current.label;` (switching animations must not leave a stale bubble). The `stepped` const stays (the tick loop uses it).

3f. Delete `renderStepLabel` (lines 159-164), the `setStepText` declaration (line 146), the `shownStep` variable (line 148), the `renderStepLabel(stepIndex)` call in `syncUi` (line 173), and drop `shownStep = null;` from `invalidateUi` (line 178). `syncUi`'s destructuring keeps `stepIndex` only if Task 2 has landed — at this task's end it becomes `const { status, t } = playback.state();`.

3g. Extend `onScrub` (line 262) to reveal the bubble at the playhead — keyboard arrows, mouse drags, and touch drags all fire `input`:

```js
  const onScrub = () => {
    disarmAutoplay();
    const f = Number(scrub.value) / 1000;
    showChapterBubble(f, { transient: true });
    guarded(() => playback.seek(f));
  };
```

3h. Delete `onPrev`/`onNext` (lines 263-264) and their two `addEventListener` lines (269-270). In `detach()`: delete the `prevBtn`/`nextBtn` `removeEventListener` lines and add, before `bar.remove()`:

```js
      scrubWrap.removeEventListener("pointermove", onWrapPointerMove);
      scrubWrap.removeEventListener("pointerleave", hideChapterBubble);
      hideChapterBubble();
```

In `src/framework/app.css`:

3i. Replace the `.pf-anim-step` rule (lines 243-247) with the bubble's, and widen the wrap:

```css
.pf-anim-chapter {
  position: absolute; bottom: calc(100% + 8px); transform: translateX(-50%);
  font-family: var(--pf-mono); font-size: 10px; color: var(--pf-text-2);
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-control); box-shadow: var(--pf-shadow-float);
  padding: 3px 8px; white-space: nowrap;
  pointer-events: none;
  opacity: 0; transition: opacity .12s ease;
}
.pf-anim-chapter.pf-show { opacity: 1; }
```

Change `.pf-anim-scrub-wrap`'s `width: 140px` to `width: 220px`, and inside the existing `@media (prefers-reduced-motion: reduce)` block — app.css has none, so add at the end of the transport-bar section:

```css
@media (prefers-reduced-motion: reduce) {
  .pf-anim-chapter { transition: none; }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvm use && npx vitest run test/framework/animation-controls.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js src/framework/app.css test/framework/animation-controls.test.js
git commit -m "Replace the step label and paging with a chapter bubble on the timeline"
```

---

### Task 2: Accessible chapter channel — aria-valuetext and PageUp/PageDown

**Files:**
- Modify: `src/framework/animation-controls.js` (renderers block, `syncUi`, `invalidateUi`, listeners, `detach`)
- Test: `test/framework/animation-controls.test.js`

**Interfaces:**
- Consumes: Task 1's `showChapterBubble(fraction, { transient: true })`, `stepIndexAt(current, t)`, and the `guarded`/`playback.seek` pattern already in the file.
- Produces: the scrubber (`.pf-anim-scrub`) carries `aria-valuetext` = `"«chapter» — NN%"` (stepped) or `"NN%"` (single-step), and answers PageUp/PageDown with chapter jumps. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/animation-controls.test.js`:

```js
test("aria-valuetext announces chapter and percent", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const scrub = container.querySelector(".pf-anim-scrub");
  expect(scrub.getAttribute("aria-valuetext")).toBe("0%"); // single-step: percent only
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  expect(scrub.getAttribute("aria-valuetext")).toBe("Lower — 0%");
  scrub.value = "750";
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  expect(scrub.getAttribute("aria-valuetext")).toBe("Open — 75%");
});

test("PageUp/PageDown jump chapter boundaries; no-ops for single-step", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  const scrub = container.querySelector(".pf-anim-scrub");
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  // From t=0, PageUp lands on the next boundary (0.5), PageUp again on the end (1).
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(0.5);
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(1);
  // PageDown walks back.
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(0.5);
  scrub.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
  expect(ctl.runtime.state().t).toBeCloseTo(0);
  // Single-step: the key is left to the browser's native coarse seek.
  container.querySelector(".pf-anim-pick").value = "open";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  const ev = new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true });
  scrub.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(ctl.runtime.state().t).toBeCloseTo(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/animation-controls.test.js -t "aria-valuetext"` then `-t "PageUp"`
Expected: FAIL — no `aria-valuetext` attribute; PageUp does nothing (`t` stays 0).

- [ ] **Step 3: Implement**

3a. Next to the other per-frame renderers (`renderPlayButton`), add — following the file's early-leave rule (see the comment block above `setPlayGlyph`):

```js
  // aria-valuetext runs on every frame like the scrubber value; an attribute
  // write never eats clicks (see the WebKit note above), but skipping
  // unchanged values keeps a playing transport from redundant DOM work.
  let shownValuetext = null;
  function renderValuetext(t, stepIndex) {
    const pct = `${Math.round(t * 100)}%`;
    const text = current.steps.length > 1 ? `${current.steps[stepIndex].label} — ${pct}` : pct;
    if (text === shownValuetext) return;
    shownValuetext = text;
    scrub.setAttribute("aria-valuetext", text);
  }
```

3b. In `syncUi`, restore `stepIndex` to the destructuring and call the renderer:

```js
  function syncUi() {
    const { status, t, stepIndex } = playback.state();
    scrub.value = String(Math.round(t * 1000));
    renderPlayButton(status === "playing" || status === "intro");
    renderValuetext(t, stepIndex);
  }
```

3c. In `invalidateUi`, add `shownValuetext = null;` (a new animation's chapter names must re-render even at the same t).

3d. With the other handlers, the chapter-jump keys:

```js
  // PageUp/PageDown jump whole chapters — the keyboard replacement for the
  // removed step buttons. PageUp goes FORWARD, matching the key's native
  // slider direction (it increases the value). Single-step animations keep
  // the browser's native coarse seek instead.
  const onScrubKeydown = (e) => {
    if (current.steps.length <= 1) return;
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    disarmAutoplay();
    const { t } = playback.state();
    const starts = current.stepStarts;
    const target = e.key === "PageUp"
      ? (starts.find((s) => s > t + 1e-6) ?? 1)
      : ([...starts].reverse().find((s) => s < t - 1e-6) ?? 0);
    showChapterBubble(target, { transient: true });
    guarded(() => playback.seek(target));
  };
  scrub.addEventListener("keydown", onScrubKeydown);
```

3e. In `detach()`, add `scrub.removeEventListener("keydown", onScrubKeydown);` next to the other scrub listener removal.

- [ ] **Step 4: Run the file's full suite**

Run: `nvm use && npx vitest run test/framework/animation-controls.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js test/framework/animation-controls.test.js
git commit -m "Announce chapters via aria-valuetext and jump them with PageUp/PageDown"
```

---

### Task 3: Whole-animation pager bookending the card

**Files:**
- Modify: `src/framework/animation-controls.js` (DOM block, listeners, `detach`)
- Test: `test/framework/animation-controls.test.js`

**Interfaces:**
- Consumes: `selectAnimation(name)` (existing: resets, swaps playback, updates `pick.value`, re-syncs), `disarmAutoplay()`, the `btn(className, text, label)` helper, and the module-level `animations` array.
- Produces: buttons `.pf-anim-page` with aria-labels `"Previous animation"` / `"Next animation"`, first and last children of `.pf-anim-bar`, present only when `animations.length > 1`. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/animation-controls.test.js`:

```js
test("animation pager bookends the card and cycles with wrap", () => {
  const { container, ctl } = setup(); handles.push(ctl); // two animations
  const bar = container.querySelector(".pf-anim-bar");
  const pagers = bar.querySelectorAll(".pf-anim-page");
  expect(pagers).toHaveLength(2);
  expect(bar.firstElementChild).toBe(pagers[0]);
  expect(bar.lastElementChild).toBe(pagers[1]);
  expect(pagers[0].getAttribute("aria-label")).toBe("Previous animation");
  expect(pagers[1].getAttribute("aria-label")).toBe("Next animation");
  const pick = container.querySelector(".pf-anim-pick");
  pagers[1].click();                                   // open → assemble
  expect(ctl.runtime.state().animation).toBe("assemble");
  expect(pick.value).toBe("assemble");
  pagers[1].click();                                   // assemble → wraps to open
  expect(ctl.runtime.state().animation).toBe("open");
  pagers[0].click();                                   // open → wraps back to assemble
  expect(ctl.runtime.state().animation).toBe("assemble");
});

test("single-animation part gets no pager", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const solo = { animations: { open: { label: "Open lid", duration: 1, easing: "linear",
    tracks: { lidAngle: [[0, 0], [1, 110]] } } } };
  const ctl = attachAnimationControls(fakeViewer(), solo, {
    container, applyValues: () => {}, getParamValues: () => ({}),
  });
  handles.push(ctl);
  expect(container.querySelectorAll(".pf-anim-page")).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/animation-controls.test.js -t "pager"`
Expected: FAIL — no `.pf-anim-page` elements.

- [ ] **Step 3: Implement**

3a. In the DOM block: build the pagers before the picker append and bookend the bar. The existing `bar.append(animations.length > 1 ? pick : title);` line and the trailing `bar.append(infoSlot, playBtn, scrubWrap, resetBtn);` become:

```js
  // Multi-animation parts page with ‹ › at the card's outer edges — whole
  // animations only, never chapters (chapters are the bubble + PageUp/Down).
  const paged = animations.length > 1;
  const prevAnimBtn = paged ? btn("pf-anim-page", "‹", "Previous animation") : null;
  const nextAnimBtn = paged ? btn("pf-anim-page", "›", "Next animation") : null;
  if (prevAnimBtn) bar.append(prevAnimBtn);
  bar.append(paged ? pick : title);
  ...
  bar.append(infoSlot, playBtn, scrubWrap, resetBtn);
  if (nextAnimBtn) bar.append(nextAnimBtn);
```

(`...` marks the untouched lines between — the chapter bubble/scrub construction stays where Task 1 put it. Keep the `chapterBubble`/`scrubWrap` code exactly as is.)

3b. With the other handlers:

```js
  const cycleAnimation = (dir) => {
    disarmAutoplay();
    const i = animations.indexOf(current);
    selectAnimation(animations[(i + dir + animations.length) % animations.length].name);
  };
  const onPrevAnim = () => cycleAnimation(-1);
  const onNextAnim = () => cycleAnimation(1);
  prevAnimBtn?.addEventListener("click", onPrevAnim);
  nextAnimBtn?.addEventListener("click", onNextAnim);
```

3c. In `detach()`:

```js
      prevAnimBtn?.removeEventListener("click", onPrevAnim);
      nextAnimBtn?.removeEventListener("click", onNextAnim);
```

No CSS needed: `.pf-anim-bar button` already styles the pagers (same base the old step buttons used).

- [ ] **Step 4: Run the file's full suite**

Run: `nvm use && npx vitest run test/framework/animation-controls.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js test/framework/animation-controls.test.js
git commit -m "Add whole-animation pagers bookending the transport card"
```

---

### Task 4: Docs, full validation, version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (lines 135 and 152)
- Modify: `package.json` + `package-lock.json` (0.46.4 → 0.47.0)

**Interfaces:**
- Consumes: the finished UI from Tasks 1-3.
- Produces: nothing new — this task ships the release.

- [ ] **Step 1: Update the two doc lines**

`docs/AUTHORING-PARTS.md:135` currently reads:

```
params** over time. The viewer shows a transport bar (play/scrub/step); hosts
```

Change `(play/scrub/step)` to `(play/scrub, with ‹ › pagers between animations)`.

Line 152's comment on `steps:` currently reads:

```
    steps: [                  // steps play in order; prev/next navigate them
```

Change the comment to `// steps play in order; named on the scrubber as you hover/drag`.

- [ ] **Step 2: Run the whole unit suite**

Run: `nvm use && npx vitest run`
Expected: ALL PASS.

- [ ] **Step 3: Run the smoke checks**

Run: `nvm use && node scripts/check-app.mjs hinged-box.html` (has a stepped animation and the anim-bar layout assertions; boots Vite + real Chromium, takes minutes — let it finish)
Expected: `errors: 0`. The existing `checkAnimBarLayout` assertions must still pass with the narrower bar — if `anim bar: no tested width squeezed the bar` appears, the slimmer bar no longer collides at the tested widths: narrow the last width in the `checkAnimBarLayout([...])` call in `scripts/check-app.mjs` (stay ≥ 720) until one squeezes, and include that change in this task's commit with a one-line note in the report.

Then: `nvm use && node scripts/check-app.mjs demo.html`
Expected: `errors: 0` (no animations — self-skip).

- [ ] **Step 4: Bump the version**

Run: `nvm use && npm version minor --no-git-tag-version`
Expected: `package.json` and `package-lock.json` move 0.46.4 → 0.47.0. (Publishing is automatic when the PR merges — do not tag.)

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md package.json package-lock.json scripts/check-app.mjs
git commit -m "Document hover-reveal chapters and pagers; bump to 0.47.0"
```

(If Step 3 required no check-app change, drop `scripts/check-app.mjs` from the `git add`.)
