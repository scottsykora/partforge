// @vitest-environment happy-dom
// The orchestrator: the only viewcube file touching both the viewer and the
// DOM. The two behaviours worth defending are the idle-cost guarantee (an
// unchanged camera must draw NOTHING) and the drag/click split.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewcubeMode } from "../../../src/framework/viewcube/viewcube-mode.js";
import { CUBE_SIZE, CUBE_SIZE_NARROW } from "../../../src/framework/viewcube/cube-canvas.js";
import { RAIL_NARROW_BREAKPOINT } from "../../../src/framework/rail-state.js";

function stubViewer() {
  const frame = new Set();
  const theme = new Set();
  const quat = { x: 0, y: 0, z: 0, w: 1 };
  return {
    camera: { quaternion: quat, isOrthographicCamera: false, zoom: 1 },
    quat,
    tick: (dt = 0.016) => frame.forEach((cb) => cb(dt)),
    setTheme: (m) => theme.forEach((cb) => cb(m)),
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onThemeChange: (cb) => { theme.add(cb); return () => theme.delete(cb); },
    getTheme: () => "dark",
    tweenCameraTo: vi.fn(),
    orbitBy: vi.fn(),
    frameCount: () => frame.size,
    themeCount: () => theme.size,
  };
}

let host, viewer, mode, draws, surface;
// The fake MUST append its element to the host: the mode attaches its pointer
// listeners to canvas.element, and the tests dispatch there. Dispatching on the
// wrapper instead would never reach them — events bubble child-to-parent.
function fakeCanvasFactory() {
  draws = [];
  return (wrap) => {
    surface = document.createElement("canvas");
    surface.className = "pf-viewcube-canvas";
    wrap.appendChild(surface);
    // happy-dom returns a zero rect and has no pointer capture; the mode reads
    // one and calls the other.
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
    surface.setPointerCapture = () => {};
    surface.releasePointerCapture = () => {};
    return {
      element: surface,
      draw: (projected, opts) => draws.push({ projected, ...opts }),
      setTheme: vi.fn(),
      size: 90,
      dispose: vi.fn(),
    };
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  viewer = stubViewer();
  mode = createViewcubeMode(viewer, { host, createCanvas: fakeCanvasFactory() });
});
afterEach(() => mode?.detach());

const pointer = (type, x, y) => {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  surface.dispatchEvent(e);
};

describe("idle cost", () => {
  it("draws once on attach so the widget is never blank", () => {
    expect(draws.length).toBe(1);
  });

  it("draws nothing on a frame where the camera did not move", () => {
    draws.length = 0;
    viewer.tick();
    viewer.tick();
    viewer.tick();
    expect(draws.length).toBe(0);
  });

  it("draws again once the camera quaternion changes", () => {
    draws.length = 0;
    viewer.quat.y = 0.3;
    viewer.tick();
    expect(draws.length).toBe(1);
  });

  it("draws again when only the ortho zoom changes", () => {
    viewer.camera.isOrthographicCamera = true;
    draws.length = 0;
    viewer.camera.zoom = 2;
    viewer.tick();
    expect(draws.length).toBe(1);
  });
});

describe("click versus drag", () => {
  it("tweens on a release inside the threshold, asking for a refit", () => {
    pointer("pointerdown", 45, 45);
    pointer("pointermove", 47, 46);
    pointer("pointerup", 47, 46);
    expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(1);
    // refit: a click on the cube is the reframe control now that the framework's
    // pages ship no reframe button, and under orthographic a plain tween does
    // not refit (see viewer.js's tweenCameraTo).
    expect(viewer.tweenCameraTo.mock.calls[0][1]).toMatchObject({ refit: true });
    expect(viewer.orbitBy).not.toHaveBeenCalled();
  });

  it("orbits and cancels the click past the threshold", () => {
    pointer("pointerdown", 45, 45);
    pointer("pointermove", 60, 45);
    pointer("pointerup", 60, 45);
    expect(viewer.orbitBy).toHaveBeenCalled();
    expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
  });

  it("does not tween when the release lands outside the cube", () => {
    pointer("pointerdown", 1, 1);
    pointer("pointerup", 1, 1);
    expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
  });
});

describe("hover", () => {
  it("passes a hovered region id to the renderer", () => {
    draws.length = 0;
    pointer("pointermove", 45, 45);
    expect(draws.at(-1).hover).toBe("front");
  });

  it("clears the hover on leave", () => {
    pointer("pointermove", 45, 45);
    draws.length = 0;
    pointer("pointerleave", 45, 45);
    expect(draws.at(-1).hover).toBeNull();
  });
});

