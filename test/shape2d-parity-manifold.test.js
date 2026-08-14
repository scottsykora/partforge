// Cross-backend identity (Manifold half). Shape2D's boolean/query surface
// (union/cut/intersect/toContours/...) is pure JS over the shared contour IR
// (paper.js booleans) — no backend WASM involved — so a boolean chain's
// toContours() output is backend-identical BY CONSTRUCTION, not just close.
// This pins that as an exact `toEqual` golden-fixture assertion. The OCCT
// half (test/shape2d-parity-occt.test.js) asserts the SAME chain against the
// SAME fixture; the two files never boot both kernels in one process.
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { A, B, C } from "./helpers/shape2d-golden-input.js";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/shape2d-boolean-golden.json", import.meta.url), "utf8"),
);

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("boolean chain matches the shared-engine golden result exactly (Manifold)", () => {
  const out = k.shape2d(A).union(k.shape2d(B)).cut(k.shape2d(C)).toContours();
  expect(out).toEqual(golden);
});
