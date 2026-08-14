import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("_offsetRegions grows a square and returns line-contour regions", () => {
  const sq = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, holes: [] };
  const out = k._offsetRegions([sq], 1, { corners: "sharp" });
  expect(out.length).toBe(1);
  expect(out[0].outer.segments.every((s) => !s.c1 && !s.via)).toBe(true);
});

test("_offsetRegions collapse throws the preserved message", () => {
  const sq = { outer: { start: [0, 0], segments: [{ to: [4, 0] }, { to: [4, 4] }, { to: [0, 4] }, { to: [0, 0] }] }, holes: [] };
  expect(() => k._offsetRegions([sq], -3, {})).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
});
