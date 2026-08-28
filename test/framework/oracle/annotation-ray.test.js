// Pure-math reconstruction of sketch-payload pick rays, and ray-plane
// intersection. Parity target: THREE.Raycaster.setFromCamera (spec
// 2026-08-28-annotation-ray-design.md).
import { expect, test } from "vitest";
import * as THREE from "three";
import { annotationRay, rayPlane } from "../../../src/framework/oracle/annotation-ray.js";

// A minimal v3-shaped payload: same camera in both frames so either can be
// exercised; aspect matches the camera.
const payload = (cam, aspect = 2) => ({
  camera: { world: cam, parts: cam },
  viewport: { aspect },
});

const PERSP = {
  pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0],
  projection: "perspective", fov: 90, orthoHeight: null,
};
const ORTHO = {
  pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0],
  projection: "orthographic", fov: null, orthoHeight: 40,
};

test("perspective: center ray runs along forward from the camera position", () => {
  const { origin, dir } = annotationRay(payload(PERSP), [0.5, 0.5]);
  expect(origin).toEqual([0, 0, 10]);
  expect(dir[0]).toBeCloseTo(0, 12);
  expect(dir[1]).toBeCloseTo(0, 12);
  expect(dir[2]).toBeCloseTo(-1, 12);
});

test("perspective: right edge tilts by tan(fov/2)·aspect", () => {
  // fov 90 → tan 45° = 1; aspect 2 → unnormalized dir [2, 0, -1]
  const { dir } = annotationRay(payload(PERSP), [1, 0.5]);
  const len = Math.hypot(2, 0, 1);
  expect(dir[0]).toBeCloseTo(2 / len, 12);
  expect(dir[1]).toBeCloseTo(0, 12);
  expect(dir[2]).toBeCloseTo(-1 / len, 12);
});

test("orthographic: origin slides in the camera plane, dir stays forward", () => {
  // screen [0,0] = top-left → nx −1, ny +1 → origin [−40, 20, 10]
  const { origin, dir } = annotationRay(payload(ORTHO), [0, 0]);
  expect(origin[0]).toBeCloseTo(-40, 12);
  expect(origin[1]).toBeCloseTo(20, 12);
  expect(origin[2]).toBeCloseTo(10, 12);
  expect(dir).toEqual([0, 0, -1]);
});

test("anchor objects pass straight through via their .screen", () => {
  const direct = annotationRay(payload(PERSP), [0.25, 0.75]);
  const viaAnchor = annotationRay(payload(PERSP), { at: "mid", screen: [0.25, 0.75], hit: null });
  expect(viaAnchor).toEqual(direct);
});

test("frame selection and its errors", () => {
  const p = payload(PERSP);
  expect(annotationRay(p, [0.5, 0.5], { frame: "world" }))
    .toEqual(annotationRay(p, [0.5, 0.5])); // same cam in both frames here
  expect(() => annotationRay({ ...p, camera: { world: PERSP, parts: null } }, [0.5, 0.5]))
    .toThrow('annotationRay: payload.camera.parts is null — the sketch was sent with no meshes (use { frame: "world" })');
  expect(() => annotationRay(p, [0.5, 0.5], { frame: "screen" }))
    .toThrow('annotationRay: frame must be "parts" or "world"');
  expect(() => annotationRay(p, [0.5, 1.5]))
    .toThrow("annotationRay: screen must be [x, y] with each in 0..1");
  expect(() => annotationRay({ camera: { parts: PERSP }, viewport: {} }, [0.5, 0.5]))
    .toThrow("annotationRay: payload has no camera/viewport block");
});

test("rayPlane: shorthand planes, custom planes, and t units", () => {
  const ray = { origin: [0, 0, 10], dir: [0, 0, -1] };
  expect(rayPlane(ray, "xy")).toEqual({ point: [0, 0, 0], t: 10 });
  const custom = rayPlane(ray, { point: [0, 0, 2], normal: [0, 0, 1] });
  expect(custom.t).toBeCloseTo(8, 12);
  expect(custom.point[2]).toBeCloseTo(2, 12);
  // yz and zx pass through the origin with x/y normals
  expect(rayPlane({ origin: [5, 0, 0], dir: [-1, 0, 0] }, "yz").t).toBe(5);
  expect(rayPlane({ origin: [0, 5, 0], dir: [0, -1, 0] }, "zx").t).toBe(5);
});

test("rayPlane misses return null: parallel and behind-origin", () => {
  expect(rayPlane({ origin: [0, 0, 10], dir: [1, 0, 0] }, "xy")).toBeNull();
  expect(rayPlane({ origin: [0, 0, -5], dir: [0, 0, -1] }, "xy")).toBeNull();
  // degenerate zero vectors fall out as parallel, not as a throw
  expect(rayPlane({ origin: [0, 0, 1], dir: [0, 0, 0] }, "xy")).toBeNull();
});

test("rayPlane input validation", () => {
  expect(() => rayPlane({ origin: [0, 0, 0] }, "xy"))
    .toThrow("rayPlane: ray must be {origin, dir}");
  expect(() => rayPlane({ origin: [0, 0, 1], dir: [0, 0, -1] }, "top"))
    .toThrow('rayPlane: plane must be {point, normal} or "xy"|"yz"|"zx"');
});

// ---- parity with three ------------------------------------------------------
// The helper must reproduce THREE.Raycaster.setFromCamera. Directions compare
// directly; origins compare after canonicalizing three's origin to the point
// on the ray line nearest the camera position (a no-op for perspective, the
// near-plane → camera-plane slide for orthographic) — the same
// canonicalization annotate-mode applies to embedded rays.
const GRID = [0, 0.25, 0.5, 0.75, 1];

function canonicalize(ray, camPos) {
  const toCam = camPos.clone().sub(ray.origin);
  return ray.origin.clone().add(ray.direction.clone().multiplyScalar(toCam.dot(ray.direction)));
}

function checkParity(camera, camBlock, aspect) {
  camera.lookAt(new THREE.Vector3(...camBlock.target));
  camera.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  for (const sx of GRID) for (const sy of GRID) {
    raycaster.setFromCamera(new THREE.Vector2(2 * sx - 1, 1 - 2 * sy), camera);
    const mine = annotationRay(payload(camBlock, aspect), [sx, sy]);
    const threeOrigin = canonicalize(raycaster.ray, camera.position);
    for (let i = 0; i < 3; i++) {
      expect(mine.dir[i]).toBeCloseTo(raycaster.ray.direction.getComponent(i), 6);
      expect(mine.origin[i]).toBeCloseTo(threeOrigin.getComponent(i), 6);
    }
  }
}

test("parity with THREE.Raycaster: perspective, off-axis camera", () => {
  const cam = {
    pos: [30, 40, 50], target: [1, 2, 3], up: [0, 1, 0],
    projection: "perspective", fov: 45, orthoHeight: null,
  };
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(...cam.pos);
  checkParity(camera, cam, 2);
});

test("parity with THREE.Raycaster: orthographic, off-axis camera", () => {
  const cam = {
    pos: [30, 40, 50], target: [1, 2, 3], up: [0, 1, 0],
    projection: "orthographic", fov: null, orthoHeight: 40,
  };
  // width = orthoHeight · aspect = 80 → left/right ±40, top/bottom ±20
  const camera = new THREE.OrthographicCamera(-40, 40, 20, -20, 0.1, 1000);
  camera.position.set(...cam.pos);
  checkParity(camera, cam, 2);
});
