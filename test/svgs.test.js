import { expect, test } from "vitest";
import { resolveSvgs, ensureSvgs } from "../src/framework/svgs.js";
import { fromInternalRegions } from "../src/framework/geometry/vector-format.js";

const box = (w = 10) => fromInternalRegions([{ outer: { start: [0, 0], segments: [
  { to: [w, 0] }, { to: [w, 10] }, { to: [0, 10] },
] }, holes: [] }], { source: null });
const bytes = (doc) => new TextEncoder().encode(JSON.stringify(doc));

test("resolves JSON bytes to internal regions", async () => {
  const map = await resolveSvgs({ a: bytes(box()) });
  expect(map.get("a")).toHaveLength(1);
  expect(map.get("a")[0].outer.segments).toHaveLength(3);
});

test("resolves a thunk returning bytes", async () => {
  const map = await resolveSvgs({ a: () => bytes(box()) });
  expect(map.get("a")).toHaveLength(1);
});

test("memoizes by source identity — one parse per source", async () => {
  let calls = 0;
  const src = () => { calls++; return bytes(box()); };
  await resolveSvgs({ a: src });
  await resolveSvgs({ b: src });
  expect(calls).toBe(1);
});

test("malformed JSON rejects with a message naming the key", async () => {
  await expect(resolveSvgs({ logo: new TextEncoder().encode("{ not json") })).rejects.toThrow(/logo/);
});

test("a structurally invalid document rejects through the format validator", async () => {
  const d = box(); d.regions[0].outer.segments[0] = { kind: "spiral", to: [1, 1] };
  const badSource = bytes(d);
  await expect(resolveSvgs({ logo: badSource })).rejects.toThrow(/spiral/);
  // A failed parse must not be cached — the same bad source retried (e.g. under a
  // different name) must fail again, not silently resolve to a stale/undefined entry.
  await expect(resolveSvgs({ other: badSource })).rejects.toThrow(/spiral/);
});

test("parsing is memoized by source, not repeated per name or per call", async () => {
  const src = bytes(box());
  const first = await resolveSvgs({ a: src });
  const second = await resolveSvgs({ b: src });
  expect(second.get("b")).toBe(first.get("a"));   // same object — not re-parsed
});

test("a source that is not bytes, a URL, or a thunk rejects", async () => {
  await expect(resolveSvgs({ bad: 42 })).rejects.toThrow(/must be bytes, a URL, or a thunk/);
});

test("ensureSvgs registers on the kernel and prunes stale names", async () => {
  const kernel = { _svgs: new Map() };
  await ensureSvgs(kernel, { a: bytes(box()), b: bytes(box(20)) });
  expect([...kernel._svgs.keys()].sort()).toEqual(["a", "b"]);
  await ensureSvgs(kernel, { a: bytes(box()) });
  expect([...kernel._svgs.keys()]).toEqual(["a"]);
});

test("ensureSvgs is a no-op on a kernel with no _svgs map", async () => {
  await expect(ensureSvgs({}, { a: bytes(box()) })).resolves.toBeUndefined();
});
