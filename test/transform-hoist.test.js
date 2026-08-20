// test/transform-hoist.test.js
import { expect, test } from "vitest";
import { hoistCommonSuffix } from "../src/framework/geometry/transform-hoist.js";

const t = (v) => ({ op: "translate", v });
const rz = (deg) => ({ op: "rotate", deg, center: [0, 0, 0], axis: [0, 0, 1] });

test("a trailing transform every operand shares is hoisted whole", () => {
  const { hoisted, residuals } = hoistCommonSuffix([[t([5, 0, 0])], [t([5, 0, 0])]]);
  expect(hoisted).toEqual([t([5, 0, 0])]);
  expect(residuals).toEqual([[], []]);
});

test("trailing translations that differ are split, not abandoned", () => {
  // the reported part's cell: hub ends .at([cx,cy,0]), support ends .at([cx,cy,z])
  const { hoisted, residuals } = hoistCommonSuffix([[t([17.5, 15, 0])], [t([17.5, 15, 1.6])]]);
  expect(hoisted).toEqual([t([17.5, 15, 0])]);
  expect(residuals).toEqual([[], [t([0, 0, 1.6])]]);
});

test("a shared trailing rotation is hoisted (the polar-array case)", () => {
  const { hoisted, residuals } = hoistCommonSuffix([[rz(30)], [t([1, 2, 3]), rz(30)]]);
  expect(hoisted).toEqual([rz(30)]);
  expect(residuals).toEqual([[], [t([1, 2, 3])]]);
});

test("hoisting continues past a rotation into a translation split", () => {
  // a polar boss: every piece ends .rotateZ(30), and the translations beneath it
  // differ only in Z — both layers should lift out.
  const { hoisted, residuals } = hoistCommonSuffix([
    [t([40, 0, 0]), rz(30)],
    [t([40, 0, 2]), rz(30)],
  ]);
  expect(hoisted).toEqual([t([40, 0, 0]), rz(30)]);
  expect(residuals).toEqual([[], [t([0, 0, 2])]]);
});

test("rotations that differ are never split — only translations commute that way", () => {
  // translate(v₁) = translate(v₀) ∘ translate(v₁−v₀) holds; the rotation analogue
  // does not compose that way around an arbitrary centre, so this must not hoist.
  const chains = [[rz(30)], [rz(60)]];
  const { hoisted, residuals } = hoistCommonSuffix(chains);
  expect(hoisted).toEqual([]);
  expect(residuals).toEqual(chains);
});

test("nothing is hoisted when the outermost transforms differ in kind", () => {
  const chains = [[t([1, 0, 0])], [rz(30)]];
  const { hoisted, residuals } = hoistCommonSuffix(chains);
  expect(hoisted).toEqual([]);
  expect(residuals).toEqual(chains);
});
