import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { handle } from "../src/framework/jobs.js";
import { fontsFor, resolveFonts } from "../src/framework/fonts.js";

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

test("fontsFor calls the function form with resolved params", () => {
  const part = { defaults: { face: "A" }, fonts: (p) => ({ face: p.face }) };
  expect(fontsFor(part, { face: "B" })).toEqual({ face: "B" });
});

test("fontsFor passes a static object through untouched", () => {
  const decl = { face: "A" };
  expect(fontsFor({ fonts: decl }, {})).toBe(decl);
  expect(fontsFor({}, {})).toBeUndefined();
});

test("resolveFonts refuses a function — it has no params to call it with", async () => {
  await expect(resolveFonts(() => ({}))).rejects.toThrow(/fontsFor/);
});

test("handle resolves a function-form fonts against the job's params", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const a = synthFont(700), b = synthFont(300);
  const part = {
    defaults: { face: "a" },
    fonts: (p) => ({ face: p.face === "b" ? b : a }),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { face: "a" } }, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(700);
  await handle(kernel, part, { ...job, params: { face: "b" } }, () => {});
  expect(kernel._fonts.get("face").charToGlyph("H").advanceWidth).toBe(300);
});

test("a throwing derive() errors before any font is fetched", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const fontsSpy = vi.fn(() => ({}));
  const part = { defaults: {}, derive: () => { throw new Error("boom"); }, fonts: fontsSpy, parts: {} };
  const posts = [];
  await handle(kernel, part, job, (m) => posts.push(m));
  const err = posts.find((m) => m.type === "error");
  expect(err).toBeTruthy();
  expect(fontsSpy).not.toHaveBeenCalled();
  // Two different bugs both satisfy "posted an error and never called
  // fontsSpy": a correctly-reordered resolveParams-throws-first (what we want
  // to prove), or an unreordered jobs.js still handing the raw function to
  // resolveFonts, which throws its own guard error before ever calling
  // fontsSpy. Pin the message to tell them apart.
  expect(err.message).toContain("boom");        // derive threw first…
  expect(err.message).not.toMatch(/fontsFor/);  // …not the resolveFonts guard
});
