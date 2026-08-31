// OCCT only — its own file, both because the two WASM kernels may not boot in one
// process and because `vi.mock` is file-global here: this file deliberately makes
// the STL writer emit a HOLED shell, which no other test may see.
//
// Pins the watertightness gate in stlBufferToShape. OCCT's MakeSolid will build a
// "solid" from an open shell without complaint, and neither of the two obvious
// checks catches it: `MakeSolid.IsDone()` is true for a holed shell (and true for
// a maker with nothing added at all), and a positive-volume test passes too — a
// shell with 40 triangles removed still measures positive volume, ~3% low. Only
// `BRep_Tool.IsClosed_1` on the UPGRADED SHELL, before MakeSolid, answers
// correctly. Delete the guard and this test fails, which is the point.
import { test, expect, vi, beforeAll } from "vitest";

// Drop 40 triangles from the end of the index buffer — a real hole in an
// otherwise valid binary STL, produced by the real writer.
const holed = { on: false };
vi.mock("../src/framework/geometry/mesh-stl.js", async (importOriginal) => {
  const real = await importOriginal();
  return { meshToStl: (positions, indices) => real.meshToStl(positions, holed.on ? indices.slice(0, indices.length - 120) : indices) };
});

const { bootOcctKernel } = await import("../src/testing/occt.js");

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

// 32x32 so there are comfortably more than 40 triangles to remove.
const ramp = (n = 32) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((x / (n - 1)) * 65535);
  return { width: n, height: n, data };
};
const opts = { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 };

test("a non-watertight shell is rejected with the author-facing message", () => {
  holed.on = true;
  try {
    expect(() => k.heightfield(ramp(), opts)).toThrow(/could not sew \d+ triangles into a B-rep solid/);
    expect(() => k.heightfield(ramp(), opts)).toThrow(/not watertight/);
    expect(() => k.heightfield(ramp(), opts)).toThrow(/Raise `pitch`/);
  } finally { holed.on = false; }
}, 120000);

test("the same build with the mesh intact still sews", () => {
  holed.on = false;
  expect(k.heightfield(ramp(), opts).volume()).toBeCloseTo(800, -2);
}, 120000);
