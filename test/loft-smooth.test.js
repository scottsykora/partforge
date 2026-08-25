// Kernel-free unit tests for the loftSmooth densifier (loft-smooth.js). Locks the
// spec'd behavior: planar equal-count rings, exact end interpolation, differing
// section counts reconciled, centripetal no-overshoot, determinism, frozen errors.
// Spec: docs/superpowers/specs/2026-08-24-loft-smooth-design.md
import { expect, test } from "vitest";
import {
  smoothLoftRings, resampleClosedSpline, resampleOpenArc, fitBezierRing,
} from "../src/framework/geometry/loft-smooth.js";

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);

// v2: rings are all-cubic contours; their vertices are the segment endpoints
// (explicit closure: the last segment lands back on start).
const verts = (r) => [r.polygon.start, ...r.polygon.segments.slice(0, -1).map((s) => s.to)];

const SECTIONS = [
  { polygon: ngon(8, 10), z: 0 },
  { polygon: ngon(12, 14), z: 15 },   // differing vertex counts on purpose
  { polygon: ngon(10, 10), z: 30 },
];

test("output rings are equal-count, planar, and span the control z range", () => {
  const rings = smoothLoftRings(SECTIONS, { stations: 17, samples: 48 });
  expect(rings.length).toBe(17);
  for (const r of rings) {
    expect(verts(r).length).toBe(48);
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
    verts(ring).forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want[j][0], 9);
      expect(p[1]).toBeCloseTo(want[j][1], 9);
    });
  }
});

test("sides+radius shorthand sections work", () => {
  const rings = smoothLoftRings(
    [{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 10 }],
    { samples: 32 });
  expect(verts(rings[0]).length).toBe(32);
});

