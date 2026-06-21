import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";
import { handle, viewParts } from "../src/geometry-jobs.js";

let k, wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

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

test("export-step posts a progress message for each feature build stage", async () => {
  // The OCCT geometry build is the slow part of a STEP export (~20 s). The worker
  // must surface per-feature progress so the UI doesn't look frozen on one label.
  // (Manifold can't write STEP, so toSTEP throws after the build — but the build,
  // and therefore the progress stream, runs first.)
  const posted = [];
  await handle(k, { type: "export-step", part: "both", params: {} }, (m) => posted.push(m));
  const phases = posted.filter((p) => p.type === "progress").map((p) => p.phase);
  // at least the big-drum groove field + the final STEP-write stage
  expect(phases).toContain("cutting big-drum grooves");
  expect(phases.length).toBeGreaterThanOrEqual(3);
  expect(phases[phases.length - 1]).toBe("writing STEP file");
});

test("export-stl meshes at print resolution — far denser than the live preview", async () => {
  // STL is a print mesh, so it must use the high-res 'print' tessellation, not the
  // coarse 'preview' segment counts the interactive view uses. (Manifold bakes
  // segment counts in at primitive creation, so the export must build with a
  // print-quality kernel — toSTL can't re-mesh after the fact.)
  const stlTris = (buf) => new DataView(buf).getUint32(80, true); // binary STL: tri count at byte 80
  const exportTris = async (kernel) => {
    let stl;
    await handle(kernel, { type: "export-stl", part: "small", params: {} },
      (m) => { if (m.type === "download-parts") stl = m.parts[0].data; });
    return stlTris(stl);
  };
  const preview = await exportTris(k);
  const print = await exportTris(createManifoldKernel(wasm, { quality: "print" }));
  expect(print).toBeGreaterThan(preview * 2.5);
});

test("viewParts includes block only when tensioner pockets are on", () => {
  expect(viewParts("both", { tensioner_pocket_depth: 7 })).toEqual(["small", "big", "block"]);
  expect(viewParts("both", { tensioner_pocket_depth: 0 })).toEqual(["small", "big"]);
});
