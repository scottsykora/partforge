import { expect, test } from "vitest";
import { resolveVectors, resolveVectorDocs, cachedVectorDocs, ensureVectors } from "../src/framework/vectors.js";
import { fromInternalRegions } from "../src/framework/geometry/vector-format.js";
import { handle } from "../src/framework/jobs.js";

const box = (w = 10) => fromInternalRegions([{ outer: { start: [0, 0], segments: [
  { to: [w, 0] }, { to: [w, 10] }, { to: [0, 10] },
] }, holes: [] }], { source: null });
const bytes = (doc) => new TextEncoder().encode(JSON.stringify(doc));

test("resolves JSON bytes to an internal document", async () => {
  const map = await resolveVectors({ a: bytes(box()) });
  expect(map.get("a").units).toBe("artwork");
  const regions = map.get("a").shapes.get("artwork").regions;
  expect(regions).toHaveLength(1);
  expect(regions[0].outer.segments).toHaveLength(3);
});

test("resolves a thunk returning bytes", async () => {
  const map = await resolveVectors({ a: () => bytes(box()) });
  expect(map.get("a").shapes.get("artwork").regions).toHaveLength(1);
});

test("memoizes by source identity — one parse per source", async () => {
  let calls = 0;
  const src = () => { calls++; return bytes(box()); };
  await resolveVectors({ a: src });
  await resolveVectors({ b: src });
  expect(calls).toBe(1);
});

test("malformed JSON rejects with a message naming the key", async () => {
  await expect(resolveVectors({ logo: new TextEncoder().encode("{ not json") })).rejects.toThrow(/logo/);
});

test("a structurally invalid document rejects through the format validator", async () => {
  const d = box(); d.shapes.artwork[0].outer.segments[0] = { kind: "spiral", to: [1, 1] };
  const badSource = bytes(d);
  await expect(resolveVectors({ logo: badSource })).rejects.toThrow(/spiral/);
  // A failed parse must not be cached — the same bad source retried (e.g. under a
  // different name) must fail again, not silently resolve to a stale/undefined entry.
  await expect(resolveVectors({ other: badSource })).rejects.toThrow(/spiral/);
});

test("parsing is memoized by source, not repeated per name or per call", async () => {
  const src = bytes(box());
  const first = await resolveVectors({ a: src });
  const second = await resolveVectors({ b: src });
  expect(second.get("b")).toBe(first.get("a"));   // same object — not re-parsed
});

test("a source that is not bytes, a URL, or a thunk rejects", async () => {
  await expect(resolveVectors({ bad: 42 })).rejects.toThrow(/must be bytes, a URL, a thunk/);
});

// Mirrors fonts.js's resolveFonts guard: `Object.entries` on a function is
// `[]`, not a thrown error, so a function-valued `vectors` reaching resolveVectors
// unresolved would otherwise silently produce an empty map and only surface
// far downstream as `vector2d: unknown vector "…"` for a name the part declared
// correctly.
test("a function-valued vectors declaration is refused, not silently resolved to nothing", async () => {
  await expect(resolveVectors((p) => ({ logo: bytes(box()) }))).rejects.toThrow(/vectors.*function|function.*vectors/i);
});

test("ensureVectors registers on the kernel and prunes stale names", async () => {
  const kernel = { _vectors: new Map() };
  await ensureVectors(kernel, { a: bytes(box()), b: bytes(box(20)) });
  expect([...kernel._vectors.keys()].sort()).toEqual(["a", "b"]);
  await ensureVectors(kernel, { a: bytes(box()) });
  expect([...kernel._vectors.keys()]).toEqual(["a"]);
});

test("ensureVectors is a no-op on a kernel with no _vectors map", async () => {
  await expect(ensureVectors({}, { a: bytes(box()) })).resolves.toBeUndefined();
});

// Integration-level, through jobs.js's `handle` — not calling ensureVectors
// directly like every test above, which cannot see jobs.js's own decision of
// WHETHER to call it. jobs.js used to guard that call with `if (part.vectors)`,
// so a worker rebound (handle called again on the SAME kernel, exactly how a
// live worker reuses one across parts — see test/worker-rebind.test.js) from
// a part WITH artwork to a part with NO `vectors` field at all skipped the prune
// entirely and left the old name resolvable forever — the exact
// stale-registration bug vectors.js's own prune comment cites, just reached
// through a different door than the "declares vectors but drops one name" case
// covered above.
const job = { type: "generate", subparts: [], view: "main", params: {} };

