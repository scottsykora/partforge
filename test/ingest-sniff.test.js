// test/ingest-sniff.test.js
import { describe, test, expect } from "vitest";
import { sniffMediaType } from "../src/framework/ingest/sniff.js";

const u8 = (...b) => Uint8Array.from(b);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe("sniffMediaType", () => {
  test("PNG magic", () => {
    expect(sniffMediaType(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });
  test("JPEG magic", () => {
    expect(sniffMediaType(u8(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe("image/jpeg");
  });
  test("WebP magic (RIFF….WEBP)", () => {
    expect(sniffMediaType(cat(ascii("RIFF"), u8(0, 0, 0, 0), ascii("WEBP")))).toBe("image/webp");
  });
  test("TrueType magic (0x00010000)", () => {
    expect(sniffMediaType(u8(0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0))).toBe("font/ttf");
  });
  test("OpenType magic (OTTO)", () => {
    expect(sniffMediaType(cat(ascii("OTTO"), u8(0, 0, 0, 0)))).toBe("font/otf");
  });
  test("WOFF2 is recognised, so it can be refused by name", () => {
    expect(sniffMediaType(cat(ascii("wOF2"), u8(0, 0, 0, 0)))).toBe("font/woff2");
  });
  test("SVG by root element", () => {
    expect(sniffMediaType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
  });
  test("SVG behind an XML declaration and a comment", () => {
    expect(sniffMediaType(ascii('<?xml version="1.0"?>\n<!-- hi -->\n<svg></svg>'))).toBe("image/svg+xml");
  });
  test("unknown bytes are null, not a guess", () => {
    expect(sniffMediaType(u8(1, 2, 3, 4, 5, 6, 7, 8))).toBe(null);
  });
  test("empty input is null", () => {
    expect(sniffMediaType(new Uint8Array(0))).toBe(null);
  });
  test("accepts an ArrayBuffer as well as a view", () => {
    const v = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(sniffMediaType(v.buffer)).toBe("image/png");
  });

  // The adversarial pair — the whole reason this file exists rather than an
  // extension check. A caller passes only bytes, so a misnamed file cannot lie.
  test("a PNG's bytes sniff as PNG regardless of any filename", () => {
    expect(sniffMediaType(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });
  test("an SVG's bytes sniff as SVG regardless of any filename", () => {
    expect(sniffMediaType(ascii("<svg></svg>"))).toBe("image/svg+xml");
  });
  test("HTML that merely mentions svg is not claimed", () => {
    expect(sniffMediaType(ascii("<html><body>svg</body></html>"))).toBe(null);
  });
});
