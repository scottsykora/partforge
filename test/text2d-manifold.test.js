// k.text2d integration on the Manifold backend: font resolution (declared name /
// inline bytes / unknown), Shape2D output shape, content-hash caching (via
// shape2d/union — text2d itself has no separate cache), and a real curvy glyph's
// hole classification (the synth fonts below are rectilinear; Roboto's 'O' has
// actual curves, exercising the flatten-to-endpoints containment test for real).
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import opentype from "opentype.js";
import { bootManifoldKernel } from "../src/testing.js";

function synthFont() {
  const g = (name, unicode, adv, draw) => {
    const p = new opentype.Path(); draw(p);
    return new opentype.Glyph({ name, unicode, advanceWidth: adv, path: p });
  };
  const notdef = g(".notdef", 0, 650, () => {});
  // 'H' — sets cap height 700 (fallback path when os2.sCapHeight is absent)
  const H = g("H", 72, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(150,700);p.lineTo(150,400);
    p.lineTo(550,400);p.lineTo(550,700);p.lineTo(650,700);p.lineTo(650,0);p.lineTo(550,0);p.lineTo(550,300);
    p.lineTo(150,300);p.lineTo(150,0);p.close(); });
  // 'O' — outer contour + a counter (hole), for hole-classification + genus tests
  const O = g("O", 79, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(650,700);p.lineTo(650,0);p.close();
    p.moveTo(200,150);p.lineTo(500,150);p.lineTo(500,550);p.lineTo(200,550);p.close(); });
  // 'I' — a plain bar
  const I = g("I", 73, 400, (p) => { p.moveTo(150,0);p.lineTo(150,700);p.lineTo(250,700);p.lineTo(250,0);p.close(); });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H, O, I] });
  font.kerningPairs = {};
  return font;
}

let k, fontBytes;
beforeAll(async () => {
  const font = synthFont();
  fontBytes = font.toArrayBuffer();
  k = await bootManifoldKernel({ fonts: { test: fontBytes } });   // declared font preloaded for the test
});

test("text2d('HI') by declared font → a Shape2D ~size tall with positive area", () => {
  const s = k.text2d("HI", { font: "test", size: 5 });
  expect(s._shape2d).toBe(true);
  const bb = s.boundingBox();
  expect(bb.max[1] - bb.min[1]).toBeCloseTo(5, 1);
  expect(s.area()).toBeGreaterThan(0);
});

test("text2d('O') extrudes to a solid with a real hole (genus 1)", () => {
  const solid = k.extrude({ profile: k.text2d("O", { font: "test", size: 6 }), h: 1 });
  expect(solid.genus()).toBe(1);
});

test("inline font bytes work without declaration", () => {
  expect(k.text2d("I", { font: fontBytes, size: 4 }).area()).toBeGreaterThan(0);
});

// Regression: an inline font passed as a Uint8Array VIEW with byteOffset>0 (common for
// Node Buffer-pooled small files) must parse from its exact byte range, not the whole
// backing buffer. A whole-buffer parse would throw "Unsupported OpenType signature".
test("inline font as an offset Uint8Array view parses (byteOffset > 0)", () => {
  const src = new Uint8Array(fontBytes);
  const padded = new Uint8Array(src.length + 100);
  padded.set(src, 50);
  const view = padded.subarray(50, 50 + src.length);  // byteOffset 50, exact length
  expect(k.text2d("I", { font: view, size: 4 }).area()).toBeGreaterThan(0);
});

test("text2d is content-hash cached (hit on repeat)", () => {
  k.beginSubPart("t"); k.resetCacheStats();
  const one = () => k.text2d("HI", { font: "test", size: 5 }).area();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});

test("unknown declared font throws a clear error", () => {
  expect(() => k.text2d("H", { font: "nope", size: 5 })).toThrow(/font/i);
});

// Regression: a font preloaded via bootManifoldKernel({ fonts }) as an OFFSET
// Uint8Array view (byteOffset>0, common for a Node Buffer-pooled fs.readFileSync)
// must be sliced to its exact byte range before opentype.parse. The old inline
// `src.buffer` handed opentype the whole backing buffer → "Unsupported OpenType
// signature". bootManifoldKernel now routes {fonts} through resolveFonts, which
// slices correctly.
test("bootManifoldKernel preloads a font passed as an offset view (no byteOffset corruption)", async () => {
  const bytes = new Uint8Array(fontBytes);
  const big = new Uint8Array(bytes.length + 40); big.set(bytes, 20);
  const view = big.subarray(20, 20 + bytes.length);              // byteOffset 20
  const k2 = await bootManifoldKernel({ fonts: { off: view } });
  expect(k2.text2d("H", { font: "off", size: 5 }).area()).toBeGreaterThan(0);
});

// Real vendored font, curvy glyphs — the synth 'O' above is rectilinear, so its
// containment classification (flatten-to-endpoints, see text2d.js groupContours)
// could pass even with a subtly wrong algorithm. A real 'O' with actual bezier
// curves forming the outer ring and the counter (hole) is the test that would
// catch a curve-containment bug the synth glyphs can't.
test("real font (Roboto) 'O' extrudes to a solid with a real hole (genus 1)", () => {
  const robotoBuf = readFileSync(new URL("../src/framework/geometry/fonts/Roboto-Regular.ttf", import.meta.url));
  const robotoBytes = robotoBuf.buffer.slice(robotoBuf.byteOffset, robotoBuf.byteOffset + robotoBuf.byteLength);
  const solid = k.extrude({ profile: k.text2d("O", { font: robotoBytes, size: 10 }), h: 1 });
  expect(solid.genus()).toBe(1);
});
