// Canonical camera angles for headless/offscreen captures, in the viewer's
// three.js WORLD space (Y-up). The model is authored Z-up; the viewer's pivot
// rotates it into Y-up, so these directions are expressed Y-up directly. Kept in
// one place so the cloud render tool and any future headless capture agree.
export const CANONICAL_VIEWS = ["iso", "front", "back", "top", "bottom", "left", "right"];

// Direction FROM the part centre TOWARD the camera (world Y-up), plus the up vector.
const DIRS = {
  iso:    { dir: [1, 1, 1],   up: [0, 1, 0] },
  front:  { dir: [0, 0, 1],   up: [0, 1, 0] },
  back:   { dir: [0, 0, -1],  up: [0, 1, 0] },
  top:    { dir: [0, 1, 0],   up: [0, 0, -1] },
  bottom: { dir: [0, -1, 0],  up: [0, 0, 1] },
  left:   { dir: [-1, 0, 0],  up: [0, 1, 0] },
  right:  { dir: [1, 0, 0],   up: [0, 1, 0] },
};

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function cameraPoseForView(view, { center, radius }) {
  const a = DIRS[view];
  if (!a) throw new Error(`unknown canonical view "${view}"`);
  const d = norm(a.dir);
  const dist = radius * 2.6 + 6; // matches viewer.frameTo's framing distance
  return {
    position: [center[0] + d[0] * dist, center[1] + d[1] * dist, center[2] + d[2] * dist],
    up: a.up,
    target: [...center],
  };
}
