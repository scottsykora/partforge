// Guardrail: a real non-drum part (src/parts/demo.js) drives the framework's
// generate + STL export with no drum knowledge involved. If the framework ever
// regrows a drum-specific assumption, this breaks.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../../src/testing.js";
import { handle, viewSubParts } from "../../src/framework/jobs.js";
import demo from "../../src/parts/demo.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("a non-drum part renders its sub-parts through the framework", async () => {
  expect(viewSubParts(demo, "spacer", {})).toEqual(["spacer"]);
  const posted = [];
  await handle(k, demo, { type: "generate", subparts: ["spacer"], view: "spacer", params: {} }, (m) => posted.push(m));
  const meshes = posted.find((m) => m.type === "meshes").meshes;
  expect(meshes.map((m) => m.name)).toEqual(["spacer"]);
  expect(meshes[0].triangles).toBeGreaterThan(0);
});

test("a non-drum part exports STL named by export.name", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-stl", view: "spacer", params: { flange_d: 16 } }, (m) => posted.push(m));
  const dl = posted.find((m) => m.type === "download-parts");
  expect(dl.parts.map((p) => p.name)).toEqual(["spacer"]);
  expect(dl.parts[0].data.byteLength).toBeGreaterThan(0);
});
