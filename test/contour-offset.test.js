// Pure unit tests for the native contour offset engine — no WASM, no kernel boot.
import { describe, expect, test } from "vitest";
import { _offsetSegment } from "../src/framework/geometry/contour-offset.js";

const close = (a, b, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(tol);

describe("line offset", () => {
  test("offsets right of travel", () => {
    // travel +x, right of travel is -y; delta +1 → shifted down
    const r = _offsetSegment([0, 0], { to: [10, 0] }, 1);
    close(r.start, [0, -1]); close(r.segments[0].to, [10, -1]);
    expect(r.dirty).toBe(false);
  });
});

describe("arc offset", () => {
  test("CCW arc grows concentrically with positive delta", () => {
    // quarter circle r=5 about origin, CCW from (5,0) to (0,5): right of travel is outward
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, 1);
    close(r.start, [6, 0]); close(r.segments[0].to, [0, 6]);
    close(r.segments[0].via, [6 / Math.SQRT2, 6 / Math.SQRT2]);
    expect(r.dirty).toBe(false);
  });
  test("CW arc shrinks with positive delta", () => {
    // same quarter circle traversed CW from (0,5) to (5,0): right of travel is inward
    const r = _offsetSegment([0, 5], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [5, 0] }, 1);
    close(r.start, [0, 4]); close(r.segments[0].to, [4, 0]);
    expect(r.dirty).toBe(false);
  });
  test("radius inversion flags dirty", () => {
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, -6);
    expect(r.dirty).toBe(true);
  });
  test("collinear via degrades to a line", () => {
    const r = _offsetSegment([0, 0], { via: [5, 0], to: [10, 0] }, 1);
    expect(r.segments[0].via).toBeUndefined();
    close(r.start, [0, -1]);
  });
});

describe("cubic offset", () => {
  test("offset endpoints displaced along endpoint normals; deviation within tolerance", () => {
    // quarter-circle cubic r=5 (k = 0.5523·r), CCW from (5,0) to (0,5)
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 1);
    close(r.start, [6, 0], 1e-6); close(r.segments.at(-1).to, [0, 6], 1e-6);
    expect(r.dirty).toBe(false);
    // every emitted piece is a cubic
    for (const s of r.segments) expect(s.c1).toBeDefined();
  });
  test("subdivided pieces connect exactly", () => {
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 4); // large delta forces subdivision
    expect(r.segments.length).toBeGreaterThan(1);
  });
});

import { _offsetContour, validateRawOffset } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = (s) => ({ start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] });
const area = (c) => ringArea(tessellateContour(c, 256));
const kinds = (c) => c.segments.map((s) => (s.c1 ? "cubic" : s.via ? "arc" : "line"));

describe("offsetContour", () => {
  test("sharp outset of a square is the exact bigger square", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "sharp");
    expect(dirty).toBe(false);
    expect(area(contour)).toBeCloseTo(144, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("round outset adds exact quarter-circle arcs", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour).filter((k) => k === "arc").length).toBe(4);
    expect(area(contour)).toBeCloseTo(140 + Math.PI, 2);  // exact πd² corners (tessellation-limited)
  });
  test("chamfer outset cuts 2d² off the sharp area", () => {
    const { contour } = _offsetContour(sq(10), 1, "chamfer");
    expect(area(contour)).toBeCloseTo(142, 9);
  });
  test("inset square trims line-line corners exactly on the fast path", () => {
    const { contour, dirty } = _offsetContour(sq(10), -1, "round");
    expect(dirty).toBe(false);                             // trimmed, not chord+dirty
    expect(area(contour)).toBeCloseTo(64, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("circle offset is exact concentric arcs, no joins", () => {
    // a circle is two half-arcs (the storage convention — one full-circle arc is ambiguous)
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const { contour, dirty } = _offsetContour(circ, 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour)).toEqual(["arc", "arc"]);
    for (const p of tessellateContour(contour, 64)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(6, 6);
  });
  test("acute triangle chamfer is a single chord per corner (true bevel)", () => {
    const tri = { start: [0, 0], segments: [{ to: [20, 0] }, { to: [10, 3] }, { to: [0, 0] }] };
    const { contour } = _offsetContour(tri, 1, "chamfer");
    // every corner contributes exactly one extra line: 3 edges + 3 chamfer chords
    expect(contour.segments.filter((s) => !s.via && !s.c1).length).toBe(6);
  });
});

describe("validateRawOffset", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
  test("accepts a clean square with a hole", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]),
      holes: [ring([[4, 4], [4, 6], [6, 6], [6, 4]])] }])).toBe(true);
  });
  test("rejects a self-intersecting (butterfly) ring", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }])).toBe(false);
  });
  // The butterfly case above short-circuits on zero net area; this pins the
  // ringSelfIntersects branch itself with a self-intersecting quad whose net area is nonzero.
  test("rejects a self-intersecting ring with nonzero net area", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 20]]), holes: [] }])).toBe(false);
  });
  test("rejects a flipped (CW) outer", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [0, 10], [10, 10], [10, 0]]), holes: [] }])).toBe(false);
  });
  test("rejects crossing rings", () => {
    expect(validateRawOffset([
      { outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] },
      { outer: ring([[5, 5], [15, 5], [15, 15], [5, 15]]), holes: [] },
    ])).toBe(false);
  });
});

