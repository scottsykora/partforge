import { describe, expect, test } from "vitest";
import * as THREE from "three";

import { sectionSegments } from "../../src/framework/cutaway-outline.js";

// Every emitted point, as Vector3s.
function points(segments) {
  const out = [];
  for (let i = 0; i < segments.length; i += 3) {
    out.push(new THREE.Vector3(segments[i], segments[i + 1], segments[i + 2]));
  }
  return out;
}

function segmentCount(segments) {
  return segments.length / 6;
}

function totalLength(segments) {
  let sum = 0;
  for (let i = 0; i < segments.length; i += 6) {
    sum += Math.hypot(
      segments[i + 3] - segments[i],
      segments[i + 4] - segments[i + 1],
      segments[i + 5] - segments[i + 2],
    );
  }
  return sum;
}

// A single triangle, given as three [x, y, z] triples.
function triangle(a, b, c) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c]), 3),
  );
  return geometry;
}

describe("sectionSegments", () => {
  test("cuts a box into its cross-section boundary", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);

    const segments = sectionSegments(geometry, plane);

    // The four side faces straddle the plane, two triangles each.
    expect(segmentCount(segments)).toBe(8);
    // Those eight segments tile the 2x2 square's perimeter exactly once.
    expect(totalLength(segments)).toBeCloseTo(8, 5);
    for (const point of points(segments)) {
      expect(point.x).toBeCloseTo(0, 6);
      expect(Math.max(Math.abs(point.y), Math.abs(point.z))).toBeCloseTo(1, 6);
    }
  });

  test("agrees between indexed and non-indexed geometry", () => {
    const indexed = new THREE.BoxGeometry(2, 2, 2);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25);

    const fromIndexed = sectionSegments(indexed, plane);
    const fromSoup = sectionSegments(indexed.toNonIndexed(), plane);

    expect(segmentCount(fromSoup)).toBe(segmentCount(fromIndexed));
    expect(totalLength(fromSoup)).toBeCloseTo(totalLength(fromIndexed), 5);
  });

  test("emits inner and outer loops for a section with a hole", () => {
    // A torus in the XY plane, sliced by that plane, sections into two
    // concentric circles: the hole boundary at r=2 and the outer at r=4.
    const geometry = new THREE.TorusGeometry(3, 1, 8, 24);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    const segments = sectionSegments(geometry, plane);
    const radii = points(segments).map((p) => Math.hypot(p.x, p.y));

    expect(segmentCount(segments)).toBe(48);
    for (const point of points(segments)) expect(point.z).toBeCloseTo(0, 6);
    expect(radii.filter((r) => Math.abs(r - 2) < 1e-6).length).toBe(48);
    expect(radii.filter((r) => Math.abs(r - 4) < 1e-6).length).toBe(48);
  });

  test("returns nothing when the plane misses the geometry", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -5);

    expect(sectionSegments(geometry, plane)).toEqual(new Float32Array(0));
  });

  test("returns nothing for geometry without positions", () => {
    expect(sectionSegments(new THREE.BufferGeometry(), new THREE.Plane()))
      .toEqual(new Float32Array(0));
    expect(sectionSegments(null, new THREE.Plane())).toEqual(new Float32Array(0));
  });

  test("a plane touching one vertex emits no segment", () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const grazing = triangle([0, 0, 0], [1, 1, 0], [-1, 1, 0]);

    expect(sectionSegments(grazing, plane)).toEqual(new Float32Array(0));
  });

  test("a plane crossing through one vertex emits one segment from it", () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const crossing = triangle([0, 0, 0], [2, 1, 0], [2, -1, 0]);

    const segments = sectionSegments(crossing, plane);

    expect(segmentCount(segments)).toBe(1);
    expect([...segments.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(segments[4]).toBeCloseTo(0, 6); // the far endpoint is on the plane too
    expect(segments[3]).toBeCloseTo(2, 6);
  });

  test("a triangle lying in the plane emits nothing", () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const coplanar = triangle([0, 0, 0], [1, 0, 0], [0, 0, 1]);

    expect(sectionSegments(coplanar, plane)).toEqual(new Float32Array(0));
  });

  test("every emitted point survives the plane's keep-rule", () => {
    const geometry = new THREE.SphereGeometry(3, 16, 12);
    const plane = new THREE.Plane(new THREE.Vector3(0.3, 0.8, 0.5).normalize(), -0.4);

    const segments = sectionSegments(geometry, plane);

    expect(segmentCount(segments)).toBeGreaterThan(0);
    for (const point of points(segments)) {
      // Same rule as pointSurvivesPlane: the outline sits exactly on the
      // boundary of the kept half, never inside the discarded one.
      expect(plane.distanceToPoint(point)).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});
