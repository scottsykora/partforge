// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  attachButtonTooltips,
  createTooltipPresenter,
} from "../../src/framework/tooltip.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

test("showPointer creates and positions the shared tooltip", () => {
  const tooltip = createTooltipPresenter();
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({ left: 0, right: 10, bottom: 10 });

  tooltip.showAnchor({ title: "Old content" }, anchor);
  tooltip.showPointer({ title: "Drainage hole", subtitle: "Planter" }, 20, 30);

  const element = document.getElementById("pf-hover-tip");
  expect(element).not.toBeNull();
  expect(element.parentElement).toBe(document.body);
  expect(element.classList.contains("pf-hover-tip")).toBe(true);
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Drainage hole");
  expect(element.querySelector(".pf-hover-sub").textContent).toBe("Planter");
  expect(element.style.left).toBe("34px");
  expect(element.style.top).toBe("44px");
  expect(element.classList.contains("pf-tooltip-anchored")).toBe(false);
});

test("showPointer keeps a measured tooltip inside every viewport margin", () => {
  vi.stubGlobal("innerWidth", 200);
  vi.stubGlobal("innerHeight", 100);
  const tooltip = createTooltipPresenter();
  const element = document.getElementById("pf-hover-tip");
  element.getBoundingClientRect = vi.fn(() => ({ width: 50, height: 20 }));

  tooltip.showPointer({ title: "Feature" }, 198, 98);

  expect(element.style.left).toBe("142px");
  expect(element.style.top).toBe("72px");
});

test("showAnchor positions below the anchor center", () => {
  const tooltip = createTooltipPresenter();
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({ left: 40, right: 100, bottom: 72 });

  tooltip.showAnchor({ title: "Reset view" }, anchor);

  const element = document.getElementById("pf-hover-tip");
  expect(element.querySelector("b").textContent).toBe("Reset view");
  expect(element.querySelector(".pf-hover-sub").textContent).toBe("");
  expect(element.style.left).toBe("70px");
  expect(element.style.top).toBe("80px");
  expect(element.classList.contains("pf-tooltip-anchored")).toBe(true);
  expect(element.classList.contains("show")).toBe(true);
});

test("showAnchor clamps a measured tooltip inside the right viewport edge", () => {
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 200);
  const tooltip = createTooltipPresenter();
  const element = document.getElementById("pf-hover-tip");
  element.getBoundingClientRect = vi.fn(() => ({ width: 100, height: 30 }));
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({
    left: 290,
    right: 310,
    top: 20,
    bottom: 40,
  });

  tooltip.showAnchor({ title: "Reset view" }, anchor);

  expect(element.getBoundingClientRect).toHaveBeenCalledTimes(1);
  expect(element.style.left).toBe("212px");
  expect(element.style.top).toBe("48px");
});

test("showAnchor fits a viewport-width tooltip between narrow-screen margins", () => {
  vi.stubGlobal("innerWidth", 200);
  vi.stubGlobal("innerHeight", 200);
  const tooltip = createTooltipPresenter();
  const element = document.getElementById("pf-hover-tip");
  const measuredWidth = 200 - 16;
  element.getBoundingClientRect = () => ({ width: measuredWidth, height: 24 });
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({
    left: 180,
    right: 196,
    top: 20,
    bottom: 40,
  });

  tooltip.showAnchor({ title: "A long valid button label" }, anchor);

  const left = Number.parseFloat(element.style.left);
  expect(left).toBe(8);
  expect(left + measuredWidth).toBe(192);
});

