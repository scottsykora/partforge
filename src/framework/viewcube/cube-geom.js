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
//
// The reshape (2026-08-19) moved the axis arrows off the cube's centre and
// onto the edge running from the corner where +X/+Y/+Z originate — model
// corner (-1,-1,-1) — to the far face. A second pass then moved the
// arrowHEAD and its label off model space entirely: the shaft now ends
// exactly ON the far face (model coordinate 1, no overshoot), and the head +
// label are built in fixed SCREEN pixels by cube-canvas.js so they read the
// same size at every rotation (see CUBE_RENDER's headLengthPx/headHalfWidthPx
// /labelGapPx). That leaves `faceHalf` as the only model-space proportion left
// to tune here — the old `arrowOvershoot`/`labelOffset`/`tailFraction` no
// longer have anything to mean and are gone.
export const CUBE_CONSTANTS = {
  faceHalf: 0.62, // half-width of the centre (face) cell, cube half-extent = 1
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

// The reverse of AXIS_FACE: face name -> the axis and sign it stands for.
const FACE_AXIS = {};
for (const axis of ["x", "y", "z"]) {
  for (const sign of [1, -1]) FACE_AXIS[AXIS_FACE[axis][String(sign)]] = { axis, sign };
}

// Canonical id ordering: vertical, then depth, then side (see view-angles.js).
const ORDER = { top: 0, bottom: 0, front: 1, back: 1, left: 2, right: 2 };
const idFor = (parts) => [...parts].sort((a, b) => ORDER[a] - ORDER[b]).join("-");

// The two in-plane axes for each face normal, in a fixed order so cell
// enumeration is deterministic.
const IN_PLANE = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] };

// The direction, IN MODEL SPACE, that has to point up the screen for a face's
// NAME to read the right way round. Declared per face rather than inferred from
// a cell's corner ordering, which is the bug the 2026-08-20 fix removed: a
// basis built from corner order was only ever checked for MIRRORING, and a
// basis rotated 180 degrees is non-mirrored too, so LEFT and BACK read upside
// down (see cube-canvas.js's faceLabelBasis).
//
// These are MODEL-space vectors, because that is the frame this module's cells
// are expressed in and parts are authored Z-UP (see the file header). Do NOT
// copy view-angles.js's FACE_DIRS here: that table is Y-up because it names
// CAMERA poses in the viewer's world frame, and the two disagree.
//
// The four side faces therefore get model +Z — the model's own up.
//
// TOP and BOTTOM have no natural up: whichever in-plane direction is chosen,
// the label reads upright from some azimuths and rotated from others. The
// choice made here is the standard CAD one, and it is not arbitrary — model
// +Y / -Y are exactly the ups view-angles.js's upFor() gives the pure top and
// bottom camera poses (world [0,0,-1] / [0,0,1]). So TOP reads upright when the
// camera is above and looking from the front, BOTTOM when it is below looking
// from the front, and in particular both read upright right after you click
// that face on the cube. Away from that azimuth they read rotated. That is
// ACCEPTED, deliberately: re-choosing the axis as the camera orbits would snap
// the label through 90-degree jumps mid-drag, which is worse than a label lying
// on its side.
export const FACE_LABEL_UP = {
  right: [0, 0, 1],
  left: [0, 0, 1],
  front: [0, 0, 1],
  back: [0, 0, 1],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

// The sign of a face's declared label up along that face's own local V axis —
// the in-plane axis a projected cell's (p3 - p0) edge runs along (cubeCells
// winds corners from IN_PLANE, so p3 - p0 is always +vAxis).
//
// Always exactly +1 or -1, because every vector in FACE_LABEL_UP IS one of its
// face's two in-plane axes: the side faces' up is model Z, the V axis of both
// the X and the Y face pair; TOP/BOTTOM's is model Y, the V axis of the Z pair.
// That is what lets the renderer turn its already-projected (and so already
// foreshortened) v edge into the label's up direction with one multiply,
// instead of needing a second projection of its own.
export function faceLabelUpSign(face) {
  const entry = FACE_AXIS[face];
  if (!entry) throw new Error(`unknown cube face "${face}"`);
  const vAxis = IN_PLANE[entry.axis][1];
  return Math.sign(FACE_LABEL_UP[face][AXIS_INDEX[vAxis]]);
}

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

// The shared corner the three axis edges radiate from: model (-1,-1,-1), the
// vertex where +X, +Y, +Z all originate.
const AXIS_ORIGIN_CORNER = [-1, -1, -1];

// The cube's 12 edges, as model-space vertex pairs. Exactly 3 are tagged with
// the axis they carry — the ones touching AXIS_ORIGIN_CORNER and running
// toward +X / +Y / +Z — because those three are drawn as the labelled arrows;
// the other 9 are plain (untagged) and drawn as quiet cube edges instead.
//
// Each edge also carries `faceNormals`: the outward normals of the two faces
// that meet along it (an edge running along `n` at fixed (su, sv) sits on the
// boundary of the uAxis face signed `su` and the vAxis face signed `sv`).
// projectCube rotates those into view space to decide whether the edge is on
// the visible silhouette — the renderer has no other way to know which faces
// an edge belongs to without recomputing this module's geometry itself.
export function cubeEdges() {
  const edges = [];
  for (const axis of ["x", "y", "z"]) {
    const [uAxis, vAxis] = IN_PLANE[axis];
    const n = AXIS_INDEX[axis], u = AXIS_INDEX[uAxis], v = AXIS_INDEX[vAxis];
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const a = [0, 0, 0], b = [0, 0, 0];
        a[u] = su; a[v] = sv; a[n] = -1;
        b[u] = su; b[v] = sv; b[n] = 1;
        // This is one of the 3 axis edges exactly when it starts at the
        // shared corner (both in-plane coords at -1) and runs toward +axis.
        const isAxisEdge = su === -1 && sv === -1;
        const normalU = [0, 0, 0]; normalU[u] = su;
        const normalV = [0, 0, 0]; normalV[v] = sv;
        edges.push({ a, b, axis: isAxisEdge ? axis : null, faceNormals: [normalU, normalV] });
      }
    }
  }
  return edges;
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

