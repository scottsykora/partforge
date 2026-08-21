import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { ransacPatches } from "../src/framework/oracle/describe/ransac.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh, rotateMesh } from "./helpers/mesh-fixtures.js";

test("ransac recovers a plane from a disconnected face set", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  // Every face, offered with no adjacency hint at all — region growing's job is
  // done by connectivity, ransac's job is done by consensus.
  const all = [...topo.faceArea.keys()];
  const { patches } = ransacPatches(topo, all, 1e-3);
  expect(patches.length).toBeGreaterThanOrEqual(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
});

test("ransac recovers a plane from a disconnected face set, arbitrarily oriented", () => {
  // Same fixture, rotated by an ugly angle triple, so recovery is proven to not
  // depend on axis alignment (see rotateMesh's own comment on why that matters).
  const topo = buildTopology(rotateMesh(boxMesh(10, 20, 5), [17 * Math.PI / 180, 29 * Math.PI / 180, 53 * Math.PI / 180]));
  const all = [...topo.faceArea.keys()];
  const { patches } = ransacPatches(topo, all, 1e-3);
  expect(patches.length).toBeGreaterThanOrEqual(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
});

test("ransac is deterministic across runs", () => {
  const topo = buildTopology(cylinderMesh(4, 10, 32));
  const a = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  const b = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  expect(a.patches.map((p) => p.faces.length)).toEqual(b.patches.map((p) => p.faces.length));
});

test("ransac leaves faces it cannot explain in unassigned", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  const { patches, unassigned } = ransacPatches(topo, [0, 1], 1e-9);
  const claimed = patches.reduce((a, p) => a + p.faces.length, 0);
  expect(claimed + unassigned.length).toBe(2);
});

test("segment runs the mop-up and reports no unassigned faces on a box", () => {
  expect(segment(buildTopology(boxMesh(10, 20, 5))).unassigned.length).toBe(0);
});

test("segment runs the mop-up on an arbitrarily oriented box too", () => {
  const rotated = rotateMesh(boxMesh(10, 20, 5), [17 * Math.PI / 180, 29 * Math.PI / 180, 53 * Math.PI / 180]);
  expect(segment(buildTopology(rotated)).unassigned.length).toBe(0);
});