test("showAnchor normalizes stale pointer placement before measuring", () => {
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 200);
  const tooltip = createTooltipPresenter();
  const element = document.getElementById("pf-hover-tip");
  tooltip.showPointer({ title: "Pointer feature" }, 300, 50);
  expect(element.style.left).toBe("312px");
  expect(element.style.top).toBe("64px");

  let measuredAt;
  element.getBoundingClientRect = vi.fn(() => {
    measuredAt = { left: element.style.left, top: element.style.top };
    const width = element.style.left === "312px" ? 40 : 120;
    return { width, height: 24 };
  });
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({
    left: 290,
    right: 310,
    top: 20,
    bottom: 40,
  });

  tooltip.showAnchor({ title: "Reset view" }, anchor);

  expect(measuredAt).toEqual({ left: "8px", top: "8px" });
  expect(element.querySelector("b").textContent).toBe("Reset view");
  expect(element.classList.contains("show")).toBe(true);
  expect(element.style.left).toBe("192px");
  expect(element.style.top).toBe("48px");
});

test("showAnchor flips a measured tooltip above the bottom viewport edge", () => {
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 200);
  const tooltip = createTooltipPresenter();
  const element = document.getElementById("pf-hover-tip");
  element.getBoundingClientRect = vi.fn(() => {
    expect(element.classList.contains("show")).toBe(true);
    expect(element.querySelector("b").textContent).toBe("Reset view");
    return { width: 80, height: 32 };
  });
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({
    left: 100,
    right: 120,
    top: 180,
    bottom: 196,
  });

  tooltip.showAnchor({ title: "Reset view" }, anchor);

  expect(element.style.left).toBe("70px");
  expect(element.style.top).toBe("140px");
});

test("showAnchor clamps an above fallback to the top viewport margin", () => {
  vi.stubGlobal("innerWidth", 320);
  vi.stubGlobal("innerHeight", 80);
  const tooltip = createTooltipPresenter();
  const element = document.getElementById("pf-hover-tip");
  element.getBoundingClientRect = vi.fn(() => ({ width: 80, height: 60 }));
  const anchor = document.createElement("button");
  anchor.getBoundingClientRect = () => ({
    left: 100,
    right: 140,
    top: 20,
    bottom: 40,
  });

  tooltip.showAnchor({ title: "Reset view" }, anchor);

  expect(element.style.top).toBe("8px");
});

test("hide conceals a visible tooltip", () => {
  const tooltip = createTooltipPresenter();
  tooltip.showPointer({ title: "Feature" }, 0, 0);

  tooltip.hide();

  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
});

test("a stale presentation token cannot hide newer tooltip content", () => {
  const tooltip = createTooltipPresenter();
  const anchor = document.createElement("button");
  const pointerToken = tooltip.showPointer({ title: "Pointer feature" }, 0, 0);
  const anchorToken = tooltip.showAnchor({ title: "Button action" }, anchor);
  const element = document.getElementById("pf-hover-tip");

  expect(typeof pointerToken).toBe("symbol");
  expect(typeof anchorToken).toBe("symbol");
  expect(anchorToken).not.toBe(pointerToken);
  tooltip.hide(pointerToken);
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Button action");

  tooltip.hide(anchorToken);
  expect(element.classList.contains("show")).toBe(false);
});

test("hiding the active claim restores the prior tooltip presentation", () => {
  const tooltip = createTooltipPresenter();
  const anchor = document.createElement("button");
  const pointerToken = tooltip.showPointer({ title: "Pointer feature" }, 0, 0);
  const anchorToken = tooltip.showAnchor({ title: "Button action" }, anchor);
  const element = document.getElementById("pf-hover-tip");

  tooltip.hide(anchorToken);
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Pointer feature");
  expect(element.classList.contains("pf-tooltip-anchored")).toBe(false);

  tooltip.hide(pointerToken);
  expect(element.classList.contains("show")).toBe(false);
});

test("a focused tooltip is restored after another button stops hovering", () => {
  const tooltip = createTooltipPresenter();
  const focusedButton = document.createElement("button");
  focusedButton.setAttribute("aria-label", "Focused action");
  const hoveredButton = document.createElement("button");
  hoveredButton.setAttribute("aria-label", "Hovered action");
  document.body.append(focusedButton, hoveredButton);
  const binding = attachButtonTooltips(tooltip, [
    { element: focusedButton },
    { element: hoveredButton },
  ]);

  focusedButton.dispatchEvent(new FocusEvent("focus"));
  hoveredButton.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  hoveredButton.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));

  const element = document.getElementById("pf-hover-tip");
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Focused action");
  binding.detach();
  tooltip.dispose();
});

