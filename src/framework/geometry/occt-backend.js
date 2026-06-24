// OCCT backend via replicad. Same GeometryKernel shape as the Manifold backend,
// and the only backend with toSTEP(). This is where today's drum.js kernel calls
// (makeCylinder, makeHelix+genericSweep, draw/extrude, cut/fuse) now live.
import { toEdgeFinder } from "./edge-selector.js";
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.5 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP, measureVolume, makeSphere } = replicad;

  // Is a shape a closed solid? A broken chamfer (one that over-ran and consumed a face)
  // meshes to an OPEN surface; a valid one is closed. OCCT meshes each face separately,
  // so weld vertices by position, then a closed solid has every edge shared by exactly
  // two triangles. (A coarse mesh is enough — this is a topology check.)
  const isClosedSolid = (shape) => {
    const m = shape.mesh({ tolerance: 0.3, angularTolerance: 1.0 });
    const P = m.vertices, T = m.triangles;
    const id = new Map();
    const vid = (i) => {
      const key = Math.round(P[i * 3] * 32) + "," + Math.round(P[i * 3 + 1] * 32) + "," + Math.round(P[i * 3 + 2] * 32);
      let d = id.get(key); if (d === undefined) { d = id.size; id.set(key, d); } return d;
    };
    const edges = new Map();
    for (let t = 0; t < T.length / 3; t++) {
      const a = vid(T[t * 3]), b = vid(T[t * 3 + 1]), c = vid(T[t * 3 + 2]);
      for (const [x, y] of [[a, b], [b, c], [c, a]]) { const e = x < y ? x * 1e7 + y : y * 1e7 + x; edges.set(e, (edges.get(e) || 0) + 1); }
    }
    for (const n of edges.values()) if (n !== 2) return false;
    return true;
  };

  // The true maximum chamfer for an edge depends on local angles and adjacent features,
  // which is hard to predict analytically (and OCCT exposes no max-radius query). So
  // VALIDATE the result instead of guessing: try the requested distance, and if it makes
  // a closed solid, use it (valid large chamfers — e.g. on a pill — go through). If not,
  // binary-search the largest distance that does. Discarded attempts are freed so OCCT's
  // WASM heap doesn't grow across regenerates.
  const validChamfer = (shape, finderFn, distance) => {
    if (!(distance > 0)) return shape.clone();
    const tryAt = (d) => {
      const probe = shape.clone();
      let res;
      try { res = probe.chamfer(d, finderFn); } catch { return null; } // probe consumed by the op
      if (measureVolume(res) > 0 && isClosedSolid(res)) return res;
      res.delete?.();
      return null;
    };
    let best = tryAt(distance);
    if (best) return best;                                   // requested distance is valid
    let lo = 0, hi = distance, bestD = 0;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const res = tryAt(mid);
      if (res) { best?.delete?.(); best = res; bestD = mid; lo = mid; } else hi = mid;
    }
    if (best) { console.info(`partforge: chamfer ${distance} reduced to ${bestD.toFixed(2)} (largest valid for this geometry)`); return best; }
    return shape.clone();                                    // nothing valid — skip the chamfer
  };

  // Native fillet/chamfer can throw or yield an empty solid for out-of-range radii
  // or awkward edge interactions — and OCCT's failures aren't monotonic in the
  // radius (e.g. a radius that equals an adjacent fillet's can fail while larger
  // ones succeed). Rather than letting the whole part vanish, attempt the op on a
  // clone and fall back to the original shape (feature skipped) on a throw or empty
  // result, with a console warning so it's discoverable.
  const safeOp = (shape, op, label) => {
    const backup = shape.clone();
    try {
      const result = op(shape);
      if (measureVolume(result) > 0) { backup.delete?.(); return result; }
      result.delete?.();
      console.warn(`partforge: ${label} produced an empty solid — feature skipped (radius out of range?)`);
    } catch (e) {
      console.warn(`partforge: ${label} failed (${e?.message || e}) — feature skipped`);
    }
    return backup;
  };

  const wrap = (shape) => ({
    _s: shape,
    cut: (t) => wrap(shape.cut(t._s)),
    cutAll: (tools) => wrap(shape.cut(makeCompound(tools.map((t) => t._s)))),
    clone: () => wrap(shape.clone()),
    boundingBox: () => {
      const bb = shape.boundingBox;        // replicad BoundingBox: .bounds [[min],[max]], .center
      const [min, max] = bb.bounds;
      return {
        min: [...min], max: [...max], center: [...bb.center],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      };
    },
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
    fillet: (radius, selector) => wrap(safeOp(shape, (sh) => sh.fillet(radius, toEdgeFinder(selector)), `fillet(${radius})`)),
    chamfer: (distance, selector) => wrap(validChamfer(shape, toEdgeFinder(selector), distance)),
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

  // extrude a 2-D polygon from z=0
  const prism = (pts, h) => {
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return wrap(pen.close().sketchOnPlane("XY").extrude(h));
  };

  // revolve a lathe profile [[r,z],…] around the Z axis (degrees defaults to 360)
  const revolve = (pts, { degrees = 360 } = {}) => {
    for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
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

  return {
    cylinder, box: (min, max) => wrap(makeBox(min, max)), prism, revolve, helixSweptTube,
    sphere: (r) => wrap(makeSphere(r)),
    union: (solids) => wrap(solids.map((s) => s._s).reduce((a, b) => a.fuse(b))),
    toSTEP: (named) => exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._s }))).arrayBuffer(),
  };
}
