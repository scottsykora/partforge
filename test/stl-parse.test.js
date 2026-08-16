import { describe, it, expect } from "vitest";
import { parseStl } from "../src/framework/geometry/stl-parse.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";

const TRI = { // one right triangle in the z=0 plane
  positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]),
  indices: Uint32Array.from([0, 1, 2]),
};

describe("parseStl", () => {
  it("round-trips the binary writer", () => {
    const bin = meshToStl(TRI.positions, TRI.indices);
    const { positions, indices } = parseStl(bin);
    expect(indices.length).toBe(3);
    expect([...positions]).toEqual([...TRI.positions]);
  });
  it("parses ascii STL", () => {
    const ascii = `solid tri
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid tri
`;
    const { positions, indices } = parseStl(new TextEncoder().encode(ascii));
    expect(indices.length).toBe(3);
    expect(positions[3]).toBe(10);
  });
  it("rejects a truncated binary file", () => {
    const bin = new Uint8Array(meshToStl(TRI.positions, TRI.indices)).slice(0, 100);
    expect(() => parseStl(bin)).toThrow(/truncated/i);
  });
});