test("dispose is idempotent and presenter calls become safe no-ops", () => {
  const tooltip = createTooltipPresenter();

  tooltip.dispose();
  tooltip.dispose();
  tooltip.hide();
  tooltip.showPointer({ title: "Feature" }, 0, 0);
  tooltip.showAnchor({ title: "Button" }, document.createElement("button"));

  expect(document.getElementById("pf-hover-tip")).toBeNull();
});

test("ID-less presenters are independent and never create duplicate global IDs", () => {
  const first = createTooltipPresenter({ id: null });
  const second = createTooltipPresenter({ id: null });
  const elements = [...document.querySelectorAll(".pf-hover-tip")];

  expect(elements).toHaveLength(2);
  expect(document.querySelectorAll("#pf-hover-tip")).toHaveLength(0);
  first.showPointer({ title: "First feature" }, 10, 20);
  second.showPointer({ title: "Second feature" }, 30, 40);
  expect(elements[0].querySelector("b").textContent).toBe("First feature");
  expect(elements[1].querySelector("b").textContent).toBe("Second feature");

  first.dispose();
  expect(document.querySelectorAll(".pf-hover-tip")).toHaveLength(1);
  expect(elements[1].isConnected).toBe(true);
  expect(elements[1].classList.contains("show")).toBe(true);
  second.dispose();
});

test("button tooltips replace the native title and respond to pointer and click", () => {
  const button = document.createElement("button");
  button.title = "Reset view";
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };

  attachButtonTooltips(tooltip, [{ element: button }]);
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Reset view");

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).toHaveBeenCalledWith({ title: "Reset view" }, button);

  button.dispatchEvent(new PointerEvent("pointerleave"));
  expect(tooltip.hide).toHaveBeenCalledTimes(1);
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  button.dispatchEvent(new MouseEvent("click"));
  expect(tooltip.hide).toHaveBeenCalledTimes(2);
});

test("button tooltips show on focus and hide on blur", () => {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Reframe part");
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new FocusEvent("focus"));
  expect(tooltip.showAnchor).toHaveBeenCalledWith({ title: "Reframe part" }, button);

  button.dispatchEvent(new FocusEvent("blur"));
  expect(tooltip.hide).toHaveBeenCalledTimes(1);
});

test("button tooltips ignore touch pointer entry", () => {
  const button = document.createElement("button");
  button.title = "Reframe part";
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));

  expect(tooltip.showAnchor).not.toHaveBeenCalled();
});

test("disabled and aria-disabled buttons never present tooltips", () => {
  const disabled = document.createElement("button");
  disabled.disabled = true;
  disabled.setAttribute("aria-label", "Disabled action");
  const ariaDisabled = document.createElement("button");
  ariaDisabled.setAttribute("aria-disabled", "true");
  ariaDisabled.setAttribute("aria-label", "ARIA-disabled action");
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  attachButtonTooltips(tooltip, [
    { element: disabled },
    { element: ariaDisabled },
  ]);

  for (const button of [disabled, ariaDisabled]) {
    button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    button.dispatchEvent(new FocusEvent("focus"));
  }

  expect(tooltip.showAnchor).not.toHaveBeenCalled();
});

test("sync hides an unavailable active binding and restores it when re-enabled", () => {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Toggle action");
  const firstToken = Symbol("first");
  const secondToken = Symbol("second");
  const tooltip = {
    showAnchor: vi.fn()
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken),
    hide: vi.fn(),
  };
  const binding = attachButtonTooltips(tooltip, [{ element: button }]);
  button.dispatchEvent(new FocusEvent("focus"));

  button.setAttribute("aria-disabled", "true");
  binding.sync();
  expect(tooltip.hide).toHaveBeenCalledWith(firstToken);

  button.removeAttribute("aria-disabled");
  binding.sync();
  expect(tooltip.showAnchor).toHaveBeenCalledTimes(2);
  expect(tooltip.showAnchor).toHaveBeenLastCalledWith(
    { title: "Toggle action" },
    button,
  );
});

