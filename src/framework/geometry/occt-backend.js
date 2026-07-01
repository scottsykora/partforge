// OCCT backend via replicad. Same GeometryKernel shape as the Manifold backend,
// and the only backend with toSTEP(). This is where today's drum.js kernel calls
// (makeCylinder, makeHelix+genericSweep, draw/extrude, cut/fuse) now live.
import { toEdgeFinder } from "./edge-selector.js";
import { toFaceFinder } from "./face-selector.js";
import { addSugar } from "./solid-sugar.js";
import { finishKernel } from "./kernel-front.js";
import { createOcctRepair } from "./occt-repair.js";
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.5 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP, measureVolume, makeSphere } = replicad;

  // Fillet/chamfer/shell failure recovery (skip-on-failure, chamfer binary search) —
  // see occt-repair.js for the policies and why they differ per op.
  const { validChamfer, safeOp } = createOcctRepair(measureVolume);

  const wrap = (shape) => addSugar({
    _s: shape,
    cut: (t) => wrap(shape.cut(t._s)),
    cutAll: (tools) => wrap(shape.cut(makeCompound(tools.map((t) => t._s)))),
    intersect: (t) => wrap(shape.intersect(t._s)),
    clone: () => wrap(shape.clone()),
    boundingBox: () => {
      const [min, max] = shape.boundingBox.bounds; // addSugar derives center/size
      return { min: [...min], max: [...max] };
    },
    translate: (v) => wrap(shape.translate(v)),
    rotate: (deg, center, axis) => wrap(shape.rotate(deg, center, axis)),
    mirror: (plane) => wrap(shape.mirror(plane)),
    scale: (factor, center) => wrap(shape.scale(factor, center)), // validated/defaulted by addSugar
    toMesh: ({ quality = "preview" } = {}) => {
      const m = shape.mesh(MESH[quality]);
      return {
        positions: Float32Array.from(m.vertices),
        normals: new Float32Array(0), // let the main thread crease (matches prior look)
        indices: Uint32Array.from(m.triangles),
        triangles: m.triangles.length / 3,
      };
    },
    toSTL: ({ quality = "print" } = {}) => shape.blobSTL(MESH[quality]).arrayBuffer(),
    fillet: (radius, selector) => wrap(safeOp(shape, (sh) => sh.fillet(radius, toEdgeFinder(selector)), `fillet(${radius})`)),
    chamfer: (distance, selector) => wrap(validChamfer(shape, toEdgeFinder(selector), distance)),
    shell: (thickness, openFaces) => {
      if (openFaces == null) throw new Error("shell: openFaces is required (a fully closed hollow is not supported)");
      // replicad shells inward with a positive thickness in this version, keeping outer dimensions.
      return wrap(safeOp(shape, (sh) => sh.shell(thickness, toFaceFinder(openFaces)), `shell(${thickness})`));
    },
    volume: () => measureVolume(shape),
    toIndexedMesh: () => {
      const m = shape.mesh(MESH.preview);
      return { positions: Float32Array.from(m.vertices), indices: Uint32Array.from(m.triangles) };
    },
  });

  // cylinder OR frustum (loft of two circles) when rb !== rt
  const cylinder = (rb, rt, h, { center = false } = {}) => {
    const z0 = center ? -h / 2 : 0;
    if (Math.abs(rb - rt) < 1e-9) return wrap(makeCylinder(rb, h, [0, 0, z0]));
    const w1 = assembleWire([makeCircle(rb, [0, 0, z0])]);
    const w2 = assembleWire([makeCircle(rt, [0, 0, z0 + h])]);
    return wrap(loft([w1, w2]));
  };

  // extrude a 2-D polygon from z=0 (arguments validated by the kernel front)
  const prism = (pts, h, { twist = 0, scaleTop = 1 } = {}) => {
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    const sketch = pen.close().sketchOnPlane("XY");
    if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(h));
    const cfg = {};
    if (twist !== 0) cfg.twistAngle = twist;
    if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
    return wrap(sketch.extrude(h, cfg));
  };

  // revolve a lathe profile [[r,z],…] around the Z axis (degrees defaults to 360)
  const revolve = (pts, { degrees = 360 } = {}) => {
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    const sketch = pen.close().sketchOnPlane("XZ");
    return wrap(sketch.revolve([0, 0, 1], { angle: degrees }));
  };

  // circle profile swept along a helix (frenet)
  const helixSweptTube = ({ pathR, profileR, pitch, turns, z0, lefthand }) => {
    const spine = makeHelix(pitch, pitch * turns, pathR, [0, 0, z0], [0, 0, 1], lefthand);
    const dir = lefthand ? -1 : 1;
    const tangent = [0, dir * pathR, pitch / (2 * Math.PI)];
    const profile = assembleWire([makeCircle(profileR, [pathR, 0, z0], tangent)]);
    return wrap(genericSweep(profile, spine, { frenet: true }));
  };

  return finishKernel({
    cylinder, // boredCylinder: the kernel front's default composition is exactly right here
    box: (min, max) => wrap(makeBox(min, max)), prism, revolve, helixSweptTube,
    sphere: (r) => wrap(makeSphere(r)),
    union: (solids) => wrap(solids.map((s) => s._s).reduce((a, b) => a.fuse(b))),
    toSTEP: (named) => exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._s }))).arrayBuffer(),
  });
}
