// Semantic descriptions and anchor specs — what the LLM reads.
import { expect, test } from "vitest";
import {
  describeElement, describeGap, elementAnchors, DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("circle and square naming, aspect-aware percentages", () => {
  // aspect 2: stage width is 2 units
  const circle = el("ellipse", { cx: 1, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  expect(describeElement(circle, 2)).toBe("circle · c (50%, 50%) · r 20%");
  const square = el("rect", { cx: 1, cy: 0.5, w: 0.4, h: 0.4, rot: 0 });
  expect(describeElement(square, 2)).toBe("square · c (50%, 50%) · 20%");
});

test("rect with rotation and erased gaps names the erased edges", () => {
  // perimeter 1.2: top edge is t 0–0.333, right 0.333–0.5, bottom 0.5–0.833
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: Math.PI / 3 },
    [[0.1, 0.2], [0.5, 0.6]]);
  expect(describeElement(rect, 1))
    .toBe("rect · c (50%, 50%) · 40% × 20% · rot 60° · 80% visible · erased top edge, bottom edge");
});

test("describeGap speaks each type's own vocabulary", () => {
  // ellipse: degrees of a full turn
  expect(describeGap(el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 }), [0.1, 0.35]))
    .toBe("arc 36°–126°");
  // rect gap spanning a corner names both edges
  expect(describeGap(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 }), [0.3, 0.4]))
    .toBe("top–right edges");
  // open paths: % along the length
  expect(describeGap(el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }), [0.25, 0.5]))
    .toBe("25%–50%");
});

test("many gaps are capped in the description, not enumerated", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
    [[0.1, 0.15], [0.3, 0.35], [0.5, 0.55], [0.7, 0.75], [0.9, 0.95]]);
  const d = describeElement(line, 1);
  expect(d).toContain("erased 10%–15%, 30%–35%, 50%–55% +2 more");
});

test("rotation folds to (-180, 180] and is silent at zero", () => {
  const r = (rot) => describeElement(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot }), 1);
  expect(r(0)).not.toContain("rot");
  expect(r(Math.PI * 1.5)).toContain("rot -90°");
});

test("line and freehand descriptions", () => {
  expect(describeElement(el("line", { x1: 0, y1: 0, x2: 1, y2: 1 }), 1))
    .toBe("line · (0%, 0%) → (100%, 100%)");
  expect(describeElement(el("freehand", { points: [[0, 0], [0.5, 0.5], [1, 0]] }), 1))
    .toBe("freehand · 3 pts");
});

test("anchors: start/mid/end per visible run, center for closed shapes", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, [[0.4, 0.6]]);
  const anchors = elementAnchors(line);
  expect(anchors.filter((a) => a.at === "start")).toHaveLength(2); // two runs
  // each fragment's anchors carry its run index — that is what tells the two
  // "start"s apart on a gapped element
  expect(anchors.filter((a) => a.at === "start").map((a) => a.run)).toEqual([0, 1]);
  expect(anchors.filter((a) => a.at === "center")).toHaveLength(0);
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 });
  const rectAnchors = elementAnchors(rect);
  const center = rectAnchors.find((a) => a.at === "center");
  expect(center).toMatchObject({ x: 0.5, y: 0.5 });
  expect(center.run).toBeUndefined(); // the center belongs to the whole shape
});
