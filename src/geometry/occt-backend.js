// OCCT backend via replicad. Same GeometryKernel shape as the Manifold backend,
// and the only backend with toSTEP(). This is where today's drum.js kernel calls
// (makeCylinder, makeHelix+genericSweep, draw/extrude, cut/fuse) now live.
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.5 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP } = replicad;

  const wrap = (shape) => ({
    _s: shape,
    cut: (t) => wrap(shape.cut(t._s)),
    cutAll: (tools) => wrap(shape.cut(makeCompound(tools.map((t) => t._s)))),
    translate: (v) => wrap(shape.translate(v)),
    rotate: (deg, center, axis) => wrap(shape.rotate(deg, center, axis)),
    mirror: (plane) => wrap(shape.mirror(plane)),
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
  });

  // cylinder OR frustum (loft of two circles) when rb !== rt
  const cylinder = (rb, rt, h, { center = false } = {}) => {
    const z0 = center ? -h / 2 : 0;
    if (Math.abs(rb - rt) < 1e-9) return wrap(makeCylinder(rb, h, [0, 0, z0]));
    const w1 = assembleWire([makeCircle(rb, [0, 0, z0])]);
    const w2 = assembleWire([makeCircle(rt, [0, 0, z0 + h])]);
    return wrap(loft([w1, w2]));
  };

  // extrude a 2-D polygon from z=0
  const prism = (pts, h) => {
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return wrap(pen.close().sketchOnPlane("XY").extrude(h));
  };

  // circle profile swept along a helix (frenet)
  const helixSweptTube = ({ pathR, profileR, pitch, turns, z0, lefthand }) => {
    const spine = makeHelix(pitch, pitch * turns, pathR, [0, 0, z0], [0, 0, 1], lefthand);
    const dir = lefthand ? -1 : 1;
    const tangent = [0, dir * pathR, pitch / (2 * Math.PI)];
    const profile = assembleWire([makeCircle(profileR, [pathR, 0, z0], tangent)]);
    return wrap(genericSweep(profile, spine, { frenet: true }));
  };

  return {
    cylinder, box: (min, max) => wrap(makeBox(min, max)), prism, helixSweptTube,
    union: (solids) => wrap(solids.map((s) => s._s).reduce((a, b) => a.fuse(b))),
    toSTEP: (named) => exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._s }))).arrayBuffer(),
  };
}
