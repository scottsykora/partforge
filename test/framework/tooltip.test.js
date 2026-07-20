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
  expect(element.style.left).toBe("314px");
  expect(element.style.top).toBe("64px");

  let measuredAt;
  element.getBoundingClientRect = vi.fn(() => {
    measuredAt = { left: element.style.left, top: element.style.top };
    const width = element.style.left === "314px" ? 40 : 120;
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

test("hide conceals a visible tooltip", () => {
  const tooltip = createTooltipPresenter();
  tooltip.showPointer({ title: "Feature" }, 0, 0);

  tooltip.hide();

  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
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
  button.dispatchEvent(new PointerEvent("pointerleave"));
  button.dispatchEvent(new FocusEvent("focus"));
  button.dispatchEvent(new FocusEvent("blur"));
  button.dispatchEvent(new MouseEvent("click"));

  expect(tooltip.showAnchor).not.toHaveBeenCalled();
  expect(tooltip.hide).not.toHaveBeenCalled();
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
