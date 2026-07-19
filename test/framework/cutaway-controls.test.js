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

  test("Escape returns focus to the primary button before hiding its actions", () => {
    const { viewer, button } = setup();
    const actions = button.nextElementSibling;
    const [flip] = actions.querySelectorAll("button");
    button.click();
    flip.focus();
    expect(document.activeElement).toBe(flip);

    pressEscape(flip);

    expect(viewer.cutawayEnabled()).toBe(false);
    expect(actions.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  test("makes the canvas focusable without replacing an existing tabindex", () => {
    const first = setup();
    expect(first.viewer.domElement.getAttribute("tabindex")).toBe("0");

    first.handle.detach();
    expect(first.viewer.domElement.hasAttribute("tabindex")).toBe(false);

    const viewer = fakeViewer();
    viewer.domElement.setAttribute("tabindex", "-1");
    const button = document.createElement("button");
    document.body.append(viewer.domElement, button);
    const handle = attachCutawayControls(viewer, { cutaway: button });
    handles.push(handle);

    expect(viewer.domElement.getAttribute("tabindex")).toBe("-1");
    handle.detach();
    expect(viewer.domElement.getAttribute("tabindex")).toBe("-1");
  });

  test("gives the focusable canvas a reversible accessible name", () => {
    const first = setup();
    expect(first.viewer.domElement.getAttribute("aria-label")).toBe("3D part viewer");

    first.handle.detach();
    expect(first.viewer.domElement.hasAttribute("aria-label")).toBe(false);

    const viewer = fakeViewer();
    viewer.domElement.setAttribute("aria-label", "Interactive gearbox preview");
    const button = document.createElement("button");
    document.body.append(viewer.domElement, button);
    const handle = attachCutawayControls(viewer, { cutaway: button });
    handles.push(handle);

    expect(viewer.domElement.getAttribute("aria-label")).toBe("Interactive gearbox preview");
    handle.detach();
    expect(viewer.domElement.getAttribute("aria-label")).toBe("Interactive gearbox preview");
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
    expect(button.getAttribute("aria-description")).toBe(
      "Cutaway requires a stencil-capable WebGL context",
    );
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

  test("detach restores primary host state and reset becomes inert", () => {
    const viewer = fakeViewer({ supported: false });
    const button = document.createElement("button");
    button.setAttribute("type", "submit");
    button.setAttribute("aria-pressed", "mixed");
    button.setAttribute("title", "Host section control");
    button.setAttribute("aria-description", "Host description");
    button.classList.add("on");
    document.body.append(viewer.domElement, button);
    const handle = attachCutawayControls(viewer, { cutaway: button });
    handles.push(handle);

    expect(button.type).toBe("button");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("on")).toBe(false);
    expect(button.nextElementSibling?.classList.contains("pf-cutaway-actions")).toBe(true);

    handle.detach();
    viewer.setCutawayEnabled.mockClear();
    handle.reset();

    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("aria-pressed")).toBe("mixed");
    expect(button.getAttribute("title")).toBe("Host section control");
    expect(button.getAttribute("aria-description")).toBe("Host description");
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.classList.contains("on")).toBe(true);
    expect(button.nextElementSibling).toBeNull();
    expect(viewer.setCutawayEnabled).not.toHaveBeenCalled();
  });

  test("detach restores absent primary attributes and allows a clean remount", () => {
    const unsupported = fakeViewer({ supported: false });
    const button = document.createElement("button");
    document.body.append(unsupported.domElement, button);
    const first = attachCutawayControls(unsupported, { cutaway: button });
    handles.push(first);
    first.detach();

    expect(button.hasAttribute("type")).toBe(false);
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.hasAttribute("aria-description")).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.classList.contains("on")).toBe(false);

    const supported = fakeViewer();
    const second = attachCutawayControls(supported, { cutaway: button });
    handles.push(second);
    button.click();

    expect(supported.setCutawayEnabled).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".pf-cutaway-actions")).toHaveLength(1);
  });
});
