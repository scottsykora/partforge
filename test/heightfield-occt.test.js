// OCCT only — must stay in its own file; the two WASM kernels may not boot in
// one process.
//
// Deviations from the brief's sketch, all verified against the code:
//   - `bootOcctKernel()` returns the kernel DIRECTLY, not `{ kernel }`.
//   - `k.heightfield(...)` is SYNCHRONOUS (addendum Ruling B), like its Manifold
//     twin — `build(k, p, d)` is a synchronous pure function.
//   - `k.toSTEP` takes `[{ name, solid }]` (not `{ shape }`) and returns a
//     Promise<ArrayBuffer> (it is `exportSTEP(...).arrayBuffer()`).
// Grids are deliberately tiny: Task 1 measured OCCT sewing at ~0.4 ms/triangle,
// so a 16x16 image at pitch 2 (270 triangles) is the right size to prove the
// path without paying for it.
import { describe, test, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;

// A linear ramp in X: the top surface is planar, so the volume is exactly the
// analytic slab + mean relief.
const ramp = (n = 16) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((x / (n - 1)) * 65535);
  return { width: n, height: n, data };
};

// A second, DIFFERENT inline grid at the same dimensions — a ramp in Y instead of
// X. Same width/height and same options as ramp(), different content: the Ruling F
// cache-bypass probe below builds both and asserts they are not the same solid.
const rampY = (n = 16) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((y / (n - 1)) * 65535);
  return { width: n, height: n, data };
};

beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

describe("heightfield on OCCT", () => {
  test("sews into a solid with positive volume", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 });
    expect(s.volume()).toBeGreaterThan(0);
  }, 120000);

  test("volume is within tolerance of the analytic slab + mean relief", () => {
    // 20*20*1 base + 20*20*(mean of a 0..2 ramp = 1) = 800.
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 });
    expect(s.volume()).toBeCloseTo(800, -2);
  }, 120000);

  test("participates in a boolean", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 });
    const box = k.box({ min: [-5, -5, 0], max: [5, 5, 10] });
    expect(s.intersect(box).volume()).toBeGreaterThan(0);
  }, 180000);

  test("exports STEP", async () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 });
    const step = await k.toSTEP([{ name: "relief", solid: s }]);
    expect(step.byteLength).toBeGreaterThan(0);
    // A real STEP part 21 file, not an empty/aborted export.
    expect(new TextDecoder().decode(step.slice(0, 20))).toMatch(/^ISO-10303-21/);
  }, 180000);

  test("a registered image is addressable by name", async () => {
    const g = ramp();
    await k._registerImage({ name: "relief", digest: "d1", width: g.width, height: g.height, data: g.data });
    expect(k._imageDigest("relief")).toBe("d1");
    expect(k.heightfield("relief", { w: 10, d: 10, base: 1, maxZ: 1, pitch: 2 }).volume()).toBeGreaterThan(0);
  }, 120000);

  // Registered images DO go through the ordinary cached() boundary-op path
  // (unlike inline grids, which deliberately bypass it — see below). A regression
  // that made them uncached would be silent: correctness intact, only sewing time
  // lost, nothing failing. Pin it — sewing is by far the most expensive op here.
  test("a registered image's second identical build hits the solid cache", async () => {
    const g = ramp();
    await k._registerImage({ name: "relief2", digest: "d2", width: g.width, height: g.height, data: g.data });
    const o = { w: 10, d: 10, base: 1, maxZ: 1, pitch: 2 };
    k.beginSubPart("heightfield-cache-hit-probe");
    k.heightfield("relief2", o);
    k.endSubPart();
    k.resetCacheStats();
    k.beginSubPart("heightfield-cache-hit-probe");
    k.heightfield("relief2", o);
    k.endSubPart();
    expect(k.cacheStats()).toEqual({ hits: 1, misses: 0 });
  }, 120000);

  test("an undeclared name throws naming the op", () => {
    expect(() => k.heightfield("nope", { w: 10, d: 10 })).toThrow(/heightfield.*"nope"/);
  });

  // Ruling F: an inline grid carries no content digest, so it must NOT be keyed
  // into the solid cache, and the solid it returns must still carry a real content
  // fingerprint in its `_hash` — that hash feeds the DOWNSTREAM boolean cache keys
  // (`cut`/`union`), so bypassing the op-level cache alone is not sufficient.
  //
  // Two different inline grids at IDENTICAL options must build DIFFERENT geometry.
  // Their volumes are equal (both ramps have the same mean), so we assert on a
  // position-sensitive quantity instead: cut away everything but a thin sliver at
  // the low-X edge, where ramp() is near its minimum and rampY() sweeps its whole
  // range. The solid cache only memoizes INSIDE a beginSubPart/endSubPart round
  // (solid-cache.js), so both builds are bracketed in one round — otherwise the
  // test would exercise the always-uncached default path and prove nothing.
  test("two different inline grids with identical options build different geometry", () => {
    k.beginSubPart("heightfield-cache-probe");
    const o = { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 };
    const sx = k.heightfield(ramp(), o);
    const sy = k.heightfield(rampY(), o);
    expect(sx.volume()).toBeCloseTo(sy.volume(), 3);
    const tool = { min: [-9, -10, -1], max: [10, 10, 5] };
    const clipX = sx.cut(k.box(tool)).volume();
    const clipY = sy.cut(k.box(tool)).volume();
    k.endSubPart();
    expect(Math.abs(clipX - clipY)).toBeGreaterThan(0.5);
  }, 180000);

  // Cross-backend parity. The Manifold figure is asserted in
  // test/heightfield-manifold.test.js against the same analytic target; the two
  // backends consume byte-identical triangles, so any gap here is sewing /
  // tessellation, not grid math.
  test("volume agrees with the Manifold build within the contract's tolerance", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 });
    expect(Math.abs(s.volume() - 800) / 800).toBeLessThan(0.02);
  }, 180000);
});
