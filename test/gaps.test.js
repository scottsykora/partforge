import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, buildView, assemblyGaps, meshGaps } from "../src/testing.js";
import gapPart from "./fixtures/gap-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("assemblyGaps reports the 0.2mm near miss with a sensible location", () => {
  const gaps = assemblyGaps(k, gapPart, "v"); // defaults: gap 0.2
  expect(gaps).toHaveLength(1);
  expect(gaps[0].a).toBe("left");
  expect(gaps[0].b).toBe("right");
  expect(gaps[0].distance).toBeCloseTo(0.2, 5);
  expect(gaps[0].at[0]).toBeCloseTo(10.1, 4);       // between the facing faces
  expect(gaps[0].at[1]).toBeGreaterThanOrEqual(0);  // on the shared face footprint
  expect(gaps[0].at[1]).toBeLessThanOrEqual(10);
});

test("a 5mm separation is not a near miss", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: 5 })).toEqual([]);
});

test("touching (gap 0) is contact, not a near miss", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: 0 })).toEqual([]);
});

test("interpenetration is not a near miss (the overlap check owns it)", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: -1 })).toEqual([]);
});

test("threshold is configurable", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: 0.7 })).toEqual([]); // ≥ default 0.5
  expect(assemblyGaps(k, gapPart, "v", { gap: 0.7 }, { threshold: 1 })).toHaveLength(1);
});

test("meshGaps returns raw distances for every pair (no threshold)", () => {
  const built = buildView(k, gapPart, "v", { gap: 3 });
  const gaps = meshGaps(built);
  expect(gaps).toHaveLength(1);
  expect(gaps[0].distance).toBeCloseTo(3, 5);
  k.cleanup?.();
});
