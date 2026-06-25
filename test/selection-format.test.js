import { expect, test } from "vitest";
import { formatSelection } from "../src/framework/selection/format.js";

const L0 = { subPart: "spacer", point: [0, 0, 5.2], normal: [1, 0, 0], params: { bore: 3.4, h: 10 } };
const L1 = { ...L0, feature: { kind: "cylinder", axis: "Z", radius: 1.7, selector: { dir: "Z", near: [0, 0, 5.2] } } };

test("token style: L0 line", () => {
  expect(formatSelection(L0)).toBe("@spacer · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
});

test("token style: L1 prepends the typed face", () => {
  expect(formatSelection(L1, { style: "token" }))
    .toBe("@spacer · cyl-face r=1.7 axis=Z · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
});

test("token style: off-axis normal prints as a tuple", () => {
  const s = { ...L0, normal: [0.71, 0.71, 0] };
  expect(formatSelection(s)).toContain("n(0.71,0.71,0)");
});

test("json style returns the object unchanged", () => {
  expect(formatSelection(L1, { style: "json" })).toEqual(L1);
});

test("prompt style is a natural-language sentence", () => {
  const s = formatSelection(L0, { style: "prompt" });
  expect(s).toContain("spacer");
  expect(s).toContain("(0, 0, 5.2)");
  expect(s).toContain("bore: 3.4");
});
