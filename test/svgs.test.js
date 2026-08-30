import { expect, test } from "vitest";
import { resolveSvgs, ensureSvgs } from "../src/framework/svgs.js";
import { fromInternalRegions } from "../src/framework/geometry/vector-format.js";
import { handle } from "../src/framework/jobs.js";

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

// Mirrors fonts.js's resolveFonts guard: `Object.entries` on a function is
// `[]`, not a thrown error, so a function-valued `svgs` reaching resolveSvgs
// unresolved would otherwise silently produce an empty map and only surface
// far downstream as `svg2d: unknown svg "…"` for a name the part declared
// correctly.
test("a function-valued svgs declaration is refused, not silently resolved to nothing", async () => {
  await expect(resolveSvgs((p) => ({ logo: bytes(box()) }))).rejects.toThrow(/svgs.*function|function.*svgs/i);
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

// Integration-level, through jobs.js's `handle` — not calling ensureSvgs
// directly like every test above, which cannot see jobs.js's own decision of
// WHETHER to call it. jobs.js used to guard that call with `if (part.svgs)`,
// so a worker rebound (handle called again on the SAME kernel, exactly how a
// live worker reuses one across parts — see test/worker-rebind.test.js) from
// a part WITH artwork to a part with NO `svgs` field at all skipped the prune
// entirely and left the old name resolvable forever — the exact
// stale-registration bug svgs.js's own prune comment cites, just reached
// through a different door than the "declares svgs but drops one name" case
// covered above.
const job = { type: "generate", subparts: [], view: "main", params: {} };

test("handle prunes a stale svg name even when the next part declares no svgs field at all", async () => {
  const kernel = { _svgs: new Map(), cleanup() {} };
  await handle(kernel, { svgs: { logo: bytes(box()) }, parts: {}, defaults: {} }, job, () => {});
  expect(kernel._svgs.has("logo")).toBe(true);

  await handle(kernel, { parts: {}, defaults: {} }, job, () => {}); // no `svgs` key whatsoever
  expect(kernel._svgs.has("logo")).toBe(false);
});
