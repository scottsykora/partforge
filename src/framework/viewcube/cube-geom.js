// The view cube's geometry, hit model, and projection — the pure leaf of the
// viewcube trio (cf. ink.js under annotate/, dim3-place.js under measure/).
// No DOM, no three, no node:. Everything here is plain numbers so the whole
// widget's correctness is testable without a GL context.
//
// The cube is modelled as 6 faces x a 3x3 grid = 54 surface cells. The centre
// cell of a face IS that face; the 4 edge cells belong to the 12 edges (each
// edge shows up on 2 faces); the 4 corner cells belong to the 8 corners (each
// corner shows up on 3 faces). 6 + 24 + 24 = 54 cells over 26 ids.
//
// Coordinates are MODEL space (parts are authored Z-up), so a cell's id can be
// assembled directly from the model axes it touches. PIVOT_QUAT carries the
// viewer's fixed pivot (rotation.x = -PI/2) so the drawing always agrees with
// the part on screen.

// Tuning block. Locked by the look-and-feel spike (see the plan's Task 4);
// every visual proportion the widget has lives here and nowhere else.
export const CUBE_CONSTANTS = {
  faceHalf: 0.62,      // half-width of the centre (face) cell, cube half-extent = 1
  arrowLength: 1.45,   // axis arrow tip, in cube half-extents — >1 so arrows clear the cube
  labelOffset: 0.22,   // label sits this far beyond the tip
  tailFraction: 0.72,  // arrow tail is drawn to this fraction of the tip, head covers the rest
};

// The viewer's pivot is rotation.x = -PI/2: quaternion (sin(-PI/4), 0, 0, cos(-PI/4)).
const HALF_SQRT2 = Math.SQRT1_2;
export const PIVOT_QUAT = [-HALF_SQRT2, 0, 0, HALF_SQRT2];

// Model axis -> face name for each sign. Mirrors FACE_DIRS in view-angles.js;
// kept here as the model-space twin so this module needs no import.
const AXIS_FACE = {
  x: { 1: "right", "-1": "left" },
  y: { 1: "back", "-1": "front" },
  z: { 1: "top", "-1": "bottom" },
};
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

// Canonical id ordering: vertical, then depth, then side (see view-angles.js).
const ORDER = { top: 0, bottom: 0, front: 1, back: 1, left: 2, right: 2 };
const idFor = (parts) => [...parts].sort((a, b) => ORDER[a] - ORDER[b]).join("-");

// The two in-plane axes for each face normal, in a fixed order so cell
// enumeration is deterministic.
const IN_PLANE = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] };

// Cell bounds along one in-plane axis for grid index -1 / 0 / +1.
function span(index, half) {
  if (index < 0) return [-1, -half];
  if (index > 0) return [half, 1];
  return [-half, half];
}

// The 54 cells, in model space. Recomputed per call rather than cached: it is a
// few hundred arithmetic ops, and a cached array would be mutable shared state
// in a module the rest of the framework expects to be pure.
export function cubeCells({ faceHalf = CUBE_CONSTANTS.faceHalf } = {}) {
  const cells = [];
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [1, -1]) {
      const [uAxis, vAxis] = IN_PLANE[axis];
      const n = AXIS_INDEX[axis], u = AXIS_INDEX[uAxis], v = AXIS_INDEX[vAxis];
      const normal = [0, 0, 0];
      normal[n] = sign;
      for (const i of [-1, 0, 1]) {
        for (const j of [-1, 0, 1]) {
          const [u0, u1] = span(i, faceHalf);
          const [v0, v1] = span(j, faceHalf);
          const parts = [AXIS_FACE[axis][String(sign)]];
          if (i !== 0) parts.push(AXIS_FACE[uAxis][String(Math.sign(i))]);
          if (j !== 0) parts.push(AXIS_FACE[vAxis][String(Math.sign(j))]);
          // Wound consistently so the projected polygon is convex in order.
          const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([uu, vv]) => {
            const p = [0, 0, 0];
            p[n] = sign;
            p[u] = uu;
            p[v] = vv;
            return p;
          });
          cells.push({ id: idFor(parts), axis, sign, normal, corners });
        }
      }
    }
  }
  return cells;
}

// --- quaternion helpers (plain arrays, [x, y, z, w]) ------------------------
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

function qApply(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

// Project the cube as seen by a camera with world quaternion `cameraQuat`.
// Model -> world is the fixed pivot; world -> view is the camera's inverse
// rotation. The projection is deliberately ORTHOGRAPHIC regardless of the
// viewer's own projection: a widget that foreshortened would read as a bug.
//
// View space follows three.js: the camera looks down -Z, so a LARGER z is
// NEARER. Both halves are sorted ascending, which is exactly painter order.
export function projectCube(cameraQuat, {
  size,
  faceHalf = CUBE_CONSTANTS.faceHalf,
  arrowLength = CUBE_CONSTANTS.arrowLength,
  labelOffset = CUBE_CONSTANTS.labelOffset,
  tailFraction = CUBE_CONSTANTS.tailFraction,
} = {}) {
  const toView = qMul(qConj(cameraQuat), PIVOT_QUAT);
  // Scale so the cube's longest diagonal still fits the box at any rotation.
  const scale = (size / 2) / (Math.sqrt(3) * Math.max(arrowLength + labelOffset, 1));
  const cx = size / 2, cy = size / 2;
  const project = (p) => {
    const v = qApply(toView, p);
    return { xy: [cx + v[0] * scale, cy - v[1] * scale], z: v[2] };
  };

  const back = [], front = [];
  for (const cell of cubeCells({ faceHalf })) {
    const projected = cell.corners.map(project);
    const normalView = qApply(toView, cell.normal);
    const depth = projected.reduce((s, p) => s + p.z, 0) / projected.length;
    const entry = { id: cell.id, points: projected.map((p) => p.xy), depth };
    // normalView[2] > 0 means the face's outward normal points at the camera.
    (normalView[2] > 0 ? front : back).push(entry);
  }
  back.sort((a, b) => a.depth - b.depth);
  front.sort((a, b) => a.depth - b.depth);

  const origin = project([0, 0, 0]);
  const arrows = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]].map(([axis, dir]) => {
    const tip = project(dir.map((c) => c * arrowLength));
    const tail = project(dir.map((c) => c * arrowLength * tailFraction));
    const label = project(dir.map((c) => c * (arrowLength + labelOffset)));
    return { axis, from: origin.xy, tail: tail.xy, tip: tip.xy, label: label.xy, depth: tip.z };
  });

  return { back, front, arrows };
}

// Convex point-in-polygon: every cross product keeps the same sign.
function inside(px, py, points) {
  let positive = false, negative = false;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

// Which orientation is under the cursor. Only camera-facing cells are
// candidates — you cannot click the far side of a cube — and they are tested
// nearest-first so an overlap resolves to the one actually on top.
export function hitRegion(px, py, projected) {
  const cells = projected?.front ?? [];
  for (let i = cells.length - 1; i >= 0; i--) {
    if (inside(px, py, cells[i].points)) return cells[i].id;
  }
  return null;
}
