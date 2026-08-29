import { test, expect } from "vitest";
import { PNG } from "pngjs";
import { resolveParams } from "../src/framework/part-model.js";
import { h } from "../src/framework/geometry/solid-hash.js";
import { handle } from "../src/framework/jobs.js";
import { imagesFor } from "../src/framework/images.js";

// Returns an ArrayBuffer holding exactly the encoded PNG bytes.
//
// The brief's version of this helper did `PNG.sync.write(p).buffer.slice(0)`.
// That is broken the same way test/images-resolve.test.js's own comment
// already documents: Node's Buffer pool means a small Buffer's `.buffer` is a
// much larger shared ArrayBuffer and the Buffer's data starts at a nonzero
// `byteOffset`, so `.slice(0)` copies from the POOL's start, not the PNG's —
// wrong length, and depending on allocation order maybe not even starting
// with the PNG signature. Slicing by the Buffer's own byteOffset/byteLength
// (as asset-resolve.js's toBuffer() and images-resolve.test.js's png() both
// do) is the fix.
const png = (v = 180) => {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  const buf = PNG.sync.write(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

// Spec §7 invariant 1.
test("resolveParams passes an ArrayBuffer through untouched", () => {
  const buf = png();
  const part = { defaults: { relief: "", n: 1 }, parameters: [] };
  const out = resolveParams(part, { relief: buf, n: 2 });
  expect(out.p.relief).toBe(buf); // identity, not a copy
});

// The `sanitize` hook (jobs.js's font/image allow-check) rewrites `params` IN
// PLACE but must never touch a key it has no opinion about — an untouched
// buffer must survive it by the same identity.
test("resolveParams' sanitize hook cannot mangle a buffer it doesn't reject", () => {
  const buf = png();
  const part = { defaults: { relief: "" }, parameters: [] };
  const out = resolveParams(part, { relief: buf }, (p) => { p.unrelated = 1; });
  expect(out.p.relief).toBe(buf);
  expect(out.p.unrelated).toBe(1);
});

// Spec §7 invariant 2.
test("h() does not expand an ArrayBuffer into a giant key", () => {
  const key = h("heightfield", "abc123", 60, 60, 1.5, 3, 0.5, false, [0, 1], "center");
  expect(key.length).toBeLessThan(32);
  expect(typeof key).toBe("string");
});

// The other half of invariant 2: h() is never actually called with raw image
// bytes anywhere in the codebase today (both backends' `heightfield` ops key
// on `grid.digest`, a hex string — see manifold-backend.js/occt-backend.js).
// This test pins WHY that discipline matters: if a future call site ever did
// pass an ArrayBuffer straight to h(), canon()'s `String(x)` would collapse
// every distinct image to the same constant, and two different images would
// collide on one cache entry. Documents the hazard rather than exercising a
// real bug — see the report for the full "did I find one" search.
test("a raw ArrayBuffer passed to h() would collide — canon() stringifies it to a constant", () => {
  const a = h("heightfield", new ArrayBuffer(8));
  const b = h("heightfield", new ArrayBuffer(400)); // a completely different image's bytes
  expect(a).toBe(b); // the hazard invariant 2 warns about, reproduced in isolation
});

const job = { type: "generate", subparts: [], view: "iso", params: {} };

// A fake kernel exposing exactly the images side-channel jobs.js consumes
// (`_registerImage`/`_imageDigest`/`_pruneImages`), mirroring how
// test/fonts-dynamic.test.js fakes `kernel._fonts` directly rather than
// booting a real WASM backend.
function fakeImageKernel() {
  const images = new Map();
  return {
    images, // exposed for assertions only; jobs.js never reads this property
    cleanup() {},
    _registerImage: ({ name, digest, width, height, data }) => { images.set(name, { digest, width, height, data }); },
    _imageDigest: (name) => images.get(name)?.digest,
    _pruneImages: (keep) => { for (const n of [...images.keys()]) if (!keep.has(n)) images.delete(n); },
  };
}

test("imagesFor calls the function form with resolved params", () => {
  const part = { defaults: { relief: "A" }, images: (p) => ({ relief: p.relief }) };
  expect(imagesFor(part, { relief: "B" })).toEqual({ relief: "B" });
});

test("a declared image is resolved and registered on the kernel", async () => {
  const kernel = fakeImageKernel();
  const bytes = png(10);
  const part = { defaults: {}, images: { relief: bytes }, parts: {} };
  await handle(kernel, part, job, () => {});
  const entry = kernel.images.get("relief");
  expect(entry.width).toBe(2);
  expect(entry.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("no image source declared for a name is skipped, not an error", async () => {
  const kernel = fakeImageKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image" }] }],
    defaults: { relief: "" },
    images: (p) => ({ relief: p.relief }),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { relief: "" } }, (m) => posts.push(m));
  expect(kernel.images.has("relief")).toBe(false);
  expect(posts.find((m) => m.type === "error")).toBeUndefined();
  const skip = posts.find((m) => m.type === "progress" && /no image source declared/.test(m.phase));
  expect(skip).toBeTruthy();
});

// ── the allow-check must run as resolveParams' sanitize hook, not after ────
// (the controller's second, substantive brief correction). Proven the same
// way font-source's placement fix is proven: derive() must observe the
// REPLACEMENT value, not the refused one.
test("derive() sees the default replacement, not a disallowed image source", async () => {
  const kernel = fakeImageKernel();
  const seen = [];
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image", allow: ["gstatic"] }] }],
    defaults: { relief: "" },
    derive: (p) => { seen.push(p.relief); return {}; },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { relief: "https://evil.test/x.png" } }, () => {});
  expect(seen).toEqual([""]); // the part's own default, not the refused URL
});

test("a disallowed image param source is refused, warns, and never registers", async () => {
  const kernel = fakeImageKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image", allow: ["gstatic"] }] }],
    defaults: { relief: "" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { relief: "https://evil.test/x.png" } }, (m) => posts.push(m));
  expect(kernel.images.has("relief")).toBe(false);
  const meshes = posts.find((m) => m.type === "meshes");
  expect(meshes.warnings).toEqual([{ part: null, message: expect.stringContaining('image source for "relief" is not allowed') }]);
});

