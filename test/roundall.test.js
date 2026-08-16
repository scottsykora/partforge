// Public-API integration for Solid.roundAll on the Manifold backend. The raw
// morphology numbers live in test/mesh-roundall.test.js; this file covers the
// contract seams: calling conventions, identity, caching, and routing.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { detectBackend } from "../src/framework/backend-select.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const box = () => k.box({ min: [0, 0, 0], max: [30, 20, 10] });

test("scalar and options forms agree (and hit the same cache entry)", () => {
  const a = box().roundAll(2);
  const b = box().roundAll({ r: 2 });
  expect(a.volume()).toBeCloseTo(b.volume(), 6);
  expect(a.volume()).toBeGreaterThan(5700);
  expect(a.volume()).toBeLessThan(5960);
});

test("roundAll(0) is the identity on the mesh class", () => {
  const s = box().roundAll(0);
  expect(s.volume()).toBeCloseTo(6000, 3);
});

test("options form rejects unknown keys", () => {
  expect(() => box().roundAll({ r: 2, edges: "all" })).toThrow(/roundAll/);
});

test("a part using roundAll stays on manifold", () => {
  const part = {
    defaults: {}, views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }).roundAll(2) } },
  };
  expect(detectBackend(part)).toBe("manifold");
});
