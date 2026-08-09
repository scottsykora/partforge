import { expect, test } from "vitest";
import { expandCases } from "../src/framework/oracle/cases.js";

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

test("expandCases sees presets declared as authored preset nodes", () => {
  const part = {
    defaults: { od: 5 },
    parameters: [{ id: "b", controls: [
      { type: "preset", presets: { Wide: { od: 9 } } },
      { key: "od", min: 1, max: 10, step: 1 },
    ] }],
  };
  const names = expandCases(part).map((c) => c.name);
  expect(names).toEqual(["defaults", "Wide"]);
});

test("a preset name repeated across sections still throws", () => {
  const part = {
    defaults: { od: 5 },
    parameters: [
      { id: "a", presets: { Dup: { od: 2 } }, advanced: [{ key: "od", min: 1, max: 10, step: 1 }] },
      { id: "b", controls: [{ type: "preset", presets: { Dup: { od: 3 } } }] },
    ],
  };
  expect(() => expandCases(part)).toThrow(/duplicate preset name/);
});
