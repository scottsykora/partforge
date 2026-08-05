// @vitest-environment happy-dom
// test/framework/animation-controls.test.js
// Transport bar + driver against a fake viewer: play/pause/scrub/step wiring,
// cue → tween dispatch, intro gating, snapshot/reset, user-edit pause, and the
// runtime surface.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnimationControls } from "../../src/framework/animation-controls.js";

function fakeViewer() {
  const frameCbs = new Set(); const orbitCbs = new Set();
  return {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => onComplete?.()), // completes instantly
    cancelCameraTween: vi.fn(),
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

// deferred-tween viewer: unlike fakeViewer() above, tweenCameraTo does NOT
// fire onComplete synchronously — it's captured so the test controls when
// (or whether) the tween settles. This is what exposes the "orbit during a
// gated intro" bug: with an instantly-completing tween, introDone() always
// fires on its own and the gate never has a chance to strand playback.
function deferredFakeViewer() {
  const frameCbs = new Set(); const orbitCbs = new Set();
  let pendingComplete = null;
  return {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => { pendingComplete = onComplete ?? null; }),
    cancelCameraTween: vi.fn(),
    frame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
    orbit: () => { for (const cb of [...orbitCbs]) cb(); },
    get pendingComplete() { return pendingComplete; },
  };
}

test("orbit during a gated intro settles the gate instead of stranding playback", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const frameCbs = new Set(); const orbitCbs = new Set();
  let pendingComplete = null;
  const viewer = {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => { pendingComplete = onComplete ?? null; }),
    cancelCameraTween: vi.fn(),
  };
  const applied = [];
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: (v) => applied.push({ ...v }),
    getParamValues: () => ({ lidAngle: 5 }),
  });
  handles.push(ctl);
  ctl.runtime.play(); // "open" has a t=0 cue → status "intro", params hold
  expect(ctl.runtime.state().status).toBe("intro");
  const before = applied.length;
  for (const cb of [...frameCbs]) cb(0.5); // gated: tick() is null, nothing applied
  expect(applied.length).toBe(before);
  for (const cb of [...orbitCbs]) cb(); // user grabs the orbit mid-intro
  expect(ctl.runtime.state().status).toBe("playing"); // gate settled
  for (const cb of [...frameCbs]) cb(1); // 1s of 2s → t=0.5 → lidAngle 55
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
});

// An unknown name is a host bug: playing "whatever is currently selected"
// instead would be a silent wrong answer.
test("runtime.play(unknown) warns and plays nothing", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { applied, ctl } = setup(); handles.push(ctl);

  ctl.runtime.play("nope");

  expect(warn).toHaveBeenCalledWith('partforge: unknown animation "nope"');
  expect(ctl.runtime.state().status).toBe("idle");
  expect(ctl.runtime.state().animation).toBe("open"); // selection untouched
  expect(applied).toHaveLength(0);
  warn.mockRestore();
});

// The driver runs from the viewer's frame listeners: a bad frame must cost that
// frame, not every other listener on the loop.
test("a throwing applyValues degrades the frame instead of killing the loop", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  const viewer = fakeViewer();
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: () => { throw new Error("bad track"); },
    getParamValues: () => ({ lidAngle: 5 }),
  });
  handles.push(ctl);

  expect(() => ctl.runtime.play()).not.toThrow();
  expect(() => viewer.frame(0.5)).not.toThrow();
  expect(() => viewer.frame(0.5)).not.toThrow();

  expect(warn).toHaveBeenCalledWith("partforge: animation frame failed", expect.any(Error));
  expect(warn.mock.calls.filter((c) => c[0] === "partforge: animation frame failed")).toHaveLength(1); // warned once, not per frame
  warn.mockRestore();
});

test("orbit while idle changes nothing", () => {
  const { applied, ctl, viewer } = (() => {
    const container = document.createElement("div");
    document.body.append(container);
    const params = { lidAngle: 5, lidLift: 0 };
    const applied = [];
    const v = deferredFakeViewer();
    const ctl = attachAnimationControls(v, part, {
      container,
      applyValues: (val) => { applied.push({ ...val }); Object.assign(params, val); },
      getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
    });
    return { applied, ctl, viewer: v };
  })();
  handles.push(ctl);
  expect(ctl.runtime.state().status).toBe("idle");
  viewer.orbit();
  expect(ctl.runtime.state().status).toBe("idle");
  expect(applied.length).toBe(0);
});

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
