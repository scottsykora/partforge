import { expect, test } from "vitest";
import opentype from "opentype.js";
import { textGlyphs } from "../src/framework/geometry/text2d.js";
import { DEFAULT_FONT_BYTES } from "../src/framework/geometry/fonts/default-font.js";

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

const font = synthFont();
const bbox = (regions) => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  const walk = (c) => { const pts = [c.start, ...c.segments.map((s) => s.to)];
    for (const [x, y] of pts) { lo[0]=Math.min(lo[0],x);lo[1]=Math.min(lo[1],y);hi[0]=Math.max(hi[0],x);hi[1]=Math.max(hi[1],y); } };
  for (const r of regions) { walk(r.outer); r.holes.forEach(walk); }
  return { lo, hi, w: hi[0]-lo[0], h: hi[1]-lo[1] };
};

test("size sets cap height (H is `size` mm tall)", () => {
  const regions = textGlyphs(font, "H", { size: 5 });
  expect(bbox(regions).h).toBeCloseTo(5, 3);          // caps == size mm
});

test("a counter becomes a hole (O = 1 outer + 1 hole)", () => {
  const regions = textGlyphs(font, "O", { size: 5 });
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
});

test("advance widths lay glyphs left-to-right; center align spans the origin", () => {
  const c = textGlyphs(font, "HI", { size: 5, align: "center" });
  const b = bbox(c);
  expect(b.w).toBeGreaterThan(5);                      // two glyphs wider than one
  expect(b.lo[0]).toBeLessThan(0); expect(b.hi[0]).toBeGreaterThan(0);   // centered on X
});

test("multi-line stacks lines downward", () => {
  const one = bbox(textGlyphs(font, "H", { size: 5 }));
  const two = bbox(textGlyphs(font, "H\nH", { size: 5 }));
  expect(two.h).toBeGreaterThan(one.h * 1.8);         // ~2 lines + line gap
});

test("tracking widens letter spacing", () => {
  const tight = bbox(textGlyphs(font, "HH", { size: 5, tracking: 0 })).w;
  const loose = bbox(textGlyphs(font, "HH", { size: 5, tracking: 2 })).w;
  expect(loose).toBeGreaterThan(tight + 1.5);
});

test("real Roboto B resolves to one region with two counters", () => {
  const { buffer, byteOffset, byteLength } = DEFAULT_FONT_BYTES;
  const roboto = opentype.parse(buffer.slice(byteOffset, byteOffset + byteLength));
  const regions = textGlyphs(roboto, "B", { size: 10, align: "left", valign: "baseline" });
  expect(regions.length).toBe(1);
  expect(regions[0].holes.length).toBe(2);
});

test("quadratic glyph commands elevate to cubic contours", () => {
  const Q = new opentype.Glyph({ name: "Q", unicode: 81, advanceWidth: 500,
    path: (() => { const p = new opentype.Path(); p.moveTo(0,0); p.quadraticCurveTo(250,700,500,0); p.close(); return p; })() });
  const f2 = new opentype.Font({ familyName:"T", styleName:"R", unitsPerEm:1000, ascender:800, descender:-200, glyphs:[new opentype.Glyph({name:".notdef",advanceWidth:650,path:new opentype.Path()}), Q] });
  f2.kerningPairs = {};
  const regions = textGlyphs(f2, "Q", { size: 5 });
  const hasCubic = regions[0].outer.segments.some((s) => s.c1 && s.c2);
  expect(hasCubic).toBe(true);                         // Q → cubicTo
});
