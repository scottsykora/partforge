// Spherical orbit math, pure. Exists so the view cube can orbit the real camera
// by handing the viewer a pixel delta, without importing three itself.
//
// The frame is the caller's `up`, not world +Y, because that is exactly what
// OrbitControls does: it builds a quaternion taking object.up to +Y, once, at
// construction. Working in the same frame is what makes orbitBy's answers agree
// with a real drag on the canvas rather than merely resemble them.
//
// In today's viewer that `up` is always [0, 1, 0]: cameraPoseForView returns an
// `up`, but tweenCameraTo drops it and camera-tween.js interpolates
// {position, target} only, so nothing ever writes the live camera's `up` (bar
// setProjection copying it across, and the throwaway capture cameras). The
// antiparallel branch in upFrame is therefore defensive, not currently
// reachable through the viewer — it is kept, and its equivariance test with it,
// so this stays correct the day a caller does set `up`.
//
// Sign convention follows OrbitControls exactly: dragging right decreases theta,
// dragging down decreases phi.

const EPS = 1e-8;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Rodrigues rotation of v about unit axis k by angle t.
function rotate(v, k, t) {
  const c = Math.cos(t), s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

// A pair of functions taking `up` onto +Y and back again.
function upFrame(up) {
  const l = length(up);
  if (l < EPS) return { to: (v) => v, from: (v) => v };
  const u = [up[0] / l, up[1] / l, up[2] / l];
  const axis = cross(u, [0, 1, 0]);
  const al = length(axis);
  if (al < EPS) {
    // Parallel (already +Y) or antiparallel (upside down): a half turn about X.
    if (dot(u, [0, 1, 0]) > 0) return { to: (v) => v, from: (v) => v };
    const k = [1, 0, 0];
    return { to: (v) => rotate(v, k, Math.PI), from: (v) => rotate(v, k, Math.PI) };
  }
  const k = [axis[0] / al, axis[1] / al, axis[2] / al];
  const angle = Math.acos(clamp(dot(u, [0, 1, 0]), -1, 1));
  return { to: (v) => rotate(v, k, angle), from: (v) => rotate(v, k, -angle) };
}

export function orbitPose(
  { position, target, up = [0, 1, 0] },
  { dx = 0, dy = 0 } = {},
  { radiansPerPx = 0.005, minPolar = 1e-4, maxPolar = Math.PI - 1e-4 } = {},
) {
  const offset = sub(position, target);
  const radius = length(offset);
  // A camera sitting exactly on its target has no orbit to speak of; returning
  // the pose untouched beats emitting NaN.
  if (radius < EPS) return { position: [...position], target: [...target] };

  const frame = upFrame(up);
  const o = frame.to(offset);
  const theta = Math.atan2(o[0], o[2]) - dx * radiansPerPx;
  const phi = clamp(Math.acos(clamp(o[1] / radius, -1, 1)) - dy * radiansPerPx, minPolar, maxPolar);
  const sinPhi = Math.sin(phi);
  const next = [
    radius * sinPhi * Math.sin(theta),
    radius * Math.cos(phi),
    radius * sinPhi * Math.cos(theta),
  ];
  return { position: add(target, frame.from(next)), target: [...target] };
}
