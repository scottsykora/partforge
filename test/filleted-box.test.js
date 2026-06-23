import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { buildView } from "../src/testing/build.js";
import part from "../src/parts/filleted-box.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("filleted-box builds on OCCT and is smaller than the raw box", () => {
  const built = buildView(k, part, "box", {});
  expect(built).toHaveLength(1);
  const p = part.defaults;
  const rawBox = p.w * p.d * p.h;
  expect(built[0].solid.volume()).toBeLessThan(rawBox);   // fillet + bore removed material (chamfer off by default)
  expect(built[0].mesh.triangles).toBeGreaterThan(0);
});
