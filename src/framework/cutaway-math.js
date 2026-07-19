import * as THREE from "three";

const PLANE_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);
const MIN_HATCH_MM = 0.5;
const MAX_HATCH_MM = 12;
const HATCHES_ACROSS_DIAGONAL = 24;
const POINT_EPSILON = 1e-6;
const PARALLEL_EPSILON = 1e-8;

export function hatchSpacingForDiagonal(diagonal) {
  return THREE.MathUtils.clamp(
    diagonal / HATCHES_ACROSS_DIAGONAL,
    MIN_HATCH_MM,
    MAX_HATCH_MM,
  );
}

export function initialCutawayPose(box, camera) {
  const position = box.getCenter(new THREE.Vector3());
  const diagonal = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
  const normal = camera.getWorldDirection(new THREE.Vector3()).negate().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    PLANE_LOCAL_NORMAL,
    normal,
  );

  return {
    position,
    quaternion,
    size: diagonal * 1.25,
    hatchSpacing: hatchSpacingForDiagonal(diagonal),
  };
}

export function planeFromPose(plane, normalTarget, position, quaternion, flipped) {
  normalTarget.copy(PLANE_LOCAL_NORMAL).applyQuaternion(quaternion).normalize();
  if (flipped) normalTarget.negate();
  return plane.setFromNormalAndCoplanarPoint(normalTarget, position);
}

export function pointSurvivesPlane(plane, point, epsilon = POINT_EPSILON) {
  return plane.distanceToPoint(point) <= epsilon;
}

export function axisParameterFromRay(ray, axisOrigin, axisDirection) {
  const axis = axisDirection.clone().normalize();
  const w0 = ray.origin.clone().sub(axisOrigin);
  const b = ray.direction.dot(axis);
  const d = ray.direction.dot(w0);
  const e = axis.dot(w0);
  const denominator = 1 - b * b;

  if (Math.abs(denominator) < PARALLEL_EPSILON) return null;
  return (e - b * d) / denominator;
}

export function signedAngleAroundAxis(from, to, axis) {
  const fromDirection = from.clone().normalize();
  const toDirection = to.clone().normalize();
  return Math.atan2(
    axis.dot(fromDirection.clone().cross(toDirection)),
    fromDirection.dot(toDirection),
  );
}
