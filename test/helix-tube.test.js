import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { helixTube } from "../src/framework/geometry/helix-tube.js";

let wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

const params = { pathR: 20, profileR: 1, pitch: 4, turns: 3, z0: 0, lefthand: false };

test("tube is a valid watertight manifold (ofMesh does not throw)", () => {
  expect(() => helixTube(wasm, params)).not.toThrow();
});

test("volume matches the analytic swept-circle estimate within 5%", () => {
  const tube = helixTube(wasm, params);
  const arc = params.turns * Math.hypot(2 * Math.PI * params.pathR, params.pitch);
  const analytic = Math.PI * params.profileR ** 2 * arc;
  expect(Math.abs(tube.volume() - analytic) / analytic).toBeLessThan(0.05);
});

test("oriented outward: subtracting from a blank REMOVES material", () => {
  const blank = wasm.Manifold.cylinder(20, 25, 25, 128); // encloses the tube
  const cut = blank.subtract(helixTube(wasm, params));
  expect(cut.volume()).toBeLessThan(blank.volume());
});
