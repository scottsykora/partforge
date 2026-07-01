import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../../src/testing.js";
import { assemblyOverlaps } from "../../src/framework/assembly.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// Two 2×2×2 boxes; `gap` slides part b along +X. gap 0 → they just touch (faces at
// x=2), gap 1 → they overlap by a 1×2×2 = 4 mm³ slab.
const twoBoxes = {
  defaults: { gap: 0 },
  parts: {
    a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [2, 2, 2]) },
    b: { views: ["v"], build: (kk, p) => kk.box([0, 0, 0], [2, 2, 2]).translate([2 - p.gap, 0, 0]) },
  },
  views: { v: {} },
};

test("flags a pair whose intersection volume exceeds the tolerance", () => {
  const o = assemblyOverlaps(k, twoBoxes, "v", { gap: 1 });
  expect(o).toHaveLength(1);
  expect(o[0]).toMatchObject({ a: "a", b: "b" });
  expect(o[0].volume).toBeCloseTo(4, 1);
});

test("ignores parts that only touch (no interpenetration)", () => {
  expect(assemblyOverlaps(k, twoBoxes, "v", { gap: 0 })).toEqual([]);
});
