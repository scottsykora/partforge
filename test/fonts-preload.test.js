import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { resolveFonts } from "../src/framework/fonts.js";

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
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font;
}

test("resolveFonts normalizes bytes, thunks, and URLs to ArrayBuffers", async () => {
  const bytes = synthFont().toArrayBuffer();
  const g = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ arrayBuffer: async () => bytes }));   // stub URL fetch
  try {
    const map = await resolveFonts({
      a: bytes,                               // inline bytes
      b: () => Promise.resolve({ default: bytes }),   // dynamic-import shape
      c: "https://example.com/font.ttf",      // URL
    });
    expect(map.get("a").byteLength).toBe(bytes.byteLength);
    expect(map.get("b").byteLength).toBe(bytes.byteLength);
    expect(opentype.parse(map.get("c"))).toBeTruthy();   // fetched bytes parse
  } finally { globalThis.fetch = g; }
});

test("resolveFonts memoizes a repeated source (fetch once)", async () => {
  const bytes = synthFont().toArrayBuffer();
  const fetchMock = vi.fn(async () => ({ arrayBuffer: async () => bytes }));
  globalThis.fetch = fetchMock;
  const url = "https://example.com/same.ttf";
  await resolveFonts({ x: url }); await resolveFonts({ y: url });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
