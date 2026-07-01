// src/framework/geometry/solid-sugar.js
// The backend-shared Solid front, defined ONCE over both geometry backends. Every
// Solid a backend's wrap() returns is passed through addSugar(), which:
//   - attaches the readable transform/placement vocabulary (rotateX/along/at/…),
//     composed purely from the solid's own rotate()/translate() primitives, so the
//     sugar is geometry-identical on Manifold and OCCT alike;
//   - validates arguments the backends would otherwise each check (scale factor);
//   - derives boundingBox center/size from the backend's raw {min,max};
//   - stubs any OCCT-only op the backend lacks with a KernelCapabilityError, so
//     the needs-occt reroute works without hand-written per-backend stubs.
import { KernelCapabilityError } from "./errors.js";
import { OCCT_ONLY_OPS } from "./kernel.js";

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
  const rawScale = s.scale;
  s.scale = (factor, center = ORIGIN) => {
    if (!(factor > 0)) throw new Error("scale: factor must be > 0");
    return rawScale(factor, center);
  };

  const rawBoundingBox = s.boundingBox;
  s.boundingBox = () => {
    const { min, max } = rawBoundingBox();
    return {
      min, max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    };
  };

  for (const op of OCCT_ONLY_OPS) {
    s[op] ??= () => { throw new KernelCapabilityError(`${op} requires the OCCT backend`); };
  }

  return Object.assign(s, SUGAR);
}
