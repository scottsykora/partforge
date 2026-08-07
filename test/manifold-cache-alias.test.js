// test/manifold-cache-alias.test.js
// A single-operand k.union([x]) returns x's own Manifold from the reduce, so the
// union's cache entry pins the SAME WASM object as x's own entry. Rebuilding after
// a dimension change evicts both old entries and disposed the shared object twice —
// embind's "Manifold instance already deleted" — killing the regenerate.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// A cap body whose feature list can be empty (ribs off) — the shape of real part
// code that unions a base solid with an optional feature array.
const cap = (od, h) => {
  const body = k
    .cylinder({ r: od / 2, h })
    .cut(k.cylinder({ r: od / 2 - 2, h }).translate([0, 0, 2])); // cached boundary op
  const ribs = []; // no ribs at this size → single-operand union
  return k.union([body, ...ribs]);
};

test("dimension change after a single-operand union rebuilds without double-free", () => {
  k.beginSubPart("cap");
  cap(30, 12).toMesh();
  k.endSubPart();
  k.cleanup();

  // Change a dimension: both stale entries (the cut and the union aliasing it)
  // are evicted in the same end() pass.
  k.beginSubPart("cap");
  const mesh = cap(32, 12).toMesh();
  expect(() => {
    k.endSubPart();
    k.cleanup();
  }).not.toThrow();
  expect(mesh.triangles).toBeGreaterThan(0);
});
