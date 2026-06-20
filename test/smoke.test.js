import { expect, test } from "vitest";
import Module from "manifold-3d";

test("manifold boots and makes a cylinder", async () => {
  const wasm = await Module();
  wasm.setup();
  const c = wasm.Manifold.cylinder(10, 5, 5, 64);
  expect(c.volume()).toBeGreaterThan(750); // π·25·10 ≈ 785, faceted
  expect(c.volume()).toBeLessThan(786);
});
