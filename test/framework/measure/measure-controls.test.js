// @vitest-environment happy-dom
// Viewbar chrome for measurement mode + the cutaway Escape-ordering contract.
import { afterEach, expect, test, vi } from "vitest";
import { attachMeasureControls } from "../../../src/framework/measure/measure-controls.js";
import { attachCutawayControls } from "../../../src/framework/cutaway-controls.js";

// Each test's fixture() appends fresh nodes to document.body without
// removing prior tests' — without this, document.querySelector(".pf-measure-actions")
// below can resolve to a previous test's row (happy-dom's document persists
// across tests within a file, same reason cutaway-controls.test.js clears it).
afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(over = {}) {
  const pinCbs = new Set();
  let enabled = false;
  let pins = 0;
  return {
    setEnabled: vi.fn((on) => { enabled = on; }),
    isEnabled: () => enabled,
    clearPins: vi.fn(() => { pins = 0; for (const cb of pinCbs) cb(); }),
    pinCount: () => pins,
    onPinsChange: (cb) => { pinCbs.add(cb); return () => pinCbs.delete(cb); },
    __setPins: (n) => { pins = n; for (const cb of pinCbs) cb(); },
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
  const chrome = attachMeasureControls(viewer, fakeMode(), {});
  chrome.detach(); // must not throw
});

test("toggle wires aria-pressed and the mode", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachMeasureControls(viewer, mode, { measure: button });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.click();
  expect(mode.setEnabled).toHaveBeenCalledWith(true);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.classList.contains("on")).toBe(true);
});

test("Clear appears only with pins and clears them", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachMeasureControls(viewer, mode, { measure: button });
  button.click();
  const actions = document.querySelector(".pf-measure-actions");
  expect(actions.hidden).toBe(false);
  const clear = [...actions.querySelectorAll("button")].find((b) => b.textContent === "Clear");
  expect(clear.hidden).toBe(true);
  mode.__setPins(2);
  expect(clear.hidden).toBe(false);
  clear.click();
  expect(mode.clearPins).toHaveBeenCalled();
  expect(clear.hidden).toBe(true);
});

test("Escape exits the mode; cutaway skips Escape while measure is active", () => {
  const { viewer, button } = fixture();
  const cutButton = document.createElement("button");
  document.body.appendChild(cutButton);
  const mode = fakeMode();
  const cutViewer = {
    domElement: viewer.domElement,
    cutawaySupported: () => true,
    cutawayEnabled: vi.fn(() => true),
    setCutawayEnabled: vi.fn(),
    flipCutaway: vi.fn(),
    resetCutaway: vi.fn(),
  };
  attachCutawayControls(cutViewer, { cutaway: cutButton }, { escapeGuard: () => mode.isEnabled() });
  attachMeasureControls(viewer, mode, { measure: button });
  button.click(); // measure on
  viewer.domElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(mode.setEnabled).toHaveBeenLastCalledWith(false);
  expect(cutViewer.setCutawayEnabled).not.toHaveBeenCalled(); // guard held
  viewer.domElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(cutViewer.setCutawayEnabled).toHaveBeenCalledWith(false); // second Escape reaches cutaway
});

test("Escape ordering holds when measure attaches before cutaway", () => {
  const { viewer, button } = fixture();
  const cutButton = document.createElement("button");
  document.body.appendChild(cutButton);
  const mode = fakeMode();
  attachMeasureControls(viewer, mode, { measure: button });
  const cutViewer = {
    domElement: viewer.domElement,
    cutawaySupported: () => true,
    cutawayEnabled: vi.fn(() => true),
    setCutawayEnabled: vi.fn(),
    flipCutaway: vi.fn(),
    resetCutaway: vi.fn(),
  };
  attachCutawayControls(cutViewer, { cutaway: cutButton }, { escapeGuard: () => mode.isEnabled() });
  button.click(); // measure on
  viewer.domElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(mode.setEnabled).toHaveBeenLastCalledWith(false);
  expect(cutViewer.setCutawayEnabled).not.toHaveBeenCalled(); // consumed by measure
  viewer.domElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(cutViewer.setCutawayEnabled).toHaveBeenCalledWith(false);
});

test("detach restores the host button and removes the actions row", () => {
  const { viewer, button } = fixture();
  button.setAttribute("title", "host title");
  const chrome = attachMeasureControls(viewer, fakeMode(), { measure: button });
  button.click();
  chrome.detach();
  expect(button.getAttribute("title")).toBe("host title");
  expect(button.classList.contains("on")).toBe(false);
  expect(document.querySelector(".pf-measure-actions")).toBeNull();
});
