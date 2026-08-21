import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { boxMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

test("a box welds to 8 vertices and 12 triangles", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  expect(t.verts.length / 3).toBe(8);
  expect(t.tris.length / 3).toBe(12);
});

test("every box edge shared by two coplanar triangles is flat", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  const flat = t.edges.filter((e) => e.convexity === "flat");
  expect(flat.length).toBe(6);              // one diagonal per quad face
});

test("every box corner edge is convex at +90 degrees", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  const convex = t.edges.filter((e) => e.convexity === "convex");
  expect(convex.length).toBe(12);
  for (const e of convex) expect(e.dihedral).toBeCloseTo(Math.PI / 2, 6);
});

test("a bore produces concave edges and an outer wall produces convex ones", () => {
  const t = buildTopology(annulusPlate(10, 4, 3, 24));
  expect(t.edges.some((e) => e.convexity === "concave")).toBe(true);
  expect(t.edges.some((e) => e.convexity === "convex")).toBe(true);
});

test("a watertight mesh has no boundary edges", () => {
  const t = buildTopology(annulusPlate(10, 4, 3, 24));
  expect(t.edges.filter((e) => e.convexity === "boundary").length).toBe(0);
});
