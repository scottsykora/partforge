// Kernel-free unit tests for the loftSmooth densifier (loft-smooth.js). Locks the
// spec'd behavior: planar equal-count rings, exact end interpolation, differing
// section counts reconciled, centripetal no-overshoot, determinism, frozen errors.
// Spec: docs/superpowers/specs/2026-08-24-loft-smooth-design.md
import { expect, test } from "vitest";
import { smoothLoftRings, resampleClosedSpline } from "../src/framework/geometry/loft-smooth.js";

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);

const SECTIONS = [
  { polygon: ngon(8, 10), z: 0 },
  { polygon: ngon(12, 14), z: 15 },   // differing vertex counts on purpose
  { polygon: ngon(10, 10), z: 30 },
];

test("output rings are equal-count, planar, and span the control z range", () => {
  const rings = smoothLoftRings(SECTIONS, { stations: 17, samples: 48 });
  expect(rings.length).toBe(17);
  for (const r of rings) {
    expect(r.polygon.length).toBe(48);
    expect(Number.isFinite(r.z)).toBe(true);
  }
  expect(rings[0].z).toBeCloseTo(0, 9);
  expect(rings[rings.length - 1].z).toBeCloseTo(30, 9);
  for (let i = 1; i < rings.length; i++) expect(rings[i].z).toBeGreaterThan(rings[i - 1].z);
});

test("end sections are interpolated exactly (reflection-phantom clamping)", () => {
  const rings = smoothLoftRings(SECTIONS, { stations: 17, samples: 48 });
  for (const [ring, section] of [[rings[0], SECTIONS[0]], [rings[16], SECTIONS[2]]]) {
    const want = resampleClosedSpline(section.polygon, 48);
    ring.polygon.forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want[j][0], 9);
      expect(p[1]).toBeCloseTo(want[j][1], 9);
    });
  }
});

test("sides+radius shorthand sections work", () => {
  const rings = smoothLoftRings(
    [{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 10 }],
    { samples: 32 });
  expect(rings[0].polygon.length).toBe(32);
});

test("no overshoot: circle controls stay in a tight radial band (centripetal CR)", () => {
  const rings = smoothLoftRings(
    [{ polygon: ngon(12, 10), z: 0 }, { polygon: ngon(12, 10), z: 10 }],
    { stations: 3, samples: 96 });
  for (const [x, y] of rings[1].polygon) {
    const r = Math.hypot(x, y);
    expect(r).toBeLessThan(10.5);
    expect(r).toBeGreaterThan(9.0);
  }
});

test("no overshoot on clustered spacing (cosine-clustered ellipse controls)", () => {
  // Airfoil-style uneven spacing — the case uniform CR overshoots on (spec finding 2).
  const clustered = Array.from({ length: 16 }, (_, i) => {
    const a = (2 * Math.PI * i) / 16;
    const t = (1 - Math.cos(a)) / 2;                       // cluster near a=0
    const th = 2 * Math.PI * t;
    return [20 * Math.cos(th), 6 * Math.sin(th)];
  });
  const rings = smoothLoftRings(
    [{ polygon: clustered, z: 0 }, { polygon: clustered, z: 10 }],
    { stations: 2, samples: 128 });
  for (const [x, y] of rings[0].polygon) {
    expect(Math.abs(x)).toBeLessThan(20 * 1.05);
    expect(Math.abs(y)).toBeLessThan(6 * 1.05);
  }
});

test("deterministic: two identical calls produce identical output", () => {
  const a = smoothLoftRings(SECTIONS, { stations: 9, samples: 24 });
  const b = smoothLoftRings(SECTIONS, { stations: 9, samples: 24 });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test('internal "controls" mode emits one ring per section at its exact z', () => {
  const rings = smoothLoftRings(SECTIONS, { stations: "controls", samples: 32 });
  expect(rings.map((r) => r.z)).toEqual([0, 15, 30]);
  expect(rings.every((r) => r.polygon.length === 32)).toBe(true);
});

test("validation errors are exact (frozen by the spec)", () => {
  expect(() => smoothLoftRings([], {}))
    .toThrow("loftSmooth: sections must be an array of at least 2 control sections");
  expect(() => smoothLoftRings([{ polygon: ngon(8, 5) }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: section 0 needs a finite z");
  expect(() => smoothLoftRings([{ polygon: [[0, 0], [1, 0]], z: 0 }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: section 0 needs polygon:[[x,y],…] (≥3 points) or sides+radius shorthand");
  expect(() => smoothLoftRings(SECTIONS, { stations: 1.5 }))
    .toThrow('loftSmooth: stations must be 2…1024 (or "controls")');
  expect(() => smoothLoftRings(SECTIONS, { samples: 4 }))
    .toThrow("loftSmooth: samples must be 8…2048");
  expect(() => smoothLoftRings([
    { polygon: { start: [10, 0], segments: [{ to: [-10, 0], via: [0, 10] }, { to: [10, 0], via: [0, -10] }] }, z: 0 },
    { polygon: ngon(8, 5), z: 5 },
  ], {})).toThrow("loftSmooth: section 0 is an arc profile — control sections must be point arrays (for now)");
  expect(() => smoothLoftRings([{ polygon: [[5, 5], [5, 5], [5, 5]], z: 0 }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: a control section has zero perimeter");
});

test("equal spans: the largest-remainder tie-break gives the leftover station to the lower-index span", () => {
  // Two equal spans and stations: 4 leave ONE leftover interior station with both
  // spans tied at remainder 0.5 — the deterministic tie-break must place it in
  // span 0, never span 1.
  const even = [0, 10, 20].map((z) => ({ polygon: ngon(8, 10), z }));
  const rings = smoothLoftRings(even, { stations: 4, samples: 16 });
  expect(rings.length).toBe(4);
  const zs = rings.map((r) => r.z);
  expect(zs.filter((z) => z > 1e-9 && z < 10 - 1e-9).length).toBe(1);
  expect(zs.filter((z) => z > 10 + 1e-9 && z < 20 - 1e-9).length).toBe(0);
});

test("default stations clamps to 1024 for very many sections; explicit out-of-range still throws", () => {
  // At 129 sections the un-clamped default (n−1)·8+1 = 1025 would reject an
  // option the caller never passed.
  const many = Array.from({ length: 129 }, (_, i) => ({ polygon: ngon(6, 10), z: i }));
  expect(smoothLoftRings(many, { samples: 8 }).length).toBe(1024);
  expect(() => smoothLoftRings(many, { stations: 1025 }))
    .toThrow('loftSmooth: stations must be 2…1024 (or "controls")');
});

test("every control section appears as an actual output ring (knot-aligned stations)", () => {
  const uneven = [
    { polygon: ngon(8, 10), z: 0 },
    { polygon: ngon(8, 12), z: 7 },    // uneven span lengths on purpose
    { polygon: ngon(8, 10), z: 30 },
  ];
  const rings = smoothLoftRings(uneven, { stations: 10, samples: 32 });
  expect(rings.length).toBe(10);
  for (const s of uneven) {
    const ring = rings.find((r) => Math.abs(r.z - s.z) < 1e-9);
    expect(ring, `no output ring at control z=${s.z}`).toBeTruthy();
    const want = resampleClosedSpline(s.polygon, 32);
    ring.polygon.forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want[j][0], 6);
      expect(p[1]).toBeCloseTo(want[j][1], 6);
    });
  }
});

test("stations below the section count is raised to the section count", () => {
  const five = [0, 5, 10, 15, 20].map((z) => ({ polygon: ngon(8, 10), z }));
  expect(smoothLoftRings(five, { stations: 2, samples: 16 }).length).toBe(5);
});
