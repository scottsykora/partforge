import { beforeAll, expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { bootManifoldKernel } from "../../src/testing.js";
import { handle } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

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
  // Manifold toSTEP throws KernelCapabilityError → the accurate needs-occt signal
  // (build + progress still ran). Unreachable in the app: mount routes STEP to occt.
  expect(posted.some((m) => m.type === "needs-occt")).toBe(true);
});

test("generate posts its mesh buffers in the transfer list (zero-copy to the main thread)", async () => {
  const posted = [];
  await handle(k, demo, { type: "generate", subparts: ["base"], view: "all", params: {} },
    (m, transfer = []) => posted.push([m, transfer]));
  const [meshes, transfer] = posted.find(([m]) => m.type === "meshes");
  const m0 = meshes.meshes[0];
  expect(transfer).toContain(m0.positions.buffer);
  expect(transfer).toContain(m0.normals.buffer);
  if (m0.edges?.buffer) expect(transfer).toContain(m0.edges.buffer);
});

test("export posts carry their payload buffers in the transfer list", async () => {
  const posted = [];
  const post = (m, transfer = []) => posted.push([m, transfer]);
  await handle(k, demo, { type: "export-stl", view: "all", params: {} }, post);
  await handle(k, demo, { type: "export-3mf", view: "all", params: {} }, post);
  const [stl, stlTransfer] = posted.find(([m]) => m.type === "download-parts");
  expect(stlTransfer).toContain(stl.parts[0].data);
  const [dl, dlTransfer] = posted.find(([m]) => m.type === "download");
  expect(dlTransfer).toContain(dl.data);
});

test("a throwing derive posts an error instead of hanging the job", async () => {
  const bad = {
    defaults: { r: 4 },
    derive: () => { throw new Error("derive blew up"); },
    views: { all: { label: "All" } },
    parts: { base: { views: ["all"], build: (k2, p) => k2.cylinder({ r: p.r, h: 10 }) } },
  };
  const posted = [];
  await handle(k, bad, { type: "generate", subparts: ["base"], view: "all", params: {} }, (m) => posted.push(m));
  const err = posted.find((m) => m.type === "error");
  expect(err?.message).toMatch(/derive blew up/);
});
