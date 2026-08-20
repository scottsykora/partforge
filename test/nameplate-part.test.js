import { expect, test, vi } from "vitest";
import nameplate from "../src/parts/nameplate.js";
import { fontsFor } from "../src/framework/fonts.js";
import { fontControlAllows } from "../src/framework/font-source.js";
import { lintPart } from "../src/lint.js";

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

test("nameplate exposes a font control wired to a function-form fonts", () => {
  expect(fontControlAllows(nameplate).has("face")).toBe(true);
  expect(typeof nameplate.fonts).toBe("function");
  // At the default (face: "") no font is declared — an empty source must not
  // flow through to resolveFonts (it would throw); text2d falls back to the
  // bundled Roboto instead.
  expect(fontsFor(nameplate, nameplate.defaults)).not.toHaveProperty("face");
  // Once a face is picked, `fonts` resolves it.
  const withFace = { ...nameplate.defaults, face: "https://fonts.gstatic.com/s/a/v1/a.ttf" };
  expect(fontsFor(nameplate, withFace)).toHaveProperty("face", "https://fonts.gstatic.com/s/a/v1/a.ttf");
});

test("nameplate passes font:\"face\" to text2d only when a face is picked", () => {
  const text2d = vi.fn(() => ({ boundingBox: () => ({ min: [-10, -5], max: [10, 5] }) }));
  const kernel = { text2d, shape2d: vi.fn(() => ({})), extrude: vi.fn(() => chainableSolid()) };

  nameplate.parts.plate.build(kernel, nameplate.defaults);
  expect(text2d.mock.calls[0][1]).not.toHaveProperty("font");

  const withFace = { ...nameplate.defaults, face: "https://fonts.gstatic.com/s/a/v1/a.ttf" };
  nameplate.parts.plate.build(kernel, withFace);
  expect(text2d.mock.calls[1][1]).toHaveProperty("font", "face");
});

test("nameplate lints clean", () => {
  expect(lintPart(nameplate).errors).toEqual([]);
  expect(lintPart(nameplate).warnings).toEqual([]);
});
