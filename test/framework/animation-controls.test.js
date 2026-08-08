// @vitest-environment happy-dom
// test/framework/animation-controls.test.js
// Transport bar + driver against a fake viewer: play/pause/scrub/step wiring,
// cue → tween dispatch, intro gating, snapshot/reset, user-edit pause, and the
// runtime surface.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnimationControls, planAnimBarPlacement } from "../../src/framework/animation-controls.js";

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
    // Models the real camera-tween: cancel() DROPS onComplete rather than firing
    // it. A stub that keeps the callback alive hides every bug where something
    // cancels a gating tween and nothing ever settles the gate.
    cancelCameraTween: vi.fn(() => { pendingComplete = null; }),
    suppressAutoRotate: vi.fn(),
    frame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
    orbit: () => { for (const cb of [...orbitCbs]) cb(); },
    settle: () => { const c = pendingComplete; pendingComplete = null; c?.(); },
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

test("reset BUTTON disarms autoplay, but autoplayKick's own selectAnimation path never does", () => {
  const { container, ctl } = setup(autoPart); handles.push(ctl);
  // Kick from the non-autoplay animation: exercises selectAnimation → doReset internally.
  ctl.runtime.state(); // (read-only, must not disarm)
  ctl.autoplayKick();
  expect(ctl.runtime.state()).toMatchObject({ animation: "cycle", status: "playing" });
  // A second kick still works (the internal path did not disarm)…
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("playing");
  // …but the reset BUTTON does disarm.
  container.querySelector(".pf-anim-reset").click();
  ctl.autoplayKick();
  expect(ctl.runtime.state().status).toBe("idle");
});

test("prefers-reduced-motion: autoplay never arms; manual play still works", () => {
  const spy = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true });
  try {
    const { ctl } = setup(autoPart); handles.push(ctl);
    ctl.autoplayKick();
    expect(ctl.runtime.state().status).toBe("idle");
    ctl.runtime.play("cycle");
    expect(ctl.runtime.state().status).toBe("playing");
  } finally { spy.mockRestore(); }
});

// An intro cue gates playback until its tween settles, and pausing cancels that
// tween — which drops onComplete. If the cue were retired when the intro started,
// resuming would issue no cue at all and the camera would stay wherever the
// cancelled sweep abandoned it, for the rest of the run.
test("pausing mid-intro and resuming re-issues the camera cue", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const params = { lidAngle: 5, lidLift: 0 };
  const viewer = deferredFakeViewer();
  const ctl = attachAnimationControls(viewer, part, {
    container,
    applyValues: (val) => Object.assign(params, val),
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
  });
  handles.push(ctl);

  ctl.runtime.play("open");
  expect(ctl.runtime.state().status).toBe("intro");
  expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(1);

  ctl.runtime.pause(); // cancels the sweep; onComplete is dropped
  expect(ctl.runtime.state().status).toBe("paused");
  expect(viewer.pendingComplete).toBeNull();

  ctl.runtime.play();
  expect(ctl.runtime.state().status).toBe("intro");
  expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(2);
  expect(viewer.tweenCameraTo.mock.calls[1][0]).toBe("front");

  // And once it does settle, playback starts and the cue is not issued again.
  viewer.settle();
  expect(ctl.runtime.state().status).toBe("playing");
  viewer.frame(0.1);
  expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(2);
});

// --- planAnimBarPlacement: pure clamp math ----------------------------------
// stage-relative px in, inline-override plan out. null = the CSS default
// (centered) already clears the viewbar.

test("placement: centered when there is room", () => {
  // centeredLeft 300 ≤ limit 800−10−400 = 390
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 800 })).toBeNull();
});

test("placement: exactly touching the gap is still centered", () => {
  // centeredLeft 300 === limit 710−10−400 = 300
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 710 })).toBeNull();
});

test("placement: slides left to hold the 10px gap", () => {
  // centeredLeft 300 > limit 700−10−400 = 290
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 700 }))
    .toEqual({ left: 290 });
});

