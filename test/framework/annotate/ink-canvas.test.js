// @vitest-environment happy-dom
// Overlay canvas renderer: DOM lifecycle, halo+core draw passes, PNG export.
import { afterEach, expect, test, vi } from "vitest";
import { createInkCanvas } from "../../../src/framework/annotate/ink-canvas.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeCtx() {
  return {
    calls: [],
    clearRect(...a) { this.calls.push(["clearRect", ...a]); },
    beginPath() { this.calls.push(["beginPath"]); },
    moveTo(...a) { this.calls.push(["moveTo", ...a]); },
    lineTo(...a) { this.calls.push(["lineTo", ...a]); },
    arc(...a) { this.calls.push(["arc", ...a]); },
    fill() { this.calls.push(["fill"]); },
    stroke() { this.calls.push(["stroke", this.strokeStyle, this.lineWidth]); },
  };
}

function fixture() {
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
  document.body.appendChild(stage);
  const ctx = fakeCtx();
  const canvas = createInkCanvas(stage, { getContext2d: () => ctx });
  return { stage, ctx, canvas };
}

test("mounts hidden inside the stage with the pf- class", () => {
  const { stage, canvas } = fixture();
  expect(canvas.element.parentElement).toBe(stage);
  expect(canvas.element.className).toBe("pf-ink-canvas");
  expect(canvas.element.hidden).toBe(true);
});

test("show() sizes the bitmap to the stage rect × dpr and unhides", () => {
  const { canvas } = fixture();
  canvas.show();
  expect(canvas.element.hidden).toBe(false);
  const { width, height, dpr } = canvas.size();
  expect(width).toBe(Math.round(200 * dpr));
  expect(height).toBe(Math.round(100 * dpr));
});

test("setStrokes draws two passes per stroke: halo then core", () => {
  const { ctx, canvas } = fixture();
  canvas.show();
  ctx.calls.length = 0;
  canvas.setStrokes([{ points: [[0, 0], [1, 1]], width: 0.01 }]);
  const strokeCalls = ctx.calls.filter(([op]) => op === "stroke");
  expect(strokeCalls).toHaveLength(2);
  // halo pass is wider than the core pass
  expect(strokeCalls[0][2]).toBeGreaterThan(strokeCalls[1][2]);
  // and a different color
  expect(strokeCalls[0][1]).not.toBe(strokeCalls[1][1]);
});

test("a one-point stroke draws as a filled dot, twice (halo + core)", () => {
  const { ctx, canvas } = fixture();
  canvas.show();
  ctx.calls.length = 0;
  canvas.setStrokes([{ points: [[0.5, 0.5]], width: 0.01 }]);
  expect(ctx.calls.filter(([op]) => op === "arc")).toHaveLength(2);
  expect(ctx.calls.filter(([op]) => op === "fill")).toHaveLength(2);
});

test("dispose removes the element and is idempotent", () => {
  const { stage, canvas } = fixture();
  canvas.dispose();
  canvas.dispose();
  expect(stage.querySelector(".pf-ink-canvas")).toBe(null);
});
