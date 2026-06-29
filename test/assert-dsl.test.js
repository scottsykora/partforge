import { expect, test } from "vitest";
import { parseAssertion, evaluateAssertion } from "../src/testing/assert-dsl.js";

test("parses numbers and booleans as equality", () => {
  expect(parseAssertion(1)).toEqual({ op: "eq", value: 1 });
  expect(parseAssertion(true)).toEqual({ op: "eq", value: true });
});

test("parses scalar comparators", () => {
  expect(parseAssertion(">=1.5")).toEqual({ op: "gte", value: 1.5 });
  expect(parseAssertion("<=2")).toEqual({ op: "lte", value: 2 });
  expect(parseAssertion(">0")).toEqual({ op: "gt", value: 0 });
  expect(parseAssertion("<10")).toEqual({ op: "lt", value: 10 });
});

test("parses ranges and normalizes units to base (mm / mm3)", () => {
  expect(parseAssertion("0.4..0.6cm3")).toEqual({ op: "range", min: 400, max: 600 });
  expect(parseAssertion("5mm")).toEqual({ op: "eq", value: 5 });
  expect(parseAssertion("2cm")).toEqual({ op: "eq", value: 20 });
});

test("parses vector bounds with * to skip an axis", () => {
  expect(parseAssertion("<=[12,12,16]")).toEqual({ op: "vle", vec: [12, 12, 16] });
  expect(parseAssertion(">=[10,*,14]")).toEqual({ op: "vge", vec: [10, null, 14] });
});

test("throws on unrecognized forms (strict)", () => {
  expect(() => parseAssertion(">==1.5")).toThrow();
  expect(() => parseAssertion("abc")).toThrow();
  expect(() => parseAssertion("<=[1,2]")).toThrow();
  expect(() => parseAssertion("5kg")).toThrow();
  expect(() => parseAssertion({})).toThrow();
});

// append to test/assert-dsl.test.js
const ev = (expr, actual) => evaluateAssertion(parseAssertion(expr), actual).pass;

test("evaluates scalar equality and comparators", () => {
  expect(ev(1, 1)).toBe(true);
  expect(ev(1, 2)).toBe(false);
  expect(ev(true, true)).toBe(true);
  expect(ev(true, false)).toBe(false);
  expect(ev(">=1.5", 1.5)).toBe(true);   // boundary
  expect(ev(">=1.5", 1.4)).toBe(false);
  expect(ev("<=2", 3)).toBe(false);
  expect(ev(">0", 0)).toBe(false);
});

test("evaluates ranges with unit normalization", () => {
  expect(ev("0.4..0.6cm3", 500)).toBe(true);   // 500 mm³ in [400,600]
  expect(ev("0.4..0.6cm3", 700)).toBe(false);
  expect(ev("0.4..0.6cm3", 400)).toBe(true);   // boundary
});

test("evaluates vector bounds componentwise, * skips", () => {
  expect(ev("<=[12,12,16]", [8, 8, 10])).toBe(true);
  expect(ev("<=[12,12,16]", [13, 8, 10])).toBe(false);
  expect(ev(">=[10,*,14]", [12, 5, 20])).toBe(true);   // axis 1 skipped
  expect(ev(">=[10,*,14]", [9, 5, 20])).toBe(false);
});
