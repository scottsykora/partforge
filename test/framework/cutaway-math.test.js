import { expect, test } from "vitest";
import * as THREE from "three";
import {
  AXIS_SNAP_RADIANS,
  axisParameterFromRay,
  initialCutawayPose,
  nearestCanonicalAxis,
  planeFromPose,
  pointSurvivesPlane,
  signedAngleAroundAxis,
  snapQuaternionToAxis,
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

test("nearest canonical axis picks the signed axis closest to a direction", () => {
  const axis = new THREE.Vector3();

  expect(nearestCanonicalAxis(new THREE.Vector3(1, 0, 0), axis).toArray()).toEqual([1, 0, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(-1, 0, 0), axis).toArray()).toEqual([-1, 0, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 1, 0), axis).toArray()).toEqual([0, 1, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, -1, 0), axis).toArray()).toEqual([0, -1, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 0, 1), axis).toArray()).toEqual([0, 0, 1]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 0, -1), axis).toArray()).toEqual([0, 0, -1]);

  // dominant-but-not-exact
  expect(nearestCanonicalAxis(new THREE.Vector3(0.2, -0.9, 0.3), axis).toArray())
    .toEqual([0, -1, 0]);
});

test("nearest canonical axis breaks ties in X, Y, Z order", () => {
  // The default isometric framing (camera at 18, 12, 18) is an exact tie
  // between -X and -Z; a strictly-greater comparison keeps the earlier axis.
  const isometric = new THREE.Vector3(-18, -12, -18).normalize();
  expect(nearestCanonicalAxis(isometric).toArray()).toEqual([-1, 0, 0]);

  expect(nearestCanonicalAxis(new THREE.Vector3(0, 1, 1).normalize()).toArray())
    .toEqual([0, 1, 0]);
});

test("nearest canonical axis falls back to +Z for degenerate directions", () => {
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 0, 0)).toArray()).toEqual([0, 0, 1]);
  expect(nearestCanonicalAxis(new THREE.Vector3(NaN, 1, 0)).toArray()).toEqual([0, 0, 1]);
});

test("initial pose snaps the plane normal to a canonical axis", () => {
  const box = new THREE.Box3(
    new THREE.Vector3(-5, -4, -3),
    new THREE.Vector3(5, 4, 3),
  );
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(18, 12, 18);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const pose = initialCutawayPose(box, camera);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);

  expect(normal.x).toBeCloseTo(-1);
  expect(normal.y).toBeCloseTo(0);
  expect(normal.z).toBeCloseTo(0);

  // A rotation between two axis vectors maps axes to axes, so the plane's
  // in-plane directions come out axis-aligned and the gizmo reads square.
  const inPlane = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
  for (const component of inPlane.toArray()) {
    expect(Math.abs(Math.abs(component) - Math.round(Math.abs(component)))).toBeLessThan(1e-6);
  }
});

test("axis snap threshold is 7 degrees", () => {
  expect(AXIS_SNAP_RADIANS).toBeCloseTo((7 * Math.PI) / 180, 10);
});

test("snapping pulls a near-axis normal exactly onto the axis", () => {
  const nudged = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (4 * Math.PI) / 180,
  );

  const snapped = snapQuaternionToAxis(nudged);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(snapped);

  expect(normal.x).toBeCloseTo(0, 6);
  expect(normal.y).toBeCloseTo(0, 6);
  expect(normal.z).toBeCloseTo(1, 6);
});

test("snapping leaves a normal outside the threshold alone", () => {
  const nudged = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (12 * Math.PI) / 180,
  );

  const snapped = snapQuaternionToAxis(nudged);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(snapped);

  expect(normal.angleTo(new THREE.Vector3(0, 0, 1))).toBeCloseTo((12 * Math.PI) / 180, 6);
});

test("snapping preserves in-plane roll so the gizmo rings do not spin", () => {
  const roll = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    Math.PI / 3,
  );
  const tilt = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (3 * Math.PI) / 180,
  );
  const pose = tilt.clone().multiply(roll);

  const snapped = snapQuaternionToAxis(pose);
  const rolledAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(snapped);
  const expected = new THREE.Vector3(1, 0, 0).applyQuaternion(roll);

  // The normal lands on +Z, and the in-plane direction stays where the roll
  // put it rather than jumping to whatever setFromUnitVectors would pick.
  expect(new THREE.Vector3(0, 0, 1).applyQuaternion(snapped).z).toBeCloseTo(1, 6);
  expect(rolledAxis.angleTo(expected)).toBeLessThan(0.06); // within the 3-degree tilt
});

test("snapping honours a custom threshold and writes into a target", () => {
  const nudged = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (10 * Math.PI) / 180,
  );
  const target = new THREE.Quaternion();

  const result = snapQuaternionToAxis(nudged, (12 * Math.PI) / 180, target);

  expect(result).toBe(target);
  expect(new THREE.Vector3(0, 0, 1).applyQuaternion(result).z).toBeCloseTo(1, 6);
});
