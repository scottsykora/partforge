import { expect, test } from "vitest";
import { detectPatterns } from "../src/framework/oracle/describe/patterns.js";

const hole = (x, y, d = 5) => ({
  key: `hole:${d}:${x},${y},0`, type: "throughHole", diameter: d,
  axis: { origin: [x, y, 0], direction: [0, 0, 1] },
});
const bounds = { min: [0, 0, 0], max: [60, 40, 12] };

test("four holes on a rectangle collapse to one 2x2 grid pattern", () => {
  const { patterns } = detectPatterns([hole(5,5), hole(55,5), hole(5,35), hole(55,35)], bounds);
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid).toBeDefined();
  expect(grid.counts).toEqual([2, 2]);
  expect(grid.members.length).toBe(4);
});

test("the grid reports the fixture pitch", () => {
  const { patterns } = detectPatterns([hole(5,5), hole(55,5), hole(5,35), hole(55,35)], bounds);
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid.pitch[0]).toBeCloseTo(50, 3);
  expect(grid.pitch[1]).toBeCloseTo(30, 3);
});

test("three evenly spaced collinear holes are a linear pattern", () => {
  const { patterns } = detectPatterns([hole(10,20), hole(20,20), hole(30,20)], bounds);
  expect(patterns[0].type).toBe("linear");
  expect(patterns[0].counts).toEqual([3]);
  expect(patterns[0].pitch[0]).toBeCloseTo(10, 6);
});

test("holes of different diameters do not form one pattern", () => {
  const { patterns } = detectPatterns([hole(10,20,5), hole(20,20,8), hole(30,20,5)], bounds);
  expect(patterns.every((p) => p.members.length < 3)).toBe(true);
});

test("two unrelated holes produce no pattern", () => {
  const { patterns } = detectPatterns([hole(3,3), hole(41,29)], bounds);
  expect(patterns).toEqual([]);
});

// Ruling R27's regression guard. The same four holes, rigidly rotated: a grid detector
// that buckets world coordinates finds nothing here, which is what the original did.
test("a rotated hole grid is still detected as a 2x2 grid with the same pitch", () => {
  const rot = ([x, y, z]) => {
    const c = Math.cos(0.7), s = Math.sin(0.7);           // about X, an ugly angle
    const c2 = Math.cos(0.4), s2 = Math.sin(0.4);         // then about Z
    const [y1, z1] = [y*c - z*s, y*s + z*c];
    return [x*c2 - y1*s2, x*s2 + y1*c2, z1];
  };
  const spun = [hole(5,5), hole(55,5), hole(5,35), hole(55,35)].map((h) => ({
    ...h, axis: { origin: rot(h.axis.origin), direction: rot([0,0,1]) },
  }));
  const { patterns } = detectPatterns(spun, { min: rot([0,0,0]), max: rot([60,40,12]) });
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid).toBeDefined();
  expect(grid.counts).toEqual([2, 2]);
  expect(grid.pitch.map((v) => Math.round(v)).sort((a, b) => a - b)).toEqual([30, 50]);
});

// A SQUARE grid (equal pitch on both axes) is the degenerate case for any axis
// recovery built on second-order statistics (PCA covariance is isotropic for a
// square's corners at any rotation, so it can't recover the true row/column
// directions). The pairwise-direction search this file's asGrid uses doesn't rely
// on that, so this locks the rotated-grid fix in for the case most likely to break
// a purely statistical alternative.
test("a rotated SQUARE hole grid (equal pitch) is still detected as a 2x2 grid", () => {
  const rot = ([x, y, z]) => {
    const c = Math.cos(0.7), s = Math.sin(0.7);
    const c2 = Math.cos(0.4), s2 = Math.sin(0.4);
    const [y1, z1] = [y*c - z*s, y*s + z*c];
    return [x*c2 - y1*s2, x*s2 + y1*c2, z1];
  };
  const spun = [hole(0,0), hole(40,0), hole(0,40), hole(40,40)].map((h) => ({
    ...h, axis: { origin: rot(h.axis.origin), direction: rot([0,0,1]) },
  }));
  const { patterns } = detectPatterns(spun, { min: rot([-5,-5,-1]), max: rot([45,45,1]) });
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid).toBeDefined();
  expect(grid.counts).toEqual([2, 2]);
  expect(grid.pitch[0]).toBeCloseTo(40, 6);
  expect(grid.pitch[1]).toBeCloseTo(40, 6);
});

