// src/framework/geometry/solid-sugar.js
// Self-describing build-step vocabulary, defined ONCE over both geometry backends.
// Every Solid a backend's wrap() returns is passed through addSugar(), which attaches
// readable transform/placement methods composed purely from the solid's existing
// rotate()/translate() primitives — so the sugar is geometry-identical to the
// hand-written primitive calls, on Manifold and OCCT alike.
const ORIGIN = [0, 0, 0];
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

// along(dir): orient the solid's canonical +Z build axis to point along dir.
const ALONG = {
  "+Z": (s) => s,
  "-Z": (s) => s.rotate(180, ORIGIN, [1, 0, 0]),
  "+Y": (s) => s.rotate(-90, ORIGIN, [1, 0, 0]),
  "-Y": (s) => s.rotate(90, ORIGIN, [1, 0, 0]),
  "+X": (s) => s.rotate(90, ORIGIN, [0, 1, 0]),
  "-X": (s) => s.rotate(-90, ORIGIN, [0, 1, 0]),
};

export function addSugar(s) {
  s.rotateX = (deg) => s.rotate(deg, ORIGIN, [1, 0, 0]);
  s.rotateY = (deg) => s.rotate(deg, ORIGIN, [0, 1, 0]);
  s.rotateZ = (deg) => s.rotate(deg, ORIGIN, [0, 0, 1]);
  s.rotateAbout = ({ axis, deg, through = ORIGIN }) => {
    const ax = Array.isArray(axis) ? axis : AXIS[axis];
    if (!ax) throw new Error(`rotateAbout: unknown axis ${JSON.stringify(axis)} (use "X"|"Y"|"Z" or a [x,y,z] vector)`);
    return s.rotate(deg, through, ax);
  };
  s.along = (dir) => {
    const f = ALONG[dir];
    if (!f) throw new Error(`along: unknown direction ${JSON.stringify(dir)} (use "+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z")`);
    return f(s);
  };
  s.at = (v) => s.translate(v);
  return s;
}
