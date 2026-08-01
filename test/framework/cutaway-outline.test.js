import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";

import { createSectionOutline, sectionSegments } from "../../src/framework/cutaway-outline.js";

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

describe("createSectionOutline", () => {
  function createFixture({ now } = {}) {
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial(),
    );
    parent.add(mesh);
    parent.updateMatrixWorld(true);
    // World-space plane through the mesh's centre (which sits at x = 10).
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -10);
    const outline = createSectionOutline({
      mesh,
      plane,
      inkColor: 0x1c232d,
      now,
    });
    outline.setVisible(true);
    return { parent, mesh, plane, outline };
  }

  test("parents a fat-line object to the mesh and slices in mesh-local space", () => {
    const { mesh, outline } = createFixture();

    expect(outline.object.parent).toBe(mesh);
    expect(mesh.children).toContain(outline.object);
    expect(outline.object.frustumCulled).toBe(false);

    expect(outline.refresh()).toBe(true);
    expect(outline.object.visible).toBe(true);

    // Local coordinates: the mesh is at x = 10 in world, so the world plane at
    // x = 10 is the local plane at x = 0.
    const positions = outline.object.geometry.attributes.instanceStart.data.array;
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(0, 5);
    }
  });

  test("re-slices only when the plane, transform, or geometry changes", () => {
    const { mesh, plane, outline } = createFixture();

    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);

    plane.constant = -10.5;
    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);

    // A transform change with no plane change still moves the section: the
    // plane is world-fixed, so recentring slides the part through it.
    mesh.position.set(0, 0.3, 0);
    mesh.updateMatrixWorld(true);
    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);

    mesh.geometry = new THREE.BoxGeometry(3, 3, 3);
    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);
  });

  test("hides itself when the plane misses the mesh", () => {
    const { plane, outline } = createFixture();

    outline.refresh();
    expect(outline.object.visible).toBe(true);

    plane.constant = -100;
    outline.refresh();
    expect(outline.object.visible).toBe(false);
  });

  test("visibility and suppression both gate the object", () => {
    const { outline } = createFixture();
    outline.refresh();

    outline.setSuppressed(true);
    expect(outline.object.visible).toBe(false);
    outline.setSuppressed(false);
    expect(outline.object.visible).toBe(true);

    outline.setVisible(false);
    expect(outline.object.visible).toBe(false);
  });

  test("skips slicing while hidden and catches up when shown", () => {
    const { plane, outline } = createFixture();
    outline.refresh();

    outline.setVisible(false);
    plane.constant = -10.25;
    expect(outline.refresh()).toBe(false);

    outline.setVisible(true);
    expect(outline.refresh()).toBe(true);
  });

  test("records the slice cost from the injected clock", () => {
    let clock = 0;
    const { outline } = createFixture({ now: () => (clock += 4) });

    expect(outline.sliceCost()).toBe(0);
    outline.refresh();
    expect(outline.sliceCost()).toBe(4);
  });

  test("ink, transparency, and viewport size reach the line material", () => {
    const { outline } = createFixture();

    outline.setInk(0xff0000);
    expect(outline.object.material.color.getHex()).toBe(0xff0000);

    outline.setTransparent(true);
    expect(outline.object.material.transparent).toBe(true);

    outline.setViewportSize(800, 600);
    expect(outline.object.material.resolution.toArray()).toEqual([800, 600]);
  });

  test("dispose detaches the object and releases its resources", () => {
    const { mesh, outline } = createFixture();
    outline.refresh();
    const material = outline.object.material;
    const disposeSpy = vi.spyOn(material, "dispose");

    outline.dispose();

    expect(mesh.children).not.toContain(outline.object);
    expect(disposeSpy).toHaveBeenCalled();
    expect(outline.refresh()).toBe(false);
  });
});
