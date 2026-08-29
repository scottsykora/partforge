import { expect, test } from "vitest";
import { formatSelection } from "../src/framework/selection/format.js";

const L0 = { subPart: "spacer", point: [0, 0, 5.2], normal: [1, 0, 0], params: { bore: 3.4, h: 10 } };

test("token style: L0 line", () => {
  expect(formatSelection(L0)).toBe("@spacer · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
});

test("token style: off-axis normal prints as a tuple", () => {
  const s = { ...L0, normal: [0.71, 0.71, 0] };
  expect(formatSelection(s)).toContain("n(0.71,0.71,0)");
});

test("json style returns the object unchanged", () => {
  expect(formatSelection(L0, { style: "json" })).toEqual(L0);
});

test("prompt style is a natural-language sentence", () => {
  const s = formatSelection(L0, { style: "prompt" });
  expect(s).toContain("spacer");
  expect(s).toContain("(0, 0, 5.2)");
  expect(s).toContain("bore: 3.4");
});

test("token style includes the feature label", () => {
  const s = { subPart: "planter", feature: { label: "Drainage hole" }, point: [0, 0, 1.5], normal: [0, 0, -1], params: { drain: 8 } };
  expect(formatSelection(s)).toBe("@planter · Drainage hole · pt(0,0,1.5) n(-Z) · {drain:8}");
});

test("prompt style names the feature", () => {
  const s = { subPart: "planter", feature: { label: "Drainage hole" }, point: [0, 0, 1.5], normal: [0, 0, -1], params: { drain: 8 } };
  expect(formatSelection(s, { style: "prompt" }))
    .toBe("On sub-part **planter**, the user pointed at **Drainage hole**, local point (0, 0, 1.5), normal -Z, with params {drain: 8}.");
});

test("a cutaway section pick says so in both written styles", () => {
  const s = { ...L0, onCutPlane: true };
  expect(formatSelection(s)).toBe("@spacer · section · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
  // Without this the sentence reads as a point on the part's own surface.
  expect(formatSelection(s, { style: "prompt" })).toContain("the cutaway section face at local point");
});

test("a section pick keeps the feature slot free — a cut face has no label", () => {
  const s = { ...L0, feature: { label: "Bore" }, onCutPlane: true };
  // Belt and braces: if a caller ever does supply both, neither is dropped.
  expect(formatSelection(s)).toBe("@spacer · Bore · section · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
});