test("placement: never crosses the 12px stage margin", () => {
  // limit 430−10−400 = 20 → still above margin
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 430 }))
    .toEqual({ left: 20 });
  // limit 415−10−400 = 5 → clamped to 12, and 400 > available 415−10−12 = 393 → capped
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 415 }))
    .toEqual({ left: 12, maxWidth: 393 });
});

test("placement: cap never goes negative", () => {
  // viewbar hugging the left edge: available 15−10−12 < 0 → cap at 0
  expect(planAnimBarPlacement({ stageWidth: 600, barWidth: 400, viewbarLeft: 15 }))
    .toEqual({ left: 12, maxWidth: 0 });
});

test("placement: honours custom gap and margin", () => {
  expect(planAnimBarPlacement({ stageWidth: 1000, barWidth: 400, viewbarLeft: 700 }, { gap: 20, margin: 30 }))
    .toEqual({ left: 280 });
});

// --- placement wiring: ResizeObserver → measured clamp -----------------------
// happy-dom has no layout, so rects are stubbed; the viewer-pose tests use the
// same globalThis.ResizeObserver stub pattern.

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

test("placement wiring: clamps against the viewbar, clears when roomy, disconnects on detach", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  const observed = new Set();
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe(el) { observed.add(el); }
    disconnect() { disconnected = true; }
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    container.append(viewbar);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 });
    let viewbarLeft = 800;
    viewbar.getBoundingClientRect = () =>
      ({ left: viewbarLeft, right: viewbarLeft + 190, top: 650, bottom: 694, width: 190, height: 44 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}),
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 300, right: 700, top: 656, bottom: 692, width: 400, height: 36 });
    expect(observed.has(container)).toBe(true);
    expect(observed.has(bar)).toBe(true);
    expect(observed.has(viewbar)).toBe(true);

    // roomy: centeredLeft 300 ≤ limit 800−10−400 → no overrides
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("");

    // squeezed: limit 700−10−400 = 290 < centeredLeft 300 → slide left
    viewbarLeft = 700;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("290px");
    expect(bar.style.transform).toBe("none");
    expect(bar.style.maxWidth).toBe("");
    expect(bar.style.overflow).toBe("");

    // capped: even the 12px margin isn't enough (300−10−12 = 278 < barWidth
    // 400) → left pins to the margin and maxWidth caps the bar, clipping its
    // over-minimum flex children instead of spilling onto #viewbar
    viewbarLeft = 300;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("12px");
    expect(bar.style.maxWidth).toBe("278px");
    expect(bar.style.overflow).toBe("hidden");

    // roomy again → overrides cleared, chrome.css back in charge
    viewbarLeft = 800;
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe("");
    expect(bar.style.transform).toBe("");
    expect(bar.style.overflow).toBe("");

    ctl.detach();
    expect(disconnected).toBe(true);
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});

test("placement wiring: no-op when the bars' vertical bands do not intersect", async () => {
  const OriginalRO = globalThis.ResizeObserver;
  let roCallback;
  globalThis.ResizeObserver = class {
    constructor(fn) { roCallback = fn; }
    observe() {}
    disconnect() {}
  };
  try {
    const container = document.createElement("div");
    const viewbar = document.createElement("div");
    viewbar.id = "viewbar";
    container.append(viewbar);
    document.body.append(container);
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 500, top: 0, bottom: 700, width: 500, height: 700 });
    // viewbar in the bottom band, bar lifted above it (narrow layout's bottom: 64px)
    viewbar.getBoundingClientRect = () =>
      ({ left: 100, right: 490, top: 650, bottom: 694, width: 390, height: 44 });
    const ctl = attachAnimationControls(fakeViewer(), part, {
      container, applyValues: () => {}, getParamValues: () => ({}),
    });
    handles.push(ctl);
    const bar = container.querySelector(".pf-anim-bar");
    bar.getBoundingClientRect = () =>
      ({ left: 50, right: 450, top: 600, bottom: 636, width: 400, height: 36 });
    roCallback(); await nextFrame();
    expect(bar.style.left).toBe(""); // would collide horizontally, but bands don't meet
  } finally {
    globalThis.ResizeObserver = OriginalRO;
  }
});
