import { expect, test, vi } from "vitest";
import nameplate from "../src/parts/nameplate.js";

const chainableSolid = () => ({
  label() { return this; },
  translate() { return this; },
  union() { return this; },
  cut() { return this; },
});

test("nameplate declares an editable multiline label parameter", () => {
  expect(nameplate.defaults.label).toBe("PARTFORGE\nv0.20");
  expect(nameplate.parameters[0].advanced).toContainEqual(expect.objectContaining({
    key: "label",
    control: "textarea",
  }));
});

test("nameplate builds text from the current label parameter", () => {
  const text2d = vi.fn(() => ({
    boundingBox: () => ({ min: [-10, -5], max: [10, 5] }),
  }));
  const kernel = {
    text2d,
    shape2d: vi.fn(() => ({})),
    extrude: vi.fn(() => chainableSolid()),
  };
  const params = { ...nameplate.defaults, label: "CUSTOM\nLABEL" };

  nameplate.parts.plate.build(kernel, params);

  expect(text2d).toHaveBeenCalledWith("CUSTOM\nLABEL", expect.any(Object));
});
