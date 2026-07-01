// @vitest-environment happy-dom
import { expect, test } from "vitest";
import * as THREE from "three";
import { raycastViewer, featureAt } from "../src/framework/selection/raycast.js";

function makeViewer() {
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
  return { camera, domElement, _subMeshes: { one: mesh }, flashPoint: () => {} };
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
