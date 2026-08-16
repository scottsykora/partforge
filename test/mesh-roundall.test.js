// Direct tests for the Minkowski close-then-open module. Boots its own wasm
// instance (same idiom as the module's only production caller) because
// bootManifoldKernel does not expose the wasm module and sphere segs here are
// radius-scaled, not SEGS[quality].
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { meshRoundAll, roundAllSegs } from "../src/framework/geometry/mesh-roundall.js";
import { meshVolume, bboxSize } from "../src/framework/oracle/mesh.js";

let wasm, k;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
  k = createManifoldKernel(wasm, { quality: "preview" });
});

const meshOf = (m) => {
  const g = m.getMesh();
  const n = g.vertProperties.length / g.numProp;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) positions[i * 3 + c] = g.vertProperties[i * g.numProp + c];
  return { positions, indices: Uint32Array.from(g.triVerts) };
};

test("segs scale with radius and quality, clamped to [12, 64]", () => {
  expect(roundAllSegs(2, "preview")).toBe(15);  // sagitta ≤ 0.05mm at r=2
  expect(roundAllSegs(2, "print")).toBe(32);    // sagitta ≤ 0.01mm at r=2
  expect(roundAllSegs(0.04, "preview")).toBe(12); // r ≤ tol → floor
  expect(roundAllSegs(200, "print")).toBe(64);    // ceiling
});

test("rounds a box: volume drops by the edge terms, bbox and genus are preserved", () => {
  const box = k.box({ min: [0, 0, 0], max: [30, 20, 10] });
  const out = meshRoundAll(wasm, box._m, 2, "preview");
  const { positions, indices } = meshOf(out);
  const vol = meshVolume(positions, indices);
  // Spike references: 5772.6 (12 segs) … 5800.1 (32 segs). Formula gives 15 segs.
  expect(vol).toBeGreaterThan(5700);
  expect(vol).toBeLessThan(5960);
  const size = bboxSize(positions);
  for (const [i, want] of [[0, 30], [1, 20], [2, 10]])
    expect(Math.abs(size[i] - want)).toBeLessThan(0.05); // faces stay in place
  expect(out.genus()).toBe(0);
  out.delete();
});

test("consumes sub-radius features: thin rib melts, small hole seals", () => {
  const base = k.box({ min: [0, 0, 0], max: [30, 20, 10] })
    .union(k.box({ min: [5, 9.5, 10], max: [25, 10.5, 18] }))       // 1mm rib, 8 tall
    .cut(k.cylinder({ d: 2, h: 14 }).translate([24, 15, -2]));       // d=2 through-hole
  expect(base._m.genus()).toBe(1); // the hole
  const out = meshRoundAll(wasm, base._m, 2, "preview");
  const { positions, indices } = meshOf(out);
  expect(out.genus()).toBe(0);                    // hole sealed
  expect(bboxSize(positions)[2]).toBeLessThan(11.5); // rib gone (base-fillet remnant ≤ ~1mm is correct morphology)
  const vol = meshVolume(positions, indices);
  expect(vol).toBeGreaterThan(5700);
  expect(vol).toBeLessThan(6000); // spike reference 5827.3–5847.6
  out.delete();
});

test("rejects non-positive and non-finite radii", () => {
  const box = k.box({ min: [0, 0, 0], max: [1, 1, 1] });
  for (const bad of [-1, 0, NaN, Infinity])
    expect(() => meshRoundAll(wasm, box._m, bad, "preview")).toThrow(/finite number > 0/);
});