// An edge is on the visible silhouette when at least one of its two adjoining
// faces is camera-facing; otherwise it is hidden (it either coincides exactly
// with a silhouette edge already drawn on the near side, in an orthographic
// projection, or projects to a point). "Camera-facing" here is view-space
// normal Z > this epsilon, not > 0: at the identity quaternion four faces are
// *exactly* edge-on (Z === 0 up to float noise from the quaternion rotation),
// and the rule needs those treated as not-facing so the back face's edges and
// the front-to-back edges land on the hidden side, not the visible one. Not a
// visual tunable (nobody sweeps a numerical epsilon by eye), so it sits
// outside CUBE_CONSTANTS, same as cube-canvas.js's MIN_ARROW_DIR_PX.
const EDGE_FACE_VISIBLE_EPS = 1e-9;

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
  // A render-side pixel budget (head length + label gap + label glyph size)
  // the caller may pass through so the SCALE reserves room for what gets
  // drawn past the cube in fixed screen pixels — the head and label are no
  // longer model-space geometry (see CUBE_CONSTANTS's comment), so the only
  // thing left that can run past the box edge is those pixels. This module
  // stays import-free (no reading CUBE_RENDER itself), so it defaults to 0
  // and leaves supplying a real value to the caller that knows those pixel
  // sizes (viewcube-mode.js).
  outerPad = 0,
} = {}) {
  const toView = qMul(qConj(cameraQuat), PIVOT_QUAT);

  // Scale so the drawing still fits the box at any rotation. Every cube
  // vertex — and the arrow shafts now end exactly ON one (the far face, model
  // coordinate 1 along the axis) — sits at the same distance from the model
  // origin: sqrt(3). That is the only model-space reach left to guard;
  // whatever the head/label add beyond it is screen pixels, covered by
  // `outerPad` instead.
  const scale = (size / 2 - outerPad) / Math.sqrt(3);
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
    const face = AXIS_FACE[cell.axis][String(cell.sign)];
    const entry = {
      id: cell.id,
      points: projected.map((p) => p.xy),
      depth,
      face,
      isCentre: cell.id === face,
    };
    // normalView[2] > 0 means the face's outward normal points at the camera.
    (normalView[2] > 0 ? front : back).push(entry);
  }
  back.sort((a, b) => a.depth - b.depth);
  front.sort((a, b) => a.depth - b.depth);

  const backEdges = [], frontEdges = [];
  for (const edge of cubeEdges()) {
    const a = project(edge.a), b = project(edge.b);
    const depth = (a.z + b.z) / 2;
    // Rotate the edge's two adjoining face normals the same way the cell
    // normals above are rotated, and hide the edge only when NEITHER faces
    // the camera — see EDGE_FACE_VISIBLE_EPS for why this is "> eps" and not
    // "> 0". Axis-tagged edges get this too (it costs nothing to compute) but
    // the renderer ignores it for them: they draw as arrows in real depth
    // order regardless, by the host's explicit choice.
    const hidden = edge.faceNormals.every((n) => qApply(toView, n)[2] <= EDGE_FACE_VISIBLE_EPS);
    const entry = { points: [a.xy, b.xy], axis: edge.axis, depth, hidden };
    (depth >= 0 ? frontEdges : backEdges).push(entry);
  }
  backEdges.sort((x, y) => x.depth - y.depth);
  frontEdges.sort((x, y) => x.depth - y.depth);

  // The three axis arrows all start at the same corner and ride their own
  // edge out to the far face (model coordinate 1 along the axis) — the whole
  // edge, not a fraction of it. Everything past that point (the head, the
  // label) is a screen-space add-on cube-canvas.js builds from `tip`, so
  // there is no model-space geometry left to compute for them here.
  const corner = project(AXIS_ORIGIN_CORNER);
  // The edge runs corner-to-corner (length 2); +dir*2 from the shared corner
  // lands exactly on the far face — the adjacent vertex along that axis.
  const farFace = (dir) => AXIS_ORIGIN_CORNER.map((c, i) => c + dir[i] * 2);
  const arrows = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]].map(([axis, dir]) => {
    const tip = project(farFace(dir));
    // The corner is the shared reference depth; the tip is where the arrow
    // actually ends up, so average the two rather than picking either alone.
    const depth = (corner.z + tip.z) / 2;
    return { axis, from: corner.xy, tip: tip.xy, depth };
  });

  return { back, front, backEdges, frontEdges, arrows };
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
