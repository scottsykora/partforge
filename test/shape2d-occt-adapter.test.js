import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("_offsetRegions on OCCT reads back curve-native contours (round corners are curves, not facet fans)", () => {
  const sq = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] }] }, holes: [] };
  const out = k._offsetRegions([sq], 2, { corners: "round" });
  expect(out.length).toBe(1);
  const segs = out[0].outer.segments;
  expect(segs.some((s) => s.c1)).toBe(true);              // rounded corners came back as cubics
  expect(segs.length).toBeLessThan(30);                   // NOT a 64-gon fan
});