describe("hiding", () => {
  it("hides and restores the element", () => {
    mode.setHidden(true);
    expect(mode.element.hidden).toBe(true);
    expect(mode.isHidden()).toBe(true);
    mode.setHidden(false);
    expect(mode.element.hidden).toBe(false);
  });

  it("draws nothing at all while hidden, even as the camera moves", () => {
    mode.setHidden(true);
    draws.length = 0;
    viewer.quat.y = 0.5;
    viewer.tick();
    expect(draws.length).toBe(0);
  });
});

describe("detach", () => {
  it("unsubscribes from the viewer and removes its DOM", () => {
    mode.detach();
    expect(viewer.frameCount()).toBe(0);
    expect(viewer.themeCount()).toBe(0);
    expect(host.querySelector(".pf-viewcube")).toBeNull();
  });

  it("is idempotent", () => {
    mode.detach();
    expect(() => mode.detach()).not.toThrow();
  });
});

// A fake matchMedia: one query, mutable `matches`, and a `.fire(next)` the
// test uses in place of the browser actually crossing the breakpoint.
function fakeMatchMedia(initialMatches) {
  let matches = initialMatches;
  const listeners = new Set();
  const matchMedia = () => ({
    get matches() { return matches; },
    addEventListener: (_type, cb) => listeners.add(cb),
    removeEventListener: (_type, cb) => listeners.delete(cb),
  });
  matchMedia.fire = (next) => { matches = next; listeners.forEach((cb) => cb()); };
  matchMedia.listenerCount = () => listeners.size;
  return matchMedia;
}

function minimalCanvas(wrap, opts = {}) {
  const el = document.createElement("canvas");
  el.className = "pf-viewcube-canvas";
  wrap.appendChild(el);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  let size = opts.size;
  return {
    element: el,
    draw: vi.fn(),
    setTheme: vi.fn(),
    setSize: vi.fn((px) => { size = px; }),
    get size() { return size; },
    dispose: vi.fn(),
  };
}

describe("narrow breakpoint (matchMedia, not a ResizeObserver)", () => {
  let narrowHost, narrowMode;
  beforeEach(() => {
    narrowHost = document.createElement("div");
    document.body.append(narrowHost);
  });
  afterEach(() => narrowMode?.detach());

  it("creates the canvas at the full CUBE_SIZE when the breakpoint does not match", () => {
    let seenSize;
    const createCanvas = (wrap, opts) => { seenSize = opts.size; return minimalCanvas(wrap, opts); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: fakeMatchMedia(false) });
    expect(seenSize).toBe(CUBE_SIZE);
  });

  it("creates the canvas at CUBE_SIZE_NARROW when the breakpoint already matches", () => {
    let seenSize;
    const createCanvas = (wrap, opts) => { seenSize = opts.size; return minimalCanvas(wrap, opts); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: fakeMatchMedia(true) });
    expect(seenSize).toBe(CUBE_SIZE_NARROW);
  });

  // The two tests above read the constants back, so they hold for ANY pair of
  // numbers — they pin the WIRING, not the sizes. This one states the tuned
  // values outright: the narrow cube is three quarters of the full one
  // (135 → 101), the 2026-08-19 decision to keep the cube legible on a phone
  // rather than shrink it to the old 90px widget.
  it("renders the narrow cube at 101 CSS px — three quarters of the full 135", () => {
    expect(CUBE_SIZE).toBe(135);
    expect(CUBE_SIZE_NARROW).toBe(101);
    let seenSize;
    const createCanvas = (wrap, opts) => { seenSize = opts.size; return minimalCanvas(wrap, opts); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: fakeMatchMedia(true) });
    expect(seenSize).toBe(101);
  });

  it("queries the exact RAIL_NARROW_BREAKPOINT, imported rather than hardcoded", () => {
    let seenQuery;
    const matchMedia = (query) => { seenQuery = query; return fakeMatchMedia(false)(query); };
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas: minimalCanvas, matchMedia });
    expect(seenQuery).toBe(`(max-width: ${RAIL_NARROW_BREAKPOINT}px)`);
  });

  it("resizes and redraws when the media query's match state changes", () => {
    let canvas;
    const createCanvas = (wrap, opts) => { canvas = minimalCanvas(wrap, opts); return canvas; };
    const mm = fakeMatchMedia(false);
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas, matchMedia: mm });
    canvas.draw.mockClear();
    mm.fire(true);
    expect(canvas.setSize).toHaveBeenCalledWith(CUBE_SIZE_NARROW);
    expect(canvas.draw).toHaveBeenCalled();
  });

  it("unsubscribes from the media query on detach", () => {
    const mm = fakeMatchMedia(false);
    narrowMode = createViewcubeMode(viewer, { host: narrowHost, createCanvas: minimalCanvas, matchMedia: mm });
    expect(mm.listenerCount()).toBe(1);
    narrowMode.detach();
    expect(mm.listenerCount()).toBe(0);
  });
});
