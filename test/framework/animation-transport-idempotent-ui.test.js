// @vitest-environment happy-dom
// The transport bar has two redraw cadences: the scrubber moves per frame, the
// buttons and readouts change only when the playback STATE changes. Keeping
// them apart is load-bearing, not tidiness.
//
// syncUi() used to rewrite the play button's glyph, aria-label and title on
// every frame. `el.textContent = x` replaces the element's child text node even
// when the string is identical, and WebKit will not dispatch a `click` on an
// element whose text node was replaced between mousedown and mouseup. At 60fps
// that ate the pause click outright: pointerdown, mousedown, pointerup and
// mouseup all fired on the button, no `click` followed, and playback carried on
// — and only ever while playing, because a stopped transport does not tick.
// Measured in WebKit, any press held >= 40ms lost it (a real click is ~100ms);
// a synthetic 0ms click survives, which is why Chromium-driven automation could
// not see it in either engine.
//
// CI drives Chromium, where the engine behaviour is invisible, so these pin the
// invariant instead: while nothing user-visible changes, the button is not
// touched at all.
import { expect, test, vi } from "vitest";
import { attachAnimationControls } from "../../src/framework/animation-controls.js";

const TRACKS = { lift: [[0, 0], [1, 40]] };
const PART = {
  meta: { title: "T" },
  parameters: [{ id: "b", title: "B", advanced: [{ key: "lift", label: "Lift", min: 0, max: 40, step: 1 }] }],
  defaults: { lift: 0 },
  parts: { p: { label: "P", views: ["v"], build: () => null } },
  views: { v: { label: "V" } },
  animations: {
    a: { label: "A", duration: 4, loop: true, easing: "linear", tracks: TRACKS },
    b: {
      label: "B",
      steps: [
        { label: "up", duration: 1, tracks: { lift: [[0, 0], [1, 40]] } },
        { label: "down", duration: 1, tracks: { lift: [[0, 40], [1, 0]] } },
      ],
    },
    c: {
      label: "C",
      steps: [
        { label: "raise", duration: 1, tracks: { lift: [[0, 0], [1, 20]] } },
        { label: "lower", duration: 1, tracks: { lift: [[0, 20], [1, 0]] } },
      ],
    },
  },
};

function harness(part = PART) {
  const container = document.createElement("div");
  document.body.append(container);
  let frame = null;
  const viewer = {
    onFrame: (cb) => { frame = cb; return () => { frame = null; }; },
    onCameraStart: () => () => {},
    tweenCameraTo: () => {},
    cancelCameraTween: () => {},
  };
  const params = { ...part.defaults };
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: (values) => Object.assign(params, values),
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
  });
  return { ctl, container, tick: (dt) => frame?.(dt), params };
}

test("a playing transport never touches the play button", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");

  playBtn.click(); // start playback
  expect(playBtn.textContent).toBe("⏸");
  // The exact node the browser compares across mousedown/mouseup.
  const textNode = playBtn.firstChild;
  expect(textNode).toBeTruthy();

  // Catch a rewrite even if it happens to restore an identical string.
  const seen = [];
  const observer = new MutationObserver((records) => seen.push(...records));
  observer.observe(playBtn, { childList: true, characterData: true, attributes: true, subtree: true });
  // Same-value attribute writes are no-ops the observer may not report, so
  // watch the call itself: a playing frame must not reach the button at all.
  const setAttr = vi.spyOn(playBtn, "setAttribute");

  for (let i = 0; i < 120; i++) tick(1 / 60); // two seconds of playback

  observer.disconnect();
  expect(playBtn.textContent).toBe("⏸");     // still playing, glyph unchanged...
  expect(playBtn.firstChild).toBe(textNode); // ...so the node must be untouched
  expect(seen).toEqual([]);                  // and nothing was written to it at all
  expect(setAttr).not.toHaveBeenCalled();
  setAttr.mockRestore();
  ctl.detach();
});

test("the scrubber does still advance on those same frames", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");
  const scrub = container.querySelector(".pf-anim-scrub");

  playBtn.click();
  for (let i = 0; i < 60; i++) tick(1 / 60); // one second of a four-second loop
  expect(Number(scrub.value)).toBeGreaterThan(200);
  expect(Number(scrub.value)).toBeLessThan(300);
  ctl.detach();
});

test("the glyph and its labels flip when playback state actually changes", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");

  playBtn.click();
  tick(1 / 60);
  expect(playBtn.textContent).toBe("⏸");
  expect(playBtn.getAttribute("aria-label")).toBe("Pause animation");
  expect(playBtn.title).toBe("Pause animation");

  playBtn.click(); // pause
  expect(playBtn.textContent).toBe("▶");
  expect(playBtn.getAttribute("aria-label")).toBe("Play animation");
  expect(playBtn.title).toBe("Play animation");
  ctl.detach();
});

// The independent half of the guarantee. Skipping redundant writes cannot help
// when the write is REAL — playback ending, or a step boundary crossing, while
// the button is held. The glyph must therefore be written by mutating the
// existing text node, never by replacing it: WebKit drops the click when the
// node the press started on is gone by the time it is released.
test("changing the glyph mutates the button's text node rather than replacing it", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");
  const textNode = playBtn.firstChild;

  playBtn.click();      // ▶ -> ⏸, a genuine change
  tick(1 / 60);
  expect(playBtn.textContent).toBe("⏸");
  expect(playBtn.firstChild).toBe(textNode);
  expect(playBtn.childNodes.length).toBe(1);

  playBtn.click();      // ⏸ -> ▶
  expect(playBtn.textContent).toBe("▶");
  expect(playBtn.firstChild).toBe(textNode);
  ctl.detach();
});

// Switching animations installs a fresh playback that starts idle at step 0 —
// the very values the outgoing animation was already showing. The per-element
// caches would therefore skip the redraw, leaving the incoming animation's step
// readout blank, so the swap has to invalidate them rather than trust them.
test("switching animations re-renders chrome the caches would have skipped", () => {
  const { ctl, container } = harness();
  const pick = container.querySelector(".pf-anim-pick");
  const stepLabel = container.querySelector(".pf-anim-step");

  const select = (name) => { pick.value = name; pick.dispatchEvent(new Event("change", { bubbles: true })); };

  expect(stepLabel.hidden).toBe(true); // "a" is not stepped
  select("b");
  expect(stepLabel.hidden).toBe(false);
  expect(stepLabel.textContent).toBe("1/2 · up");

  // The case the cache actually swallows: stepped -> stepped. Both sit at step
  // 0 with the same status, so a trusted cache skips the redraw and leaves the
  // previous animation's step name on screen.
  select("c");
  expect(stepLabel.textContent).toBe("1/2 · raise");
  ctl.detach();
});

test("a frame that does not advance the clock does no work at all", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");
  const scrub = container.querySelector(".pf-anim-scrub");

  playBtn.click();
  for (let i = 0; i < 10; i++) tick(1 / 60);
  const setter = vi.spyOn(scrub, "value", "set");
  tick(0); // the state machine ignores a zero delta and returns no snapshot
  expect(setter).not.toHaveBeenCalled();
  setter.mockRestore();
  ctl.detach();
});
