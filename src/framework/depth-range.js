// Where the camera's near and far planes go. Pure, so the one property that
// matters — that nothing the viewer draws can fall outside them — is
// unit-testable without a renderer.
//
// They used to be constants, 0.1 and 1000, from when every part was a spacer
// or a bracket. `frameTo` frames at `2.6 * maxExtent + 6` mm, so a 300 mm box
// is viewed from 786 mm with its far corner another 260 mm out: past 1000, and
// the back of the box is simply not drawn. The first cube that clips is about
// 287 mm, which is why nothing looked wrong for a year and then arrived as a
// bug report about one particular box. Zooming out clips it away entirely, and
// the same constants reached the offscreen captures, so a part big enough took
// its far corner off the agent-facing renders too.
//
// So both planes are derived instead, from the sphere enclosing what is being
// drawn and the camera's distance to it. Two forces pull against each other:
//
//   * nothing may be clipped — far must reach past the furthest visible point
//     and near must stop short of the nearest one;
//   * the depth buffer must stay precise — its resolution falls off with the
//     far/near RATIO, so both planes want to hug the geometry.
//
// Hugging exactly would rewrite the projection matrix on every frame of every
// orbit, and a depth buffer whose resolution changes each frame makes
// near-coplanar surfaces (a part and the feature-edge lines drawn on it)
// shimmer. So both are QUANTIZED to quarter-octave steps — far rounded up,
// near rounded down. That keeps each on the safe side of the geometry, bounds
// the waste at one step, and leaves the projection matrix untouched for as
// long as a slow dolly stays inside a step.

// Quarter-octave steps: neighbouring values differ by 2^(1/4) ≈ 1.19, so the
// range is at most ~19% wider than it needs to be at each end.
const STEPS_PER_OCTAVE = 4;
const quantizeUp = (v) => 2 ** (Math.ceil(Math.log2(v) * STEPS_PER_OCTAVE) / STEPS_PER_OCTAVE);
const quantizeDown = (v) => 2 ** (Math.floor(Math.log2(v) * STEPS_PER_OCTAVE) / STEPS_PER_OCTAVE);

// The scene holds more than the meshes a caller measures its radius from: the
// cutaway gizmo's handles, measurement dimension lines and their pins, a pick
// marker. All of them are sized and placed relative to the part, so one
// proportional margin covers the lot. It costs a slice of depth range and
// nothing visible.
export const SCENE_MARGIN = 1.25;

// Depth precision is a function of far/near, never of either alone. A 24-bit
// buffer carries 1e5 comfortably. This ceiling binds only when the camera is
// inside the scene sphere, which is exactly where there is no true "nearest
// visible point" to put a near plane in front of.
const MAX_DEPTH_RATIO = 1e5;

// Near plane for a camera inside the sphere, as a fraction of the scene: how
// close you may put the lens to a surface before it starts to disappear.
const INSIDE_NEAR_FRACTION = 1e-4;

// What an empty scene keeps: the historical constants, so a viewer with
// nothing shown behaves exactly as it always did.
export const DEFAULT_NEAR = 0.1;
export const DEFAULT_FAR = 1000;

/**
 * Near/far planes for a camera `distance` from the centre of a sphere of
 * `radius` enclosing everything that will be drawn. Degenerate input (an empty
 * scene, a non-finite pose) falls back to the historical constants rather than
 * producing a broken projection.
 */
export function depthRangeFor({ distance, radius, projection = "perspective" } = {}) {
  if (!(radius > 0) || !Number.isFinite(distance) || distance < 0) {
    return { near: DEFAULT_NEAR, far: DEFAULT_FAR };
  }
  const reach = radius * SCENE_MARGIN;
  const far = quantizeUp(distance + reach);
  const nearest = distance - reach;

  // An orthographic projection divides by nothing, so it has no precision
  // falloff and no ratio to defend — and its camera position is a direction
  // more than a place, which is why three allows a NEGATIVE near there. Taking
  // it is what keeps the half of the part "behind" the camera on screen after
  // a swap from a perspective view that had been dollied inside the part.
  if (projection === "orthographic") {
    if (nearest === 0) return { near: 0, far };
    return { near: nearest > 0 ? quantizeDown(nearest) : -quantizeUp(-nearest), far };
  }

  // A perspective near plane must stay positive, and past this floor the
  // returned near can sit a hair BEYOND the nearest point rather than in front
  // of it. That only happens with the camera within far/1e5 of the sphere's
  // surface — sub-micron on any real part — and the alternative is a depth
  // buffer with no precision left.
  const floor = Math.max(radius * INSIDE_NEAR_FRACTION, far / MAX_DEPTH_RATIO);
  return { near: nearest > 0 ? Math.max(quantizeDown(nearest), floor) : floor, far };
}
