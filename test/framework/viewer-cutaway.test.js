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
      state.renderer = this;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
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
  return {
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
    dispose: vi.fn(),
  };
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

test("viewer injects its initial feature-edge color into cutaway", () => {
  const viewer = createViewer(createContainer(), {
    meta: {},
    parts: { body: {} },
  });

  expect(state.cutawayOptions.edgeColor).toBe(0x1c232d);

  viewer.dispose();
});

test("viewer forwards every viewport resize to cutaway edge materials", () => {
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

  expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(400, 300);

  width = 900;
  height = 700;
  state.resize();
  expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(900, 700);

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
