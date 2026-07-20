import { expect, test } from "vitest";
import * as THREE from "three";
import {
  axisParameterFromRay,
  initialCutawayPose,
  planeFromPose,
  pointSurvivesPlane,
  signedAngleAroundAxis,
} from "../../src/framework/cutaway-math.js";

test("initial pose centers the plane, points away from the camera, and sizes it to the box", () => {
  const box = new THREE.Box3(
    new THREE.Vector3(-5, -10, -15),
    new THREE.Vector3(5, 10, 15),
  );
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const pose = initialCutawayPose(box, camera);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  const diagonal = box.getSize(new THREE.Vector3()).length();

  expect(pose.position.toArray()).toEqual([0, 0, 0]);
  expect(normal.x).toBeCloseTo(0);
  expect(normal.y).toBeCloseTo(0);
  expect(normal.z).toBeCloseTo(-1);
  expect(pose.size).toBeCloseTo(diagonal * 1.25);
  expect(pose.size).toBeGreaterThan(diagonal);
  expect(pose).not.toHaveProperty("hatchSpacing");
});

test("plane pose keeps the positive side and flip reverses it", () => {
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const position = new THREE.Vector3(0, 0, 2);
  const quaternion = new THREE.Quaternion();

  expect(planeFromPose(plane, normal, position, quaternion, false)).toBe(plane);
  expect(normal.toArray()).toEqual([0, 0, 1]);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 1))).toBe(false);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 3))).toBe(true);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 2 - 0.5e-6))).toBe(true);

  planeFromPose(plane, normal, position, quaternion, true);
  expect(normal.x).toBeCloseTo(0);
  expect(normal.y).toBeCloseTo(0);
  expect(normal.z).toBeCloseTo(-1);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 1))).toBe(true);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 3))).toBe(false);
});

test("axis parameter finds the closest point and rejects parallel rays", () => {
  const ray = new THREE.Ray(
    new THREE.Vector3(3, 5, 10),
    new THREE.Vector3(0, 0, -1),
  );
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3(0, 1, 0);

  expect(axisParameterFromRay(ray, origin, direction)).toBeCloseTo(5);
  expect(axisParameterFromRay(
    new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
    origin,
    direction,
  )).toBeNull();
  expect(axisParameterFromRay(
    new THREE.Ray(
      new THREE.Vector3(),
      new THREE.Vector3(5e-4, 1, 0).normalize(),
    ),
    origin,
    direction,
  )).toBeNull();
});

test("signed angle preserves rotation direction around the axis", () => {
  const x = new THREE.Vector3(1, 0, 0);
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3(0, 0, 1);

  expect(signedAngleAroundAxis(x, y, z)).toBeCloseTo(Math.PI / 2);
  expect(signedAngleAroundAxis(y, x, z)).toBeCloseTo(-Math.PI / 2);
});
