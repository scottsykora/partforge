import { describe, test, expect } from "vitest";
import { PNG } from "pngjs";
import { zlibSync } from "fflate";
import { decodePng } from "../src/framework/geometry/png-decode.js";

// pngjs is a devDependency and Node-only — an independent reference encoder
// here, and the oracle we diff against.
function encode(width, height, fill, { colorType = 6, bitDepth = 8, inputHasAlpha = true } = {}) {
  const png = new PNG({ width, height, colorType, bitDepth, inputHasAlpha });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [r, g, b, a] = fill(x, y);
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

const gray = (v) => () => [v, v, v, 255];

// --- Hand-built 16-bit grayscale PNG fixture ---------------------------------
//
// pngjs's `.data` input buffer is always 8-bit RGBA, regardless of the target
// colorType/bitDepth: writing bitDepth 16 through it just replicates (or
// truncates) 8-bit input, so it cannot place two arbitrary 16-bit sample
// values a few units apart (e.g. 0x8000 and 0x80ff differ only in the low
// byte, which the 8-bit input path can't address). Confirmed experimentally:
// writing input bytes 0x80 and 0x81 into a bitDepth-16 grayscale PNG and
// inflating the resulting IDAT showed pngjs collapsed both output samples to
// the identical 16-bit value 0x8000 — i.e. it cannot express the sub-8-bit
// deltas this test needs to prove. So per the controller's addendum, this one
// fixture is hand-built: raw chunk bytes, our own CRC32, fflate's zlibSync
// for the IDAT.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = crc32(body);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0);
  out.set(body, 4);
  out.set(u32be(crc), 4 + body.length);
  return out;
}

// pngjs's own encoder never writes an interlaced file: `packer.js` hardcodes
// `buf[12] = 0; // interlace` regardless of the `interlace: true` constructor
// option (confirmed by inspecting node_modules/pngjs/lib/packer.js — there is
// no reachable pngjs API that sets the IHDR interlace byte to 1). So the
// brief's original test — `new PNG({ interlace: true }); PNG.sync.write(png)`
// — can never actually exercise interlace rejection: it always writes a
// non-interlaced file, and would pass even for a decoder with no interlace
// check at all. Fixed by hand-flipping the already-written IHDR interlace
// byte and recomputing that chunk's CRC32, rather than trusting pngjs to
// write it.
function forceInterlaceFlag(buf) {
  const out = Uint8Array.from(buf);
  // Signature (8) + IHDR length (4) + "IHDR" (4) = 16, then 13 bytes of IHDR
  // data; the interlace method is the last of those 13 bytes.
  const dataStart = 16, dataLen = 13;
  out[dataStart + 12] = 1;
  const body = out.subarray(dataStart - 4, dataStart + dataLen); // "IHDR" + data
  const crc = crc32(body);
  out.set(u32be(crc), dataStart + dataLen);
  return out;
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}

// samples: array of 16-bit unsigned sample values, row-major, one channel (gray).
function buildGray16Png(width, height, samples) {
  const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = new Uint8Array(13);
  ihdrData.set(u32be(width), 0);
  ihdrData.set(u32be(height), 4);
  ihdrData[8] = 16; // bit depth
  ihdrData[9] = 0; // colour type: grayscale
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace: none
  const ihdr = chunk("IHDR", ihdrData);

  // Scanlines: filter byte 0 (None) + big-endian 16-bit samples per row.
  const rowBytes = width * 2;
  const raw = new Uint8Array((rowBytes + 1) * height);
  let si = 0;
  for (let y = 0; y < height; y++) {
    const base = y * (rowBytes + 1);
    raw[base] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const v = samples[si++];
      raw[base + 1 + x * 2] = (v >>> 8) & 0xff;
      raw[base + 1 + x * 2 + 1] = v & 0xff;
    }
  }
  const compressed = zlibSync(raw);
  const idat = chunk("IDAT", compressed);
  const iend = chunk("IEND", new Uint8Array(0));

  return concatBytes([SIG, ihdr, idat, iend]);
}

describe("decodePng", () => {
  test("reads dimensions", () => {
    const out = decodePng(encode(4, 3, gray(0)));
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
  });

  test("8-bit RGBA black and white map to 0 and 65535", () => {
    expect(decodePng(encode(2, 2, gray(0))).data[0]).toBe(0);
    expect(decodePng(encode(2, 2, gray(255))).data[0]).toBe(65535);
  });

  test("8-bit grayscale decodes", () => {
    const out = decodePng(encode(2, 2, gray(128), { colorType: 0, inputHasAlpha: false }));
    expect(out.data[0]).toBeGreaterThan(32000);
    expect(out.data[0]).toBeLessThan(33500);
  });

  // Replaces the brief's original "16-bit grayscale keeps precision beyond 8
  // bits" test — see ADDENDUM FROM THE CONTROLLER (pre-flight Ruling D) in
  // task-3-brief.md. As originally written the test only checked
  // `data.length === 2` and `instanceof Uint16Array`, which passes even if
  // the decoder silently truncates every 16-bit sample to its high byte.
  // This version encodes two samples a sub-8-bit-step apart (0x8000 and
  // 0x80ff, 255 apart — less than the 256 a single 8-bit step represents)
  // and asserts the decoder actually distinguishes them.
  test("16-bit grayscale preserves precision finer than an 8-bit step", () => {
    const buf = buildGray16Png(2, 1, [0x8000, 0x80ff]);
    const out = decodePng(buf);
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect(out.data.length).toBe(2);
    expect(out.data).toBeInstanceOf(Uint16Array);
    expect(out.data[0]).toBe(0x8000);
    expect(out.data[1]).toBe(0x80ff);
    expect(out.data[0]).not.toBe(out.data[1]);
    expect(Math.abs(out.data[1] - out.data[0])).toBeLessThan(256); // sub-8-bit delta
  });

  test("RGB without alpha decodes", () => {
    const out = decodePng(encode(2, 2, gray(255), { colorType: 2, inputHasAlpha: false }));
    expect(out.data[0]).toBe(65535);
  });

  test("a horizontal ramp round-trips monotonically", () => {
    const w = 8;
    const out = decodePng(encode(w, 1, (x) => { const v = Math.round((x / (w - 1)) * 255); return [v, v, v, 255]; }));
    for (let i = 1; i < w; i++) expect(out.data[i]).toBeGreaterThan(out.data[i - 1]);
  });

  test("luminance weights the channels (green dominates red)", () => {
    const red = decodePng(encode(1, 1, () => [255, 0, 0, 255])).data[0];
    const green = decodePng(encode(1, 1, () => [0, 255, 0, 255])).data[0];
    expect(green).toBeGreaterThan(red);
  });

  test("rejects a non-PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/i);
  });

  test("rejects a truncated file", () => {
    const full = encode(4, 4, gray(200));
    expect(() => decodePng(full.subarray(0, 30))).toThrow();
  });

  test("rejects an interlaced PNG with a clear message", () => {
    const png = new PNG({ width: 4, height: 4, interlace: true });
    png.data.fill(200);
    // pngjs's encoder ignores `interlace: true` (see forceInterlaceFlag above)
    // — flip the IHDR byte by hand so this file is actually interlaced.
    const buf = forceInterlaceFlag(PNG.sync.write(png));
    expect(() => decodePng(buf)).toThrow(/interlac/i);
  });
});
