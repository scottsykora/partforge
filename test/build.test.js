import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { buildView } from "../src/testing/build.js";
import part from "../src/parts/demo.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("buildView returns one live solid + mesh for the demo spacer view", () => {
  const built = buildView(k, part, "spacer");
  expect(built).toHaveLength(1);
  expect(built[0].name).toBe("spacer");
  expect(built[0].mesh.triangles).toBeGreaterThan(0);
  // buildView must NOT cleanup — the solid is still live, so its exact volume reads
  expect(built[0].solid.volume()).toBeGreaterThan(0);
});
