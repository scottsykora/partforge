// OCCT twin of test/extrude-bevel.test.js — the bevel desugars at the shared
// front, so the identical composition must hold on the exact kernel (own file:
// the two WASM kernels must not boot in one process).
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const SQUARE = [[0, 0], [20, 0], [20, 20], [0, 20]];
const H = 10;
const maxRemoval = (c) => (80 * c * c) / 2; // per rim; see the Manifold twin

test("bevel removes rim material within the same analytic envelope as Manifold", () => {
  const plain = k.extrude({ profile: SQUARE, h: H }).volume();
  const beveled = k.extrude({ profile: SQUARE, h: H, bevel: 2 });
  const removed = plain - beveled.volume();
  expect(removed).toBeGreaterThan(0.5 * 2 * maxRemoval(2));
  expect(removed).toBeLessThanOrEqual(2 * maxRemoval(2) + 1e-6);
  expect(beveled.toMesh().triangles).toBeGreaterThan(0);
});

test("per-rim bevel preserves the z extent on OCCT too", () => {
  const s = k.extrude({ profile: SQUARE, h: H, bevel: { top: 2 } });
  const bb = s.boundingBox();
  expect(bb.min[2]).toBeCloseTo(0, 4);
  expect(bb.max[2]).toBeCloseTo(H, 4);
});
