import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("OCCT rotateAbout matches the same non-basis axis-angle ground truth", () => {
  const r = k.box({ min: [0, 0, 0], max: [2, 4, 6] }).rotateAbout({ axis: [1, 1, 0], deg: 90 });
  const b = r.boundingBox();
  expect(b.min[0]).toBeCloseTo(0, 2);      expect(b.max[0]).toBeCloseTo(7.2426, 2);
  expect(b.min[1]).toBeCloseTo(-4.2426, 2); expect(b.max[1]).toBeCloseTo(3, 2);
  expect(b.min[2]).toBeCloseTo(-1.4142, 2); expect(b.max[2]).toBeCloseTo(2.8284, 2);
});

test("OCCT solids are pre-sugared and along() matches the primitive rotation", () => {
  const s = k.box({ min: [0, 0, 0], max: [2, 4, 6] });
  expect(typeof s.along).toBe("function");
  const got = s.along("+Y");
  const want = k.box({ min: [0, 0, 0], max: [2, 4, 6] }).rotate(-90, [0, 0, 0], [1, 0, 0]);
  expect(got.volume()).toBeCloseTo(want.volume(), 4);
  const a = got.boundingBox(), b = want.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(a.min[i]).toBeCloseTo(b.min[i], 3);
    expect(a.max[i]).toBeCloseTo(b.max[i], 3);
  }
});
