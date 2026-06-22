// Regression guards carried over from the retired geometry-jobs.test.js, retargeted
// at the generalized handle() + the drum PartDefinition. Manifold-only (no OCCT in
// this process). Covers: per-job WASM cleanup (no heap leak/double-free),
// per-feature export progress, and high-res STL export.
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../../src/framework/geometry/manifold-backend.js";
import { handle } from "../../src/framework/jobs.js";
import drum from "../../src/parts/drum.js";

let wasm, k;
beforeAll(async () => { wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

test("repeated generates with per-job cleanup never post an error (no leak/double-free)", async () => {
  for (let i = 0; i < 6; i++) {
    const posted = [];
    await handle(k, drum, { type: "generate", subparts: ["small", "big", "block"], view: "both", params: {} }, (m) => posted.push(m));
    expect(posted.some((p) => p.type === "error")).toBe(false);
    expect(posted.find((p) => p.type === "meshes").meshes).toHaveLength(3);
  }
});

test("export-step posts a progress message for each feature build stage", async () => {
  // build runs through the drum's per-feature onProgress before the (unsupported on
  // Manifold) STEP write; the final stage is always "writing STEP file".
  const posted = [];
  await handle(k, drum, { type: "export-step", view: "both", params: {} }, (m) => posted.push(m));
  const phases = posted.filter((p) => p.type === "progress").map((p) => p.phase);
  expect(phases).toContain("cutting big-drum grooves");
  expect(phases[phases.length - 1]).toBe("writing STEP file");
  expect(posted.some((p) => p.type === "error")).toBe(true);
});

test("export-stl meshes at print resolution — far denser than the live preview", async () => {
  const stlTris = (buf) => new DataView(buf).getUint32(80, true); // binary STL: tri count at byte 80
  const exportTris = async (kernel) => {
    let stl;
    await handle(kernel, drum, { type: "export-stl", view: "small", params: {} },
      (m) => { if (m.type === "download-parts") stl = m.parts[0].data; });
    return stlTris(stl);
  };
  const preview = await exportTris(createManifoldKernel(wasm, { quality: "preview" }));
  const print = await exportTris(createManifoldKernel(wasm, { quality: "print" }));
  expect(print).toBeGreaterThan(preview * 2.5);
});
