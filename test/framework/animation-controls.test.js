// @vitest-environment happy-dom
// test/framework/animation-controls.test.js
// Transport bar + driver against a fake viewer: play/pause/scrub/step wiring,
// cue → tween dispatch, intro gating, auto-rotate suppression, snapshot/reset,
// user-edit pause, and the runtime surface.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnimationControls } from "../../src/framework/animation-controls.js";

function fakeViewer() {
  const frameCbs = new Set(); const orbitCbs = new Set();
  return {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => onComplete?.()), // completes instantly
    cancelCameraTween: vi.fn(),
    suppressAutoRotate: vi.fn(),
    frame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
    orbit: () => { for (const cb of [...orbitCbs]) cb(); },
  };
}

const part = {
  animations: {
    open: { label: "Open lid", camera: "front", duration: 2, easing: "linear",
      description: "Opens the **lid**.", tracks: { lidAngle: [[0, 0], [1, 110]] } },
    assemble: { label: "Assemble", steps: [
      { label: "Lower", duration: 1, easing: "linear", tracks: { lidLift: [[0, 40], [1, 0]] } },
      { label: "Open", duration: 1, easing: "linear", tracks: { lidAngle: [[0, 0], [1, 110]] } },
    ] },
  },
};

function setup(defn = part) {
  const container = document.createElement("div");
  document.body.append(container);
  const params = { lidAngle: 5, lidLift: 0 };
  const applied = [];
  const ctl = attachAnimationControls(fakeViewer(), defn, {
    container,
    applyValues: (v) => { applied.push({ ...v }); Object.assign(params, v); },
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
  });
  return { container, params, applied, ctl, viewer: ctl.__viewer };
}

let handles = [];
afterEach(() => { for (const h of handles.splice(0)) h?.detach(); document.body.replaceChildren(); });

test("no animations → null, no DOM", () => {
  const container = document.createElement("div");
  expect(attachAnimationControls(fakeViewer(), {}, { container, applyValues: () => {}, getParamValues: () => ({}) })).toBeNull();
  expect(container.children).toHaveLength(0);
});

test("renders the bar with a picker (two animations) and an info glyph", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  expect(container.querySelector(".pf-anim-bar")).toBeTruthy();
  expect(container.querySelector(".pf-anim-pick")).toBeTruthy();
  expect(container.querySelector(".pf-anim-bar .info")).toBeTruthy(); // description glyph
});

test("play runs the intro tween, then frames drive param values", () => {
  const { applied, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  expect(viewer.tweenCameraTo).toHaveBeenCalledWith("front", expect.anything());
  expect(viewer.suppressAutoRotate).toHaveBeenLastCalledWith(true);
  viewer.frame(1); // 1s of 2s → t=0.5 → lidAngle 55
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
});

test("reset restores the pre-animation param snapshot", () => {
  const { applied, ctl } = setup(); handles.push(ctl);
  ctl.runtime.play();
  ctl.__viewer.frame(1);
  ctl.runtime.stop();
  expect(applied.at(-1)).toEqual({ lidAngle: 5 }); // the snapshot taken at play
});

test("user orbit disarms cues; user edit pauses", () => {
  const { ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  viewer.orbit();
  ctl.notifyUserEdit();
  expect(ctl.runtime.state().status).toBe("paused");
  expect(viewer.suppressAutoRotate).toHaveBeenLastCalledWith(false);
});

test("scrubbing applies values without moving the camera", () => {
  const { container, applied, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  const scrub = container.querySelector(".pf-anim-scrub");
  scrub.value = "500";
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
  expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
});

test("stepped animation shows step chrome and step ticks", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  expect(container.querySelector(".pf-anim-step").hidden).toBe(false);
  expect(container.querySelectorAll(".pf-anim-tick")).toHaveLength(1); // one interior boundary
});

test("runtime.play(name) switches animation; detach removes the bar", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  ctl.runtime.play("assemble");
  expect(ctl.runtime.state().animation).toBe("assemble");
  ctl.detach();
  expect(container.querySelector(".pf-anim-bar")).toBeNull();
});