test("touch activation never shows a tooltip through its synthetic focus and click", () => {
  const button = document.createElement("button");
  button.title = "Reframe part";
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
  button.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
  button.dispatchEvent(new FocusEvent("focus"));
  button.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
  button.dispatchEvent(new MouseEvent("click"));

  expect(tooltip.showAnchor).not.toHaveBeenCalled();
});

test("mouse hover remains presented when focus begins before pointerleave", () => {
  const button = document.createElement("button");
  button.title = "Reframe part";
  const token = Symbol("button tooltip");
  const tooltip = { showAnchor: vi.fn(() => token), hide: vi.fn() };
  attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  button.dispatchEvent(new FocusEvent("focus"));
  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  expect(tooltip.hide).not.toHaveBeenCalled();

  button.dispatchEvent(new FocusEvent("blur"));
  expect(tooltip.showAnchor).toHaveBeenCalledOnce();
  expect(tooltip.hide).toHaveBeenCalledWith(token);
});

test("keyboard focus remains presented when hover begins before blur", () => {
  const button = document.createElement("button");
  button.title = "Reframe part";
  const token = Symbol("button tooltip");
  const tooltip = { showAnchor: vi.fn(() => token), hide: vi.fn() };
  attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new FocusEvent("focus"));
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  button.dispatchEvent(new FocusEvent("blur"));
  expect(tooltip.hide).not.toHaveBeenCalled();

  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).toHaveBeenCalledOnce();
  expect(tooltip.hide).toHaveBeenCalledWith(token);
});

test("click dismisses current reasons until a new entry presents again", () => {
  const button = document.createElement("button");
  button.title = "Reframe part";
  const firstToken = Symbol("first");
  const secondToken = Symbol("second");
  const tooltip = {
    showAnchor: vi.fn()
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken),
    hide: vi.fn(),
  };
  attachButtonTooltips(tooltip, [{ element: button }]);

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  button.dispatchEvent(new FocusEvent("focus"));
  button.dispatchEvent(new MouseEvent("click"));
  expect(tooltip.hide).toHaveBeenCalledWith(firstToken);

  button.dispatchEvent(new FocusEvent("blur"));
  expect(tooltip.showAnchor).toHaveBeenCalledOnce();
  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(tooltip.showAnchor).toHaveBeenCalledTimes(2);
  button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  expect(tooltip.hide).toHaveBeenLastCalledWith(secondToken);
});

test("button tooltip labels are read at show time", () => {
  const dynamicAria = document.createElement("button");
  dynamicAria.setAttribute("aria-label", "Pause rotation");
  const custom = document.createElement("button");
  let customLabel = "Enable cutaway";
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  attachButtonTooltips(tooltip, [
    { element: dynamicAria },
    { element: custom, getLabel: () => customLabel },
  ]);

  dynamicAria.setAttribute("aria-label", "Resume rotation");
  dynamicAria.dispatchEvent(new FocusEvent("focus"));
  customLabel = "Disable cutaway";
  custom.dispatchEvent(new FocusEvent("focus"));

  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    1,
    { title: "Resume rotation" },
    dynamicAria,
  );
  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    2,
    { title: "Disable cutaway" },
    custom,
  );
});

test("detach restores title and aria-label attributes exactly", () => {
  const titleOnly = document.createElement("button");
  titleOnly.setAttribute("title", "");
  const ariaOnly = document.createElement("button");
  ariaOnly.setAttribute("aria-label", "");
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  const handle = attachButtonTooltips(tooltip, [
    null,
    { element: null },
    { element: titleOnly },
    { element: ariaOnly },
  ]);

  titleOnly.setAttribute("title", "changed");
  titleOnly.setAttribute("aria-label", "changed");
  ariaOnly.setAttribute("title", "changed");
  ariaOnly.setAttribute("aria-label", "changed");
  handle.detach();
  handle.detach();

  expect(titleOnly.hasAttribute("title")).toBe(true);
  expect(titleOnly.getAttribute("title")).toBe("");
  expect(titleOnly.hasAttribute("aria-label")).toBe(false);
  expect(ariaOnly.hasAttribute("title")).toBe(false);
  expect(ariaOnly.hasAttribute("aria-label")).toBe(true);
  expect(ariaOnly.getAttribute("aria-label")).toBe("");
});

