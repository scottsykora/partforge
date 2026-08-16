import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { parse3MF } from "../src/framework/geometry/threemf-parse.js";
import { meshTo3MF } from "../src/framework/geometry/threemf.js";

const QUAD = { // unit square, two triangles
  name: "q",
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
};

describe("parse3MF", () => {
  it("round-trips the writer", () => {
    const { positions, indices } = parse3MF(meshTo3MF([QUAD]));
    expect(indices.length).toBe(6);
    expect(positions.length).toBe(12);
    expect(positions[3]).toBeCloseTo(1);
  });

  it("scales non-mm units to mm", () => {
    // Take the writer's output, unzip it (fflate), rewrite unit="millimeter" ->
    // unit="centimeter" in the model XML, rezip, and confirm every coordinate
    // comes back scaled by 10 (1 cm = 10 mm).
    const buf = meshTo3MF([QUAD]);
    const files = unzipSync(new Uint8Array(buf));
    const modelPath = Object.keys(files).find((f) => f.toLowerCase().endsWith(".model"));
    const xml = new TextDecoder().decode(files[modelPath]).replace('unit="millimeter"', 'unit="centimeter"');
    files[modelPath] = strToU8(xml);
    const rezipped = zipSync(files);

    const { positions } = parse3MF(rezipped);
    expect(positions[3]).toBeCloseTo(10);
    expect(positions[6]).toBeCloseTo(10);
    expect(positions[7]).toBeCloseTo(10);
  });

  it("applies a build-item transform (row-major 4x3, translation in the last row)", () => {
    // Hand-written model XML (not produced by the writer, which never emits a
    // transform) so the parser's matrix convention can be checked directly:
    // scale x2 on the diagonal, plus a translation, applied to a single point.
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" type="model" name="p"><mesh><vertices>' +
      '<vertex x="1" y="2" z="3"/><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      "</vertices><triangles>" +
      '<triangle v1="0" v2="1" v3="2"/>' +
      "</triangles></mesh></object></resources>" +
      '<build><item objectid="1" transform="2 0 0 0 2 0 0 0 2 10 20 30"/></build>' +
      "</model>";
    const files = {
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
      ),
      "3D/3dmodel.model": strToU8(xml),
    };
    const zip = zipSync(files);

    const { positions } = parse3MF(zip);
    // vertex (1,2,3) * diag(2,2,2) + (10,20,30) = (12, 24, 36)
    expect(positions[0]).toBeCloseTo(12);
    expect(positions[1]).toBeCloseTo(24);
    expect(positions[2]).toBeCloseTo(36);
  });

  it("throws when no 3D model part exists", () => {
    expect(() => parse3MF(new TextEncoder().encode("PK\x03\x04garbage"))).toThrow(/3mf/i);
  });
});
