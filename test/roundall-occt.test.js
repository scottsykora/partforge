// OCCT side of roundAll: triple offset with the variant cascade. Reference
// volumes come from the design spike; the Manifold twin numbers live in
// test/mesh-roundall.test.js (the backends never boot in one process).
import { beforeAll, expect, test, vi } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { occtRoundAll } from "../src/framework/geometry/occt-roundall.js";

let k, replicad;
beforeAll(async () => {
  k = await bootOcctKernel();
  replicad = await import("replicad");
});

test("rounds a box within the parity band of the mesh result", () => {
  const box = k.box({ min: [0, 0, 0], max: [30, 20, 10] });
  const out = occtRoundAll(replicad, box._s, 2);
  const vol = replicad.measureVolume(out);
  expect(Math.abs(vol - 5803)).toBeLessThan(30); // spike: OCCT 5802.8, Manifold 5800.1
});

test("rounds an L-shape (concave seam) within the parity band", () => {
  const l = k.box({ min: [0, 0, 0], max: [30, 20, 10] })
    .union(k.box({ min: [0, 0, 10], max: [10, 20, 30] }));
  const out = occtRoundAll(replicad, l._s, 2);
  const vol = replicad.measureVolume(out);
  expect(Math.abs(vol - 9736)).toBeLessThan(40); // spike: OCCT 9736.5, Manifold 9732.8
});

test("feature-consuming radius skips whole with a warning, never emits garbage", () => {
  const featured = k.box({ min: [0, 0, 0], max: [30, 20, 10] })
    .union(k.box({ min: [5, 9.5, 10], max: [25, 10.5, 18] }))
    .cut(k.cylinder({ d: 2, h: 14 }).translate([24, 15, -2]));
  const before = replicad.measureVolume(featured._s);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const out = occtRoundAll(replicad, featured._s, 2);
    expect(replicad.measureVolume(out)).toBeCloseTo(before, 1); // unchanged clone
    expect(warn.mock.calls.some(([msg]) => String(msg).includes("roundall-skipped"))).toBe(true);
  } finally { warn.mockRestore(); }
});

test("rejects non-positive and non-finite radii", () => {
  const box = k.box({ min: [0, 0, 0], max: [1, 1, 1] });
  for (const bad of [-1, 0, NaN, Infinity])
    expect(() => occtRoundAll(replicad, box._s, bad)).toThrow(/finite number > 0/);
});
