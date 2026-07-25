import * as THREE from "three";

const KEY_COLOR = 0xffffff, KEY_INTENSITY = 1.45;
const FILL_COLOR = 0xe5efff, FILL_INTENSITY = 0.65;

export function addViewerLights(scene) {
  const hemisphere = new THREE.HemisphereLight(0xdce9ff, 0x687586, 1.35);
  const key = new THREE.DirectionalLight(KEY_COLOR, KEY_INTENSITY);
  key.position.set(8, 14, 10);
  const fill = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY);
  fill.position.set(-10, 6, -8);

  scene.add(hemisphere, key, fill);

  return { hemisphere, key, fill };
}

// The key/fill above are fixed in WORLD space, which is right for a user who orbits
// into the lit hemisphere and wrong for an offscreen canonical-view capture: `bottom`,
// `back`, and `left` stare at faces the key at (8,14,10) never reaches, so they come
// back flat — hemisphere ambient only, with no shading gradient to reveal a chamfer or
// a 1 mm snap barb. These two lights are the capture-time stand-ins, swapped in for the
// duration of one offscreen render (see viewer.js renderOffscreen) and posed relative to
// the view axis, so every canonical view is exposed and shaded the same way.
export function createCaptureLights() {
  const key = new THREE.DirectionalLight(KEY_COLOR, KEY_INTENSITY);
  const fill = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY);
  return { key, fill };
}

// Offsets from the camera, in camera-space multiples of the camera-to-target distance:
// the key sits over the viewer's shoulder (up and to the right, ~41° off the view axis),
// the fill opposes it from the left at eye level. Both still shine mostly ALONG the view
// direction, so whatever the camera can see is lit.
const KEY_OFFSET = { right: 0.45, up: 0.75 };
const FILL_OFFSET = { right: -0.7, up: 0.15 };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (v) => Math.hypot(v[0], v[1], v[2]);
const norm = (v) => {
  const l = length(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// World-space positions for the capture key/fill, given a camera pose (the same
// `{position, up, target}` shape cameraPoseForView returns). Pure — no THREE, no scene.
export function captureLightPoses({ position, up, target }) {
  const forward = norm(sub(target, position));
  // Camera basis. A canonical view never passes an `up` parallel to its own view axis,
  // but a caller could, and a degenerate basis would put NaN into the light positions.
  let right = cross(forward, up);
  if (length(right) < 1e-6) right = cross(forward, [0, 0, 1]);
  if (length(right) < 1e-6) right = cross(forward, [0, 1, 0]);
  right = norm(right);
  const trueUp = norm(cross(right, forward));
  const dist = length(sub(target, position)) || 1;
  const place = (offset) => [0, 1, 2].map(
    (i) => position[i] + (right[i] * offset.right + trueUp[i] * offset.up) * dist,
  );
  return { key: place(KEY_OFFSET), fill: place(FILL_OFFSET) };
}
