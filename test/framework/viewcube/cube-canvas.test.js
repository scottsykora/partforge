// @vitest-environment happy-dom
// The view cube's renderer. happy-dom has no real 2d context, so the context is
// injected and the assertions are on the DRAW ORDER and the fills chosen — the
// two things that decide whether a ghost cube with arrows in front of it reads
// correctly (the ink-canvas.js / dim3-scene paintLabel precedent).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCubeCanvas, CUBE_PALETTE } from "../../../src/framework/viewcube/cube-canvas.js";

function fakeContext() {
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 0, height: 0 },
    setTransform: (...a) => calls.push(["setTransform", ...a]),
    clearRect: (...a) => calls.push(["clearRect", ...a]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (...a) => calls.push(["moveTo", ...a]),
    lineTo: (...a) => calls.push(["lineTo", ...a]),
    closePath: () => calls.push(["closePath"]),
    fill: () => calls.push(["fill", ctx.fillStyle]),
    stroke: () => calls.push(["stroke", ctx.strokeStyle]),
    fillText: (...a) => calls.push(["fillText", a[0], ctx.fillStyle]),
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    set strokeStyle(v) { this._stroke = v; },
    get strokeStyle() { return this._stroke; },
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
  return ctx;
}

const projection = {
  back: [{ id: "back", points: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: -1 }],
  front: [
    { id: "front", points: [[2, 2], [8, 2], [8, 8], [2, 8]], depth: 1 },
    { id: "top-front", points: [[2, 0], [8, 0], [8, 2], [2, 2]], depth: 1.1 },
  ],
  arrows: [
    { axis: "X", from: [5, 5], tail: [9, 5], tip: [10, 5], label: [11, 5], depth: 0.5 },
    { axis: "Y", from: [5, 5], tail: [5, 9], tip: [5, 10], label: [5, 11], depth: 0.4 },
    { axis: "Z", from: [5, 5], tail: [5, 1], tip: [5, 0], label: [5, -1], depth: 0.6 },
  ],
};

let host, handle, ctx;
beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  ctx = fakeContext();
  handle = createCubeCanvas(host, { getContext2d: () => ctx });
});
afterEach(() => handle?.dispose());

const order = () => ctx.calls.map((c) => c[0]);
const fills = () => ctx.calls.filter((c) => c[0] === "fill").map((c) => c[1]);
const texts = () => ctx.calls.filter((c) => c[0] === "fillText").map((c) => c[1]);

describe("createCubeCanvas", () => {
  it("appends a canvas to the host", () => {
    expect(host.querySelector("canvas")).toBe(handle.element);
    expect(handle.element.className).toContain("pf-viewcube-canvas");
  });

  it("clears before drawing anything", () => {
    handle.draw(projection, {});
    expect(order()[0]).toBe("setTransform");
    expect(order()[1]).toBe("clearRect");
  });

  it("sizes the backing store by DPR while the CSS box stays in CSS px", () => {
    // Sizing the backing store in CSS px while scaling the context by DPR
    // renders everything at 2x on a retina display and clips the cube to its
    // top-left quarter — silent on a 1x test machine, obvious on a laptop.
    const original = globalThis.devicePixelRatio;
    globalThis.devicePixelRatio = 2;
    try {
      handle.draw(projection, {});
      expect(handle.element.width).toBe(handle.size * 2);
      expect(handle.element.height).toBe(handle.size * 2);
      expect(handle.element.style.width).toBe(`${handle.size}px`);
      // The context is scaled by the same factor, so draw code stays in CSS px.
      expect(ctx.calls[0]).toEqual(["setTransform", 2, 0, 0, 2, 0, 0]);
    } finally {
      globalThis.devicePixelRatio = original;
    }
  });

  it("draws back faces, then arrow tails, then front faces, then heads, then labels", () => {
    handle.draw(projection, {});
    const backFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.backFill);
    const tail = ctx.calls.findIndex((c) => c[0] === "stroke" && c[1] === CUBE_PALETTE.dark.axisX);
    const frontFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.frontFill);
    const head = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.axisX);
    const label = ctx.calls.findIndex((c) => c[0] === "fillText");
    expect(backFace).toBeGreaterThan(-1);
    expect(backFace).toBeLessThan(tail);
    expect(tail).toBeLessThan(frontFace);
    expect(frontFace).toBeLessThan(head);
    expect(head).toBeLessThan(label);
  });

  it("labels the three model axes", () => {
    handle.draw(projection, {});
    expect(texts()).toEqual(["X", "Y", "Z"]);
  });

  it("paints the hovered region in the highlight fill and leaves the others alone", () => {
    handle.draw(projection, { hover: "top-front" });
    expect(fills()).toContain(CUBE_PALETTE.dark.hoverFill);
    expect(fills()).toContain(CUBE_PALETTE.dark.frontFill);
  });

  it("uses no highlight fill when nothing is hovered", () => {
    handle.draw(projection, {});
    expect(fills()).not.toContain(CUBE_PALETTE.dark.hoverFill);
  });

  it("repaints in the light palette after a theme change", () => {
    handle.draw(projection, {});
    ctx.calls.length = 0;
    handle.setTheme("light");
    expect(fills()).toContain(CUBE_PALETTE.light.frontFill);
  });

  it("removes its canvas on dispose", () => {
    handle.dispose();
    expect(host.querySelector("canvas")).toBeNull();
  });
});
