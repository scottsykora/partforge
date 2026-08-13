// Layout engine against a fake orthographic projector: silhouette-edge
// selection, primitive anatomy, collision nudging, hysteresis, offscreen chips.
import { expect, test } from "vitest";
import { layout, DIM_OFFSET, LABEL_H } from "../../../src/framework/measure/dim-layout.js";
import { bboxSpec } from "../../../src/framework/measure/feature-dims.js";

// Top-down ortho: X -> right, Y -> up (screen y flipped), Z ignored.
const ortho = (p) => ({ x: 200 + p[0], y: 200 - p[1], behind: false });
const vp = { width: 400, height: 400 };
const item = (over = {}) => ({
  id: "a", tier: "static", spec: bboxSpec([-50, -30, 0], [50, 30, 10]), project: ortho, ...over,
});

test("bbox produces three linear dims with ext+dim lines and a label each", () => {
  const out = layout([item()], vp, null);
  const dimLines = out.lines.filter((l) => l.kind === "dim");
  const extLines = out.lines.filter((l) => l.kind === "ext");
  expect(dimLines.length).toBe(3);          // W, D, H
  expect(extLines.length).toBe(6);          // two per dim
  expect(out.arrows.length).toBe(6);
  expect(out.labels.map((l) => l.text).sort()).toEqual(["100.00", "20.00", "60.00"]);
});

test("silhouette rule: the W dim uses an outboard edge, offset outward", () => {
  const out = layout([item()], vp, null);
  const w = out.labels.find((l) => l.text === "100.00");
  // outboard for the X-extent under top-down ortho = above or below the model
  const modelTop = 200 - 30, modelBottom = 200 + 30;
  expect(w.y + LABEL_H < modelTop || w.y > modelBottom).toBe(true);
});

test("hysteresis: same input with prev keeps the same choices", () => {
  const first = layout([item()], vp, null);
  const second = layout([item()], vp, first);
  expect(second.choices).toEqual(first.choices);
  expect(second.labels).toEqual(first.labels);
});

test("plane spec produces two linear dims", () => {
  const spec = {
    kind: "plane", values: { width: 24, height: 12 },
    anchors: {
      width: { a: [0, 0, 0], b: [24, 0, 0] },
      height: { a: [24, 0, 0], b: [24, 12, 0] },
      normal: [0, 0, 1],
    },
  };
  const out = layout([item({ spec, tier: "hover" })], vp, null);
  expect(out.lines.filter((l) => l.kind === "dim").length).toBe(2);
  expect(out.labels.map((l) => l.text).sort()).toEqual(["12.00", "24.00"]);
});

test("cylinder produces a leader with drafting notation + a depth dim", () => {
  const spec = {
    kind: "cylinder", values: { diameter: 8, depth: 10, partial: false },
    anchors: { center: [0, 0, 5], axis: [0, 0, 1], bottom: [0, 0, 0], top: [0, 0, 10] },
  };
  const out = layout([item({ spec, tier: "hover" })], vp, null);
  expect(out.lines.some((l) => l.kind === "leader")).toBe(true);
  expect(out.labels.some((l) => l.text.startsWith("⌀"))).toBe(true); // ⌀8.00
  const partial = { ...spec, values: { ...spec.values, partial: true } };
  const out2 = layout([item({ spec: partial, tier: "hover" })], vp, null);
  expect(out2.labels.some((l) => l.text.startsWith("R"))).toBe(true);   // R4.00
});

test("labels never overlap after the collision pass", () => {
  const items = [0, 1, 2, 3].map((i) => ({
    id: `p${i}`, tier: "pinned", project: ortho,
    spec: {
      kind: "cylinder", values: { diameter: 4 + i * 0.01, depth: 2, partial: false },
      anchors: { center: [0, 0, 0], axis: [0, 0, 1], bottom: [0, 0, 0], top: [0, 0, 2] },
    },
  }));
  const out = layout(items, vp, null);
  const rects = out.labels.map((l) => l);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap).toBe(false);
  }
});

test("fully offscreen pinned item collapses to an edge chip; others drop", () => {
  const far = (p) => ({ x: p[0] + 5000, y: p[1] + 5000, behind: false });
  const pinned = layout([item({ project: far, tier: "pinned", pinned: true })], vp, null);
  expect(pinned.labels.length).toBe(1);
  expect(pinned.labels[0].kind).toBe("offscreen");
  const chip = pinned.labels[0];
  expect(chip.x + chip.w).toBeLessThanOrEqual(vp.width);
  expect(chip.y + chip.h).toBeLessThanOrEqual(vp.height);
  const hover = layout([item({ project: far, tier: "hover" })], vp, null);
  expect(hover.labels.length).toBe(0);
});

test("behind-camera anchors drop their primitives cleanly", () => {
  const behind = (p) => ({ x: 200 + p[0], y: 200 - p[1], behind: true });
  const out = layout([item({ project: behind })], vp, null);
  expect(out.lines.length).toBe(0);
  expect(out.labels.length).toBe(0);
});
