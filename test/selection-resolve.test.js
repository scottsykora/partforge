import { expect, test } from "vitest";
import { resolveSelection, quantizePoint, snapNormal } from "../src/framework/selection/resolve.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    one: { views: ["v"], build: (k, p) => k.cylinder(p.a, p.a, p.a) },        // reads a only
    two: { views: ["v"], build: (k, p) => k.box([0, 0, 0], [p.b, p.b, p.b]) }, // reads b only
  },
};
const ctx = { view: "v", params: { a: 1, b: 2 }, derived: {} };

test("quantizePoint rounds to 0.01mm and removes -0", () => {
  expect(quantizePoint([0.004, 5.2349, -0.001])).toEqual([0, 5.23, 0]);
});

test("snapNormal snaps a near-axis vector to the exact axis", () => {
  expect(snapNormal([0.999, 0.02, 0.0])).toEqual([1, 0, 0]);
  expect(snapNormal([0, -1.0, 0])).toEqual([0, -1, 0]);
});

test("snapNormal leaves an off-axis vector normalized (quantized)", () => {
  const n = snapNormal([1, 1, 0]);
  expect(n[0]).toBeCloseTo(0.71, 2);
  expect(n[1]).toBeCloseTo(0.71, 2);
  expect(n[2]).toBe(0);
});

test("L0: scopes params to the clicked sub-part's read keys, quantizes, snaps", () => {
  const sel = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [0, 0, 5.2349], normalLocal: [0.999, 0, 0.02],
  });
  expect(sel.subPart).toBe("one");
  expect(sel.point).toEqual([0, 0, 5.23]);
  expect(sel.normal).toEqual([1, 0, 0]);
  expect(sel.params).toEqual({ a: 1 });   // sub-part "one" reads only `a`
  expect(sel.feature).toBeUndefined();     // no face metadata → L0 only
});

test("a hit with a feature resolves to selection.feature.label", () => {
  const s = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [1, 2, 3], normalLocal: [0, 0, 1],
    feature: { id: 1, label: "Drainage hole" },
  });
  expect(s.feature).toEqual({ label: "Drainage hole" });
});

test("a hit without a feature has no selection.feature", () => {
  const s = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [1, 2, 3], normalLocal: [0, 0, 1], feature: null,
  });
  expect(s.feature).toBeUndefined();
});
