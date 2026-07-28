// OCCT export bytes. OCCT boots alone (never with Manifold).
import { beforeAll, describe, it, expect } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

describe("OCCT toSTL", () => {
  it("returns an ArrayBuffer that parses as a binary STL (no Blob)", async () => {
    const s = k.box({ min: [0,0,0], max: [10,10,10] });
    const ab = await s.toSTL({ quality: "print" });
    expect(ab).toBeInstanceOf(ArrayBuffer);
    const dv = new DataView(ab);
    const n = dv.getUint32(80, true);
    expect(n).toBeGreaterThanOrEqual(12); // a box meshes to >= 12 triangles
    expect(ab.byteLength).toBe(84 + n * 50); // exact binary-STL size for n facets
  });
});
