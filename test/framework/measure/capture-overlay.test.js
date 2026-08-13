// @vitest-environment happy-dom
// Style inlining + serialization for dimensioned captures (rasterization
// itself is not testable in happy-dom).
import { expect, test, beforeAll } from "vitest";
import { inlineOverlayStyles, overlaySvgString } from "../../../src/framework/measure/capture-overlay.js";

beforeAll(() => {
  // Add CSS so getComputedStyle returns values in happy-dom. The actual
  // styles come from app.css in the real app; here we just need enough to
  // test that inlining works.
  const style = document.createElement("style");
  style.textContent = `
    .pf-dim-line {
      stroke: #000;
      stroke-width: 1;
      fill: none;
    }
    .pf-dim-text {
      fill: #000;
      font-family: system-ui;
      font-size: 12px;
      font-weight: normal;
      letter-spacing: normal;
      paint-order: normal;
      text-anchor: start;
      dominant-baseline: auto;
    }
  `;
  document.head.appendChild(style);
});

function overlayFixture() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "pf-dim-overlay");
  const line = document.createElementNS(NS, "line");
  line.setAttribute("class", "pf-dim-line");
  const text = document.createElementNS(NS, "text");
  text.setAttribute("class", "pf-dim-text");
  text.textContent = "24.00";
  svg.append(line, text);
  document.body.appendChild(svg);
  return svg;
}

test("inlineOverlayStyles clones and stamps presentation attributes", () => {
  const svg = overlayFixture();
  const clone = inlineOverlayStyles(svg);
  expect(clone).not.toBe(svg);
  const line = clone.querySelector("line");
  expect(line.hasAttribute("stroke")).toBe(true);
  const text = clone.querySelector("text");
  expect(text.hasAttribute("fill")).toBe(true);
  expect(text.hasAttribute("font-family")).toBe(true);
  // the original is untouched
  expect(svg.querySelector("line").hasAttribute("stroke")).toBe(false);
});

test("overlaySvgString serializes with xmlns and explicit size", () => {
  const svg = overlayFixture();
  const s = overlaySvgString(svg, { width: 640, height: 480 });
  expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(s).toContain('width="640"');
  expect(s).toContain('height="480"');
  expect(s).toContain("24.00");
});
