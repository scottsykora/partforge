import * as THREE from "three";
import { EASINGS } from "./animation.js";

// Retargetable orbit-camera tween for animation camera cues and view-cube
// clicks: eased spherical interpolation of {position, target} pairs about the
// (linearly moving) orbit target, shortest-path in azimuth. Pure math, no clock
// — the viewer feeds dt seconds into update() each frame and applies the
// returned pose.
//
// NOT clamped off the poles. It used to be, by 0.01 rad, to keep OrbitControls
// off its gimbal — but the clamp applied to the DESTINATION too, so a "top" or
// "bottom" cue landed 0.573° short of the axis every single time, in both
// projections. That is the whole of the "clicking top doesn't view from the top"
// bug: a spacer kept a sliver of side wall visible instead of reading as a flat
// outline.
//
// Landing exactly on the pole is safe, because OrbitControls' own update() is
// the backstop: Spherical.makeSafe() holds phi off 0 and PI by 1e-6 rad (a
// 5.7e-5° tilt, three orders of magnitude under what the eye or a frustum can
// resolve), so the camera is never left with a degenerate lookAt basis and the
// roll stays deterministic. Azimuth at the pole is a no-op either way, and
// atan2(0, 0) is 0 rather than NaN — which is also the azimuth the canonical
// top/bottom poses ask for, so the roll OrbitControls derives there is exactly
// the `up` view-angles.js names for them.
function toSpherical(position, target) {
  const off = new THREE.Vector3().fromArray(position).sub(new THREE.Vector3().fromArray(target));
  return new THREE.Spherical().setFromVector3(off);
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
