// k.text2d on the OCCT backend: text2d itself is backend-agnostic (Task 2 builds a
// Shape2D from glyph contours that both backends consume), so this file only pins
// two OCCT-specific things: (1) bootOcctKernel accepts { fonts } like the Manifold
// boot helper, and (2) a curved glyph's contour survives as an exact curve all the
// way to STEP (a B_SPLINE entity), proving OCCT did not tessellate the outline.
import { beforeAll, expect, test } from "vitest";
import opentype from "opentype.js";
import { bootOcctKernel } from "../src/testing/occt.js";

// Same synth font as test/text2d.test.js / test/text2d-manifold.test.js, plus a 'Q'
// glyph drawn with quadraticCurveTo (Task 1's Q fixture) so an outline carries a
// real curve — the synth H/O/I glyphs are all straight lines.
function curvedFont() {
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
  // 'Q' — a single quadratic-curve contour (elevates to a cubic segment in text2d),
  // so its extruded solid carries a real curved face → STEP B_SPLINE.
  const Q = g("Q", 81, 500, (p) => { p.moveTo(0,0); p.quadraticCurveTo(250,700,500,0); p.close(); });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H, O, I, Q] });
  font.kerningPairs = {};
  return font;
}

let k;
beforeAll(async () => {
  k = await bootOcctKernel({ fonts: { test: curvedFont().toArrayBuffer() } });
});

test("text2d extrudes to a watertight solid on OCCT", () => {
  const solid = k.extrude({ profile: k.text2d("O", { font: "test", size: 6 }), h: 1 });
  expect(solid.volume()).toBeGreaterThan(0);
});

test("a curved glyph keeps exact curves → STEP has a B_SPLINE", async () => {
  const solid = k.extrude({ profile: k.text2d("Q", { font: "test", size: 6 }), h: 1 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "t", solid }]));
  expect(step).toMatch(/B_SPLINE/);
});

// Empirical confirmation (Task 4): does OCCT actually subtract a raw-font-winding
// counter as a hole, or is OCCT winding-SENSITIVE (unlike Manifold, which the
// text2d-manifold.test.js suite confirms subtracts fine either way)? If OCCT ever
// treated the counter as same-sign fill instead of a hole, this solid's volume
// would be close to (or greater than) a solid block of the same bounding box,
// instead of visibly less than it.
test("OCCT empirically subtracts the counter as a real hole (winding-insensitive)", () => {
  const size = 6;
  const oSolid = k.extrude({ profile: k.text2d("O", { font: "test", size }), h: 1 });
  const bb = oSolid.boundingBox();
  const blockVolume = (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * 1;
  // A genuine hole removes a good chunk of the bbox-block volume. If the counter
  // were NOT subtracted, oSolid.volume() would equal the full block instead.
  expect(oSolid.volume()).toBeLessThan(blockVolume * 0.85);
});
