// opentype.js 2.x ships no `exports` map, so its namespace splits by resolver:
// bundlers take the `module` field (real ESM — named `parse`, NO default export),
// Node takes `main` (a UMD/CJS bundle whose named exports Node's lexer cannot
// detect — the namespace holds ONLY `default`). Every headless test runs under
// Node resolution, so a call site reading `.default` unconditionally stays green
// here while being `undefined` in every browser bundle — which is exactly how the
// part-`fonts` preload in jobs.js shipped failing every sandbox build that
// declared a font ("undefined is not an object (evaluating 'p.parse')").
//
// This file therefore mocks opentype.js into its BROWSER shape (named exports,
// no default) and drives the real `handle` preload through it, so the bundler
// interop shape is finally exercised by a test that runs under Node.
import { expect, test, vi } from "vitest";
import { normalizeOpentype } from "../src/framework/geometry/opentype-interop.js";

vi.mock("opentype.js", async (importOriginal) => {
  const actual = await importOriginal();
  const real = typeof actual.parse === "function" ? actual : actual.default;
  // Browser/ESM shape: named exports only, no `default` key at all.
  return { parse: real.parse, Font: real.Font, Glyph: real.Glyph, Path: real.Path };
});

import { Font, Glyph, Path } from "opentype.js";
import { handle } from "../src/framework/jobs.js";

function synthFontBytes() {
  const g = (name, unicode, adv, draw) => {
    const p = new Path(); draw(p);
    return new Glyph({ name, unicode, advanceWidth: adv, path: p });
  };
  const notdef = g(".notdef", 0, 650, () => {});
  const H = g("H", 72, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(150,700);p.lineTo(150,400);
    p.lineTo(550,400);p.lineTo(550,700);p.lineTo(650,700);p.lineTo(650,0);p.lineTo(550,0);p.lineTo(550,300);
    p.lineTo(150,300);p.lineTo(150,0);p.close(); });
  const font = new Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font.toArrayBuffer();
}

// Pure normalization: both real-world interop shapes, plus the fallback.
test("normalizeOpentype handles the bundler (ESM) namespace shape", () => {
  const esm = { parse: () => "parsed" };                       // named exports, no default
  expect(normalizeOpentype(esm)).toBe(esm);
});

test("normalizeOpentype handles the Node (CJS) namespace shape", () => {
  const api = { parse: () => "parsed" };
  const cjs = { default: api };                                // only `default` detectable
  expect(normalizeOpentype(cjs)).toBe(api);
});

test("normalizeOpentype falls through to the namespace when neither shape matches", () => {
  const odd = {};                                              // future resolver surprise
  expect(normalizeOpentype(odd)).toBe(odd);                    // named errors, not `undefined.parse`
});

// The regression at the real call site: jobs.js's fonts preload must work when
// `import("opentype.js")` yields the browser shape. Before the fix this threw
// "Cannot read properties of undefined (reading 'parse')" (Safari: "undefined is
// not an object (evaluating 'p.parse')") for EVERY part declaring `fonts`.
test("handle's fonts preload works against the browser-shaped opentype namespace", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = { fonts: { body: synthFontBytes() }, parts: {}, defaults: {} };
  const msg = { type: "generate", subparts: [], view: "iso", params: {} };
  await handle(kernel, part, msg, () => {});
  expect(kernel._fonts.has("body")).toBe(true);
  expect(kernel._fonts.get("body").tables).toBeTruthy();       // a real parsed opentype.Font
});
