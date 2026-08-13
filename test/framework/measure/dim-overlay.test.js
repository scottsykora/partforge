// @vitest-environment happy-dom
// SVG overlay renderer: primitive -> element mapping, chip interactivity, teardown.
import { expect, test, vi } from "vitest";
import { createDimOverlay } from "../../../src/framework/measure/dim-overlay.js";

const prims = {
  lines: [
    { x1: 0, y1: 0, x2: 10, y2: 0, kind: "ext", tier: "static" },
    { x1: 0, y1: 5, x2: 10, y2: 5, kind: "dim", tier: "static" },
  ],
  arrows: [{ x: 10, y: 5, angle: 0, tier: "static" }],
  labels: [
    { id: "a:0", itemId: "a", text: "24.00", x: 2, y: 8, w: 40, h: 16, tier: "static", kind: "chip", paramName: null, pinned: false },
    { id: "b:dia", itemId: "pin:leg:hole:1", text: "⌀8.00", x: 60, y: 8, w: 60, h: 16, tier: "pinned", kind: "chip", paramName: "bore_d", pinned: true },
  ],
};
const vp = { width: 200, height: 100 };

test("renders lines, arrows and labels with tier/kind classes", () => {
  const host = document.createElement("div");
  const overlay = createDimOverlay(host);
  overlay.render(prims, vp);
  const svg = overlay.element;
  expect(svg.getAttribute("viewBox")).toBe("0 0 200 100");
  expect(svg.querySelectorAll("line.pf-dim-ext").length).toBe(1);
  expect(svg.querySelectorAll("line.pf-dim-line").length).toBe(1);
  expect(svg.querySelectorAll("path.pf-dim-arrow").length).toBe(1);
  expect(svg.querySelectorAll("g.pf-dim-chip").length).toBe(2);
  const chip = svg.querySelector('g[data-dim-id="b:dia"]');
  expect(chip.classList.contains("linked")).toBe(true);
  // Structured item ref alongside the (possibly colon-bearing) dim id: chip
  // resolution keys off data-item-id, never off parsing data-dim-id.
  expect(chip.getAttribute("data-item-id")).toBe("pin:leg:hole:1");
  overlay.dispose();
  expect(host.querySelector("svg")).toBeNull();
});

test("linked chip carries the param name and is a keyboard button", () => {
  const host = document.createElement("div");
  const onChipClick = vi.fn();
  const overlay = createDimOverlay(host, { onChipClick });
  overlay.render(prims, vp);
  const chip = overlay.element.querySelector('g[data-dim-id="b:dia"]');
  expect(chip.getAttribute("role")).toBe("button");
  expect(chip.getAttribute("tabindex")).toBe("0");
  expect(chip.textContent).toContain("bore_d");
  chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // itemId first, dimId second — the resolver acts on the structured ref.
  expect(onChipClick).toHaveBeenCalledWith("pin:leg:hole:1", "b:dia");
  chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onChipClick).toHaveBeenCalledTimes(2);
  overlay.dispose();
});

test("re-render replaces content; clear empties; setVisible toggles hidden", () => {
  const host = document.createElement("div");
  const overlay = createDimOverlay(host);
  overlay.render(prims, vp);
  overlay.render({ lines: [], arrows: [], labels: [prims.labels[0]] }, vp);
  expect(overlay.element.querySelectorAll("g.pf-dim-chip").length).toBe(1);
  overlay.clear();
  expect(overlay.element.querySelectorAll("*").length).toBe(0);
  overlay.setVisible(false);
  expect(overlay.element.hasAttribute("hidden")).toBe(true);
  overlay.dispose();
});

test("a linked offscreen chip carries both classes", () => {
  const host = document.createElement("div");
  const overlay = createDimOverlay(host);
  overlay.render({ lines: [], arrows: [], labels: [
    { id: "p:0", itemId: "p:0", text: "⌀8.00", x: 2, y: 2, w: 60, h: 16, tier: "pinned", kind: "offscreen", paramName: "bore_d", pinned: true },
  ] }, { width: 100, height: 50 });
  const chip = overlay.element.querySelector("g.pf-dim-chip");
  expect(chip.classList.contains("linked")).toBe(true);
  expect(chip.classList.contains("kind-offscreen")).toBe(true);
  overlay.dispose();
});
