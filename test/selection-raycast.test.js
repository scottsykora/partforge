// @vitest-environment happy-dom
import { expect, test } from "vitest";
import * as THREE from "three";
import { raycastViewer, featureAt } from "../src/framework/selection/raycast.js";

function makeViewer({ isWorldPointVisible } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const geo = new THREE.BoxGeometry(4, 4, 4).toNonIndexed(); // non-indexed like Manifold payloads
  const nTri = geo.getAttribute("position").count / 3;
  geo.userData.featureIds = new Uint16Array(nTri).fill(1);
  geo.userData.features = ["Test feature"];
  const mesh = new THREE.Mesh(geo);
  mesh.name = "one";
  mesh.visible = true;
  new THREE.Group().add(mesh); // hover adds overlays to mesh.parent
  mesh.parent.updateMatrixWorld(true);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  return {
    camera,
    domElement,
    _subMeshes: { one: mesh },
    flashPoint: () => {},
    ...(isWorldPointVisible ? { isWorldPointVisible } : {}),
  };
}

test("raycastViewer resolves subPart, triangle, local point, and feature", () => {
  const viewer = makeViewer();
  const hit = raycastViewer(viewer, 100, 100); // dead centre → hits the box front face
  expect(hit).not.toBeNull();
  expect(hit.subPart).toBe("one");
  expect(hit.feature).toEqual({ id: 1, label: "Test feature" });
  expect(hit.pointLocal[2]).toBeCloseTo(2, 4); // front face of the 4mm box
  expect(hit.triIndex).toBeGreaterThanOrEqual(0);
});

test("raycastViewer returns null on a miss", () => {
  const viewer = makeViewer();
  expect(raycastViewer(viewer, 1, 1)).toBeNull(); // corner ray misses the box
});

test("featureAt is null when the geometry has no feature data", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  expect(featureAt(mesh, 0)).toBeNull();
});

test("invisible meshes are not hit", () => {
  const viewer = makeViewer();
  viewer._subMeshes.one.visible = false;
  expect(raycastViewer(viewer, 100, 100)).toBeNull();
});

test("raycast skips a clipped front hit and returns the retained back hit", () => {
  const viewer = makeViewer({ isWorldPointVisible: (point) => point.z < 0 });
  viewer._subMeshes.one.material.side = THREE.DoubleSide;
  const hit = raycastViewer(viewer, 100, 100);
  expect(hit).not.toBeNull();
  expect(hit.pointWorld.z).toBeCloseTo(-2, 4);
});

test("raycast behavior is unchanged without a visibility predicate", () => {
  const viewer = makeViewer();
  expect(raycastViewer(viewer, 100, 100).pointWorld.z).toBeCloseTo(2, 4);
});

test("a fast-path pose on the sub-part is reflected in the reported point and normal", () => {
  // The viewer's pose fast path writes a rigid matrix straight onto the sub-part
  // mesh (viewer.setSubPose). Selection coords must describe the part as it is
  // now posed, not the frame the delivered mesh was baked in.
  const viewer = makeViewer();
  const mesh = viewer._subMeshes.one;
  mesh.matrixAutoUpdate = false;
  // rotate +90° about X, then lift +1 in Z — the box's +Y geometry face becomes
  // the +Z-facing face, and the front face lands at z = 3.
  mesh.matrix
    .makeRotationX(Math.PI / 2)
    .premultiply(new THREE.Matrix4().makeTranslation(0, 0, 1));
  mesh.parent.updateMatrixWorld(true);

  const hit = raycastViewer(viewer, 100, 100);
  expect(hit).not.toBeNull();
  expect(hit.pointWorld.z).toBeCloseTo(3, 4);
  // posed frame: [0, 0, 3] — NOT the delivered-geometry frame's [0, 2, 0]
  expect(hit.pointLocal[0]).toBeCloseTo(0, 4);
  expect(hit.pointLocal[1]).toBeCloseTo(0, 4);
  expect(hit.pointLocal[2]).toBeCloseTo(3, 4);
  // the hit triangle's geometry normal is +Y; the pose rotates it to +Z
  expect(hit.normalLocal[0]).toBeCloseTo(0, 4);
  expect(hit.normalLocal[1]).toBeCloseTo(0, 4);
  expect(hit.normalLocal[2]).toBeCloseTo(1, 4);
});

// --- cutaway section picks --------------------------------------------------
// A cut face has no geometry of its own: the ray's only front-face hit is the
// discarded outer wall. These pin the parity test that decides whether the
// sub-part is actually solid where the ray crosses the plane.

// Keeps the half a THREE.Plane calls nonnegative, matching three's clipping.
function sectionViewer(planeNormal, constant) {
  const plane = new THREE.Plane(planeNormal, constant);
  const viewer = makeViewer({
    isWorldPointVisible: (point) => plane.distanceToPoint(point) >= -1e-6,
  });
  viewer.getCutawayPlane = (target = new THREE.Plane()) => target.copy(plane);
  return viewer;
}

test("a click on the cut face picks the point where the ray enters the retained half", () => {
  // Camera at +z looking down -z; the section keeps z <= 0, so the ray crosses
  // into it at z = 0 — a point squarely inside the 4mm box.
  const viewer = sectionViewer(new THREE.Vector3(0, 0, -1), 0);
  const hit = raycastViewer(viewer, 100, 100, { includeSection: true });
  expect(hit).not.toBeNull();
  expect(hit.onCutPlane).toBe(true);
  expect(hit.subPart).toBe("one");
  expect(hit.pointWorld.z).toBeCloseTo(0, 6);
  // The cut face looks back at the half that was removed.
  expect(hit.normalLocal[2]).toBeCloseTo(1, 6);
  // A cut face is not a built feature, however well labelled the solid is.
  expect(hit.feature).toBeNull();
});

test("no section pick where the ray has already left the solid before the plane", () => {
  // Keeping z <= -5 puts the crossing outside the box entirely: the ray enters
  // at z = 2 and exits at z = -2, so it is in empty space at the plane.
  const viewer = sectionViewer(new THREE.Vector3(0, 0, -1), -5);
  expect(raycastViewer(viewer, 100, 100, { includeSection: true })).toBeNull();
});

test("a section pick is not offered where the ray misses the part", () => {
  const viewer = sectionViewer(new THREE.Vector3(0, 0, -1), 0);
  expect(raycastViewer(viewer, 1, 1, { includeSection: true })).toBeNull();
});

test("a retained surface in front of the cut still wins", () => {
  // Keeping z <= 10 leaves the whole box retained: the crossing is in front of
  // the part, where there is nothing to be solid.
  const viewer = sectionViewer(new THREE.Vector3(0, 0, -1), 10);
  const hit = raycastViewer(viewer, 100, 100, { includeSection: true });
  expect(hit).not.toBeNull();
  expect(hit.onCutPlane).toBeUndefined();
  expect(hit.pointWorld.z).toBeCloseTo(2, 4);
});

test("section picks are opt-in — hover and measurement see real geometry only", () => {
  const viewer = sectionViewer(new THREE.Vector3(0, 0, -1), 0);
  expect(raycastViewer(viewer, 100, 100)).toBeNull();
});

test("no section pick without a cutaway plane", () => {
  const viewer = makeViewer();
  viewer.getCutawayPlane = () => null; // what the viewer answers while disabled
  expect(raycastViewer(viewer, 100, 100, { includeSection: true }).onCutPlane).toBeUndefined();
});
