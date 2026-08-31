import { describe, test, expect, beforeAll } from "vitest";
// The brief's sketch imported `createManifoldKernel` from this module — that name
// belongs to ../src/framework/geometry/manifold-backend.js (the raw backend
// factory, which takes a booted wasm module as its first argument). This test
// wants the Node-harness convenience wrapper that boots the WASM module itself,
// which src/testing/manifold.js exports as `bootManifoldKernel`.
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
// A 32x32 linear ramp in X: height should average exactly half of maxZ.
const ramp = (n = 32) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((x / (n - 1)) * 65535);
  return { width: n, height: n, data };
};

// A second, DIFFERENT inline grid at the same dimensions as ramp() — a linear
// ramp in Y instead of X. Same width/height/options as ramp(), different content:
// used to prove that two distinct inline grids never collide on the solid cache
// (Ruling F — the brief's own `digest = "inline"` sketch would make them collide).
const rampY = (n = 32) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((y / (n - 1)) * 65535);
  return { width: n, height: n, data };
};

beforeAll(async () => { k = await bootManifoldKernel(); });

describe("heightfield on Manifold", () => {
  test("builds a watertight, genus-0 solid", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 });
    expect(s.volume()).toBeGreaterThan(0);
    if (typeof s.genus === "function") expect(s.genus()).toBe(0);
  });

  test("volume matches the analytic slab + mean relief", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 0.5 });
    // 20*20*1 base + 20*20*(mean of a 0..2 ramp = 1)
    expect(s.volume()).toBeCloseTo(400 * 1 + 400 * 1, -1);
  });

  test("a registered image is addressable by name", async () => {
    const g = ramp(16);
    await k._registerImage({ name: "relief", digest: "d1", width: g.width, height: g.height, data: g.data });
    expect(k._imageDigest("relief")).toBe("d1");
    expect(k.heightfield("relief", { w: 10, d: 10, base: 1, maxZ: 1, pitch: 1 }).volume()).toBeGreaterThan(0);
  });

  // _pruneImages against the REAL backend, not jobs.js's fakeImageKernel
  // reimplementation (test/images-jobs.test.js only exercises the fake). This
  // is what jobs.js actually calls when a picked image is cleared or a
  // worker-rebind lands on a different part reusing the same declared name.
  test("_pruneImages drops a stale name and leaves the rest alone on the real kernel", async () => {
    const g = ramp(8);
    await k._registerImage({ name: "prune-a", digest: "pa", width: g.width, height: g.height, data: g.data });
    await k._registerImage({ name: "prune-b", digest: "pb", width: g.width, height: g.height, data: g.data });
    expect(k._imageDigest("prune-a")).toBe("pa");
    expect(k._imageDigest("prune-b")).toBe("pb");
    k._pruneImages(new Set(["prune-b"]));
    expect(k._imageDigest("prune-a")).toBeUndefined();
    expect(k._imageDigest("prune-b")).toBe("pb");
    expect(() => k.heightfield("prune-a", { w: 10, d: 10, base: 1, maxZ: 1, pitch: 1 }))
      .toThrow(/unknown image "prune-a"/);
  });

  // Registered images DO go through the ordinary cached() boundary-op path
  // (unlike inline grids, which deliberately bypass it — see the test below).
  // A regression that made registered images uncached would be silent
  // otherwise: correctness intact, only speed lost, nothing failing. Pin it.
  test("a registered image's second identical build hits the solid cache", async () => {
    const g = ramp(16);
    await k._registerImage({ name: "relief2", digest: "d2", width: g.width, height: g.height, data: g.data });
    const o = { w: 10, d: 10, base: 1, maxZ: 1, pitch: 1 };
    k.beginSubPart("heightfield-cache-hit-probe");
    k.heightfield("relief2", o);
    k.endSubPart();
    k.resetCacheStats();
    // Same sub-part name, same image, same options: solid-cache.js's `lookup`
    // adopts the previous round's entry from `prev` into `active` on a hash
    // match — a hit, not a rebuild.
    k.beginSubPart("heightfield-cache-hit-probe");
    k.heightfield("relief2", o);
    k.endSubPart();
    expect(k.cacheStats()).toEqual({ hits: 1, misses: 0 });
  });

  test("an undeclared name throws naming the op", () => {
    expect(() => k.heightfield("nope", { w: 10, d: 10 })).toThrow(/heightfield.*"nope"/);
  });

  test("maxZ scales volume linearly above the base", () => {
    const o = { w: 20, d: 20, base: 1, pitch: 1 };
    const v1 = k.heightfield(ramp(), { ...o, maxZ: 2 }).volume();
    const v2 = k.heightfield(ramp(), { ...o, maxZ: 4 }).volume();
    expect(v2 - 400).toBeCloseTo((v1 - 400) * 2, -1);
  });

  test("a pitch clamp reaches takeBuildWarnings", () => {
    k.takeBuildWarnings?.();
    k.heightfield(ramp(), { w: 400, d: 400, base: 1, maxZ: 1, pitch: 0.01 });
    expect((k.takeBuildWarnings?.() ?? []).join(" ")).toMatch(/clamped/);
  });

  // Ruling F: an inline grid carries no content digest, so it must NOT be keyed
  // into the solid cache. Two different inline grids built with IDENTICAL options
  // must produce DIFFERENT geometry — a ramp in X has all its relief on one side,
  // a ramp in Y on the other, so their volumes are equal (same mean) but their
  // shapes, and therefore which vertices sit where, differ. We assert on a
  // position-sensitive quantity (a cut-and-measure probe of one corner) rather
  // than volume, since volume alone is identical for these two ramps and would
  // not catch a same-cache-key collision on its own.
  //
  // The solid cache only memoizes INSIDE a beginSubPart/endSubPart round (see
  // solid-cache.js: `lookup` returns `make().value` uncached when no round is
  // open) — bracket both builds in one round so this test actually exercises the
  // cache the fix bypasses, not just the always-uncached default path.
  test("two different inline grids with identical options build different geometry", () => {
    k.beginSubPart("heightfield-cache-probe");
    const o = { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 };
    const sx = k.heightfield(ramp(), o);
    const sy = k.heightfield(rampY(), o);
    // Same footprint/base/maxZ -> same volume (both ramps average to the same
    // mean height), so a cache collision would NOT be caught by volume alone.
    expect(sx.volume()).toBeCloseTo(sy.volume(), 6);
    // Probe a corner where ramp() (X-varying) is near its minimum but rampY()
    // (Y-varying) is near its maximum: cut away everything except a thin sliver
    // at x ≈ -10 (the low-X edge of the 20mm footprint, centered at the origin)
    // and compare the remaining volumes, which must differ if the two solids
    // are genuinely different shapes.
    const clipX = sx.cut(k.box({ min: [-9, -10, -1], max: [10, 10, 5] })).volume();
    const clipY = sy.cut(k.box({ min: [-9, -10, -1], max: [10, 10, 5] })).volume();
    k.endSubPart();
    expect(Math.abs(clipX - clipY)).toBeGreaterThan(0.5);
  });
});
