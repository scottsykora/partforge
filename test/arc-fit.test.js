import { expect, test } from "vitest";
import { recoverArcs } from "../src/framework/geometry/arc-fit.js";
import { arcCenterAndSweep } from "../src/framework/geometry/paper-bridge.js";

// A circle the way paper.js builds one: four cubics with the standard kappa
// handle. This is the exact shape importSVG hands back for a <circle>.
const KAPPA = 0.5522847498307936;
function paperCircle(cx, cy, r) {
  const k = KAPPA * r;
  const pts = [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
  const tans = [[0, k], [-k, 0], [0, -k], [k, 0]];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], ta = tans[i], tb = tans[(i + 1) % 4];
    segments.push({ to: b, c1: [a[0] + ta[0], a[1] + ta[1]], c2: [b[0] - tb[0], b[1] - tb[1]] });
  }
  return { start: pts[0], segments };
}

test("a paper-style circle collapses to arcs", () => {
  const out = recoverArcs(paperCircle(5, 7, 3));
  expect(out.segments.every((s) => s.via)).toBe(true);
  expect(out.segments.every((s) => s.c1 === undefined)).toBe(true);
});

// Sweep-direction coverage: paperCircle above always traces CCW (right → top →
// left → bottom, positive dA). recoverArcs' 3-point circle fit has to be
// equally correct for the opposite handedness — nothing about ingest
// guarantees CCW: a transformed <circle> (e.g. a negative scale) or a winding
// flip (svg-ingest.js negates y to go from SVG's y-down to the model's y-up,
// which reverses every contour's sense) can hand recoverArcs a CW run just as
// easily. This is the highest-risk part of arc recovery — a sign error in the
// fit or in how the recovered `via` encodes sweep direction — and until now
// nothing here traced a circle the other way to catch it.
function paperCircleCW(cx, cy, r) {
  const k = KAPPA * r;
  const pts = [[cx + r, cy], [cx, cy - r], [cx - r, cy], [cx, cy + r]];
  const tans = [[0, -k], [-k, 0], [0, k], [k, 0]];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], ta = tans[i], tb = tans[(i + 1) % 4];
    segments.push({ to: b, c1: [a[0] + ta[0], a[1] + ta[1]], c2: [b[0] - tb[0], b[1] - tb[1]] });
  }
  return { start: pts[0], segments };
}

test("a clockwise (mirrored) circle also collapses to arcs, with the correct negative sweep", () => {
  const out = recoverArcs(paperCircleCW(5, 7, 3));
  expect(out.segments.every((s) => s.via)).toBe(true);
  expect(out.segments.every((s) => s.c1 === undefined)).toBe(true);
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(c.center[0]).toBeCloseTo(5, 6);
    expect(c.center[1]).toBeCloseTo(7, 6);
    expect(c.r).toBeCloseTo(3, 6);
    expect(c.dA).toBeLessThan(0);   // CW is the negative-sweep sense in this convention — CCW (above) is positive
    prev = s.to;
  }
});

test("the recovered circle has the exact original centre and radius", () => {
  const out = recoverArcs(paperCircle(5, 7, 3));
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(c.center[0]).toBeCloseTo(5, 6);
    expect(c.center[1]).toBeCloseTo(7, 6);
    expect(c.r).toBeCloseTo(3, 6);
    prev = s.to;
  }
});

test("a full circle is split into arcs of at most 180 degrees", () => {
  const out = recoverArcs(paperCircle(0, 0, 1));
  expect(out.segments.length).toBeGreaterThanOrEqual(2);
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(Math.abs(c.dA)).toBeLessThanOrEqual(Math.PI + 1e-9);
    prev = s.to;
  }
});

test("an ellipse does not collapse — it is not a circle", () => {
  const c = paperCircle(0, 0, 4);
  const squash = (p) => [p[0], p[1] / 2];
  const flat = { start: squash(c.start), segments: c.segments.map((s) => ({ to: squash(s.to), c1: squash(s.c1), c2: squash(s.c2) })) };
  const out = recoverArcs(flat);
  expect(out.segments.some((s) => s.c1)).toBe(true);
});

test("a freeform curve does not collapse", () => {
  const wiggle = { start: [0, 0], segments: [
    { to: [10, 0], c1: [2, 8], c2: [8, -8] },
    { to: [20, 4], c1: [12, 6], c2: [18, -2] },
  ] };
  const out = recoverArcs(wiggle);
  expect(out.segments).toEqual(wiggle.segments);
});