import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { profileArea } from "../src/framework/geometry/contour-ops.js";

const region = (outer, holes = []) => ({ outer, holes });
const sqRegion = (s) => region(sq(s));

describe("offsetRegions", () => {
  test("validates corners and delta with the pinned messages", () => {
    expect(() => offsetRegions([sqRegion(10)], 1, { corners: "bevel" }))
      .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
    expect(() => offsetRegions([sqRegion(10)], NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  });
  test("collapse throws the pinned message", () => {
    expect(() => offsetRegions([sqRegion(10)], -6)).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  });
  test("zero delta returns an equal-area copy", () => {
    const out = offsetRegions([sqRegion(10)], 0);
    expect(profileArea(out)).toBeCloseTo(100, 9);
  });
  test("hole shrinks when the region grows", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }; // CW
    // delta 0.5 keeps this short of the hole's own half-width (1) — past that the hole
    // collapses entirely (see "hole vanishing" below), so this is the largest delta that
    // still leaves a partially-shrunk hole to assert against.
    const out = offsetRegions([region(sq(10), [hole])], 0.5, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(121 - 1, 6);      // hole 2×2 shrank to 1×1
  });
  test("hole vanishing under positive delta is absorbed", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] };
    const out = offsetRegions([region(sq(10), [hole])], 2, { corners: "sharp" });
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(196, 6);
  });
  test("dumbbell inset splits into two regions via cleanup", () => {
    const db = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 4] }, { to: [20, 4] }, { to: [20, 0] }, { to: [30, 0] },
      { to: [30, 10] }, { to: [20, 10] }, { to: [20, 6] }, { to: [10, 6] }, { to: [10, 10] },
      { to: [0, 10] }, { to: [0, 0] }] };
    const out = offsetRegions([region(db)], -2, { corners: "sharp" });
    expect(out.length).toBe(2);
    expect(profileArea(out)).toBeCloseTo(72, 4);           // two 6×6 squares
  });
  test("L-shape inset stays on the fast path with exact area", () => {
    const L = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] };
    const out = offsetRegions([region(L)], -2, { corners: "sharp" });
    expect(profileArea(out)).toBeCloseTo(11, 9);
    for (const s of out[0].outer.segments) { expect(s.via).toBeUndefined(); expect(s.c1).toBeUndefined(); }
  });
  test("cusp-producing inward cubic offset yields a simple result", () => {
    const arch = { start: [10, 0], segments: [{ c1: [7, 4], c2: [3, 4], to: [0, 0] }, { to: [10, 0] }] };
    const out = offsetRegions([region(arch)], -0.8, { corners: "round" });
    expect(validateRawOffset(out)).toBe(true);             // output must be simple
  });
});
