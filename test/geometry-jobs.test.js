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

test("viewParts includes block only when tensioner pockets are on", () => {
  expect(viewParts("both", { tensioner_pocket_depth: 7 })).toEqual(["small", "big", "block"]);
  expect(viewParts("both", { tensioner_pocket_depth: 0 })).toEqual(["small", "big"]);
});
