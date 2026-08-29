// Sizing for the transient pick marker (viewer.flashPoint).
//
// The marker used to be a fixed 1.2 mm sphere — a constant WORLD size, so it
// swelled to cover the very feature it was pointing at as soon as you zoomed
// in, and shrank to nothing on a large part. Sizing it from the camera each
// frame keeps it a constant handful of CSS pixels under both projections.
import * as THREE from "three";

export const FLASH_PIXEL_RADIUS = 5; // CSS px — a ~10px dot, the size it read as at default framing

const MIN_RADIUS = 1e-6; // never a zero-scale matrix

const _offset = new THREE.Vector3();
const _forward = new THREE.Vector3();

// World units spanned by one CSS pixel at `worldPoint`, for `camera`.
//
// Perspective: the frustum widens with view depth, so the answer is measured
// along the view direction rather than as a straight distance to the camera —
// an off-axis point is farther from the eye than it is deep, and would size a
// fraction too large. Orthographic: depth does not enter into it at all; the
// frustum height (as zoom leaves it) is the whole story.
export function worldPerPixel(camera, worldPoint, viewportHeightPx) {
  const height = viewportHeightPx > 0 ? viewportHeightPx : 1;
  if (camera.isOrthographicCamera) {
    const extent = Math.abs(camera.top - camera.bottom) / (camera.zoom || 1);
    return extent / height;
  }
  camera.getWorldDirection(_forward);
  const depth = Math.abs(_offset.copy(worldPoint).sub(camera.position).dot(_forward));
  const fov = ((camera.fov ?? 50) * Math.PI) / 180;
  return (2 * Math.tan(fov / 2) * depth) / height;
}

// Radius, in world units, for a marker that should read as `pixelRadius` CSS px.
export function flashWorldRadius(
  camera,
  worldPoint,
  viewportHeightPx,
  pixelRadius = FLASH_PIXEL_RADIUS,
) {
  const radius = worldPerPixel(camera, worldPoint, viewportHeightPx) * pixelRadius;
  return Number.isFinite(radius) && radius > MIN_RADIUS ? radius : MIN_RADIUS;
}
