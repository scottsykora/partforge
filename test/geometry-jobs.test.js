import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";
import { handle, viewParts } from "../src/geometry-jobs.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

test("generate posts one mesh per requested sub-part", async () => {
  const posted = [];
  await handle(k, { type: "generate", subparts: ["small", "big"], params: {} }, (m) => posted.push(m));
  const meshes = posted.find((p) => p.type === "meshes");
  expect(meshes.meshes.map((x) => x.name).sort()).toEqual(["big", "small"]);
});

test("repeated generates with per-job cleanup never post an error (no leak/double-free)", async () => {
  // Each generate frees its WASM objects via kernel.cleanup(); regression guard
  // for the heap-exhaustion crash and the cleanup double-delete it once caused.
  for (let i = 0; i < 6; i++) {
    const posted = [];
    await handle(k, { type: "generate", subparts: ["small", "big", "block"], params: {} }, (m) => posted.push(m));
    expect(posted.some((p) => p.type === "error")).toBe(false);
    expect(posted.find((p) => p.type === "meshes").meshes).toHaveLength(3);
  }
});

test("viewParts includes block only when tensioner pockets are on", () => {
  expect(viewParts("both", { tensioner_pocket_depth: 7 })).toEqual(["small", "big", "block"]);
  expect(viewParts("both", { tensioner_pocket_depth: 0 })).toEqual(["small", "big"]);
});
