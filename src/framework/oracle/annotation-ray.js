// Reconstruct pick rays from a sketch annotation payload (ANNOTATION_VERSION 3)
// and intersect them with planes — the consumer-side half of the payload's
// camera block (spec: docs/superpowers/specs/2026-08-28-annotation-ray-design.md).
//
// Pure vector math on arrays: no three, no DOM, no node:, no imports at all
// (worker-layering holds this folder to that). The math mirrors
// THREE.Raycaster.setFromCamera exactly, with one deliberate normalization:
// an orthographic ray's origin sits on the plane through the camera POSITION
// (three puts it on the near plane) — the same canonicalization annotate-mode
// applies to the rays it embeds per anchor, so embedded and reconstructed rays
// are definitionally identical. Two stated caveats: perspective assumes
// camera zoom 1 (the viewer dollies perspective cameras, never zooms them;
// orthoHeight already folds zoom in at send time), and payload numbers are
// rounded to 4 decimals, so reconstruction agrees with the live raycaster to
// ~1e-4 relative — sub-micrometre at part scale.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b, c) => [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

// screen: [sx, sy] in the payload's anchor screen frame (each 0..1, y down),
// or any object carrying such a `screen` array (an anchor passes directly).
export function annotationRay(payload, screen, { frame = "parts" } = {}) {
  if (frame !== "parts" && frame !== "world") {
    throw new Error('annotationRay: frame must be "parts" or "world"');
  }
  const s = Array.isArray(screen) ? screen : screen?.screen;
  if (!Array.isArray(s) || s.length !== 2
      || !s.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error("annotationRay: screen must be [x, y] with each in 0..1");
  }
  if (frame === "parts" && payload?.camera?.parts === null) {
    throw new Error("annotationRay: payload.camera.parts is null — the sketch was sent with no meshes (use { frame: \"world\" })");
  }
  const cam = payload?.camera?.[frame];
  const aspect = payload?.viewport?.aspect;
  if (!cam?.pos || !cam.target || !cam.up || !Number.isFinite(aspect)) {
    throw new Error("annotationRay: payload has no camera/viewport block");
  }
  // Basis orthonormalized the way three's lookAt does it: `up` is a hint, not
  // trusted to be orthogonal to forward.
  const forward = norm(sub(cam.target, cam.pos));
  const right = norm(cross(forward, cam.up));
  const trueUp = cross(right, forward);
  const nx = 2 * s[0] - 1;
  const ny = 1 - 2 * s[1];
  if (cam.projection === "orthographic") {
    const halfH = cam.orthoHeight / 2;
    return {
      origin: add3(cam.pos, scale(right, nx * halfH * aspect), scale(trueUp, ny * halfH)),
      dir: forward,
    };
  }
  const t = Math.tan((cam.fov * Math.PI) / 360); // vertical fov, degrees
  return {
    origin: [cam.pos[0], cam.pos[1], cam.pos[2]],
    dir: norm(add3(forward, scale(right, nx * t * aspect), scale(trueUp, ny * t))),
  };
}

const PLANES = {
  xy: { point: [0, 0, 0], normal: [0, 0, 1] },
  yz: { point: [0, 0, 0], normal: [1, 0, 0] },
  zx: { point: [0, 0, 0], normal: [0, 1, 0] },
};

// Miss semantics match the payload's `hit: null`: parallel rays and
// intersections at/behind the origin return null rather than throwing. `t` is
// in units of |dir| (unit for payload/annotationRay rays).
export function rayPlane(ray, plane) {
  if (!Array.isArray(ray?.origin) || !Array.isArray(ray?.dir)) {
    throw new Error("rayPlane: ray must be {origin, dir}");
  }
  const p = typeof plane === "string" ? PLANES[plane] : plane;
  if (!Array.isArray(p?.point) || !Array.isArray(p?.normal)) {
    throw new Error('rayPlane: plane must be {point, normal} or "xy"|"yz"|"zx"');
  }
  const denom = dot(ray.dir, p.normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(p.point, ray.origin), p.normal) / denom;
  if (t <= 1e-6) return null;
  return { point: add3(ray.origin, scale(ray.dir, t), [0, 0, 0]), t };
}
