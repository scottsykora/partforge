// @vitest-environment happy-dom
// The optional viewer-chrome buttons (pause / reframe / theme), now taking element
// refs and returning a detach() for mount dispose.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachViewerControls } from "../../src/framework/viewer-controls.js";
import { createTooltipPresenter } from "../../src/framework/tooltip.js";

function fakeViewer() {
  return {
    setTheme: vi.fn(),
    setAutoRotate: vi.fn(),
    frame: vi.fn(),
    onCameraEnd: vi.fn(),
    getCameraState: vi.fn(() => ({ pos: [1, 2, 3], target: [0, 0, 0] })),
  };
}

let els;
let handles = [];
// attachViewerControls adds a window "pagehide" listener, and happy-dom shares one
// window across the whole file — detach every handle so listeners can't leak
// between tests. Double-detach is safe (removeEventListener is a no-op on repeat).
afterEach(() => { for (const h of handles.splice(0)) h?.detach(); });
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<button id="pause"></button><button id="reframe"></button><button id="theme"></button>';
  els = {
    pause: document.getElementById("pause"),
    reframe: document.getElementById("reframe"),
    theme: document.getElementById("theme"),
  };
});

test("theme button toggles the page theme and the scene", () => {
  const viewer = fakeViewer();
  const chrome = attachViewerControls(viewer, els);
  handles.push(chrome);
  expect(viewer.setTheme).toHaveBeenCalledWith("dark"); // initial apply (default theme)
  els.theme.click();
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(viewer.setTheme).toHaveBeenLastCalledWith("light");
});

test("buttons expose exact state-aware accessible labels", () => {
  const viewer = fakeViewer();
  const chrome = attachViewerControls(viewer, els);
  handles.push(chrome);

  expect(els.pause.getAttribute("aria-label")).toBe("Pause rotation");
  expect(els.reframe.getAttribute("aria-label")).toBe("Re-frame model");
  expect(els.theme.getAttribute("aria-label")).toBe("Switch to light mode");

  els.pause.click();
  els.theme.click();

  expect(els.pause.getAttribute("aria-label")).toBe("Resume rotation");
  expect(els.theme.getAttribute("aria-label")).toBe("Switch to dark mode");
});

test("shared tooltips cover every viewer button and read current action labels", () => {
  const viewer = fakeViewer();
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  const chrome = attachViewerControls(viewer, els, { tooltip });
  handles.push(chrome);

  for (const button of [els.pause, els.reframe, els.theme]) {
    expect(button.hasAttribute("title")).toBe(false);
    button.dispatchEvent(new FocusEvent("focus"));
  }
  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    1,
    { title: "Pause rotation" },
    els.pause,
  );
  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    2,
    { title: "Re-frame model" },
    els.reframe,
  );
  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    3,
    { title: "Switch to light mode" },
    els.theme,
  );

  els.pause.click();
  els.theme.click();
  els.pause.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  els.theme.dispatchEvent(new FocusEvent("focus"));
  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    4,
    { title: "Resume rotation" },
    els.pause,
  );
  expect(tooltip.showAnchor).toHaveBeenNthCalledWith(
    5,
    { title: "Switch to dark mode" },
    els.theme,
  );
});

test("custom tooltip detach restores original attributes and removes its listeners", () => {
  const viewer = fakeViewer();
  const tooltip = { showAnchor: vi.fn(), hide: vi.fn() };
  els.pause.setAttribute("title", "Host pause title");
  els.pause.setAttribute("aria-label", "Host pause label");
  const chrome = attachViewerControls(viewer, els, { tooltip });
  handles.push(chrome);

  expect(els.pause.hasAttribute("title")).toBe(false);
  expect(els.pause.getAttribute("aria-label")).toBe("Pause rotation");
  chrome.detach();
  tooltip.showAnchor.mockClear();
  tooltip.hide.mockClear();

  expect(els.pause.getAttribute("title")).toBe("Host pause title");
  expect(els.pause.getAttribute("aria-label")).toBe("Host pause label");
  els.pause.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  els.pause.dispatchEvent(new FocusEvent("focus"));
  els.pause.dispatchEvent(new PointerEvent("pointerleave"));
  els.pause.dispatchEvent(new FocusEvent("blur"));
  expect(tooltip.showAnchor).not.toHaveBeenCalled();
  expect(tooltip.hide).not.toHaveBeenCalled();
});

test("viewer state sync hides a tooltip whose control became disabled", () => {
  const viewer = fakeViewer();
  const tooltip = createTooltipPresenter();
  const chrome = attachViewerControls(viewer, els, { tooltip });
  handles.push(chrome);
  els.pause.dispatchEvent(new FocusEvent("focus"));
  const element = document.getElementById("pf-hover-tip");
  expect(element.classList.contains("show")).toBe(true);

  els.pause.disabled = true;
  els.theme.click();

  expect(element.classList.contains("show")).toBe(false);
  tooltip.dispose();
});

test("reframe button re-fits the camera", () => {
  const viewer = fakeViewer();
  const chrome = attachViewerControls(viewer, els);
  handles.push(chrome);
  els.reframe.click();
  expect(viewer.frame).toHaveBeenCalledTimes(1);
});

test("missing buttons are a no-op", () => {
  const viewer = fakeViewer();
  expect(() => handles.push(attachViewerControls(viewer, {}))).not.toThrow();
  expect(() => handles.push(attachViewerControls(viewer, {}, {
    tooltip: { showAnchor: vi.fn(), hide: vi.fn() },
  }))).not.toThrow();
});

test("detach() removes button and pagehide listeners", () => {
  const viewer = fakeViewer();
  const chrome = attachViewerControls(viewer, els);
  handles.push(chrome);
  chrome.detach();
  els.reframe.click();
  expect(viewer.frame).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pagehide"));
  expect(localStorage.getItem("partforge:camera")).toBeNull(); // camera not saved after detach
});
