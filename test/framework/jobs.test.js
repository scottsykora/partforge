import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { unzipSync, strFromU8 } from "fflate";
import { createManifoldKernel } from "../../src/framework/geometry/manifold-backend.js";
import { handle } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("generate posts one mesh per requested sub-part", async () => {
  const posted = [];
  await handle(k, demo, { type: "generate", subparts: ["base"], view: "all", params: {} }, (m) => posted.push(m));
  const meshes = posted.find((m) => m.type === "meshes");
  expect(meshes.meshes.map((x) => x.name)).toEqual(["base"]);
  expect(meshes.meshes[0].triangles).toBeGreaterThan(0);
});

test("export-stl builds the view's enabled sub-parts and names them via export.name", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-stl", view: "all", params: { with_lid: 1 } }, (m) => posted.push(m));
  const dl = posted.find((m) => m.type === "download-parts");
  expect(dl.parts.map((p) => p.name)).toEqual(["base", "lid"]);
  expect(dl.parts[0].data.byteLength).toBeGreaterThan(0);
});

test("export-3mf posts one combined 3MF download with an object per enabled sub-part", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-3mf", view: "all", params: { with_lid: 1 } }, (m) => posted.push(m));
  const dl = posted.find((m) => m.type === "download");
  expect(dl.filename).toBe("all.3mf");
  expect(dl.mime).toBe("model/3mf");
  const model = strFromU8(unzipSync(new Uint8Array(dl.data))["3D/3dmodel.model"]);
  expect((model.match(/<object /g) || []).length).toBe(2); // base + lid
});

test("export-step emits a final 'writing STEP file' progress before the (unsupported) write", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-step", view: "base", params: {} }, (m) => posted.push(m));
  const phases = posted.filter((m) => m.type === "progress").map((m) => m.phase);
  expect(phases[phases.length - 1]).toBe("writing STEP file");
  // Manifold kernel can't write STEP → an error is posted (build + progress still ran)
  expect(posted.some((m) => m.type === "error")).toBe(true);
});
