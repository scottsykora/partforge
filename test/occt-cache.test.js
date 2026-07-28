// The solid cache on the OCCT backend — the same createSolidCache the Manifold
// backend uses, bracketed per sub-part by jobs.js. OCCT must boot alone (never
// with Manifold) — this file only imports bootOcctKernel.
//
// The pose-lazy piece is what makes preview param drags fast: translate/rotate
// accumulate a rigid pose on the wrap instead of running OCCT transforms, and
// toMesh caches the BASE solid's tessellation and re-poses the cached vertices —
// so a change to a pose-only param (a lid's open angle) re-runs no kernel op at all.
import { beforeAll, expect, test, vi } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

// Minimal hinged-box-shaped part: an expensive base (fillet + cut), then a final
// pose rotation driven by its own param — the hinged-box lid pattern.
const posedPart = {
  defaults: { w: 10, bore: 3, angle: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: {
      views: ["v"],
      build: (k2, p) =>
        k2.box({ min: [0, 0, 0], max: [p.w, 10, 5] })
          .fillet({ r: 1, edges: { dir: "Z" } })
          .cut(k2.cylinder({ r: p.bore / 2, h: 7 }).at([5, 5, -1]))
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    },
  },
};

const gen = (part, params) => {
  const post = vi.fn();
  return handle(k, part, { type: "generate", subparts: Object.keys(part.parts), view: "v", params }, post)
    .then(() => post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes"));
};

test("the generate result carries cache stats (OCCT implements the optional cache ops)", async () => {
  const msg = await gen(posedPart, { w: 10, bore: 3, angle: 0 });
  expect(msg.cache).toEqual(expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }));
});

test("an identical re-generate recomputes nothing", async () => {
  await gen(posedPart, { w: 10, bore: 3, angle: 0 });
  k.resetCacheStats();
  const msg = await gen(posedPart, { w: 10, bore: 3, angle: 0 });
  expect(msg.cache.misses).toBe(0);
  expect(msg.cache.hits).toBeGreaterThan(0);
});

test("a pose-only change (open angle) re-runs no kernel op — cached mesh, re-posed", async () => {
  await gen(posedPart, { w: 10, bore: 3, angle: 0 });
  k.resetCacheStats();
  const msg = await gen(posedPart, { w: 10, bore: 3, angle: 45 });
  expect(msg.cache.misses).toBe(0); // no OCCT op ran: base solid AND its tessellation were reused
  expect(msg.cache.hits).toBeGreaterThan(0);
  expect(msg.meshes[0].triangles).toBeGreaterThan(0);
});

test("a downstream-only change resumes the build (upstream hits, changed op misses)", async () => {
  await gen(posedPart, { w: 10, bore: 3, angle: 0 });
  k.resetCacheStats();
  const msg = await gen(posedPart, { w: 10, bore: 4, angle: 0 }); // bore changed only
  expect(msg.cache.hits).toBeGreaterThanOrEqual(1);  // box + fillet reused
  expect(msg.cache.misses).toBeGreaterThanOrEqual(1); // the cut was redone
  expect(msg.meshes[0].triangles).toBeGreaterThan(0); // and the cached operand survived being reused (no consumed-operand throw)
});

test("the posed mesh matches replicad's own transform of the same solid", () => {
  const base = k.box({ min: [0, 0, 0], max: [10, 10, 5] }).fillet({ r: 1, edges: { dir: "Z" } });
  const posed = base.clone().rotateAbout({ axis: "X", deg: 45, through: [0, 0, 5] });
  const m = posed.toMesh({ quality: "preview" });
  // bounding box straight from replicad (materializes the pose through OCCT)…
  const bb = posed.boundingBox();
  // …must agree with the bounds of the re-posed cached vertices.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], m.positions[i + a]);
      hi[a] = Math.max(hi[a], m.positions[i + a]);
    }
  for (let a = 0; a < 3; a++) {
    expect(lo[a]).toBeCloseTo(bb.min[a], 1);
    expect(hi[a]).toBeCloseTo(bb.max[a], 1);
  }
});

test("feature labels survive the cached, re-posed mesh path", async () => {
  const labeled = {
    defaults: { angle: 0 },
    views: { v: { label: "V" } },
    parts: {
      a: {
        views: ["v"],
        build: (k2, p) =>
          k2.box({ min: [0, 0, 0], max: [10, 10, 5] })
            .cut(k2.cylinder({ r: 2, h: 7 }).at([5, 5, -1]).label("Bore"))
            .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
      },
    },
  };
  await gen(labeled, { angle: 0 });
  const msg = await gen(labeled, { angle: 30 }); // cached mesh, new pose
  const m = msg.meshes[0];
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds.length).toBe(m.triangles);
});

test("a build that throws mid-way still closes the cache bracket — the kernel is reusable", async () => {
  const flaky = {
    defaults: { boom: false },
    views: { v: { label: "V" } },
    parts: {
      a: {
        views: ["v"],
        build: (k2, p) => {
          const s = k2.box({ min: [0, 0, 0], max: [8, 8, 8] }).cut(k2.cylinder({ r: 2, h: 10 }).at([4, 4, -1]));
          if (p.boom) throw new Error("boom");
          return s;
        },
      },
    },
  };
  const run = (params) => {
    const post = vi.fn();
    return handle(k, flaky, { type: "generate", subparts: ["a"], view: "v", params }, post).then(() => post);
  };

  const post1 = await run({ boom: true });
  expect(post1.mock.calls.some(([m]) => m.type === "error")).toBe(true);

  k.resetCacheStats();
  const post2 = await run({ boom: false });
  const msg = post2.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
  expect(msg.meshes[0].triangles).toBeGreaterThan(0);
  expect(msg.cache.hits).toBeGreaterThan(0); // the failed build committed the cut before throwing
});

test("a function-form edge selector opts its fillet out of caching (closures can capture params invisibly)", async () => {
  const fnSelector = {
    defaults: { w: 10 },
    views: { v: { label: "V" } },
    parts: {
      a: {
        views: ["v"],
        build: (k2, p) =>
          k2.box({ min: [0, 0, 0], max: [p.w, 10, 5] }).fillet(1, (e) => e.inDirection("Z")),
      },
    },
  };
  await gen(fnSelector, { w: 10 });
  k.resetCacheStats();
  const msg = await gen(fnSelector, { w: 10 }); // identical params…
  expect(msg.cache.misses).toBeGreaterThan(0);  // …but the function-selector fillet must not be trusted to a hash
});
