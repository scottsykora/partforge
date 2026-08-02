// resolveDefaultView: which view the tab bar opens on. Order is author override →
// most sub-parts placed at defaults → declaration order.
import { expect, test } from "vitest";
import { resolveDefaultView } from "../../src/framework/default-view.js";

const partWith = (views, parts, defaults = {}) => ({ meta: { title: "T" }, defaults, parts, views });

test("with no flag and equal counts, the first declared view wins", () => {
  const part = partWith(
    { a: { label: "A" }, b: { label: "B" } },
    { one: { views: ["a"] }, two: { views: ["b"] } },
  );
  expect(resolveDefaultView(part)).toBe("a");
});

test("the view placing the most sub-parts wins over declaration order", () => {
  const part = partWith(
    { solo: {}, assembly: {} },
    {
      base: { views: ["solo", "assembly"] },
      lid: { views: ["assembly"] },
      pin: { views: ["assembly"] },
    },
  );
  expect(resolveDefaultView(part)).toBe("assembly");
});

test("`default: true` beats a bigger view", () => {
  const part = partWith(
    { solo: { default: true }, assembly: {} },
    { base: { views: ["solo", "assembly"] }, lid: { views: ["assembly"] } },
  );
  expect(resolveDefaultView(part)).toBe("solo");
});

test("the first flagged view wins when several claim the default", () => {
  const part = partWith(
    { a: {}, b: { default: true }, c: { default: true } },
    { one: { views: ["a", "b", "c"] } },
  );
  expect(resolveDefaultView(part)).toBe("b");
});

test("sub-parts disabled at defaults don't count", () => {
  const part = partWith(
    { small: {}, big: {} },
    {
      base: { views: ["small"] },
      a: { views: ["big"], enabled: (p) => p.extras },
      b: { views: ["big"], enabled: (p) => p.extras },
    },
    { extras: false },
  );
  expect(resolveDefaultView(part)).toBe("small");
});

test("enabled() is evaluated against defaults, so an on-by-default sub-part counts", () => {
  const part = partWith(
    { small: {}, big: {} },
    {
      base: { views: ["small"] },
      a: { views: ["big"], enabled: (p) => p.extras },
      b: { views: ["big"], enabled: (p) => p.extras },
    },
    { extras: true },
  );
  expect(resolveDefaultView(part)).toBe("big");
});

test("a throwing enabled() counts the sub-part as present", () => {
  const part = partWith(
    { small: {}, big: {} },
    {
      base: { views: ["small"] },
      a: { views: ["big"], enabled: () => { throw new Error("boom"); } },
      b: { views: ["big"] },
    },
  );
  expect(resolveDefaultView(part)).toBe("big");
});

test("no views, an empty views map, or a missing part → null", () => {
  expect(resolveDefaultView({ views: {} })).toBeNull();
  expect(resolveDefaultView({})).toBeNull();
  expect(resolveDefaultView(undefined)).toBeNull();
});

test("a views map with no parts resolves to the first view", () => {
  expect(resolveDefaultView({ views: { a: {}, b: {} } })).toBe("a");
});

test("a missing defaults object is passed to enabled() as {}", () => {
  const part = {
    views: { a: {}, b: {} },
    parts: { x: { views: ["b"], enabled: (p) => p.on === undefined } },
  };
  expect(resolveDefaultView(part)).toBe("b");
});