// A 3x3 grid, arbitrarily oriented and non-square, to check the axis search beyond
// the minimal 2x2 case.
test("a rotated 3x3 hole grid reports both pitches and the full member count", () => {
  const rot = ([x, y, z]) => {
    const c = Math.cos(0.7), s = Math.sin(0.7);
    const c2 = Math.cos(0.4), s2 = Math.sin(0.4);
    const [y1, z1] = [y*c - z*s, y*s + z*c];
    return [x*c2 - y1*s2, x*s2 + y1*c2, z1];
  };
  const g33 = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) g33.push(hole(i * 20, j * 12));
  const spun = g33.map((h) => ({ ...h, axis: { origin: rot(h.axis.origin), direction: rot([0,0,1]) } }));
  const { patterns } = detectPatterns(spun, { min: rot([-5,-5,-1]), max: rot([45,45,1]) });
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid).toBeDefined();
  expect(grid.counts.slice().sort((a, b) => a - b)).toEqual([3, 3]);
  expect(grid.members.length).toBe(9);
  expect(grid.pitch.map((v) => Math.round(v)).sort((a, b) => a - b)).toEqual([12, 20]);
});

// A genuine bolt circle: 5 holes evenly spaced at 72 degree increments around a
// centre, rigidly rotated to an arbitrary orientation.
test("an evenly spaced hole circle is a circular pattern", () => {
  const rot = ([x, y, z]) => {
    const c = Math.cos(0.7), s = Math.sin(0.7);
    const c2 = Math.cos(0.4), s2 = Math.sin(0.4);
    const [y1, z1] = [y*c - z*s, y*s + z*c];
    return [x*c2 - y1*s2, x*s2 + y1*c2, z1];
  };
  const n = 5, r = 20, cx = 30, cy = 20;
  const ring = Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n;
    return hole(cx + r * Math.cos(t), cy + r * Math.sin(t));
  });
  const spun = ring.map((h) => ({ ...h, axis: { origin: rot(h.axis.origin), direction: rot([0,0,1]) } }));
  const { patterns } = detectPatterns(spun, { min: rot([0,0,0]), max: rot([60,40,5]) });
  const circular = patterns.find((p) => p.type === "circular");
  expect(circular).toBeDefined();
  expect(circular.counts).toEqual([5]);
  expect(circular.pitch[0]).toBeCloseTo(72, 3);
});

// Six holes, equidistant from their own centroid by 3-fold symmetry (three antipodal
// PAIRS, each pair 8 degrees apart, the pairs 120 degrees apart) but nothing like an
// evenly spaced bolt circle. Equal radius from the centroid alone can't tell this
// apart from a real 6-hole ring -- confirmed the brief's reference `asCircular`
// (radius check only) reports this as a clean 60-degree pattern before the angular
// check was added.
test("holes equidistant from their centroid but bunched in arcs are not a circular pattern", () => {
  const r0 = 20;
  const angles = [0, 8, 120, 128, 240, 248];
  const clustered = angles.map((deg) => {
    const t = (deg * Math.PI) / 180;
    return hole(r0 * Math.cos(t), r0 * Math.sin(t));
  });
  const { patterns } = detectPatterns(clustered, { min: [-25,-25,0], max: [25,25,5] });
  expect(patterns.find((p) => p.type === "circular")).toBeUndefined();
});

test("a symmetric hole layout reports a mirror plane", () => {
  const { symmetry } = detectPatterns([hole(5,5), hole(55,5), hole(5,35), hole(55,35)], bounds);
  const mirror = symmetry.find((s) => s.type === "mirror");
  expect(mirror).toBeDefined();
  expect(mirror.coverage).toBeCloseTo(1, 6);
});
