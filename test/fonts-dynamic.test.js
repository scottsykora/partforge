import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { handle } from "../src/framework/jobs.js";

// Two distinguishable synthetic fonts: same glyph, different advance width, so
// a stale registration is visible in the parsed font's own metrics.
function synthFont(advance) {
  const p = new opentype.Path();
  p.moveTo(50, 0); p.lineTo(50, 700); p.lineTo(650, 700); p.lineTo(650, 0); p.close();
  const notdef = new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: advance, path: new opentype.Path() });
  const H = new opentype.Glyph({ name: "H", unicode: 72, advanceWidth: advance, path: p });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font.toArrayBuffer();
}

const job = { type: "generate", subparts: [], view: "iso", params: {} };

test("a second part reusing a font NAME with different bytes wins", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);

  await handle(kernel, { fonts: { face: a }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);

  await handle(kernel, { fonts: { face: b }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(300);
});

test("the same source is parsed once even across names and jobs", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700);
  const parseSpy = vi.spyOn(opentype, "parse");
  await handle(kernel, { fonts: { face: a }, parts: {}, defaults: {} }, job, () => {});
  const after = parseSpy.mock.calls.length;
  await handle(kernel, { fonts: { other: a }, parts: {}, defaults: {} }, job, () => {});
  expect(parseSpy.mock.calls.length).toBe(after);        // same bytes → memo hit
  expect(kernel._fonts.get("other")).toBe(kernel._fonts.get("face")); // same parsed object
  parseSpy.mockRestore();
});
