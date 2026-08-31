import { expect, test } from "vitest";
import * as THREE from "three";
import {
  anchorMoved,
  flashWorldRadius,
  projectToScreen,
  worldPerPixel,
  FLASH_PIXEL_RADIUS,
} from "../src/framework/pick-flash.js";

function perspective() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

test("perspective sizing scales with view depth, so a dot holds its pixel size", () => {
  const camera = perspective();
  const near = worldPerPixel(camera, new THREE.Vector3(0, 0, 0), 400);   // 10 deep
  const far = worldPerPixel(camera, new THREE.Vector3(0, 0, -10), 400);  // 20 deep
  // A 60° fov spans 2·tan(30°)·depth world units over the viewport's height.
  expect(near).toBeCloseTo((2 * Math.tan(Math.PI / 6) * 10) / 400, 9);
  expect(far).toBeCloseTo(near * 2, 9);
});

test("perspective sizing measures depth along the view axis, not distance to the eye", () => {
  const camera = perspective();
  const onAxis = worldPerPixel(camera, new THREE.Vector3(0, 0, 0), 400);
  const offAxis = worldPerPixel(camera, new THREE.Vector3(6, 0, 0), 400); // farther from the eye, same depth
  expect(offAxis).toBeCloseTo(onAxis, 9);
});

test("orthographic sizing follows the frustum and its zoom, not the point", () => {
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  expect(worldPerPixel(camera, new THREE.Vector3(0, 0, 0), 400)).toBeCloseTo(16 / 400, 9);
  // Depth is irrelevant under ortho: the same answer anywhere along the ray.
  expect(worldPerPixel(camera, new THREE.Vector3(0, 0, -50), 400)).toBeCloseTo(16 / 400, 9);
  camera.zoom = 4;
  expect(worldPerPixel(camera, new THREE.Vector3(0, 0, 0), 400)).toBeCloseTo(16 / 4 / 400, 9);
});

test("flashWorldRadius is the pixel radius in world units", () => {
  const camera = perspective();
  const perPixel = worldPerPixel(camera, new THREE.Vector3(0, 0, 0), 400);
  expect(flashWorldRadius(camera, new THREE.Vector3(0, 0, 0), 400)).toBeCloseTo(
    perPixel * FLASH_PIXEL_RADIUS,
    9,
  );
  expect(flashWorldRadius(camera, new THREE.Vector3(0, 0, 0), 400, 20)).toBeCloseTo(
    perPixel * 20,
    9,
  );
});

test("a degenerate viewport or a point at the eye still yields a usable scale", () => {
  const camera = perspective();
  expect(flashWorldRadius(camera, new THREE.Vector3(0, 0, 0), 0)).toBeGreaterThan(0);
  // A point exactly at the camera has zero depth — scale must not collapse to 0.
  expect(flashWorldRadius(camera, camera.position.clone(), 400)).toBeGreaterThan(0);
});

test("projectToScreen puts a centred point in the middle of the canvas", () => {
  const camera = perspective(); // at z=10 looking at the origin
  const a = projectToScreen(camera, new THREE.Vector3(0, 0, 0), 800, 400);
  expect(a.x).toBeCloseTo(400, 6);
  expect(a.y).toBeCloseTo(200, 6);
  expect(a.visible).toBe(true);
});

test("projectToScreen puts +Y up the screen, not down", () => {
  // Screen y grows downward; world +Y is up, so a point above the origin must
  // land ABOVE the centre line. Getting this backwards is the classic NDC bug
  // and it is invisible in a symmetric test.
  const camera = perspective();
  const above = projectToScreen(camera, new THREE.Vector3(0, 1, 0), 800, 400);
  expect(above.y).toBeLessThan(200);
  expect(above.x).toBeCloseTo(400, 6);
});

test("a point behind the camera is not visible", () => {
  const camera = perspective(); // eye at z = 10 looking toward -z
  expect(projectToScreen(camera, new THREE.Vector3(0, 0, 40), 800, 400).visible).toBe(false);
});

test("a point off the side of the canvas reports its position and visible:false", () => {
  const camera = perspective();
  const off = projectToScreen(camera, new THREE.Vector3(40, 0, 0), 800, 400);
  expect(off.visible).toBe(false);
  // Still reported: the caller decides what an off-stage anchor means.
  expect(Number.isFinite(off.x)).toBe(true);
});

test("projectToScreen works under an orthographic camera", () => {
  const camera = new THREE.OrthographicCamera(-10, 10, 5, -5, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const a = projectToScreen(camera, new THREE.Vector3(5, 0, 0), 800, 400);
  expect(a.x).toBeCloseTo(600, 6); // +5 of a 20-wide frustum = three quarters across
  expect(a.visible).toBe(true);
});

test("anchorMoved ignores sub-pixel drift and notices a visibility flip", () => {
  const at = (x, y, visible = true) => ({ x, y, visible });
  expect(anchorMoved(at(10, 10), at(10.2, 10.2))).toBe(false);
  expect(anchorMoved(at(10, 10), at(11, 10))).toBe(true);
  expect(anchorMoved(at(10, 10), at(10, 10, false))).toBe(true);
  expect(anchorMoved(null, at(10, 10))).toBe(true);
  expect(anchorMoved(null, null)).toBe(false);
});
