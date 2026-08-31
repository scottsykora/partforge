// The vector-art sibling of test/images-jobs.test.js's allow-check block —
// the fifth parity site the task-9 fix-round-1 review found: a `type:
// "vector"` param reaches vectorsFor()/ensureVectors() the same way a
// `type: "image"` param reaches imagesFor()/ensureImages(), and until this
// file's fix, jobs.js's resolveParams sanitize hook gated fonts and images
// but not vectors — a share-link-supplied vector URL reached the resolver's
// fetcher completely ungated.
import { test, expect } from "vitest";
import { handle } from "../src/framework/jobs.js";
import { fromInternalRegions } from "../src/framework/geometry/vector-format.js";

const job = { type: "generate", subparts: [], view: "iso", params: {} };

// A valid partforge-vector document object — the "already-parsed" source
// shape (see vectors.js's `asParsedFile`), built the way test/vectors.test.js
// builds one rather than hand-written, since the format validator rejects a
// hand-rolled contour missing its `kind`.
const doc = () => fromInternalRegions([{ outer: { start: [0, 0], segments: [
  { to: [1, 0] }, { to: [1, 1] }, { to: [0, 1] },
] }, holes: [] }], { source: null });

// A fake kernel exposing exactly the `_vectors` side-channel ensureVectors
// consumes, mirroring images-jobs.test.js's fakeImageKernel.
function fakeVectorKernel() {
  const vectors = new Map();
  return { vectors, cleanup() {}, _vectors: vectors };
}

// ── the allow-check must run as resolveParams' sanitize hook, not after ────
// same placement rule as the font/image blocks: derive() must observe the
// REPLACEMENT value, not the refused one, or the geometry would be built
// from a value nothing ever validated.
test("derive() sees the default replacement, not a disallowed vector source", async () => {
  const kernel = fakeVectorKernel();
  const seen = [];
  const part = {
    parameters: [{ id: "t", controls: [{ key: "art", type: "vector", allow: ["gstatic"] }] }],
    defaults: { art: "" },
    derive: (p) => { seen.push(p.art); return {}; },
    vectors: (p) => (p.art ? { art: p.art } : {}),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { art: "https://evil.test/x.svg" } }, () => {});
  expect(seen).toEqual([""]); // the part's own default, not the refused URL
});

test("a disallowed vector param source is refused, warns, and never resolves", async () => {
  const kernel = fakeVectorKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "art", type: "vector", allow: ["gstatic"] }] }],
    defaults: { art: "" },
    vectors: (p) => (p.art ? { art: p.art } : {}),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { art: "https://evil.test/x.svg" } }, (m) => posts.push(m));
  // Gated: the sanitize hook reset `p.art` to "" before vectorsFor() ever ran,
  // so `vectors: (p) => …` returned `{}` and ensureVectors had nothing to
  // resolve — the malicious URL never reached asset-resolve.js's `fetch`.
  expect(kernel.vectors.has("art")).toBe(false);
  const meshes = posts.find((m) => m.type === "meshes");
  expect(meshes.warnings).toEqual([{ part: null, message: expect.stringContaining('vector source for "art" is not allowed') }]);
});

// vector-source.js's header: an already-parsed document is plain JSON and
// DOES round-trip a share link — unlike font/image bytes, it is not exempted
// because it's implausible on a link. It's exempted because it structurally
// never reaches `fetch`: vectors.js's `asParsedFile` claims it before the
// resolver's fetch branch, and `toInternalDocument` validates its shape
// downstream. Confirmed here at the jobs.js integration level, not just the
// vectorSourceAllowed unit level.
test("an already-parsed document source always bypasses the allow check — it never reaches fetch", async () => {
  const kernel = fakeVectorKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "art", type: "vector", allow: ["gstatic"] }] }],
    defaults: { art: "" },
    vectors: (p) => (p.art ? { art: p.art } : {}),
    parts: {},
  };
  const posts = [];
  await handle(kernel, part, { ...job, params: { art: doc() } }, (m) => posts.push(m));
  expect(kernel.vectors.has("art")).toBe(true);
  expect(posts.find((m) => m.type === "meshes").warnings).toBeUndefined();
});

// ── stale-registration pruning: the vectors-map twin of the images test ────
//
// `vectors: (p) => (p.art ? { art: p.art } : {})` — guarded, unlike the
// unconditional `images: (p) => ({ relief: p.relief })` idiom
// images-jobs.test.js's equivalent test uses. jobs.js pre-filters
// `isNoImageSource`/`isNoFontSource` entries before ever calling
// ensureImages/resolveFonts, so an unguarded declaration is safe for those
// two; it does NOT do the equivalent filtering for vectors before calling
// ensureVectors, so an unconditional declaration would hand an empty-string
// source straight to asset-resolve.js's resolver, which treats "" as a URL
// and throws (`fetch("")` -> "Failed to parse URL from "). That gap predates
// this task (vectorsFor's function form shipped in Task 1, before any
// control could ever write "" into it) and is not part of this fix's scope
// — noted in the task-9 report rather than fixed here. Guarding in the
// declaration, as this test does, is what every part author must do today.
test("clearing a picked vector drops the name instead of leaving the old artwork registered", async () => {
  const kernel = fakeVectorKernel();
  const part = {
    parameters: [{ id: "t", controls: [{ key: "art", type: "vector" }] }],
    defaults: { art: "" },
    vectors: (p) => (p.art ? { art: p.art } : {}),
    parts: {},
  };
  await handle(kernel, part, { ...job, params: { art: doc() } }, () => {});
  expect(kernel.vectors.has("art")).toBe(true);
  await handle(kernel, part, { ...job, params: { art: "" } }, () => {}); // cleared
  expect(kernel.vectors.has("art"), "a cleared pick must not stay registered").toBe(false);
});
