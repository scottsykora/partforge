// @vitest-environment happy-dom
// Viewbar chrome for annotation mode. Mirrors measure-controls.test.js:
// attach/detach round-trip, aria-pressed, action gating, Escape consumption.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnnotateControls } from "../../../src/framework/annotate/annotate-controls.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(over = {}) {
  const inkCbs = new Set();
  const modeCbs = new Set();
  let enabled = false;
  let strokes = 0;
  return {
    setEnabled: vi.fn((on) => { enabled = on; for (const cb of modeCbs) cb(); }),
    isEnabled: () => enabled,
    undo: vi.fn(() => { if (strokes) strokes -= 1; for (const cb of inkCbs) cb(); }),
    clear: vi.fn(() => { strokes = 0; for (const cb of inkCbs) cb(); }),
    strokeCount: () => strokes,
    send: vi.fn(() => strokes > 0),
    onInkChange: (cb) => { inkCbs.add(cb); return () => inkCbs.delete(cb); },
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
    __setStrokes: (n) => { strokes = n; for (const cb of inkCbs) cb(); },
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

test("toggle drives aria-pressed and reveals the actions row", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.click();
  expect(mode.setEnabled).toHaveBeenCalledWith(true);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  const actions = document.querySelector(".pf-annotate-actions");
  expect(actions.hidden).toBe(false);
  button.click();
  expect(actions.hidden).toBe(true);
});

test("Undo/Clear/Send disable while the canvas is empty, enable with ink", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  button.click(); // enable
  const [undoBtn, clearBtn, sendBtn] = document.querySelectorAll(".pf-annotate-actions button");
  expect(sendBtn.textContent).toBe("Send");
  expect(undoBtn.disabled && clearBtn.disabled && sendBtn.disabled).toBe(true);
  mode.__setStrokes(2);
  expect(undoBtn.disabled || clearBtn.disabled || sendBtn.disabled).toBe(false);
  sendBtn.click();
  expect(mode.send).toHaveBeenCalledTimes(1);
  undoBtn.click();
  expect(mode.undo).toHaveBeenCalledTimes(1);
  clearBtn.click();
  expect(mode.clear).toHaveBeenCalledTimes(1);
});

test("send:host drops Send and keeps Undo/Clear working", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  const chrome = attachAnnotateControls(viewer, mode, { annotate: button }, { send: "host" });
  button.click(); // enable
  const actionButtons = [...document.querySelectorAll(".pf-annotate-actions button")];
  expect(actionButtons.map((b) => b.textContent)).toEqual(["Undo", "Clear"]);
  mode.__setStrokes(1);
  const [undoBtn, clearBtn] = actionButtons;
  expect(undoBtn.disabled || clearBtn.disabled).toBe(false);
  undoBtn.click();
  expect(mode.undo).toHaveBeenCalledTimes(1);
  // The host drives Send itself; nothing in the row does.
  expect(mode.send).not.toHaveBeenCalled();
  expect(() => chrome.detach()).not.toThrow();
  expect(document.querySelector(".pf-annotate-actions")).toBe(null);
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

test("detach restores host attributes, content and removes the actions row", () => {
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
  expect(document.querySelector(".pf-annotate-actions")).toBe(null);
});
