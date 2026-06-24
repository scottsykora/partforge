import { beforeAll, expect, test, vi } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { handle } from "../src/framework/jobs.js";
import part from "../src/parts/demo.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

// Demo spacer with the flange on → build is union(barrel, flange) then cut(bore).
const gen = (params) => handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params }, vi.fn());

test("re-generating after a bore-only change resumes the build (union hits, cut misses)", async () => {
  await gen({ od: 8, h: 10, flange_d: 16, bore: 3.4 }); // cold
  k.resetCacheStats();
  await gen({ od: 8, h: 10, flange_d: 16, bore: 4.0 }); // bore changed only
  const { hits, misses } = k.cacheStats();
  expect(hits).toBeGreaterThanOrEqual(1); // the flange union was reused
  expect(misses).toBeGreaterThanOrEqual(1); // the bore cut was redone
});

test("an identical re-generate recomputes nothing", async () => {
  await gen({ od: 8, h: 10, flange_d: 16, bore: 3.4 });
  k.resetCacheStats();
  await gen({ od: 8, h: 10, flange_d: 16, bore: 3.4 });
  expect(k.cacheStats().misses).toBe(0);
});

test("a build that throws mid-way still closes the cache bracket — the kernel is reusable, not stuck", async () => {
  // Inline part: builds a cached boundary op (cut), then throws when p.boom is set.
  const flaky = {
    defaults: { boom: false },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => {
      const s = k.cylinder(5, 5, 10).cut(k.cylinder(2, 2, 12).translate([0, 0, -1]));
      if (p.boom) throw new Error("boom");
      return s;
    } } },
  };
  const run = (params) => { const post = vi.fn(); return handle(k, flaky, { type: "generate", subparts: ["a"], view: "v", params }, post).then(() => post); };

  const post1 = await run({ boom: true });   // throws mid-build
  expect(post1.mock.calls.some(([m]) => m.type === "error")).toBe(true);

  k.resetCacheStats();
  const post2 = await run({ boom: false });  // must still work — bracket was closed in finally
  const meshesMsg = post2.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
  expect(meshesMsg).toBeTruthy();
  expect(meshesMsg.meshes[0].triangles).toBeGreaterThan(0);
  // The failed build committed the cut solid before throwing; a clean build reuses it.
  expect(k.cacheStats().hits).toBeGreaterThan(0);
});

test("the generate result carries build ms and cache stats", async () => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params: { od: 8, h: 10, flange_d: 16, bore: 3.4 } }, post);
  const msg = post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
  expect(typeof msg.ms).toBe("number");
  expect(msg.cache).toEqual(expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }));
});

test("cache:false bypasses the cache — a repeat generate reports no hits", async () => {
  const gen = (extra) => {
    const post = vi.fn();
    return handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params: { od: 8, h: 10, flange_d: 16, bore: 3.4 }, ...extra }, post)
      .then(() => post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes"));
  };
  await gen({ cache: false });            // unbracketed
  const m2 = await gen({ cache: false });  // repeat, still unbracketed
  expect(m2.cache).toEqual({ hits: 0, misses: 0 }); // nothing was cached → no hits
});

test("default (cache on) reuses across repeats — hits on the repeat generate", async () => {
  const gen = () => {
    const post = vi.fn();
    return handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params: { od: 8, h: 10, flange_d: 16, bore: 3.4 } }, post)
      .then(() => post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes"));
  };
  await gen();             // (cold or already-warm from earlier tests)
  const m2 = await gen();  // repeat
  expect(m2.cache.hits).toBeGreaterThan(0);
});
