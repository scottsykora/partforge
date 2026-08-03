import * as THREE from "three";
import { EASINGS } from "./animation.js";

// Retargetable orbit-camera tween for animation camera cues: eased spherical
// interpolation of {position, target} pairs about the (linearly moving) orbit
// target, shortest-path in azimuth, clamped off the poles so OrbitControls
// never gimbal-locks on a "top"/"bottom" cue. Pure math, no clock — the viewer
// feeds dt seconds into update() each frame and applies the returned pose.
const POLE_EPS = 0.01;

function toSpherical(position, target) {
  const off = new THREE.Vector3().fromArray(position).sub(new THREE.Vector3().fromArray(target));
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.phi = Math.min(Math.PI - POLE_EPS, Math.max(POLE_EPS, sph.phi));
  return sph;
}

export function createCameraTween() {
  let tw = null; // { fromSph, toSph, fromTarget, toTarget, duration, elapsed, onComplete }

  // `from` is always the CALLER's current pose, which is what makes a restart
  // mid-flight retarget smoothly: the new tween begins wherever the camera is.
  function start(from, to, { duration = 0.6, onComplete } = {}) {
    const fromSph = toSpherical(from.position, from.target);
    const toSph = toSpherical(to.position, to.target);
    const d = toSph.theta - fromSph.theta;
    if (d > Math.PI) toSph.theta -= 2 * Math.PI;
    if (d < -Math.PI) toSph.theta += 2 * Math.PI;
    tw = {
      fromSph, toSph,
      fromTarget: new THREE.Vector3().fromArray(from.target),
      toTarget: new THREE.Vector3().fromArray(to.target),
      duration, elapsed: 0, onComplete,
    };
  }

  function update(dt) {
    if (!tw) return null;
    tw.elapsed += dt;
    const done = tw.elapsed >= tw.duration;
    const u = done ? 1 : EASINGS["ease-in-out"](tw.elapsed / tw.duration);
    const lerp = (a, b) => a + (b - a) * u;
    const sph = new THREE.Spherical(
      lerp(tw.fromSph.radius, tw.toSph.radius),
      lerp(tw.fromSph.phi, tw.toSph.phi),
      lerp(tw.fromSph.theta, tw.toSph.theta),
    );
    const target = tw.fromTarget.clone().lerp(tw.toTarget, u);
    const position = new THREE.Vector3().setFromSpherical(sph).add(target);
    const onComplete = tw.onComplete;
    if (done) tw = null;
    const out = { position: position.toArray(), target: target.toArray(), done };
    if (done) onComplete?.();
    return out;
  }

  return { start, update, cancel: () => { tw = null; }, isActive: () => !!tw };
}
