// @vitest-environment happy-dom
// Viewbar chrome for annotation mode: just the pencil toggle now — the
// Undo/Clear/Send actions row moved to the sketch toolbar (sketch-toolbar.js,
// spec 2026-08-27; see sketch-toolbar.test.js for its own coverage). Mirrors
// measure-controls.test.js: attach/detach round-trip, aria-pressed, Escape
// consumption.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnnotateControls } from "../../../src/framework/annotate/annotate-controls.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(over = {}) {
  const modeCbs = new Set();
  let enabled = false;
  return {
    setEnabled: vi.fn((on) => { enabled = on; for (const cb of modeCbs) cb(); }),
    isEnabled: () => enabled,
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
    ...over,
  };
}

function fixture() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const button = document.createElement("button");
  document.body.appendChild(button);
  return { canvas, button, viewer: { domElement: canvas } };
}

test("no button -> inert no-op", () => {
  const { viewer } = fixture();
  const chrome = attachAnnotateControls(viewer, fakeMode(), {});
  expect(() => chrome.detach()).not.toThrow();
});

test("button without a mode (no onAnnotationSend) is hidden, restored on detach", () => {
  const { viewer, button } = fixture();
  const chrome = attachAnnotateControls(viewer, null, { annotate: button });
  expect(button.hidden).toBe(true);
  chrome.detach();
  expect(button.hidden).toBe(false);
});

test("toggle drives aria-pressed and the mode", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.click();
  expect(mode.setEnabled).toHaveBeenCalledWith(true);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  button.click();
  expect(mode.setEnabled).toHaveBeenCalledWith(false);
  expect(button.getAttribute("aria-pressed")).toBe("false");
});

test("Escape exits the mode and consumes the keystroke", () => {
  const { viewer, button, canvas } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  button.click(); // enable
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  const stopSpy = vi.spyOn(event, "stopImmediatePropagation");
  canvas.dispatchEvent(event);
  expect(mode.setEnabled).toHaveBeenLastCalledWith(false);
  expect(event.defaultPrevented).toBe(true);
  expect(stopSpy).toHaveBeenCalled();
});

test("detach restores host attributes and content", () => {
  const { viewer, button } = fixture();
  button.setAttribute("title", "host title");
  button.textContent = "host";
  const chrome = attachAnnotateControls(viewer, fakeMode(), { annotate: button });
  expect(button.innerHTML).toContain("svg");
  chrome.detach();
  chrome.detach(); // idempotent
  expect(button.getAttribute("title")).toBe("host title");
  expect(button.textContent).toBe("host");
  expect(button.hasAttribute("aria-pressed")).toBe(false);
});
