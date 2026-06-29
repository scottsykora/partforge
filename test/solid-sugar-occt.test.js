import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("OCCT solids are pre-sugared and along() matches the primitive rotation", () => {
  const s = k.box([0, 0, 0], [2, 4, 6]);
  expect(typeof s.along).toBe("function");
  const got = s.along("+Y");
  const want = k.box([0, 0, 0], [2, 4, 6]).rotate(-90, [0, 0, 0], [1, 0, 0]);
  expect(got.volume()).toBeCloseTo(want.volume(), 4);
  const a = got.boundingBox(), b = want.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(a.min[i]).toBeCloseTo(b.min[i], 3);
    expect(a.max[i]).toBeCloseTo(b.max[i], 3);
  }
});
