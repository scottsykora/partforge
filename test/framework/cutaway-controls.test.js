// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { attachCutawayControls } from "../../src/framework/cutaway-controls.js";

function fakeViewer({ supported = true } = {}) {
  let enabled = false;
  return {
    domElement: document.createElement("canvas"),
    cutawaySupported: vi.fn(() => supported),
    cutawayEnabled: vi.fn(() => enabled),
    setCutawayEnabled: vi.fn((on) => {
      enabled = supported && on;
      return enabled === on;
    }),
    flipCutaway: vi.fn(),
    resetCutaway: vi.fn(),
  };
}

function setup(options) {
  const viewer = fakeViewer(options);
  const button = document.createElement("button");
  document.body.append(viewer.domElement, button);
  const handle = attachCutawayControls(viewer, { cutaway: button });
  handles.push(handle);
  return { viewer, button, handle };
}

function pressEscape(target) {
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
  }));
}

let handles = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.detach();
});

describe("attachCutawayControls", () => {
  test("configures and synchronizes the primary toggle", () => {
    const { viewer, button } = setup();

    expect(button.type).toBe("button");
    expect(button.title).toBe("Toggle cutaway view");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("on")).toBe(false);

    button.click();
    expect(viewer.setCutawayEnabled).toHaveBeenLastCalledWith(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("on")).toBe(true);

    button.click();
    expect(viewer.setCutawayEnabled).toHaveBeenLastCalledWith(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("on")).toBe(false);
  });

  test("preserves a host-provided title", () => {
    const viewer = fakeViewer();
    const button = document.createElement("button");
    button.title = "Section the model";
    document.body.append(button);
    const handle = attachCutawayControls(viewer, { cutaway: button });
    handles.push(handle);

    expect(button.title).toBe("Section the model");
  });

  test("generates adjacent Flip and Reset actions that are shown only while active", () => {
    const { viewer, button } = setup();
    const actions = button.nextElementSibling;
    const [flip, reset] = actions.querySelectorAll("button");

    expect(actions.className).toBe("pf-cutaway-actions");
    expect(actions.hidden).toBe(true);
    expect(flip.textContent).toBe("Flip");
    expect(reset.textContent).toBe("Reset");

    button.click();
    expect(actions.hidden).toBe(false);
    flip.click();
    reset.click();

    expect(viewer.flipCutaway).toHaveBeenCalledTimes(1);
    expect(viewer.resetCutaway).toHaveBeenCalledTimes(1);
    expect(viewer.setCutawayEnabled).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(actions.hidden).toBe(false);

    button.click();
    expect(actions.hidden).toBe(true);
  });

  test("handle reset disables cutaway and synchronizes the DOM", () => {
    const { viewer, button, handle } = setup();
    const actions = button.nextElementSibling;
    button.click();

    handle.reset();

    expect(viewer.setCutawayEnabled).toHaveBeenLastCalledWith(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("on")).toBe(false);
    expect(actions.hidden).toBe(true);
  });

  test("Escape disables cutaway only from the canvas or cutaway buttons", () => {
    const { viewer, button } = setup();
    const [flip, reset] = button.nextElementSibling.querySelectorAll("button");

    for (const target of [viewer.domElement, button, flip, reset]) {
      button.click();
      expect(viewer.cutawayEnabled()).toBe(true);
      pressEscape(target);
      expect(viewer.cutawayEnabled()).toBe(false);
    }

    button.click();
    pressEscape(document.body);
    expect(viewer.cutawayEnabled()).toBe(true);
  });

  test("makes the canvas focusable without replacing an existing tabindex", () => {
    const first = setup();
    expect(first.viewer.domElement.getAttribute("tabindex")).toBe("0");

    const viewer = fakeViewer();
    viewer.domElement.setAttribute("tabindex", "-1");
    const button = document.createElement("button");
    document.body.append(viewer.domElement, button);
    const handle = attachCutawayControls(viewer, { cutaway: button });
    handles.push(handle);

    expect(viewer.domElement.getAttribute("tabindex")).toBe("-1");
  });

  test("focuses the canvas without scrolling after pointer interaction", () => {
    const { viewer } = setup();
    const focus = vi.spyOn(viewer.domElement, "focus");

    viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("disables unsupported cutaway with an explanation", () => {
    const { viewer, button } = setup({ supported: false });

    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Cutaway requires a stencil-capable WebGL context");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    button.click();
    expect(viewer.setCutawayEnabled).not.toHaveBeenCalled();
  });

  test("missing primary button returns safe no-op methods", () => {
    const viewer = fakeViewer();
    viewer.domElement.setAttribute("tabindex", "-1");
    const handle = attachCutawayControls(viewer, {});

    expect(() => {
      handle.reset();
      handle.detach();
      handle.detach();
    }).not.toThrow();
    expect(viewer.setCutawayEnabled).not.toHaveBeenCalled();
    expect(viewer.domElement.getAttribute("tabindex")).toBe("-1");
  });

  test("detach removes listeners and generated DOM and is safe twice", () => {
    const { viewer, button, handle } = setup();
    const actions = button.nextElementSibling;
    const [flip] = actions.querySelectorAll("button");
    const focus = vi.spyOn(viewer.domElement, "focus");
    button.click();
    viewer.setCutawayEnabled.mockClear();

    handle.detach();
    handle.detach();
    button.click();
    flip.click();
    pressEscape(viewer.domElement);
    viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(actions.isConnected).toBe(false);
    expect(viewer.setCutawayEnabled).not.toHaveBeenCalled();
    expect(viewer.flipCutaway).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