test("handle prunes a stale vector name even when the next part declares no vectors field at all", async () => {
  const kernel = { _vectors: new Map(), cleanup() {} };
  await handle(kernel, { vectors: { logo: bytes(box()) }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._vectors.has("logo")).toBe(true);

  await handle(kernel, { parts: {}, defaults: {} }, job, () => {}); // no `vectors` key whatsoever
  expect(kernel._vectors.has("logo")).toBe(false);
});

// resolveVectorDocs — the RAW parsed JSON lint's document-aware rules read
// (lint/index.js's ctx.vectorDocs). Unlike resolveVectors, it never rejects:
// a per-name failure maps that one entry to null instead of taking the whole
// call down, so lint stays useful for a part's other, well-formed vectors.
const rawDoc = (units = "mm", shapes = { body: [] }) => bytes({ format: "partforge-vector", version: 1, units, shapes });

test("resolveVectorDocs returns the raw parsed JSON, not the internal document", async () => {
  const map = await resolveVectorDocs({ a: rawDoc("artwork", { body: [], holes: [] }) });
  expect(map.get("a")).toEqual({ format: "partforge-vector", version: 1, units: "artwork", shapes: { body: [], holes: [] } });
});

// The important one: resolution is PER-SOURCE. A single unresolvable vector
// must not silence document-aware lint for every OTHER vector the part
// declares — confirmed here with a good source right beside one whose thunk
// rejects (the "will not fetch" case, below).
test("one bad source maps to null without affecting a good sibling", async () => {
  const map = await resolveVectorDocs({ good: rawDoc("mm"), bad: async () => { throw new Error("network down"); } });
  expect(map.get("good")).toEqual({ format: "partforge-vector", version: 1, units: "mm", shapes: { body: [] } });
  expect(map.get("bad")).toBeNull();
});

test("a source that will not fetch maps to null", async () => {
  const map = await resolveVectorDocs({ bad: async () => { throw new Error("network down"); } });
  expect(map.get("bad")).toBeNull();
});

test("a source of the wrong type (not bytes/URL/thunk) also maps to null, not a throw", async () => {
  const map = await resolveVectorDocs({ bad: 42 });
  expect(map.get("bad")).toBeNull();
});

test("bytes that are not valid UTF-8 map to null", async () => {
  // Decoding invalid UTF-8 does not itself throw (the default TextDecoder
  // substitutes U+FFFD rather than raising); the replacement characters break
  // JSON syntax instead, which is what actually maps this to null — the
  // observable contract ("garbage bytes in, null out") holds either way.
  const map = await resolveVectorDocs({ bad: new Uint8Array([0xff, 0xfe, 0x80, 0x81, 0x7b]) });
  expect(map.get("bad")).toBeNull();
});

test("valid UTF-8 that is not JSON maps to null", async () => {
  const map = await resolveVectorDocs({ bad: new TextEncoder().encode("{ not json") });
  expect(map.get("bad")).toBeNull();
});

test("JSON that is not an object maps to null", async () => {
  const map = await resolveVectorDocs({ bad: new TextEncoder().encode("42") });
  expect(map.get("bad")).toBeNull();
});

test("resolveVectorDocs never rejects, even when every source is bad", async () => {
  await expect(resolveVectorDocs({ a: 42, b: new TextEncoder().encode("not json") })).resolves.toBeInstanceOf(Map);
});

test("resolveVectorDocs on a function-valued vectors declaration resolves to an empty map, not a throw", async () => {
  await expect(resolveVectorDocs((p) => ({ logo: rawDoc() }))).resolves.toEqual(new Map());
});

// --- cachedVectorDocs: synchronous, fetch-free, never throws ------------------
//
// This is what the worker's lint job reads. Its whole reason to exist is that
// lint must stay instant and offline: it may look only at bytes that are already
// resolved, must never start a fetch (asset-resolve.js's has no timeout), and
// must never throw, because a throw there costs the host its lint-report.

test("cachedVectorDocs returns nothing for a source that has not resolved yet", () => {
  expect([...cachedVectorDocs({ a: bytes(box()) }).keys()]).toEqual([]);
});

test("cachedVectorDocs returns the RAW parsed JSON once the source has resolved", async () => {
  const src = bytes(box());
  await resolveVectors({ a: src });
  const doc = cachedVectorDocs({ a: src }).get("a");
  // Raw JSON, not the internal form: `shapes` is a plain object the lint rules
  // can call Object.hasOwn on, not the Map that toInternalDocument builds.
  expect(doc.format).toBe("partforge-vector");
  expect(doc.units).toBe("artwork");
  expect(Object.hasOwn(doc.shapes, "artwork")).toBe(true);
});

test("cachedVectorDocs never invokes a thunk, so it can never start a fetch", () => {
  let called = 0;
  const src = () => { called++; return bytes(box()); };
  expect([...cachedVectorDocs({ a: src }).keys()]).toEqual([]);
  expect(called).toBe(0);
});

test("cachedVectorDocs reports resolved siblings even when one source is unresolved", async () => {
  const ready = bytes(box());
  await resolveVectors({ ready });
  const out = cachedVectorDocs({ ready, pending: () => new Promise(() => {}) });
  expect([...out.keys()]).toEqual(["ready"]);
});

test("cachedVectorDocs maps a resolved-but-unparseable source to null, not a throw", async () => {
  const src = new TextEncoder().encode("<svg>not json</svg>");
  await resolveVectors({ a: src }).catch(() => {});   // parse fails downstream; bytes still resolved
  expect(cachedVectorDocs({ a: src }).get("a")).toBeNull();
});

test.each([
  ["null", null],
  ["a function", () => ({})],
  ["a throwing ownKeys Proxy", new Proxy({}, { ownKeys() { throw new Error("hostile"); } })],
  ["a throwing value getter", Object.defineProperty({}, "a", { get() { throw new Error("hostile"); }, enumerable: true })],
])("cachedVectorDocs never throws on %s", (_label, decl) => {
  expect(() => cachedVectorDocs(decl)).not.toThrow();
});

// --- an already-parsed file as a source --------------------------------------
//
// The in-memory form of a vectors source: the CONTENTS of a .vector.json that
// something already parsed, rather than its bytes or a URL to fetch them from.
// This is what lets artwork live in the part TREE as an editable file —
// `import doc from "./plate.vector.json"` — instead of behind an opaque asset
// token. A format an agent is meant to read and edit has to be reachable as
// data, not only as an attachment.

test("resolves an already-parsed file object", async () => {
  const map = await resolveVectors({ a: box() });
  expect(map.get("a").units).toBe("artwork");
  expect(map.get("a").shapes.get("artwork").regions).toHaveLength(1);
});

test("resolves a thunk returning an already-parsed file", async () => {
  const map = await resolveVectors({ a: () => box() });
  expect(map.get("a").shapes.get("artwork").regions).toHaveLength(1);
});

// A static `import doc from "./x.vector.json"` yields the object itself; a
// dynamic `import("./x.vector.json")` yields the module namespace. Both forms
// have to land on the same place, the way FontSource already handles Vite's
// `() => import("./x.ttf")`.
test("resolves the { default } module shape a dynamic JSON import yields", async () => {
  const map = await resolveVectors({ a: () => ({ default: box() }) });
  expect(map.get("a").shapes.get("artwork").regions).toHaveLength(1);
});

test("an invalid parsed file rejects through the format validator, naming the key", async () => {
  await expect(resolveVectors({ logo: { format: "svg", version: 1, units: "mm", shapes: {} } }))
    .rejects.toThrow(/logo/);
});

test("parsing is memoized by object identity, not repeated per name", async () => {
  const doc = box();
  const first = await resolveVectors({ a: doc });
  const second = await resolveVectors({ b: doc });
  expect(second.get("b")).toBe(first.get("a"));
});

// The caller owns the object — a part module's `vectors` map is plain data the
// host may also be holding. Reading it must not write to it.
test("resolution does not mutate the caller's object", async () => {
  const doc = box();
  const before = JSON.stringify(doc);
  await resolveVectors({ a: doc });
  expect(JSON.stringify(doc)).toBe(before);
});

test("an array source is still refused by the source grammar", async () => {
  await expect(resolveVectors({ bad: [] })).rejects.toThrow(/must be bytes, a URL, a thunk/);
});

test("resolveVectorDocs returns the raw object for an already-parsed source", async () => {
  const doc = { format: "partforge-vector", version: 1, units: "mm", shapes: { body: [] } };
  const map = await resolveVectorDocs({ a: doc });
  expect(map.get("a")).toEqual(doc);
});

// The one behavioural gain over bytes or a URL: nothing has to resolve first.
// A part whose artwork lives in its own tree gets document-aware lint on the
// FIRST keystroke, before any build has run — which is exactly the case a
// hosted editor spends most of its time in.
test("cachedVectorDocs reads an already-parsed source with no resolve at all", () => {
  const doc = { format: "partforge-vector", version: 1, units: "artwork", shapes: { body: [] } };
  expect(cachedVectorDocs({ a: doc }).get("a")).toEqual(doc);
});

test("cachedVectorDocs unwraps the { default } module shape too", () => {
  const doc = { format: "partforge-vector", version: 1, units: "artwork", shapes: { body: [] } };
  expect(cachedVectorDocs({ a: { default: doc } }).get("a")).toEqual(doc);
});

test("ensureVectors registers an already-parsed file on the kernel", async () => {
  const kernel = { _vectors: new Map() };
  await ensureVectors(kernel, { a: box() });
  expect(kernel._vectors.get("a").shapes.get("artwork").regions).toHaveLength(1);
});