test("no overshoot: circle controls stay in a tight radial band (centripetal CR)", () => {
  const rings = smoothLoftRings(
    [{ polygon: ngon(12, 10), z: 0 }, { polygon: ngon(12, 10), z: 10 }],
    { stations: 3, samples: 96 });
  for (const [x, y] of verts(rings[1])) {
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
  for (const [x, y] of verts(rings[0])) {
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
  expect(rings.every((r) => verts(r).length === 32)).toBe(true);
});

test("validation errors are exact (frozen by the spec)", () => {
  expect(() => smoothLoftRings([], {}))
    .toThrow("loftSmooth: sections must be an array of at least 2 control sections");
  expect(() => smoothLoftRings([{ polygon: ngon(8, 5) }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: section 0 needs a finite z");
  expect(() => smoothLoftRings([{ polygon: [[0, 0], [1, 0]], z: 0 }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: section 0 needs polygon:[[x,y],…] (≥3 points), a curve contour, a Shape2D, or sides+radius shorthand");
  expect(() => smoothLoftRings(SECTIONS, { stations: 1.5 }))
    .toThrow('loftSmooth: stations must be 2…1024 (or "controls")');
  expect(() => smoothLoftRings(SECTIONS, { samples: 4 }))
    .toThrow("loftSmooth: samples must be 8…2048");
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
    verts(ring).forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want[j][0], 6);
      expect(p[1]).toBeCloseTo(want[j][1], 6);
    });
  }
});

test("stations below the section count is raised to the section count", () => {
  const five = [0, 5, 10, 15, 20].map((z) => ({ polygon: ngon(8, 10), z }));
  expect(smoothLoftRings(five, { stations: 2, samples: 16 }).length).toBe(5);
});

test("resampleOpenArc interpolates its endpoints exactly and is monotone in count", () => {
  const arc = [[0, 0], [4, 3], [8, 3], [12, 0]];
  const out = resampleOpenArc(arc, 6);
  expect(out.length).toBe(7);
  expect(out[0]).toEqual([0, 0]);
  expect(out[6]).toEqual([12, 0]);
});

test("sharp tags survive reconciliation: tagged vertices appear at the same index in every ring", () => {
  // Two squares with all four corners tagged — corners must sit at identical shared indices.
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const rings = smoothLoftRings(
    [{ polygon: sq(10), sharp: [0, 1, 2, 3], z: 0 }, { polygon: sq(6), sharp: [0, 1, 2, 3], z: 10 }],
    { stations: 5, samples: 32 });
  for (const r of rings) {
    expect(verts(r).length).toBe(32);
    // 4 equal arcs of a square → corners at 0, 8, 16, 24; corner positions lie on the square's diagonals
    for (const idx of [0, 8, 16, 24]) {
      const [x, y] = verts(r)[idx];
      expect(Math.abs(Math.abs(x) - Math.abs(y))).toBeLessThan(1e-6);
    }
  }
});

test("sharp corners are interpolated exactly at control stations", () => {
  const sq = (r) => [[r, r], [-r, r], [-r, -r], [r, -r]];
  const rings = smoothLoftRings(
    [{ polygon: sq(10), sharp: [0, 1, 2, 3], z: 0 }, { polygon: sq(10), sharp: [0, 1, 2, 3], z: 10 }],
    { stations: 2, samples: 16 });
  expect(verts(rings[0])[0][0]).toBeCloseTo(10, 9);
  expect(verts(rings[0])[0][1]).toBeCloseTo(10, 9);
});

test("corner 0 anchors the seam: a rotated sharp list still puts corner 0 at vertex 0", () => {
  const sq = [[10, 10], [-10, 10], [-10, -10], [10, -10]];
  const rings = smoothLoftRings(
    [{ polygon: sq, sharp: [2, 3], z: 0 }, { polygon: sq, sharp: [2, 3], z: 10 }],
    { stations: 2, samples: 16 });
  expect(verts(rings[0])[0]).toEqual([-10, -10]); // vertex at sharp index 2 leads the ring
});

test("curve contour sections are accepted; their corners are implicit", () => {
  // A half-round "D": one line segment (2 implicit corners) + one arc.
  const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
  const rings = smoothLoftRings([{ polygon: D, z: 0 }, { polygon: D, z: 10 }], { stations: 2, samples: 24 });
  expect(rings.length).toBe(2);
  expect(verts(rings[0]).length).toBe(24);
});

test("point and curve sections mix when their corner counts match", () => {
  // The D-contour has 2 implicit corners (line↔arc joints); the point section
  // tags 2 of its own — correspondence works across forms.
  const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
  const lens = [[0, -8], [0, 8], [4, 6], [7, 0], [4, -6]];
  const rings = smoothLoftRings(
    [{ polygon: D, z: 0 }, { polygon: lens, sharp: [0, 1], z: 10 }],
    { stations: 4, samples: 24 });
  expect(rings.length).toBe(4);
  expect(rings.every((r) => verts(r).length === 24)).toBe(true);
});

test("corner-count mismatch and sharp-validation errors are exact (frozen by the spec)", () => {
  const sq = [[10, 10], [-10, 10], [-10, -10], [10, -10]];
  const D = { start: [0, -8], segments: [{ to: [0, 8] }, { to: [0, -8], via: [8, 0] }] };
  expect(() => smoothLoftRings([{ polygon: sq, sharp: [0], z: 0 }, { polygon: sq, z: 10 }], {}))
    .toThrow("loftSmooth: every section must have the same corner count — section 1 has 0, section 0 has 1");
  expect(() => smoothLoftRings([{ polygon: D, sharp: [0], z: 0 }, { polygon: D, z: 10 }], {}))
    .toThrow("loftSmooth: section 0 is a curve contour — its corners are implicit; sharp is only for point sections");
  expect(() => smoothLoftRings([{ polygon: sq, sharp: [4], z: 0 }, { polygon: sq, sharp: [0], z: 10 }], {}))
    .toThrow("loftSmooth: section 0 sharp indices must be integers in 0…3");
  expect(() => smoothLoftRings([{ polygon: sq, sharp: [1.5], z: 0 }, { polygon: sq, sharp: [0], z: 10 }], {}))
    .toThrow("loftSmooth: section 0 sharp indices must be integers in 0…3");
});

test("samples below the corner count is raised to it", () => {
  const oct = [[10, 0], [7, 7], [0, 10], [-7, 7], [-10, 0], [-7, -7], [0, -10], [7, -7]];
  // 8 corners, samples clamped-in at 8 → raised to 8 (1 span per arc)
  const rings = smoothLoftRings(
    [{ polygon: oct, sharp: [0, 1, 2, 3, 4, 5, 6, 7], z: 0 }, { polygon: oct, sharp: [0, 1, 2, 3, 4, 5, 6, 7], z: 5 }],
    { stations: 2, samples: 8 });
  expect(verts(rings[0]).length).toBe(8);
});

const bezAt = (p0, s, u) => { // de Casteljau on one {to,c1,c2} segment from p0
  const l = (a, b) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const a1 = l(p0, s.c1), a2 = l(s.c1, s.c2), a3 = l(s.c2, s.to);
  const b1 = l(a1, a2), b2 = l(a2, a3);
  return l(b1, b2);
};

test("fitBezierRing interpolates every vertex exactly and closes explicitly", () => {
  const pts = resampleClosedSpline([[10, 0], [0, 10], [-10, 0], [0, -12]], 24);
  const c = fitBezierRing(pts);
  expect(c.segments.length).toBe(24);
  expect(c.start).toEqual(pts[0]);
  expect(c.segments[23].to).toEqual(pts[0]);
  c.segments.slice(0, -1).forEach((s, i) => expect(s.to).toEqual(pts[i + 1]));
  expect(c.segments.every((s) => s.c1 && s.c2)).toBe(true);
});

test("fitBezierRing is C1 at smooth joints, tangent-broken at corners", () => {
  const tangentPair = (c, i) => { // out-tangent of segment i-1 and in-tangent of segment i at vertex i
    const n = c.segments.length;
    const prev = c.segments[(i - 1 + n) % n];
    const cur = c.segments[i];
    const from = i === 0 ? c.start : c.segments[i - 1].to;
    return [[from[0] - prev.c2[0], from[1] - prev.c2[1]], [cur.c1[0] - from[0], cur.c1[1] - from[1]]];
  };
  const cross = ([a, b]) => Math.abs(a[0] * b[1] - a[1] * b[0]) / (Math.hypot(...a) * Math.hypot(...b));
  const smoothC = fitBezierRing(resampleClosedSpline([[10, 0], [0, 10], [-10, 0], [0, -10]], 16));
  for (let i = 0; i < 16; i++) expect(cross(tangentPair(smoothC, i))).toBeLessThan(1e-9);
  // Square with 4 corners at indices 0,4,8,12 of a 16-vertex ring: corners break tangency.
  const sq = [[10, 10], [-10, 10], [-10, -10], [10, -10]];
  const ring = [];
  for (let j = 0; j < 4; j++) {
    const a = sq[j], b = sq[(j + 1) % 4];
    for (let s = 0; s < 4; s++) ring.push([a[0] + (b[0] - a[0]) * (s / 4), a[1] + (b[1] - a[1]) * (s / 4)]);
  }
  const cornered = fitBezierRing(ring, [0, 4, 8, 12]);
  for (const i of [0, 4, 8, 12]) expect(cross(tangentPair(cornered, i))).toBeGreaterThan(1e-3);
  for (const i of [2, 6, 10, 14]) expect(cross(tangentPair(cornered, i))).toBeLessThan(1e-9);
});

test("emitted cubics lie on the CR curve (midpoints match a dense resample)", () => {
  const ctrl = [[10, 0], [3, 9], [-8, 5], [-9, -6], [4, -11]];
  const pts = resampleClosedSpline(ctrl, 16);
  const c = fitBezierRing(pts);
  // Each cubic's midpoint must sit between its endpoints at a plausible CR position:
  // compare against a 16x denser resample of the same base ring, nearest-point distance.
  const dense = resampleClosedSpline(ctrl, 256);
  c.segments.forEach((s, i) => {
    const p0 = i === 0 ? c.start : c.segments[i - 1].to;
    const mid = bezAt(p0, s, 0.5);
    const d = Math.min(...dense.map(([x, y]) => Math.hypot(x - mid[0], y - mid[1])));
    expect(d).toBeLessThan(0.15); // on-curve to well under a facet width at r≈10
  });
});

test("closed:true emits a periodic station list — every control ring once, no ring-0 repeat", () => {
  const four = [10, 13, 11, 14].map((r, i) => ({ polygon: ngon(8, r), z: i * 5 }));
  const rings = smoothLoftRings(four, { stations: 12, samples: 16, closed: true });
  expect(rings.length).toBe(12);
  const first = verts(rings[0]), last = verts(rings[rings.length - 1]);
  expect(last).not.toEqual(first); // the wrap-back station is interior, not a duplicate of ring 0
  // control station 0 is emitted exactly
  const want = resampleClosedSpline(ngon(8, 10), 16);
  first.forEach((p, j) => {
    expect(p[0]).toBeCloseTo(want[j][0], 9);
    expect(p[1]).toBeCloseTo(want[j][1], 9);
  });
});

test("closed default station count is n*8", () => {
  const four = [10, 13, 11, 14].map((r, i) => ({ polygon: ngon(8, r), z: i * 5 }));
  expect(smoothLoftRings(four, { samples: 16, closed: true }).length).toBe(32);
});

test("closed validation errors are exact (frozen by the spec)", () => {
  const two = [{ polygon: ngon(8, 10), z: 0 }, { polygon: ngon(8, 12), z: 5 }];
  expect(() => smoothLoftRings(two, { closed: true }))
    .toThrow("loftSmooth: closed:true needs at least 3 control sections");
  const four = [10, 13, 11, 14].map((r, i) => ({ polygon: ngon(8, r), z: i * 5 }));
  expect(() => smoothLoftRings(four, { stations: "controls", closed: true }))
    .toThrow('loftSmooth: closed:true cannot combine with stations:"controls"');
});
