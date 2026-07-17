// test/compound-op.test.js
import { beforeAll, beforeEach, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { createProbeKernel } from "../src/framework/geometry/probe.js";
import { meshVolume } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
beforeEach(() => k.resetCacheStats());

test("boredCylinder removes the bore volume", () => {
  const solid = k.boredCylinder({ od: 10, h: 20, bore: 4 });
  const plain = k.cylinder({ r: 5, h: 20 });
  expect(meshVolume(solid.toMesh().positions)).toBeLessThan(meshVolume(plain.toMesh().positions));
});

test("boredCylinder is a single atomic cache node", () => {
  k.beginSubPart("a"); k.boredCylinder({ od: 10, h: 20, bore: 4 }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(1); // one node, not its internal cylinders+cut
  k.resetCacheStats();
  k.beginSubPart("a"); k.boredCylinder({ od: 10, h: 20, bore: 4 }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats()).toEqual({ hits: 1, misses: 0 }); // whole compound reused
});

test("the probe kernel records boredCylinder (so builds using it stay analyzable)", () => {
  const { kernel, used } = createProbeKernel();
  kernel.boredCylinder({ od: 10, h: 20, bore: 4 });
  expect(used.has("boredCylinder")).toBe(true);
});