test("detach removes every button tooltip listener", () => {
  const button = document.createElement("button");
  button.title = "Reframe part";
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  const handle = attachButtonTooltips(tooltip, [{ element: button }]);
  handle.detach();
  tooltip.showAnchor.mockClear();
  tooltip.hide.mockClear();

  button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  button.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
  button.dispatchEvent(new PointerEvent("pointercancel", { pointerType: "touch" }));
  button.dispatchEvent(new PointerEvent("pointerleave"));
  button.dispatchEvent(new FocusEvent("focus"));
  button.dispatchEvent(new FocusEvent("blur"));
  button.dispatchEvent(new MouseEvent("click"));

  expect(tooltip.showAnchor).not.toHaveBeenCalled();
  expect(tooltip.hide).not.toHaveBeenCalled();
});

test("hide attempts every active binding before reporting collected errors", () => {
  const first = document.createElement("button");
  first.setAttribute("aria-label", "First action");
  const second = document.createElement("button");
  second.setAttribute("aria-label", "Second action");
  const firstToken = Symbol("first");
  const secondToken = Symbol("second");
  const firstError = new Error("first hide failed");
  const secondError = new Error("second hide failed");
  const tooltip = {
    showAnchor: vi.fn()
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken),
    hide: vi.fn((token) => {
      throw token === firstToken ? firstError : secondError;
    }),
  };
  const binding = attachButtonTooltips(tooltip, [
    { element: first },
    { element: second },
  ]);
  first.dispatchEvent(new FocusEvent("focus"));
  second.dispatchEvent(new FocusEvent("focus"));

  let thrown;
  try { binding.hide(); } catch (error) { thrown = error; }

  expect(tooltip.hide).toHaveBeenCalledTimes(2);
  expect(thrown).toBeInstanceOf(AggregateError);
  expect(thrown.errors).toEqual([firstError, secondError]);
});

test("detach restores every binding before reporting collected hide errors", () => {
  const first = document.createElement("button");
  first.setAttribute("title", "First host title");
  const second = document.createElement("button");
  second.setAttribute("title", "Second host title");
  second.setAttribute("aria-label", "Second host label");
  const firstError = new Error("first hide failed");
  const secondError = new Error("second hide failed");
  const tooltip = {
    showAnchor: vi.fn()
      .mockReturnValueOnce(Symbol("first"))
      .mockReturnValueOnce(Symbol("second")),
    hide: vi.fn()
      .mockImplementationOnce(() => { throw firstError; })
      .mockImplementationOnce(() => { throw secondError; }),
  };
  const binding = attachButtonTooltips(tooltip, [
    { element: first },
    { element: second },
  ]);
  first.dispatchEvent(new FocusEvent("focus"));
  second.dispatchEvent(new FocusEvent("focus"));

  let thrown;
  try { binding.detach(); } catch (error) { thrown = error; }

  expect(thrown).toBeInstanceOf(AggregateError);
  expect(thrown.errors).toEqual([firstError, secondError]);
  expect(first.getAttribute("title")).toBe("First host title");
  expect(first.hasAttribute("aria-label")).toBe(false);
  expect(second.getAttribute("title")).toBe("Second host title");
  expect(second.getAttribute("aria-label")).toBe("Second host label");

  tooltip.showAnchor.mockClear();
  tooltip.hide.mockClear();
  for (const button of [first, second]) {
    button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    button.dispatchEvent(new FocusEvent("focus"));
    button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    button.dispatchEvent(new FocusEvent("blur"));
  }
  expect(tooltip.showAnchor).not.toHaveBeenCalled();
  expect(tooltip.hide).not.toHaveBeenCalled();
  expect(() => binding.detach()).not.toThrow();
});

