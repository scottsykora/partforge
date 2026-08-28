// test/framework/annotate/sketch-toolbar.test.js
// @vitest-environment happy-dom
// The sketch-mode toolbar: build, sync, tool wiring, host-send contract.
import { afterEach, expect, test, vi } from "vitest";
import { attachSketchToolbar } from "../../../src/framework/annotate/sketch-toolbar.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(over = {}) {
  const toolCbs = new Set(), inkCbs = new Set(), modeCbs = new Set();
  let tool = "pen", color = "red", enabled = false;
  return {
    tool: () => tool, color: () => color,
    setTool: vi.fn((t) => { tool = t; toolCbs.forEach((cb) => cb()); }),
    setColor: vi.fn((c) => { color = c; toolCbs.forEach((cb) => cb()); }),
    isEnabled: () => enabled,
    _setEnabled(on) { enabled = on; modeCbs.forEach((cb) => cb()); },
    strokeCount: () => 0, canUndo: () => false,
    undo: vi.fn(), clear: vi.fn(), send: vi.fn(), setEnabled: vi.fn(),
    onToolChange: (cb) => { toolCbs.add(cb); return () => toolCbs.delete(cb); },
    onInkChange: (cb) => { inkCbs.add(cb); return () => inkCbs.delete(cb); },
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
    ...over,
  };
}

const stage = () => {
  const s = document.createElement("div");
  document.body.appendChild(s);
  return s;
};

test("builds six tools, three swatches, undo/clear, and follows mode visibility", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  expect(element.hidden).toBe(true);
  mode._setEnabled(true);
  expect(element.hidden).toBe(false);
  expect(element.querySelectorAll("[data-tool]")).toHaveLength(6);
  expect(element.querySelectorAll("[data-color]")).toHaveLength(3);
  expect(element.querySelector('[data-action="undo"]').disabled).toBe(true);
});

test("clicking a tool selects it; clicking a swatch sets the color", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  mode._setEnabled(true);
  element.querySelector('[data-tool="rect"]').click();
  expect(mode.setTool).toHaveBeenCalledWith("rect");
  expect(element.querySelector('[data-tool="rect"]').classList.contains("on")).toBe(true);
  element.querySelector('[data-color="green"]').click();
  expect(mode.setColor).toHaveBeenCalledWith("green");
});

test("send: 'viewbar' renders a Send button, 'host' renders none", () => {
  const withSend = attachSketchToolbar(fakeMode(), { stage: stage() });
  expect(withSend.element.querySelector('[data-action="send"]')).not.toBeNull();
  const hostOwned = attachSketchToolbar(fakeMode(), { stage: stage(), send: "host" });
  expect(hostOwned.element.querySelector('[data-action="send"]')).toBeNull();
});

// The close button is the toolbar's own exit affordance — the in-UI escape
// hatch now that #viewbar (and its pencil toggle) is hidden for the duration
// of sketch mode. It must survive both `send` variants and always sit last,
// after Send when Send exists at all.
test("close button exists and is last in both send variants", () => {
  const withSend = attachSketchToolbar(fakeMode(), { stage: stage() });
  const closeInWithSend = withSend.element.querySelector('[data-action="close"]');
  expect(closeInWithSend).not.toBeNull();
  expect(withSend.element.lastElementChild).toBe(closeInWithSend);

  const hostOwned = attachSketchToolbar(fakeMode(), { stage: stage(), send: "host" });
  const closeInHostOwned = hostOwned.element.querySelector('[data-action="close"]');
  expect(closeInHostOwned).not.toBeNull();
  expect(hostOwned.element.lastElementChild).toBe(closeInHostOwned);
});

test("clicking close exits the mode", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  mode._setEnabled(true);
  element.querySelector('[data-action="close"]').click();
  expect(mode.setEnabled).toHaveBeenCalledWith(false);
});

test("hint line follows the tool", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  mode._setEnabled(true);
  const hint = element.parentElement.querySelector(".pf-sketch-hint");
  expect(hint.textContent).toBe("drag to draw");
  element.querySelector('[data-tool="eraser"]').click();
  expect(hint.textContent).toBe("scrub to erase");
});

test("detach removes the DOM and survives double-detach", () => {
  const mode = fakeMode();
  const s = stage();
  const bar = attachSketchToolbar(mode, { stage: s });
  bar.detach();
  bar.detach();
  expect(s.querySelector(".pf-sketch-toolbar")).toBeNull();
  expect(s.querySelector(".pf-sketch-hint")).toBeNull();
});
