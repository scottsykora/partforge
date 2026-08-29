// Pure-JS PNG → luminance grid. Lives in the worker graph, so it must be DOM-free
// and node:-free: no createImageBitmap/OffscreenCanvas (browser-only), no pngjs
// (Node-only). One decoder in one place is what keeps the browser, the CLI and CI
// from disagreeing about geometry. Inflate comes from fflate, already in this
// closure via threemf-parse.js.
import { unzlibSync } from "fflate";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const U16 = 65535;

// Rec. 709 luma, the same weighting a viewer would show.
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  for (let i = 0; i < 8; i++) if (u8[i] !== SIG[i]) throw new Error("decodePng: not a PNG (bad signature)");

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 8, width = 0, height = 0, depth = 8, colorType = 6, interlace = 0;
  let palette = null;
  const idat = [];

  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    const body = off + 8;
    if (body + len > u8.length) throw new Error(`decodePng: truncated file (chunk ${type} runs past the end)`);
    if (type === "IHDR") {
      width = dv.getUint32(body); height = dv.getUint32(body + 4);
      depth = u8[body + 8]; colorType = u8[body + 9]; interlace = u8[body + 12];
    } else if (type === "PLTE") palette = u8.subarray(body, body + len);
    // tRNS (alpha) is intentionally not parsed: ignoring alpha is correct for a
    // depth map, and this chunk still falls through to the unconditional
    // `off` advance below like any other chunk type we don't care about.
    else if (type === "IDAT") idat.push(u8.subarray(body, body + len));
    else if (type === "IEND") break;
    off = body + len + 4; // + CRC
  }

  if (!width || !height) throw new Error("decodePng: truncated file (no IHDR)");
  if (interlace) throw new Error("decodePng: interlaced (Adam7) PNGs are not supported — re-save without interlacing");

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CHANNELS) throw new Error(`decodePng: unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("decodePng: palette image with no PLTE chunk");

  // Concatenate IDAT then inflate.
  let total = 0; for (const c of idat) total += c.length;
  if (!total) throw new Error("decodePng: truncated file (no IDAT)");
  const z = new Uint8Array(total);
  { let p = 0; for (const c of idat) { z.set(c, p); p += c.length; } }
  const raw = unzlibSync(z);

  const bpp = Math.max(1, (CHANNELS * depth) >> 3);
  const rowBytes = Math.ceil((CHANNELS * depth * width) / 8);
  if (raw.length < (rowBytes + 1) * height) throw new Error("decodePng: truncated file (short image data)");

  // Un-filter in place, row by row.
  const img = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes, up = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? img[dst + x - bpp] : 0;
      const b = y > 0 ? img[up + x] : 0;
      const c = x >= bpp && y > 0 ? img[up + x - bpp] : 0;
      img[dst + x] = (ft === 0 ? v : ft === 1 ? v + a : ft === 2 ? v + b
                   : ft === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
    }
  }

  // Read samples → luminance, scaled to 0..65535.
  const out = new Uint16Array(width * height);
  const maxIn = depth === 16 ? 65535 : (1 << depth) - 1;
  const readSample = (row, i) => {
    if (depth === 16) return (img[row + i * 2] << 8) | img[row + i * 2 + 1];
    if (depth === 8) return img[row + i];
    const per = 8 / depth, byte = img[row + ((i / per) | 0)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & maxIn;
  };

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      let v;
      if (colorType === 3) {
        const idx = readSample(row, x) * 3;
        v = luma(palette[idx], palette[idx + 1], palette[idx + 2]) / 255;
      } else if (colorType === 0 || colorType === 4) {
        v = readSample(row, x * CHANNELS) / maxIn;
      } else {
        const b0 = x * CHANNELS;
        v = luma(readSample(row, b0), readSample(row, b0 + 1), readSample(row, b0 + 2)) / maxIn;
      }
      out[y * width + x] = Math.round(Math.min(Math.max(v, 0), 1) * U16);
    }
  }
  return { width, height, data: out };
}
