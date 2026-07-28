// Pure rigid-pose math (no kernel boot): the OCCT backend's lazy translate/rotate
// steps composed into a mat4 and applied to cached mesh vertices.
import { expect, test } from "vitest";
import { composePose, transformPositions } from "../src/framework/geometry/pose.js";

const apply = (steps, p) => {
  const positions = Float32Array.from(p);
  transformPositions(positions, composePose(steps));
  return [...positions];
};

test("a translate step moves points by the vector", () => {
  expect(apply([{ t: "translate", v: [1, 2, 3] }], [0, 0, 0, 10, 0, 0]))
    .toEqual([1, 2, 3, 11, 2, 3]);
});

test("a rotate step spins about an axis through a center", () => {
  // 90° about Z through the origin: +X → +Y
  const [x, y, z] = apply([{ t: "rotate", deg: 90, center: [0, 0, 0], axis: [0, 0, 1] }], [1, 0, 0]);
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(1, 6);
  expect(z).toBeCloseTo(0, 6);
});

test("rotation about an off-origin center keeps the center fixed", () => {
  const [x, y, z] = apply([{ t: "rotate", deg: 180, center: [5, 5, 0], axis: [0, 0, 1] }], [5, 5, 0]);
  expect([x, y, z]).toEqual([5, 5, 0]);
});

test("steps compose in application order (earlier steps first)", () => {
  // origin → translate to [1,0,0] → rotate 90° about Z → [0,1,0].
  // (Rotate-then-translate would leave the origin at [1,0,0] instead.)
  const [x, y] = apply(
    [{ t: "translate", v: [1, 0, 0] }, { t: "rotate", deg: 90, center: [0, 0, 0], axis: [0, 0, 1] }],
    [0, 0, 0],
  );
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(1, 6);
});
