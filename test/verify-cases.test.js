import { expect, test } from "vitest";
import { expandCases } from "../src/testing/cases.js";

const part = {
  defaults: { od: 8, bore: 3.4, h: 10 },
  parameters: [{ id: "body", presets: { M3: { od: 8, bore: 3.4 }, M5: { od: 12, bore: 5.4, h: 16 } } }],
  views: { v: {} },
  parts: {},
};

test("expands defaults + every preset, merging overrides onto defaults", () => {
  const cases = expandCases(part);
  expect(cases.map((c) => c.name)).toEqual(["defaults", "M3", "M5"]);
  expect(cases.find((c) => c.name === "M5").params).toEqual({ od: 12, bore: 5.4, h: 16 });
  expect(cases.find((c) => c.name === "M3").params).toEqual({ od: 8, bore: 3.4, h: 10 });
});

test("verify.cases selects and orders an explicit subset", () => {
  const p = { ...part, verify: { cases: ["defaults", "M5"] } };
  expect(expandCases(p).map((c) => c.name)).toEqual(["defaults", "M5"]);
});

test("throws on an unknown named case", () => {
  const p = { ...part, verify: { cases: ["M9"] } };
  expect(() => expandCases(p)).toThrow();
});

test("a part with no parameters yields just defaults", () => {
  expect(expandCases({ defaults: { a: 1 }, views: { v: {} }, parts: {} })).toEqual([{ name: "defaults", params: { a: 1 } }]);
});
