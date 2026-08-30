import { expect, test } from "vitest";
import { resolveVectors, ensureVectors } from "../src/framework/vectors.js";
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
  await expect(resolveVectors({ bad: 42 })).rejects.toThrow(/must be bytes, a URL, or a thunk/);
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
