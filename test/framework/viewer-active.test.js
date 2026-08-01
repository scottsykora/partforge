// @vitest-environment happy-dom
// Parking the viewer when the host hides it without unmounting it, and reporting
// WebGL context loss. Both exist for embedders: partforge's own narrow layout
// hides the stage with `display: none` (which collapses clientWidth, so the
// ResizeObserver already shrinks the buffer), but partforge-cloud's phone tab bar
// uses `visibility: hidden` on a full-size container — the buffer and the render
// loop survive that, and on an iPhone they cost tens of MB and 60fps of GPU work
// for a canvas nobody can see.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ renderer: null, resize: null }));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.sizes = [];
      this.frames = 0;
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio(value) { this.pixelRatio = value; }
    getPixelRatio() { return this.pixelRatio; }
    setSize(width, height, updateStyle) { this.sizes.push([width, height, updateStyle]); }
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() { this.frames += 1; }
    get capabilities() { return { maxTextureSize: 8192 }; }
    setRenderTarget() {}
    readRenderTargetPixels() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

import { createViewer } from "../../src/framework/viewer.js";

function createContainer(width = 400, height = 300) {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  document.body.appendChild(container);
  return container;
}

const newViewer = () => createViewer(createContainer(), { meta: {}, parts: { body: {} } });
const lastSize = () => state.renderer.sizes.at(-1);

beforeEach(() => {
  state.renderer = null;
  state.resize = null;
  globalThis.ResizeObserver = class {
    constructor(callback) { state.resize = callback; }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  globalThis.ResizeObserver = OriginalResizeObserver;
  document.body.innerHTML = "";
});

test("a fresh viewer is active: it renders and sizes to the container", () => {
  const viewer = newViewer();
  state.renderer.animationLoop();
  expect(state.renderer.frames).toBe(1);
  expect(lastSize().slice(0, 2)).toEqual([400, 300]);
  viewer.dispose();
});

test("setActive(false) stops the render loop", () => {
  const viewer = newViewer();
  viewer.setActive(false);
  expect(state.renderer.animationLoop).toBe(null);
  viewer.dispose();
});

test("setActive(false) releases the drawing buffer but keeps the canvas layout size", () => {
  const viewer = newViewer();
  viewer.setActive(false);
  // updateStyle false: the buffer collapses, the canvas element keeps its CSS
  // box, so the host's layout does not move while the pane is hidden.
  expect(lastSize()).toEqual([1, 1, false]);
  viewer.dispose();
});

test("a resize while parked does not re-inflate the buffer", () => {
  const viewer = newViewer();
  viewer.setActive(false);
  const sizeCount = state.renderer.sizes.length;
  state.resize(); // iOS fires these constantly as the URL bar collapses
  expect(state.renderer.sizes.length).toBe(sizeCount);
  viewer.dispose();
});

test("setActive(true) restores the buffer and the render loop", () => {
  const viewer = newViewer();
  viewer.setActive(false);
  viewer.setActive(true);
  expect(lastSize().slice(0, 2)).toEqual([400, 300]);
  expect(typeof state.renderer.animationLoop).toBe("function");
  state.renderer.animationLoop();
  expect(state.renderer.frames).toBe(1);
  viewer.dispose();
});

test("setActive is idempotent in both directions", () => {
  const viewer = newViewer();
  viewer.setActive(false);
  const parked = state.renderer.sizes.length;
  viewer.setActive(false);
  expect(state.renderer.sizes.length).toBe(parked);
  viewer.setActive(true);
  const live = state.renderer.sizes.length;
  viewer.setActive(true);
  expect(state.renderer.sizes.length).toBe(live);
  viewer.dispose();
});

test("parking leaves the camera framing alone, so an offscreen capture still matches the pane", () => {
  // The phone case this exists for: the user is on the Chat tab (viewer parked)
  // and the agent triggers a build that needs build sight. captureCurrent renders
  // into its own target and frames from camera.aspect, so parking must not touch
  // it — collapsing the buffer to 1x1 must not become a 1:1 screenshot.
  const viewer = newViewer();
  const aspect = viewer.camera.aspect;
  expect(aspect).toBeCloseTo(400 / 300);
  viewer.setActive(false);
  expect(viewer.camera.aspect).toBe(aspect);
  viewer.dispose();
});

test("setActive after dispose is a no-op rather than a throw", () => {
  const viewer = newViewer();
  viewer.dispose();
  expect(() => viewer.setActive(false)).not.toThrow();
  expect(() => viewer.setActive(true)).not.toThrow();
});

test("context loss is reported to subscribers and preventDefault()ed so it can restore", () => {
  const viewer = newViewer();
  const seen = vi.fn();
  viewer.onContextLost(seen);

  const event = new Event("webglcontextlost", { cancelable: true });
  state.renderer.domElement.dispatchEvent(event);

  expect(seen).toHaveBeenCalledTimes(1);
  // Without preventDefault the context is gone for good — the canvas would stay
  // black with no way back.
  expect(event.defaultPrevented).toBe(true);
  viewer.dispose();
});

test("onContextLost returns an unsubscribe", () => {
  const viewer = newViewer();
  const seen = vi.fn();
  viewer.onContextLost(seen)();
  state.renderer.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  expect(seen).not.toHaveBeenCalled();
  viewer.dispose();
});
