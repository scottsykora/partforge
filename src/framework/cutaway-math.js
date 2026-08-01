import * as THREE from "three";

const PLANE_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);
const POINT_EPSILON = 1e-6;
const PARALLEL_EPSILON = 1e-6;

// Nearest signed canonical axis (+/-X, +/-Y, +/-Z) to `direction`. Axes are
// scanned X, Y, Z and replaced only on a strictly larger |component|, so a tie
// resolves to the earlier axis — the default isometric framing is an exact tie
// between -X and -Z and lands on -X. Degenerate input falls back to +Z.
export function nearestCanonicalAxis(direction, target = new THREE.Vector3()) {
  const components = [direction.x, direction.y, direction.z];
  if (!components.every(Number.isFinite)) return target.set(0, 0, 1);

  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < 3; i++) {
    const score = Math.abs(components[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return target.set(0, 0, 1);

  // Built by setComponent rather than negating a unit axis: multiplying a zero
  // component by -1 yields -0, and toEqual([0, -1, 0]) does not accept -0.
  return target.set(0, 0, 0).setComponent(bestIndex, components[bestIndex] < 0 ? -1 : 1);
}

export function initialCutawayPose(box, camera) {
  const position = box.getCenter(new THREE.Vector3());
  const diagonal = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
  // Square the cut plane up with the part rather than the camera: the axis
  // nearest the view direction, so the near half is still what gets cut away.
  const normal = nearestCanonicalAxis(
    camera.getWorldDirection(new THREE.Vector3()).normalize(),
  );
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    PLANE_LOCAL_NORMAL,
    normal,
  );

  return {
    position,
    quaternion,
    size: diagonal * 1.25,
  };
}

export function planeFromPose(plane, normalTarget, position, quaternion, flipped) {
  normalTarget.copy(PLANE_LOCAL_NORMAL).applyQuaternion(quaternion).normalize();
  if (flipped) normalTarget.negate();
  return plane.setFromNormalAndCoplanarPoint(normalTarget, position);
}

export function pointSurvivesPlane(plane, point, epsilon = POINT_EPSILON) {
  // three.js clipping retains the nonnegative side of a THREE.Plane.
  return plane.distanceToPoint(point) >= -epsilon;
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
