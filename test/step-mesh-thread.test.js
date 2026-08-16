// test/step-mesh-thread.test.js — Manifold in THIS process + OCCT in a worker_thread.
// This test doubles as the process-isolation spike: if it crashes, fall back to
// child_process.fork in step-mesh.js and record the finding in the plan/spec.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { tessellateStepAssets } from "../src/testing/step-mesh.js";

describe("node STEP crossover", () => {
  it("tessellates STEP in a thread while manifold runs here", async () => {
    const k = await bootManifoldKernel(); // manifold in the main isolate
    const bytes = readFileSync("test/fixtures/box-10mm.step");
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const meshes = await tessellateStepAssets([{ name: "ref", bytes: ab, digest: "dX" }]);
    const m = meshes.get("ref");
    expect(m.digest).toBe("dX");
    k._registerImport({ name: "ref", digest: "dX", positions: m.positions, indices: m.indices });
    expect(k.import("ref").volume()).toBeCloseTo(1000, 0);
  }, 180000);
  it("boot handles STEP imports transparently", async () => {
    const k2 = await bootManifoldKernel({ imports: { ref: new URL(`file://${process.cwd()}/test/fixtures/box-10mm.step`) } });
    expect(k2.import("ref").volume()).toBeCloseTo(1000, 0);
  }, 180000);
});
