// Hand-tool machinery: handles, anchored resize, rotation, the probe.
import { expect, test } from "vitest";
import {
  handlesOf, translateElement, rectAnchorFor, resizeRectFromAnchor,
  resizeEllipseHandle, applyRotation, probe, centerOf, invalidateSample,
  DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("handles: line endpoints, rect corners, ellipse radii, circle single", () => {
  const line = el("line", { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 });
  expect(handlesOf(line)).toEqual([
    { id: "p1", x: 0.1, y: 0.2 }, { id: "p2", x: 0.5, y: 0.6 },
  ]);
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 });
  const corners = handlesOf(rect);
  expect(corners.length).toBe(4);
  expect(corners[0]).toMatchObject({ x: 0.3, y: 0.4, sx: -1, sy: -1 });
  const circle = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  expect(handlesOf(circle)).toEqual([{ id: "r", x: 0.7, y: 0.5 }]);
  const oval = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, rot: 0 });
  expect(handlesOf(oval).map((h) => h.id)).toEqual(["rx", "ry"]);
});

test("rect corner handles rotate with the shape", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: Math.PI / 2 });
  const h = handlesOf(rect)[0]; // (-0.2,-0.1) rotated 90° = (0.1,-0.2)
  expect(h.x).toBeCloseTo(0.6);
  expect(h.y).toBeCloseTo(0.3);
});

test("translateElement moves every type; gaps untouched", () => {
  const line = el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0.2, 0.4]]);
  translateElement(line, 0.1, 0.2);
  expect(line.params).toEqual({ x1: 0.1, y1: 0.2, x2: 1.1, y2: 0.2 });
  expect(line.gaps).toEqual([[0.2, 0.4]]);
  const free = el("freehand", { points: [[0, 0], [0.5, 0.5]] });
  translateElement(free, 0.1, 0);
  expect(free.params.points).toEqual([[0.1, 0], [0.6, 0.5]]);
});

test("anchored rect resize keeps the opposite corner fixed, snaps near 1:1", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 });
  const brCorner = handlesOf(rect)[2]; // (0.7, 0.6)
  const [ax, ay] = rectAnchorFor(rect, brCorner); // top-left (0.3, 0.4)
  expect([ax, ay]).toEqual([0.3, 0.4]);
  resizeRectFromAnchor(rect, ax, ay, 0, 0.8, 0.7, {}); // drag BR corner outward
  invalidateSample(rect);
  expect(rect.params.w).toBeCloseTo(0.5);
  expect(rect.params.h).toBeCloseTo(0.3);
  expect(rect.params.cx).toBeCloseTo(0.55);
  expect(rect.params.cy).toBeCloseTo(0.55);
  // near-square drag snaps
  resizeRectFromAnchor(rect, ax, ay, 0, 0.72, 0.81, {}); // 0.42 × 0.41
  expect(rect.params.w).toBe(rect.params.h);
});

test("ellipse handles: r keeps a circle; rx edits one axis; near-1:1 re-snaps", () => {
  const circle = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  resizeEllipseHandle(circle, "r", 0.8, 0.5, {});
  expect(circle.params.rx).toBeCloseTo(0.3);
  expect(circle.params.ry).toBeCloseTo(0.3);
  const oval = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, rot: 0 });
  resizeEllipseHandle(oval, "rx", 0.9, 0.5, {});
  expect(oval.params.rx).toBeCloseTo(0.4);
  expect(oval.params.ry).toBeCloseTo(0.2);
  resizeEllipseHandle(oval, "rx", 0.71, 0.5, {}); // rx 0.21 vs ry 0.2 → snap circle
  expect(oval.params.rx).toBe(oval.params.ry);
});

test("applyRotation: rot param for shapes, point transform for line/freehand, no drift", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0.1 });
  const orig = JSON.parse(JSON.stringify(rect.params));
  applyRotation(rect, orig, centerOf(rect), Math.PI / 2);
  expect(rect.params.rot).toBeCloseTo(0.1 + Math.PI / 2);
  // re-applying a different total from the SAME orig replaces, not accumulates
  applyRotation(rect, orig, centerOf(rect), Math.PI / 4);
  expect(rect.params.rot).toBeCloseTo(0.1 + Math.PI / 4);
  const line = el("line", { x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.5 });
  const lorig = JSON.parse(JSON.stringify(line.params));
  applyRotation(line, lorig, centerOf(line), Math.PI / 2);
  expect(line.params.x1).toBeCloseTo(0.5);
  expect(line.params.y1).toBeCloseTo(0.4);
  expect(line.params.x2).toBeCloseTo(0.5);
  expect(line.params.y2).toBeCloseTo(0.6);
});

test("probe priority and the lonely-rotate rule", () => {
  const line = el("line", { x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5 });
  const opts = { reach: 0.02, handleR: 0.016, band: 0.05 };
  // handle beats outline at an endpoint
  expect(probe([line], 0.2, 0.5, opts)).toMatchObject({ kind: "handle", handle: { id: "p1" } });
  // on the outline
  expect(probe([line], 0.5, 0.51, opts)).toMatchObject({ kind: "outline" });
  // just outside → rotate
  expect(probe([line], 0.5, 0.55, opts)).toMatchObject({ kind: "rotate" });
  // beyond the band → nothing
  expect(probe([line], 0.5, 0.7, opts)).toBeNull();
  // a second element inside the band kills rotation
  const other = el("line", { x1: 0.2, y1: 0.6, x2: 0.8, y2: 0.6 });
  expect(probe([line, other], 0.5, 0.55, opts)).toBeNull();
});
