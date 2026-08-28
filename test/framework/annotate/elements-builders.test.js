// Drag → params builders: bounding boxes, magnetic 1:1 snap, 45° line snap.
import { expect, test } from "vitest";
import {
  rectFromDrag, ellipseFromDrag, lineFromDrag, appendThinned,
} from "../../../src/framework/annotate/elements.js";

test("rectFromDrag: any corner order yields the same box", () => {
  const a = rectFromDrag(0.2, 0.2, 0.6, 0.5).params;
  const b = rectFromDrag(0.6, 0.5, 0.2, 0.2).params;
  expect(a).toEqual(b);
  expect(a.cx).toBeCloseTo(0.4); expect(a.cy).toBeCloseTo(0.35);
  expect(a.w).toBeCloseTo(0.4); expect(a.h).toBeCloseTo(0.3);
  expect(a.rot).toBe(0);
});

test("magnetic square snap inside 12%, none outside, force always", () => {
  // 0.40 × 0.37 → ratio 0.925 > 0.88 → snaps
  const near = rectFromDrag(0, 0, 0.40, 0.37);
  expect(near.snapped).toBe(true);
  expect(near.params.w).toBeCloseTo(0.40);
  expect(near.params.h).toBeCloseTo(0.40);
  // 0.40 × 0.30 → ratio 0.75 → no snap
  const far = rectFromDrag(0, 0, 0.40, 0.30);
  expect(far.snapped).toBe(false);
  expect(far.params.h).toBeCloseTo(0.30);
  // force wins from any aspect
  const forced = rectFromDrag(0, 0, 0.40, 0.10, { force: true });
  expect(forced.snapped).toBe(true);
  expect(forced.params.h).toBeCloseTo(0.40);
});

test("ellipseFromDrag fills the box; circle snap mirrors the rect rule", () => {
  const e = ellipseFromDrag(0.2, 0.2, 0.6, 0.4).params;
  expect(e.cx).toBeCloseTo(0.4); expect(e.cy).toBeCloseTo(0.3);
  expect(e.rx).toBeCloseTo(0.2); expect(e.ry).toBeCloseTo(0.1);
  const circle = ellipseFromDrag(0, 0, 0.4, 0.38);
  expect(circle.snapped).toBe(true);
  expect(circle.params.rx).toBe(circle.params.ry);
});

test("lineFromDrag: distance-based 0/45/90° magnet, free angles kept, force always snaps", () => {
  const SNAP = { snapDistance: 0.02 };
  // cursor 0.01 above horizontal: inside the magnet → snaps flat, length preserved
  const flat = lineFromDrag(0, 0, 0.5, 0.01, SNAP);
  expect(flat.snapped).toBe(true);
  expect(flat.params.y2).toBeCloseTo(0);
  expect(flat.params.x2).toBeCloseTo(Math.hypot(0.5, 0.01));
  // cursor 0.05 off horizontal: outside the magnet → endpoint kept as dragged
  const free = lineFromDrag(0, 0, 0.5, 0.05, SNAP);
  expect(free.snapped).toBe(false);
  expect(free.params).toMatchObject({ x1: 0, y1: 0, x2: 0.5, y2: 0.05 });
  // near-vertical: snaps upright
  const upright = lineFromDrag(0, 0, 0.01, 0.5, SNAP);
  expect(upright.snapped).toBe(true);
  expect(upright.params.x2).toBeCloseTo(0);
  // near the diagonal (perp distance ≈ len·sin(1.2°) ≈ 0.015 < 0.02) → 45°
  const diag = lineFromDrag(0, 0, 0.5, 0.48, SNAP);
  expect(diag.snapped).toBe(true);
  expect(diag.params.x2).toBeCloseTo(diag.params.y2);
  // the SAME angle on a longer line is farther from the snapped line — no snap:
  // distance scales with length, which is the point of pixel-space snapping
  const longFree = lineFromDrag(0, 0, 1.0, 0.03, SNAP);   // ~1.7°, perp ≈ 0.03
  expect(longFree.snapped).toBe(false);
  const shortSnap = lineFromDrag(0, 0, 0.3, 0.009, SNAP); // same ~1.7°, perp ≈ 0.009
  expect(shortSnap.snapped).toBe(true);
  // no snapDistance given → no magnet at all
  expect(lineFromDrag(0, 0, 0.5, 0.005).snapped).toBe(false);
  // force (shift) snaps from any angle: ~11° → 0°
  const forced = lineFromDrag(0, 0, 0.5, 0.1, { force: true }).params;
  expect(forced.y2).toBeCloseTo(0);
  expect(forced.x2).toBeCloseTo(Math.hypot(0.5, 0.1));
});

test("appendThinned drops sub-threshold points and keeps the rest", () => {
  const pts = [[0.5, 0.5]];
  expect(appendThinned(pts, 0.5005, 0.5, 0.0015)).toBe(false);
  expect(pts.length).toBe(1);
  expect(appendThinned(pts, 0.52, 0.5, 0.0015)).toBe(true);
  expect(pts).toEqual([[0.5, 0.5], [0.52, 0.5]]);
});
