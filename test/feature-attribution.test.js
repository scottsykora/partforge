// Pure classification math for OCCT feature labels: does a face group's sampled
// triangle centroids lie on a labeled solid's (coarsely meshed) surface?
import { expect, test } from "vitest";
import { classifyFaceGroups, pointTriDist } from "../src/framework/geometry/feature-attribution.js";

test("pointTriDist: interior projection, edge, and vertex cases", () => {
  const a = [0, 0, 0], b = [4, 0, 0], c = [0, 4, 0];
  expect(pointTriDist([1, 1, 5], a, b, c)).toBeCloseTo(5, 6);   // above interior
  expect(pointTriDist([2, -3, 0], a, b, c)).toBeCloseTo(3, 6);  // beyond edge ab
  expect(pointTriDist([-3, -4, 0], a, b, c)).toBeCloseTo(5, 6); // beyond vertex a
});

// Two unit-ish quads in the z=0 and z=10 planes as one "result mesh" with two
// face groups; one soup covering only the z=10 quad.
const quad = (z) => ({
  vertices: [0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z],
  triangles: [0, 1, 2, 0, 2, 3],
});
const both = {
  vertices: [...quad(0).vertices, ...quad(10).vertices],
  triangles: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  faceGroups: [{ start: 0, count: 2, faceId: 1 }, { start: 2, count: 2, faceId: 2 }],
};

test("classifyFaceGroups attributes only faces on the labeled surface", () => {
  const { featureIds, features } = classifyFaceGroups(both, [{ label: "Top", ...quad(10) }]);
  expect(features).toEqual(["Top"]);
  expect([...featureIds]).toEqual([0, 0, 1, 1]);
});

test("most recently applied label wins a tie", () => {
  const { featureIds, features } = classifyFaceGroups(both, [
    { label: "First", ...quad(10) },
    { label: "Second", ...quad(10) },
  ]);
  expect(features[featureIds[2] - 1]).toBe("Second");
});

test("faceGroups counted in index units (start/count *3) are auto-detected", () => {
  const indexUnits = { ...both, faceGroups: [{ start: 0, count: 6, faceId: 1 }, { start: 6, count: 6, faceId: 2 }] };
  const { featureIds } = classifyFaceGroups(indexUnits, [{ label: "Top", ...quad(10) }]);
  expect([...featureIds]).toEqual([0, 0, 1, 1]);
});

test("no faceGroups → no attribution (graceful degrade)", () => {
  const out = classifyFaceGroups({ ...both, faceGroups: undefined }, [{ label: "Top", ...quad(10) }]);
  expect(out.featureIds).toBeUndefined();
});
