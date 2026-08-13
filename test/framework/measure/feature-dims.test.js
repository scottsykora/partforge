// Pure dimension engine: triangle subsets -> plane / cylinder / bbox specs.
import { expect, test } from "vitest";
import { classifyFeature, bboxSpec, unionBounds, fmtMm } from "../../../src/framework/measure/feature-dims.js";

// Non-indexed unit square in the XY plane (normal +Z), feature 1.
function square({ w = 1, h = 1, z = 0 } = {}) {
  const positions = new Float32Array([
    0, 0, z,  w, 0, z,  w, h, z,
    0, 0, z,  w, h, z,  0, h, z,
  ]);
  return { positions, featureIds: new Uint16Array([1, 1]) };
}

// Open tube (no caps): radius r, height along +Z, `seg` segments over `arc` radians.
function tube({ r = 4, height = 10, seg = 24, arc = Math.PI * 2, id = 1 } = {}) {
  const pos = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (arc * i) / seg, a1 = (arc * (i + 1)) / seg;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    pos.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], height);
    pos.push(p0[0], p0[1], 0, p1[0], p1[1], height, p0[0], p0[1], height);
  }
  const positions = new Float32Array(pos);
  return { positions, featureIds: new Uint16Array(positions.length / 9).fill(id) };
}

test("planar axis-snapped face -> plane spec with global-axis extents", () => {
  const spec = classifyFeature(square({ w: 24, h: 12.5 }), 1);
  expect(spec.kind).toBe("plane");
  expect(spec.values).toEqual({ width: 24, height: 12.5 });
  // normal +Z -> basis (X, Y); width anchors run along X at the vMin edge
  expect(spec.anchors.width.a[1]).toBeCloseTo(0);
  expect(spec.anchors.width.b[0]).toBeCloseTo(24);
  expect(spec.anchors.normal).toEqual([0, 0, 1]);
});

test("indexed planar face classifies identically", () => {
  const positions = new Float32Array([0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const spec = classifyFeature({ positions, indices, featureIds: new Uint16Array([1, 1]) }, 1);
  expect(spec.kind).toBe("plane");
  expect(spec.values).toEqual({ width: 4, height: 3 });
});

test("full tube -> cylinder spec with diameter and depth", () => {
  const spec = classifyFeature(tube({ r: 4, height: 10 }), 1);
  expect(spec.kind).toBe("cylinder");
  expect(spec.values.diameter).toBeCloseTo(8, 1);
  expect(spec.values.depth).toBeCloseTo(10, 5);
  expect(spec.values.partial).toBe(false);
  // axis is ±Z
  expect(Math.abs(spec.anchors.axis[2])).toBeCloseTo(1, 5);
});

test("120° arc -> partial cylinder (R notation)", () => {
  const spec = classifyFeature(tube({ arc: (2 * Math.PI) / 3 }), 1);
  expect(spec.kind).toBe("cylinder");
  expect(spec.values.partial).toBe(true);
});

test("irregular soup falls back to bbox", () => {
  const positions = new Float32Array([
    0, 0, 0, 3, 0, 1, 0, 2, 2,
    0, 0, 0, 0, 2, 2, 1, 1, 3,
  ]);
  const spec = classifyFeature({ positions, featureIds: new Uint16Array([1, 1]) }, 1);
  expect(spec.kind).toBe("bbox");
  expect(spec.values).toEqual({ w: 3, d: 2, h: 3 });
});

test("unknown feature id -> null", () => {
  expect(classifyFeature(square(), 9)).toBeNull();
});

test("bboxSpec + unionBounds + fmtMm", () => {
  const u = unionBounds([
    { min: [0, 0, 0], max: [1, 1, 1] },
    { min: [-2, 0, 0], max: [0, 5, 0.5] },
  ]);
  expect(u).toEqual({ min: [-2, 0, 0], max: [1, 5, 1] });
  expect(bboxSpec(u.min, u.max).values).toEqual({ w: 3, d: 5, h: 1 });
  expect(fmtMm(8)).toBe("8.00");
});
