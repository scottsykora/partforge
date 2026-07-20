// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  cutaway: null,
  cutawayOptions: null,
  renderer: null,
  resize: null,
}));

const OriginalResizeObserver = globalThis.ResizeObserver;

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal();
  class FakeRenderer {
    constructor() {
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
      this.calls = [];
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio(value) { this.pixelRatio = value; }
    getPixelRatio() { return this.pixelRatio; }
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render(scene, camera) { this.calls.push({ type: "main", scene, camera }); }
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("../../src/framework/cutaway.js", () => ({
  createCutaway: vi.fn((options) => {
    state.cutawayOptions = options;
    return state.cutaway;
  }),
}));

import { createViewer } from "../../src/framework/viewer.js";

function createFakeCutaway() {
  const cutaway = {
    isSupported: true,
    isEnabled: false,
    setSubpart: vi.fn(),
    updateGeometry: vi.fn(),
    setVisible: vi.fn(),
    setEnabled: vi.fn(),
    flip: vi.fn(),
    reset: vi.fn(),
    setTheme: vi.fn(),
    setViewportSize: vi.fn(),
    isPointVisible: vi.fn(() => true),
    registerClippableMaterial: vi.fn(),
    updateForCamera: vi.fn(),
    renderOverlay: vi.fn((renderer, camera) => {
      if (!cutaway.isEnabled) return false;
      renderer.calls.push({ type: "overlay", camera });
      return true;
    }),
    dispose: vi.fn(),
  };
  return cutaway;
}

function createContainer(width = 400, height = 300) {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  document.body.appendChild(container);
  return container;
}

beforeEach(() => {
  state.cutaway = createFakeCutaway();
  state.cutawayOptions = null;
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
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test("viewer skips per-frame cutaway camera updates while cutaway is disabled", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  state.renderer.animationLoop();
  expect(state.cutaway.updateForCamera).not.toHaveBeenCalled();

  state.cutaway.isEnabled = true;
  state.renderer.animationLoop();
  expect(state.cutaway.updateForCamera).toHaveBeenCalledOnce();

  viewer.dispose();
});

test("viewer renders the main scene before the enabled cutaway handle overlay", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });
  state.cutaway.isEnabled = true;

  state.renderer.animationLoop();

  expect(state.renderer.calls.map((call) => call.type)).toEqual(["main", "overlay"]);
  expect(state.cutaway.renderOverlay).toHaveBeenCalledWith(
    state.renderer,
    state.renderer.calls[0].camera,
  );
  viewer.dispose();
});

test("viewer renders only the main scene when cutaway is disabled", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  state.renderer.animationLoop();

  expect(state.renderer.calls.map((call) => call.type)).toEqual(["main"]);
  expect(state.cutaway.renderOverlay).toHaveBeenCalledOnce();
  viewer.dispose();
});

test("viewer injects its initial feature-edge color into cutaway", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  expect(state.cutawayOptions.edgeColor).toBe(0x1c232d);

  viewer.dispose();
});

test("viewer forwards every viewport resize to cutaway edge materials", () => {
  vi.stubGlobal("devicePixelRatio", 3);
  let width = 400;
  let height = 300;
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  });
  document.body.appendChild(container);
  const viewer = createViewer(container, {
    meta: {},
    parts: { body: {} },
  });

  expect(state.renderer.getPixelRatio()).toBe(2);
  expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(400, 300, 2);

  width = 900;
  height = 700;
  state.resize();
  expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(900, 700, 2);

  viewer.dispose();
});

test("viewer forwards the exact feature-edge color for each cutaway theme", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  viewer.setTheme("dark");
  expect(state.cutaway.setTheme).toHaveBeenLastCalledWith("dark", 0x1c232d);

  viewer.setTheme("light");
  expect(state.cutaway.setTheme).toHaveBeenLastCalledWith("light", 0x33414f);

  viewer.dispose();
});
