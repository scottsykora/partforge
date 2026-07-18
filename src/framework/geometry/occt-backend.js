// OCCT backend via replicad. Same GeometryKernel shape as the Manifold backend,
// and the only backend with toSTEP(). This is where today's drum.js kernel calls
// (makeCylinder, makeHelix+genericSweep, draw/extrude, cut/fuse) now live.
import { toEdgeFinder } from "./edge-selector.js";
import { toFaceFinder } from "./face-selector.js";
import { addSugar } from "./solid-sugar.js";
import { finishKernel } from "./kernel-front.js";
import { createOcctRepair } from "./occt-repair.js";
import { classifyFaceGroups } from "./feature-attribution.js";
import { resolveRings } from "./loft.js";
import { resolveSweepStations } from "./sweep.js";
import { normalizeProfile } from "./profile.js";
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.5 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP, measureVolume, makeSphere, makeLine, Plane } = replicad;

  // Fillet/chamfer/shell failure recovery (skip-on-failure, chamfer binary search) —
  // see occt-repair.js for the policies and why they differ per op.
  const { validChamfer, safeOp } = createOcctRepair(measureVolume);

  // Feature labels: each entry snapshots the labeled solid's geometry at the moment
  // the label applies; transforms move the snapshots along, booleans merge the two
  // sides' lists. At toMesh() time result faces are classified against the snapshots.
  const cloneLabels = (ls) => ls.map((l) => ({ label: l.label, snapshot: l.snapshot.clone() }));
  const mapLabels = (ls, f) => ls.map((l) => ({ label: l.label, snapshot: f(l.snapshot.clone()) }));

  const wrap = (shape, labels = []) => addSugar({
    _s: shape,
    _labels: labels,
    label: (name) => wrap(shape, [...labels, { label: name, snapshot: shape.clone() }]),
    cut: (t) => wrap(shape.cut(t._s), [...cloneLabels(labels), ...cloneLabels(t._labels ?? [])]),
    cutAll: (tools) => wrap(
      shape.cut(makeCompound(tools.map((t) => t._s))),
      [...cloneLabels(labels), ...tools.flatMap((t) => cloneLabels(t._labels ?? []))]
    ),
    intersect: (t) => wrap(shape.intersect(t._s), [...cloneLabels(labels), ...cloneLabels(t._labels ?? [])]),
    clone: () => wrap(shape.clone(), cloneLabels(labels)),
    boundingBox: () => {
      const [min, max] = shape.boundingBox.bounds; // addSugar derives center/size
      return { min: [...min], max: [...max] };
    },
    translate: (v) => wrap(shape.translate(v), mapLabels(labels, (s) => s.translate(v))),
    rotate: (deg, center, axis) => wrap(shape.rotate(deg, center, axis), mapLabels(labels, (s) => s.rotate(deg, center, axis))),
    mirror: (plane) => wrap(shape.mirror(plane), mapLabels(labels, (s) => s.mirror(plane))),
    scale: (factor, center) => wrap(shape.scale(factor, center), mapLabels(labels, (s) => s.scale(factor, center))), // validated/defaulted by addSugar
    toMesh: ({ quality = "preview" } = {}) => {
      const m = shape.mesh(MESH[quality]);
      const out = {
        positions: Float32Array.from(m.vertices),
        normals: new Float32Array(0), // let the main thread crease (matches prior look)
        indices: Uint32Array.from(m.triangles),
        triangles: m.triangles.length / 3,
      };
      if (labels.length) {
        const soups = labels.map((l) => {
          const lm = l.snapshot.clone().mesh(MESH.preview); // clone: mesh() must not disturb the kept snapshot
          return { label: l.label, vertices: lm.vertices, triangles: lm.triangles };
        });
        Object.assign(out, classifyFaceGroups(m, soups));
      }
      return out;
    },
    toSTL: ({ quality = "print" } = {}) => shape.blobSTL(MESH[quality]).arrayBuffer(),
    fillet: (radius, selector) => wrap(safeOp(shape, (sh) => sh.fillet(radius, toEdgeFinder(selector)), `fillet(${radius})`), cloneLabels(labels)),
    chamfer: (distance, selector) => wrap(validChamfer(shape, toEdgeFinder(selector), distance), cloneLabels(labels)),
    shell: (thickness, openFaces) => {
      if (openFaces == null) throw new Error("shell: openFaces is required (a fully closed hollow is not supported)");
      // replicad shells inward with a positive thickness in this version, keeping outer dimensions.
      return wrap(safeOp(shape, (sh) => sh.shell(thickness, toFaceFinder(openFaces)), `shell(${thickness})`), cloneLabels(labels));
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

  // Draw a closed Drawing from a Contour: a legacy 2-D point list (all straight edges,
  // the former polyDrawing) OR an ArcContour whose { to, via } segments become true
  // OCCT arc edges via threePointsArcTo — so a rounded corner survives to STEP as a
  // real CIRCLE B-rep entity, not a fan of LINEs. close() joins the last point back to
  // the start with a straight edge (mirrors the implied ArcContour closure).
  const contourDrawing = (contour) => {
    if (Array.isArray(contour)) {
      let pen = draw(contour[0]);
      for (let i = 1; i < contour.length; i++) pen = pen.lineTo(contour[i]);
      return pen.close();
    }
    let pen = draw(contour.start);
    for (const seg of contour.segments)
      pen = seg.c1 ? pen.cubicBezierCurveTo(seg.to, seg.c1, seg.c2)
          : seg.via ? pen.threePointsArcTo(seg.to, seg.via)
          : pen.lineTo(seg.to);
    return pen.close();
  };

  // extrude a 2-D polygon from z=0 (arguments validated by the kernel front)
  const prism = (pts, h, { twist = 0, scaleTop = 1 } = {}) => {
    const sketch = contourDrawing(pts).sketchOnPlane("XY");
    if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(h));
    const cfg = {};
    if (twist !== 0) cfg.twistAngle = twist;
    if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
    return wrap(sketch.extrude(h, cfg));
  };

  // revolve a lathe profile [[r,z],…] around the Z axis (degrees defaults to 360)
  const revolve = (pts, { degrees = 360 } = {}) =>
    wrap(contourDrawing(pts).sketchOnPlane("XZ").revolve([0, 0, 1], { angle: degrees }));

  // extrude a polygon-with-holes region from z=0: cut each hole Drawing out of the outer
  // Drawing (winding-agnostic 2-D boolean), sketch it, then extrude (twist/taper via cfg).
  const extrude = (profile, h, { twist = 0, scaleTop = 1 } = {}) => {
    const { outer, holes } = normalizeProfile(profile);
    let region = contourDrawing(outer);
    for (const hole of holes) region = region.cut(contourDrawing(hole));
    const sketch = region.sketchOnPlane("XY");
    if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(h));
    const cfg = {};
    if (twist !== 0) cfg.twistAngle = twist;
    if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
    return wrap(sketch.extrude(h, cfg));
  };

  // ring loft: each ring becomes a closed polygon wire placed at its z (native loft closes
  // the ends for closed wires). closed:true loops are Manifold-only (replicad loft is open).
  const loftOp = (rings, { ruled = true, closed = false } = {}) => {
    if (closed) throw new Error("loft: closed:true loops are only supported on the Manifold backend");
    const wires = resolveRings(rings).map(({ pts2d, z }) => contourDrawing(pts2d).sketchOnPlane("XY", z).wire);
    return wrap(loft(wires, { ruled }));
  };

  // Sweep a 2-D profile along a 3-D polyline path. DEFAULT (§3A recipe): loft the SAME
  // 3-D stations resolveSweepStations() hands the Manifold backend, as ruled polygon wires
  // — so the two backends produce identical elbow geometry by construction (the loft-parity
  // mechanism, not a tolerance). smooth:true switches to the OCCT-native genericSweep along
  // a spline spine for an exact swept B-rep (STEP-exact / preview-faceted, parity waived —
  // the same contract loft ships for ruled:false). closed:true loops are Manifold-only.
  const sweepSmooth = (profile2D, path3D, cornerRadius) => {
    const edges = [];
    for (let i = 0; i < path3D.length - 1; i++) edges.push(makeLine(path3D[i], path3D[i + 1]));
    const spine = assembleWire(edges);
    const t0 = [path3D[1][0] - path3D[0][0], path3D[1][1] - path3D[0][1], path3D[1][2] - path3D[0][2]];
    const profileWire = contourDrawing(profile2D).sketchOnPlane(new Plane(path3D[0], null, t0)).wire;
    return wrap(genericSweep(profileWire, spine, {
      transitionMode: cornerRadius > 0 ? "round" : "right", // sharp miter analogue vs rounded joint
      forceProfileSpineOthogonality: true,
    }));
  };
  const sweep = (profile2D, path3D, { closed = false, cornerRadius = 0, ruled = true, smooth = false } = {}) => {
    if (closed) throw new Error("sweep: closed:true loops are only supported on the Manifold backend");
    if (smooth) return sweepSmooth(profile2D, path3D, cornerRadius);
    const { stations } = resolveSweepStations(profile2D, path3D, { closed, cornerRadius });
    const wires = stations.map((ring) => assembleWire(ring.map((p, i) => makeLine(p, ring[(i + 1) % ring.length]))));
    return wrap(loft(wires, { ruled }));
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
    box: (min, max) => wrap(makeBox(min, max)), prism, extrude, revolve, loft: loftOp, sweep, helixSweptTube,
    sphere: (r) => wrap(makeSphere(r)),
    union: (solids) => wrap(
      solids.map((s) => s._s).reduce((a, b) => a.fuse(b)),
      solids.flatMap((s) => cloneLabels(s._labels ?? []))
    ),
    toSTEP: (named) => exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._s }))).arrayBuffer(),
  });
}
