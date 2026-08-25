// Manifold-side loftSmooth tests. Parity with OCCT is asserted the loft way (see
// test/loft-shape2d-occt.test.js's header): both backend files pin the SAME shared
// anchor at the same tolerance — here the propeller reference part's recorded
// volume, 22.85 cm³ ± 2% (loftSmooth is the screwSweep parity class: the backends
// interpolate across stations differently, so tolerance, not construction).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import propeller from "../src/parts/propeller.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);
const BULGE = [
  { polygon: ngon(24, 10), z: 0 },
  { polygon: ngon(24, 14), z: 15 },
  { polygon: ngon(24, 10), z: 30 },
];

test("loftSmooth of a 3-section bulge is a positive watertight solid in the expected band", () => {
  const s = k.loftSmooth({ sections: BULGE });
  const v = s.volume();
  // Bounded by the r=10 and r=14 cylinders (24-gon area factor ≈ 0.9886·πr²).
  expect(v).toBeGreaterThan(Math.PI * 10 * 10 * 30 * 0.95);
  expect(v).toBeLessThan(Math.PI * 14 * 14 * 30);
  const { size } = s.boundingBox();
  expect(size[2]).toBeCloseTo(30, 6);
  expect(size[0]).toBeGreaterThan(27.5);  // the r=14 waist is interpolated, ±overshoot bound
  expect(size[0]).toBeLessThan(28.7);
});

test("density convergence: default resolution is within 1% of a much denser run", () => {
  const lo = k.loftSmooth({ sections: BULGE }).volume();
  const hi = k.loftSmooth({ sections: BULGE, stations: 97, samples: 256 }).volume();
  expect(Math.abs(lo - hi) / hi).toBeLessThan(0.01);
});

test("parity anchor: propeller reference part volume (shared literal with the OCCT file)", () => {
  const PARITY_CM3 = 22.85;                         // spike-recorded midpoint; OCCT file pins the same
  const v = propeller.parts.propeller.build(k, propeller.defaults).volume() / 1000;
  expect(v).toBeGreaterThan(PARITY_CM3 * 0.98);
  expect(v).toBeLessThan(PARITY_CM3 * 1.02);
});
