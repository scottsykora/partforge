// src/framework/ingest/sniff.js
// Bytes -> media type. The whole point is that a caller passes BYTES, never a
// filename: a file's claimed type is user input, and this is the path a
// mislabelled upload would travel. Nothing here trusts an extension because
// nothing here is given one.
//
// DOM-free and node:-free, and free of any converter import, so both the panel
// and the CLI can read it without loading paper.js.

const MAGIC = [
  { type: "image/png",  bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "font/otf",   bytes: [0x4f, 0x54, 0x54, 0x4f] },              // "OTTO"
  { type: "font/woff2", bytes: [0x77, 0x4f, 0x46, 0x32] },              // "wOF2"
  { type: "font/ttf",   bytes: [0x00, 0x01, 0x00, 0x00] },
  { type: "font/ttf",   bytes: [0x74, 0x72, 0x75, 0x65] },              // "true"
];

const startsWith = (u8, sig) => {
  if (u8.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[i] !== sig[i]) return false;
  return true;
};

// How far into a text file we look for an <svg root. Enough for an XML
// declaration, a DOCTYPE and a licence comment; bounded so a huge non-SVG text
// file is not scanned end to end.
const SVG_SCAN = 4096;

export function sniffMediaType(input) {
  if (!input) return null;
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length === 0) return null;

  for (const m of MAGIC) if (startsWith(u8, m.bytes)) return m.type;

  // WebP is RIFF????WEBP — the size field sits between the two tags.
  if (u8.length >= 12 && startsWith(u8, [0x52, 0x49, 0x46, 0x46])
      && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
    return "image/webp";
  }

  // SVG has no magic number, so look for an <svg ROOT element — not the mere
  // substring "svg", which any HTML page mentioning it would match.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(u8.subarray(0, SVG_SCAN));
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";

  return null;
}
