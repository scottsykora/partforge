// src/framework/geometry/solid-sugar.js
// Self-describing build-step vocabulary, defined ONCE over both geometry backends.
// Every Solid a backend's wrap() returns is passed through addSugar(), which attaches
// readable transform/placement methods composed purely from the solid's existing
// rotate()/translate() primitives — so the sugar is geometry-identical to the
// hand-written primitive calls, on Manifold and OCCT alike.
const ORIGIN = [0, 0, 0];
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

const SUGAR = {
  rotateX(deg) { return this.rotate(deg, ORIGIN, [1, 0, 0]); },
  rotateY(deg) { return this.rotate(deg, ORIGIN, [0, 1, 0]); },
  rotateZ(deg) { return this.rotate(deg, ORIGIN, [0, 0, 1]); },
  rotateAbout({ axis, deg, through = ORIGIN }) {
    const ax = Array.isArray(axis) ? axis : AXIS[axis];
    if (!ax) throw new Error(`rotateAbout: unknown axis ${JSON.stringify(axis)} (use "X"|"Y"|"Z" or a [x,y,z] vector)`);
    return this.rotate(deg, through, ax);
  },
  along(dir) {
    switch (dir) {
      case "+Z": return this.translate(ORIGIN);   // fresh handle, identity geometry — consistent with the other directions
      case "-Z": return this.rotate(180, ORIGIN, [1, 0, 0]);
      case "+Y": return this.rotate(-90, ORIGIN, [1, 0, 0]);
      case "-Y": return this.rotate(90, ORIGIN, [1, 0, 0]);
      case "+X": return this.rotate(90, ORIGIN, [0, 1, 0]);
      case "-X": return this.rotate(-90, ORIGIN, [0, 1, 0]);
      default: throw new Error(`along: unknown direction ${JSON.stringify(dir)} (use "+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z")`);
    }
  },
  at(v) { return this.translate(v); },
};

export function addSugar(s) {
  return Object.assign(s, SUGAR);
}
