// @vitest-environment happy-dom
// The optional viewer-chrome buttons (pause / reframe / theme), now taking element
// refs and returning a detach() for mount dispose.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { attachViewerControls } from "../../src/framework/viewer-controls.js";

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
