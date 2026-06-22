import { expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { meshTo3MF } from "../../src/framework/geometry/threemf.js";

test("meshTo3MF packages each part's mesh into a valid 3MF (OPC zip)", () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]); // 4 verts
  const indices = new Uint32Array([0, 1, 2, 0, 1, 3]); // 2 triangles
  const buf = meshTo3MF([{ name: "thing", positions, indices }]);

  const files = unzipSync(new Uint8Array(buf));
  expect(Object.keys(files)).toEqual(
    expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"])
  );
  const model = strFromU8(files["3D/3dmodel.model"]);
  expect(model).toContain('unit="millimeter"');
  expect(model).toContain('name="thing"');
  expect((model.match(/<vertex /g) || []).length).toBe(4);
  expect((model.match(/<triangle /g) || []).length).toBe(2);
  expect((model.match(/<item /g) || []).length).toBe(1);
});

test("meshTo3MF bundles multiple parts as separate objects in one file", () => {
  const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const buf = meshTo3MF([{ name: "a", ...tri }, { name: "b", ...tri }]);
  const model = strFromU8(unzipSync(new Uint8Array(buf))["3D/3dmodel.model"]);
  expect((model.match(/<object /g) || []).length).toBe(2);
  expect((model.match(/<item /g) || []).length).toBe(2);
  expect(model).toContain('name="a"');
  expect(model).toContain('name="b"');
});
