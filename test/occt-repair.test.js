// Unit tests for the OCCT failure-recovery helpers — pure logic, no OCCT boot.
// (The chamfer binary-search integration path is covered by the OCCT test files.)
import { expect, test, vi } from "vitest";
import { isClosedSolid, createOcctRepair } from "../src/framework/geometry/occt-repair.js";

// A fake replicad shape is anything with .mesh() → { vertices (flat), triangles (flat) }.
const shapeOf = (vertices, triangles) => ({ mesh: () => ({ vertices, triangles }) });

const TETRA_VERTS = [0, 0, 0, /*v0*/ 1, 0, 0, /*v1*/ 0, 1, 0, /*v2*/ 0, 0, 1 /*v3*/];

test("a closed tetrahedron is a closed solid (every edge shared by two triangles)", () => {
  const closed = shapeOf(TETRA_VERTS, [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  expect(isClosedSolid(closed)).toBe(true);
});

test("an open surface (missing face) is not a closed solid", () => {
  const open = shapeOf(TETRA_VERTS, [0, 1, 2, 0, 1, 3, 0, 2, 3]); // face 1-2-3 missing
  expect(isClosedSolid(open)).toBe(false);
});

test("coincident vertices are welded before the edge count (OCCT meshes faces separately)", () => {
  // v4 duplicates v0's position; one face references the duplicate. Without welding
  // the mesh looks open; welded by position it is the same closed tetrahedron.
  const verts = [...TETRA_VERTS, 0, 0, 0 /* v4 == v0 */];
  const welded = shapeOf(verts, [0, 1, 2, 4, 1, 3, 0, 2, 3, 1, 2, 3]);
  expect(isClosedSolid(welded)).toBe(true);
});

test("safeOp returns the op's result when it yields real volume", () => {
  const { safeOp } = createOcctRepair((s) => s.vol);
  const backup = { marker: "backup", delete: vi.fn() };
  const shape = { clone: () => backup };
  const out = safeOp(shape, () => ({ vol: 5, marker: "result" }), "fillet(1)");
  expect(out.marker).toBe("result");
  expect(backup.delete).toHaveBeenCalled(); // the unused backup is freed
});

test("safeOp falls back to the original when the op empties the solid or throws", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { safeOp } = createOcctRepair((s) => s.vol);
  const shape = { clone: () => ({ marker: "backup" }) };
  const emptied = safeOp(shape, () => ({ vol: 0, delete: vi.fn() }), "fillet(9)");
  expect(emptied.marker).toBe("backup");
  const threw = safeOp(shape, () => { throw new Error("BRepFilletAPI failed"); }, "fillet(9)");
  expect(threw.marker).toBe("backup");
  expect(warn).toHaveBeenCalledTimes(2); // both skips are discoverable in the console
  warn.mockRestore();
});
