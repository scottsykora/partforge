// test/oracle-cache.test.js — the oracle (buildView / assemblyOverlaps) must reuse
// solids the display build already made, WITHOUT evicting the display cache: it runs
// after every generate, and rebuilding the whole view twice is most of its cost.
import { beforeAll, expect, test } from "vitest";
import { assemblyOverlaps, bootManifoldKernel, buildView, viewSubParts } from "../src/testing.js";
import part from "../src/parts/demo.js";

const VIEW = Object.keys(part.views)[0];
let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const generate = () => {
  const p = { ...part.defaults };
  const d = part.derive?.(p) ?? {};
  for (const n of viewSubParts(part, VIEW, p)) {
    k.beginSubPart(n);
    try { part.parts[n].build(k, p, d)._m.numTri(); } finally { k.endSubPart(); k.cleanup(); }
  }
};

test("buildView caches its solids instead of rebuilding every call", () => {
  buildView(k, part, VIEW, {});
  k.resetCacheStats();
  buildView(k, part, VIEW, {});
  const { hits, misses } = k.cacheStats();
  expect(misses).toBe(0);
  expect(hits).toBeGreaterThan(0);
});

test("the oracle reuses the solids the display build already made", () => {
  generate();
  k.resetCacheStats();
  buildView(k, part, VIEW, {});
  const { hits, misses } = k.cacheStats();
  expect(misses).toBe(0);                  // every solid came from the generate
  expect(hits).toBeGreaterThan(0);         // ...and it actually consulted the cache
});

test("oracle geometry at other params does not displace the display cache", () => {
  // verify walks cases with params of their own. Those builds must land in the
  // oracle's partition, not the display one — otherwise measuring a part throws away
  // the geometry the viewer is showing and the next redraw rebuilds from cold.
  generate();
  buildView(k, part, VIEW, { od: 12, h: 14 });      // an oracle build at other params
  assemblyOverlaps(k, part, VIEW, { od: 12, h: 14 });
  k.resetCacheStats();
  generate();                                       // display build must still be warm
  expect(k.cacheStats().misses).toBe(0);
});

test("a build that throws mid-check still closes the cache bracket", () => {
  // Observed through a fake kernel: a leaked bracket is invisible to cacheStats
  // (every later round just nests inside the stranded one and still reports hits)
  // but leaks the round forever, so assert the begin/end pairing directly.
  const calls = [];
  const fake = {
    beginSubPart: (n) => calls.push(`begin:${n}`),
    endSubPart: () => calls.push("end"),
    cleanup: () => calls.push("cleanup"),
  };
  const broken = {
    views: { v: { label: "v" } },
    defaults: {},
    parts: { boom: { views: ["v"], build: () => { throw new Error("build failed"); } } },
  };
  expect(() => assemblyOverlaps(fake, broken, "v", {})).toThrow(/build failed/);
  expect(calls.filter((c) => c.startsWith("begin")).length).toBe(1);
  expect(calls.filter((c) => c === "end").length).toBe(1);
});
