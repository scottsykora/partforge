import { test, expect } from "vitest";
import { PNG } from "pngjs";
import { imagesFor, resolveImages, ensureImages } from "../src/framework/images.js";

// Returns an ArrayBuffer holding exactly the encoded PNG bytes.
//
// The brief's version of this helper returned the Buffer itself, and callers
// did `png().buffer.slice(0)` to get bytes. That is broken: Node's Buffer
// pool means a small Buffer's `.buffer` is a much larger shared ArrayBuffer,
// and the Buffer's own data starts at a nonzero `byteOffset`
// (asset-resolve.js's `toBuffer()` has a comment about exactly this
// pitfall). `.slice(0)` copies from the pool's start, not the PNG's start,
// so the result is the wrong length and, depending on allocation order,
// may not even start with the PNG signature — this failed on the first test
// run here. Slicing by the Buffer's own byteOffset/byteLength (as
// toBuffer() itself does) is the fix; callers below just use `png()`.
const png = (v = 200) => {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  const buf = PNG.sync.write(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

test("imagesFor resolves the function form with params", () => {
  const part = { images: (p) => (p.relief ? { relief: p.relief } : {}) };
  expect(imagesFor(part, { relief: "x" })).toEqual({ relief: "x" });
  expect(imagesFor(part, {})).toEqual({});
});

test("imagesFor resolves the plain-object form regardless of params", () => {
  const part = { images: { relief: "https://cdn.test/d.png" } };
  expect(imagesFor(part, { anything: 1 })).toEqual({ relief: "https://cdn.test/d.png" });
});

test("imagesFor returns undefined when the part declares no images", () => {
  expect(imagesFor({}, {})).toBeUndefined();
});

test("resolveImages decodes bytes without fetching, and digests them", async () => {
  const bytes = png();
  const m = await resolveImages({ relief: bytes });
  const e = m.get("relief");
  expect(e.width).toBe(2);
  expect(e.height).toBe(2);
  expect(e.data).toBeInstanceOf(Uint16Array);
  expect(e.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("different bytes give different digests", async () => {
  const a = await resolveImages({ r: png(10) });
  const b = await resolveImages({ r: png(240) });
  expect(a.get("r").digest).not.toBe(b.get("r").digest);
});

test("resolveImages rejects when `images` is still the function form (must be resolved via imagesFor first)", async () => {
  await expect(resolveImages((p) => ({}))).rejects.toThrow(/imagesFor/);
});

test("a non-PNG source names the ingest helper", async () => {
  await expect(resolveImages({ r: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer }))
    .rejects.toThrow(/imageToPng/);
});

test("ensureImages registers on the kernel and is digest-gated", async () => {
  const seen = [];
  const kernel = {
    _registerImage: (e) => seen.push(e),
    _imageDigest: (n) => seen.find((s) => s.name === n)?.digest,
  };
  const decl = { relief: png() };
  await ensureImages(kernel, decl);
  await ensureImages(kernel, decl);
  expect(seen.length).toBe(1); // second call is a no-op at the same digest
});

test("ensureImages re-registers when the digest changes", async () => {
  const seen = [];
  const kernel = {
    _registerImage: (e) => seen.push(e),
    _imageDigest: (n) => seen.find((s) => s.name === n)?.digest,
  };
  await ensureImages(kernel, { relief: png(10) });
  await ensureImages(kernel, { relief: png(240) });
  expect(seen.length).toBe(2);
  expect(seen[0].digest).not.toBe(seen[1].digest);
});

test("ensureImages is a no-op on a kernel with no _registerImage", async () => {
  await expect(ensureImages({}, { relief: png() })).resolves.toBeUndefined();
});

test("ensureImages is a no-op when imagesDecl is falsy", async () => {
  const seen = [];
  const kernel = { _registerImage: (e) => seen.push(e), _imageDigest: () => undefined };
  await ensureImages(kernel, undefined);
  expect(seen.length).toBe(0);
});
