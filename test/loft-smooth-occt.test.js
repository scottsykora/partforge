// OCCT-only file (vitest isolates per file; never boot Manifold here). loftSmooth's
// B-rep path lofts the SPARSE control wires with the native smooth skin
// (ruled:false) — the spike showed the densified-wire alternative is both slow
// (23 s at 32×96) and abort-prone (48×128), so speed here is a contract, not a nicety.
// Parity: same shared anchor literal as test/loft-smooth-manifold.test.js.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import propeller from "../src/parts/propeller.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);
const BULGE = [
  { polygon: ngon(24, 10), z: 0 },
  { polygon: ngon(24, 14), z: 15 },
  { polygon: ngon(24, 10), z: 30 },
];

test("B-rep path: positive volume in the same band as the mesh backend", () => {
  const s = k.loftSmooth({ sections: BULGE });
  const v = s.volume();
  expect(v).toBeGreaterThan(Math.PI * 10 * 10 * 30 * 0.95);
  expect(v).toBeLessThan(Math.PI * 14 * 14 * 30);
});

test("high density stays fast — the control-wire path, not the dense-wire path", () => {
  const t0 = Date.now();
  const s = k.loftSmooth({ sections: BULGE, stations: 48, samples: 128 });
  expect(s.volume()).toBeGreaterThan(0);
  expect(Date.now() - t0).toBeLessThan(5000);   // spike measured ~0.2 s; dense wires ABORTED here
});

test("STEP export of a loftSmooth solid succeeds", async () => {
  const step = await k.toSTEP([{ name: "bulge", solid: k.loftSmooth({ sections: BULGE }) }]);
  expect(step.byteLength).toBeGreaterThan(1000);
});

test("parity anchor: propeller reference part volume (shared literal with the Manifold file)", () => {
  const PARITY_CM3 = 22.85;                        // same literal as loft-smooth-manifold.test.js
  const v = propeller.parts.propeller.build(k, propeller.defaults).volume() / 1000;
  expect(v).toBeGreaterThan(PARITY_CM3 * 0.98);
  expect(v).toBeLessThan(PARITY_CM3 * 1.02);
}, 60_000);
