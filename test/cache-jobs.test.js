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
