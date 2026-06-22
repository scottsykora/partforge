import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import occtVolumes from "./fixtures/occt-volumes.json";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { buildSubPart } from "../src/parts/drum/bodies.js";
import { meshVolume, bboxSize } from "./helpers.js";

let k;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  k = createManifoldKernel(wasm, { quality: "preview" });
});

// Volume + bbox parity catches scale/placement drift. Handedness/mirroring can
// still pass these — the ?backend=occt visual A/B (Task 10) is the handedness gate.
for (const name of ["small", "big"]) {
  test(`Manifold ${name} drum matches OCCT (volume 1.5%, bbox 2%)`, () => {
    const m = buildSubPart(k, name, {}).toMesh();
    const v = meshVolume(m.positions, m.indices);
    const size = bboxSize(m.positions);
    const volDiff = Math.abs(v - occtVolumes[name].volume) / occtVolumes[name].volume;
    const occtSize = occtVolumes[name].size;
    console.log(`  ${name}: Manifold vol=${v.toFixed(1)} (OCCT=${occtVolumes[name].volume.toFixed(1)}, diff=${(volDiff*100).toFixed(2)}%)`);
    for (let a = 0; a < 3; a++) {
      const axisDiff = Math.abs(size[a] - occtSize[a]) / occtSize[a];
      console.log(`    axis[${a}]: Manifold=${size[a].toFixed(2)}, OCCT=${occtSize[a].toFixed(2)}, diff=${(axisDiff*100).toFixed(2)}%`);
    }
    expect(volDiff).toBeLessThan(0.015);
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(size[a] - occtSize[a]) / occtSize[a]).toBeLessThan(0.02);
    }
  });
}

test("Manifold block builds and is non-empty (OCCT can't mesh it headless)", () => {
  expect(buildSubPart(k, "block", {}).toMesh().triangles).toBeGreaterThan(0);
});