// image-source.js's header: an ArrayBuffer in params cannot have arrived via a
// share link (a URL can't carry megabytes), so it always bypasses `allow` —
// even a maximally restrictive list. Do NOT special-case it in jobs.js; the
// existing imageSourceAllowed(bytes) === true check must be enough.
test("a byte-valued param source always bypasses the allow check", async () => {
  const kernel = fakeImageKernel();
  const bytes = png(50);
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image", allow: ["gstatic"] }] }],
    defaults: { relief: "" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { relief: bytes } }, (m) => posts.push(m));
  expect(kernel.images.has("relief")).toBe(true);
  expect(posts.find((m) => m.type === "meshes").warnings).toBeUndefined();
});

// ── stale-registration pruning: the images-map twin of the fonts prune ─────
test("clearing a picked image drops the name instead of leaving the old grid registered", async () => {
  const kernel = fakeImageKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "relief", type: "image" }] }],
    defaults: { relief: "" },
    images: (p) => ({ relief: p.relief }),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { relief: png(10) } }, () => {});
  expect(kernel.images.has("relief")).toBe(true);
  await handle(kernel, part, { ...job, params: { relief: "" } }, () => {}); // cleared
  expect(kernel.images.has("relief"), "a cleared pick must not stay registered").toBe(false);
});

test("a part with no `images` field leaves a host-seeded kernel image map alone", async () => {
  const kernel = fakeImageKernel();
  kernel._registerImage({ name: "heading", digest: "seeded", width: 1, height: 1, data: new Uint16Array(1) });
  await handle(kernel, { parts: {}, defaults: {} }, job, () => {});
  expect(kernel.images.get("heading").digest).toBe("seeded");
});

test("a renamed image declaration prunes only the name it dropped", async () => {
  const kernel = fakeImageKernel();
  const part1 = { defaults: {}, images: { one: png(1), two: png(2) }, parts: {} };
  await handle(kernel, part1, job, () => {});
  expect([...kernel.images.keys()].sort()).toEqual(["one", "two"]);
  const part2 = { defaults: {}, images: { two: png(2) }, parts: {} };
  await handle(kernel, part2, job, () => {});
  expect([...kernel.images.keys()]).toEqual(["two"]);
});
