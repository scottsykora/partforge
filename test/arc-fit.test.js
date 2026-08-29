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