test("detach hides only an active binding and remains idempotent", () => {
  const activeButton = document.createElement("button");
  activeButton.setAttribute("aria-label", "Reframe part");
  const inactiveButton = document.createElement("button");
  inactiveButton.setAttribute("aria-label", "Pause rotation");
  const token = Symbol("reframe");
  const tooltip = { showAnchor: vi.fn(() => token), hide: vi.fn() };
  const active = attachButtonTooltips(tooltip, [{ element: activeButton }]);
  const inactive = attachButtonTooltips(tooltip, [{ element: inactiveButton }]);
  activeButton.dispatchEvent(new FocusEvent("focus"));

  active.detach();
  active.detach();
  inactive.detach();

  expect(tooltip.showAnchor).toHaveBeenCalledWith(
    { title: "Reframe part" },
    activeButton,
  );
  expect(tooltip.hide).toHaveBeenCalledOnce();
  expect(tooltip.hide).toHaveBeenCalledWith(token);
});

test("detaching one button binding cannot hide another binding's presentation", () => {
  const tooltip = createTooltipPresenter();
  const buttonA = document.createElement("button");
  buttonA.setAttribute("aria-label", "Button A");
  const buttonB = document.createElement("button");
  buttonB.setAttribute("aria-label", "Button B");
  const bindingA = attachButtonTooltips(tooltip, [{ element: buttonA }]);
  const bindingB = attachButtonTooltips(tooltip, [{ element: buttonB }]);
  buttonB.dispatchEvent(new FocusEvent("focus"));

  bindingA.detach();

  const element = document.getElementById("pf-hover-tip");
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Button B");

  bindingB.detach();
  expect(element.classList.contains("show")).toBe(false);
});

test("button detach cannot hide a newer pointer presentation", () => {
  const tooltip = createTooltipPresenter();
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Button action");
  const binding = attachButtonTooltips(tooltip, [{ element: button }]);
  button.dispatchEvent(new FocusEvent("focus"));
  tooltip.showPointer({ title: "Model feature" }, 20, 30);

  binding.detach();

  const element = document.getElementById("pf-hover-tip");
  expect(element.classList.contains("show")).toBe(true);
  expect(element.querySelector("b").textContent).toBe("Model feature");
});

test("tooltip styles apply by class without shifting anchored coordinates", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/framework/app.css", "utf8");
  const element = document.createElement("div");
  element.className = "pf-hover-tip pf-tooltip-anchored show";
  document.head.appendChild(style);
  document.body.appendChild(element);

  const computed = getComputedStyle(element);
  expect(computed.position).toBe("fixed");
  expect(computed.display).toBe("block");
  expect(computed.transform).toBe("");

  style.remove();
});

test("tooltip max width preserves both viewport margins on narrow screens", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/framework/app.css", "utf8");
  const element = document.createElement("div");
  element.className = "pf-hover-tip";
  document.head.appendChild(style);
  document.body.appendChild(element);

  expect(style.textContent).toContain(
    "max-width: min(260px, calc(100vw - 16px))",
  );

  style.remove();
});

test("legacy ID-only tooltip keeps display and subtitle styling", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/framework/app.css", "utf8");
  const element = document.createElement("div");
  element.id = "pf-hover-tip";
  element.className = "show";
  const subtitle = document.createElement("span");
  subtitle.className = "pf-hover-sub";
  subtitle.textContent = "Planter";
  element.appendChild(subtitle);
  document.head.appendChild(style);
  document.body.appendChild(element);

  expect(getComputedStyle(element).display).toBe("block");
  const subtitleStyle = getComputedStyle(subtitle);
  expect(subtitleStyle.fontSize).toBe("11px");
  expect(subtitleStyle.marginLeft).toBe("7px");

  style.remove();
});
