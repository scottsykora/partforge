// @vitest-environment happy-dom
// syncUi() runs on EVERY playback frame. It used to rewrite the play button's
// glyph, aria-label and title unconditionally, and `el.textContent = x` replaces
// the element's child text node even when the string is identical. WebKit will
// not dispatch a `click` on an element whose text node was replaced between
// mousedown and mouseup — so at 60fps the transport ate the pause click
// outright: press, release, no click event at all, and only ever while playing.
// Measured in WebKit before the fix, any press held >= 40ms lost it (a real
// click is ~100ms); a synthetic 0ms click survived, which is exactly why
// Chromium-driven automation could never see it.
//
// The invariant is therefore "no redundant DOM writes per frame", not "pause
// works in WebKit" — CI drives Chromium, where the bug is invisible. Pin the
// invariant instead: across many frames where nothing user-visible changed, the
// button's text node must be the SAME node object it started as.
import { expect, test, vi } from "vitest";
import { attachAnimationControls } from "../../src/framework/animation-controls.js";

const PART = {
  meta: { title: "T" },
  parameters: [{ id: "b", title: "B", advanced: [{ key: "lift", label: "Lift", min: 0, max: 40, step: 1 }] }],
  defaults: { lift: 0 },
  parts: { p: { label: "P", views: ["v"], build: () => null } },
  views: { v: { label: "V" } },
  animations: { a: { label: "A", duration: 4, loop: true, easing: "linear", tracks: { lift: [[0, 0], [1, 40]] } } },
};

function harness() {
  const container = document.createElement("div");
  document.body.append(container);
  let frame = null;
  const viewer = {
    onFrame: (cb) => { frame = cb; return () => { frame = null; }; },
    onCameraStart: () => () => {},
    tweenCameraTo: () => {},
    cancelCameraTween: () => {},
  };
  const params = { ...PART.defaults };
  const ctl = attachAnimationControls(viewer, PART, {
    container,
    applyValues: (values) => Object.assign(params, values),
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
  });
  return { ctl, container, tick: (dt) => frame?.(dt), params };
}

test("a playing transport does not rewrite the play button's text node every frame", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");

  playBtn.click(); // start playback
  expect(playBtn.textContent).toBe("⏸");
  // The exact node the browser would compare across mousedown/mouseup.
  const textNode = playBtn.firstChild;
  expect(textNode).toBeTruthy();

  for (let i = 0; i < 120; i++) tick(1 / 60); // two seconds of playback
  expect(playBtn.textContent).toBe("⏸"); // still playing, glyph unchanged...
  expect(playBtn.firstChild).toBe(textNode); // ...so the node must be untouched

  ctl.detach();
});

test("the glyph and its labels still flip when playback state actually changes", () => {
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

test("the scrubber still tracks playback, and only writes when the position moves", () => {
  const { ctl, container, tick } = harness();
  const playBtn = container.querySelector(".pf-anim-play");
  const scrub = container.querySelector(".pf-anim-scrub");

  playBtn.click();
  for (let i = 0; i < 60; i++) tick(1 / 60); // one second of a four-second loop
  expect(Number(scrub.value)).toBeGreaterThan(200);
  expect(Number(scrub.value)).toBeLessThan(300);

  // A frame that does not move the clock must not touch the input at all.
  const setter = vi.spyOn(scrub, "value", "set");
  tick(0);
  expect(setter).not.toHaveBeenCalled();
  setter.mockRestore();

  ctl.detach();
});
