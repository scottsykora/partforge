import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("shell hollows a box inward, keeping outer dimensions", () => {
  const solidV = k.box([0, 0, 0], [20, 20, 20]).volume(); // 8000
  const cup = k.box([0, 0, 0], [20, 20, 20]).shell(2, { inPlane: "XY", at: 20 }); // open top
  const v = cup.volume();
  expect(v).toBeLessThan(solidV);        // material removed
  expect(v).toBeGreaterThan(1000);       // a wall remains (not vanished)
  // outer footprint unchanged
  expect(cup.boundingBox().size[0]).toBeCloseTo(20, 1);
  expect(cup.boundingBox().size[1]).toBeCloseTo(20, 1);
  expect(cup.toMesh().triangles).toBeGreaterThan(0);
});

test("shell requires openFaces", () => {
  expect(() => k.box([0, 0, 0], [10, 10, 10]).shell(1)).toThrow(/openFaces/);
});
