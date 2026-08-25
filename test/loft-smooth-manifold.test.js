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

test("sharp tags change the surface: tagged square prism differs from the untagged fit, both watertight", () => {
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const sections = (sharp) => [
    { polygon: sq(10), ...(sharp ? { sharp: [0, 1, 2, 3] } : {}), z: 0 },
    { polygon: sq(10), ...(sharp ? { sharp: [0, 1, 2, 3] } : {}), z: 20 },
  ];
  const tagged = k.loftSmooth({ sections: sections(true), stations: 5, samples: 32 });
  const smooth = k.loftSmooth({ sections: sections(false), stations: 5, samples: 32 });
  // Tagged corners keep the true square (400 mm² cross-section) exactly. The
  // untagged CR does NOT round the corners off here — a closed spline through
  // only 4 sparse right-angle controls overshoots outward instead — so the
  // comparison below is magnitude-only by design, not directional.
  expect(tagged.volume()).toBeCloseTo(400 * 20, -2); // within ~50 mm³ of the exact prism
  expect(Math.abs(tagged.volume() / smooth.volume() - 1)).toBeGreaterThan(0.001);
  expect(tagged.genus()).toBe(0);
  expect(smooth.genus()).toBe(0);
});

test("propeller sharpTE toggle changes the built solid's volume (creased vs smeared trailing edge)", () => {
  // The tag touches one vertex per airfoil section out of ~24, on a small
  // fraction of the assembly's surface — measured relative volume delta is
  // ~1.8e-5 (deterministic), well below the 1e-4 headline sharp-corner effect
  // the square-prism test above sees. Threshold is set with margin under the
  // measured signal, not against a rounder guess.
  const on = propeller.parts.propeller.build(k, propeller.defaults);
  const off = propeller.parts.propeller.build(k, { ...propeller.defaults, sharpTE: 0 });
  expect(on.volume()).toBeGreaterThan(0);
  expect(off.volume()).toBeGreaterThan(0);
  expect(Math.abs(on.volume() / off.volume() - 1)).toBeGreaterThan(1e-6);
  // Both a single through-hole for the shaft bore — the crease is local to the
  // trailing edge and doesn't change the assembly's topology.
  expect(on.genus()).toBe(1);
  expect(off.genus()).toBe(1);
});

test("closed:true builds a capless genus-1 loop (the loft-mesh precedent, smoothed)", () => {
  const sections = [];
  for (let i = 0; i < 6; i++) sections.push({ sides: 8, radius: 8 + i, z: i * 3 });
  const s = k.loftSmooth({ sections, closed: true, samples: 24 });
  expect(s.genus()).toBe(1);
  expect(s.volume()).toBeGreaterThan(0);
});

test("lefthand mirrors the blades: same volume and topology, opposite chirality", () => {
  const right = propeller.parts.propeller.build(k, propeller.defaults);
  const left = propeller.parts.propeller.build(k, { ...propeller.defaults, lefthand: 1 });
  // A mirror preserves volume (the emitted rings are exact mirrors — CR and the
  // arc-length resample are affine-equivariant) and the bore keeps genus 1.
  expect(left.volume() / right.volume()).toBeCloseTo(1, 3);
  expect(left.genus()).toBe(1);
  // Chirality probe: a box over the +Y half of blade 1's radial reach (x ≥ 16
  // clears the r=15 hub). Mirroring y→−y moves the twisted blade's material
  // across the y=0 plane, so the trapped volumes must differ between hands.
  const box = () => k.box({ min: [16, 2, -40], max: [90, 90, 40] });
  const vR = right.intersect(box()).volume();
  const vL = left.intersect(box()).volume();
  expect(Math.abs(vL / vR - 1)).toBeGreaterThan(0.02);
});