test("lines and existing arcs pass through untouched", () => {
  const mixed = { start: [0, 0], segments: [
    { to: [5, 0] }, { to: [10, 5], via: [9, 1] }, { to: [0, 5] },
  ] };
  expect(recoverArcs(mixed)).toEqual(mixed);
});

test("a circular run collapses while its non-circular neighbours stay cubic", () => {
  const c = paperCircle(0, 0, 2);
  const mixed = { start: [0, 0], segments: [
    { to: c.start },                                   // a line into the arc run
    ...c.segments.slice(0, 2),                         // half the circle
    { to: [40, 40], c1: [20, 0], c2: [30, 30] },       // a freeform cubic out of it
  ] };
  const out = recoverArcs(mixed);
  expect(out.segments[0].via).toBeUndefined();         // line untouched
  expect(out.segments.some((s) => s.via)).toBe(true);  // the run collapsed
  expect(out.segments.at(-1).c1).toEqual([20, 0]);     // freeform untouched
});

test("a single cubic that is a quarter circle collapses on its own", () => {
  const c = paperCircle(0, 0, 5);
  const one = { start: c.start, segments: [c.segments[0], { to: c.start }] };
  const out = recoverArcs(one);
  expect(out.segments[0].via).toBeDefined();
});

test("endpoints are preserved exactly", () => {
  const c = paperCircle(3, 4, 2);
  const out = recoverArcs(c);
  expect(out.start).toEqual(c.start);
  expect(out.segments.at(-1).to).toEqual(c.segments.at(-1).to);
});

// --- the tolerance must not grow with the fitted radius ----------------------
//
// The acceptance band used to be `1e-3 * r` alone, where r is the radius of the
// circle the run FITS. A nearly-straight run fits a huge circle, so the band grew
// without limit exactly where the author's own feature was smallest, and a gentle
// asymmetric cubic — the most common curve in real logo artwork — was silently
// replaced by an arc that missed it by half the curve's own depth. Nothing threw,
// and the stored file then claimed `"kind": "arc"`, so the intent was unrecoverable.
//
// Max deviation of a cubic run from the circle a recovered arc encodes, sampled
// densely. The arc's three points (previous point, `via`, `to`) determine it.
const deviationFromArc = (start, cubics, arc) => {
  const c = arcCenterAndSweep(start, arc.via, arc.to);
  const d = (p) => Math.hypot(p[0] - c.center[0], p[1] - c.center[1]);
  const at = (p0, s, t) => {
    const u = 1 - t;
    return [0, 1].map((i) =>
      u ** 3 * p0[i] + 3 * u * u * t * s.c1[i] + 3 * u * t * t * s.c2[i] + t ** 3 * s.to[i]);
  };
  let max = 0, p = start;
  for (const s of cubics) {
    for (let i = 0; i <= 200; i++) max = Math.max(max, Math.abs(d(at(p, s, i / 200)) - c.r));
    p = s.to;
  }
  return max;
};

const straightRun = (c1, c2) => ({ start: [0, 0], segments: [{ c1, c2, to: [100, 0] }] });

test("a shallow ASYMMETRIC cubic is left alone, not swallowed by a huge-radius fit", () => {
  // Reported case: fitted r = 913.6, max deviation 0.701 against the curve's own
  // sagitta of 1.427 — 49% error, accepted silently.
  const out = recoverArcs(straightRun([10, 3.0], [55, 0.4]));
  expect(out.segments[0].via).toBeUndefined();
  expect(out.segments[0].c1).toEqual([10, 3.0]);

  // …and the milder sibling from the same report (27% error) too.
  expect(recoverArcs(straightRun([20, 2.2], [70, 0.9])).segments[0].via).toBeUndefined();
});

test("a shallow cubic that really is near-circular still recovers, and accurately", () => {
  const run = straightRun([33, 1.5], [67, 1.5]);
  const out = recoverArcs(run);
  expect(out.segments[0].via).toBeDefined();
  // Fidelity, not just acceptance: within 2e-3 of the 100-unit chord.
  expect(deviationFromArc(run.start, run.segments, out.segments[0])).toBeLessThan(0.2);
});

test("a deep non-circular cubic stays a cubic (unchanged behaviour)", () => {
  expect(recoverArcs(straightRun([33, 40], [67, 40])).segments[0].via).toBeUndefined();
});

test("genuine circles still recover across four orders of magnitude of radius", () => {
  // The chord bound must not be so tight that a real large-radius circle — the
  // thing a radius-relative tolerance existed to protect — stops being one.
  for (const r of [0.5, 5, 100, 5000]) {
    const out = recoverArcs(paperCircle(0, 0, r));
    expect(out.segments.every((s) => s.via), `r=${r} lost its arcs`).toBe(true);
  }
});
