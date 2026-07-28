import { describe, it, expect } from "vitest";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";

// One triangle in the z=0 plane, CCW seen from +z → outward normal +z.
const positions = new Float32Array([0,0,0,  1,0,0,  0,1,0]);
const indices = new Uint32Array([0,1,2]);

describe("meshToStl", () => {
  it("writes a valid binary STL for one triangle", () => {
    const ab = meshToStl(positions, indices);
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(ab.byteLength).toBe(84 + 1 * 50); // header+count + one facet
    const dv = new DataView(ab);
    expect(dv.getUint32(80, true)).toBe(1); // triangle count
    // facet normal at offset 84 is unit +z
    expect(dv.getFloat32(84, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(88, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(92, true)).toBeCloseTo(1, 5);
    // first vertex (offset 84+12) is (0,0,0)
    expect(dv.getFloat32(96, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(100, true)).toBeCloseTo(0, 5);
    expect(dv.getFloat32(104, true)).toBeCloseTo(0, 5);
  });

  it("sizes the buffer for N triangles", () => {
    const p = new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1]);
    const idx = new Uint32Array([0,1,2, 0,1,3]);
    const dv = new DataView(meshToStl(p, idx));
    expect(dv.getUint32(80, true)).toBe(2);
    expect(dv.buffer.byteLength).toBe(84 + 2 * 50);
  });

  it("normalizes a degenerate facet's normal to a finite vector (no NaN)", () => {
    // zero-area triangle → normal length 0; writer must not emit NaN
    const p = new Float32Array([0,0,0, 0,0,0, 0,0,0]);
    const dv = new DataView(meshToStl(p, new Uint32Array([0,1,2])));
    for (const off of [84, 88, 92]) expect(Number.isFinite(dv.getFloat32(off, true))).toBe(true);
  });
});
