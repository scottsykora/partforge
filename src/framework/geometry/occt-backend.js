// OCCT backend via replicad. Same GeometryKernel shape as the Manifold backend,
// and the only backend with toSTEP(). This is where today's drum.js kernel calls
// (makeCylinder, makeHelix+genericSweep, draw/extrude, cut/fuse) now live.
//
// Caching: the SAME createSolidCache as the Manifold backend, bracketed per
// sub-part by jobs.js. Two backend-specific twists:
//   - replicad ops CONSUME their operands (transform/boolean inputs are deleted),
//     so every op that feeds a possibly-cached shape into replicad clones it
//     first. Disposal is free: replicad wrappers release their WASM through a
//     FinalizationRegistry when the JS object is collected, so evicted cache
//     entries need no dispose bookkeeping (unlike Manifold's tracked/cleanup).
//   - translate/rotate are POSE-LAZY: they accumulate rigid steps on the wrap
//     (pose.js) instead of running OCCT transforms, and toMesh caches the BASE
//     solid's tessellation and re-poses the cached vertices in JS. A pose-only
//     param change (a lid's open angle) therefore re-runs no OCCT op at all.
//     Ops that need the real B-rep (booleans, fillet/chamfer/shell, exports,
//     volume, boundingBox) materialize the pending pose through replicad first.
import { toEdgeFinder } from "./edge-selector.js";
import { toFaceFinder } from "./face-selector.js";
import { addSugar } from "./solid-sugar.js";
import { makeShape2dFactory } from "./shape2d.js";
import { finishKernel } from "./kernel-front.js";
import { createOcctRepair } from "./occt-repair.js";
import { occtRoundAll } from "./occt-roundall.js";
import { classifyFaceGroups } from "./feature-attribution.js";
import { resolveLoftRings, loftRingsKey } from "./loft-rings.js";
import { resolveSweepStations } from "./sweep.js";
import { normalizeProfile } from "./profile.js";
import { roundedRectContour } from "./rounded-solids.js";
import { offsetRegions } from "./contour-offset.js";
import { h } from "./solid-hash.js";
import { createSolidCache } from "./solid-cache.js";
import { composePose, transformPositions, rotateNormals } from "./pose.js";
import { filterBrepEdges } from "./brep-edges.js";
import { meshToStl } from "./mesh-stl.js";
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.25 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          loft, draw, exportSTEP, importSTEP, measureVolume, makeSphere, makeLine, Plane } = replicad;

  // Feature-skip warnings: everything occt-repair (and roundAll) skips or rescues
  // is recorded here as well as console.warned, and jobs.js drains it per
  // sub-part (takeBuildWarnings) onto the meshes message — same channel as the
  // Manifold backend's fillet/chamfer degradation.
  const buildWarnings = [];
  const recordWarning = (msg) => { buildWarnings.push(msg); console.warn(`partforge: ${msg}`); };
  // Fillet/chamfer/shell failure recovery (skip-on-failure, chamfer binary search) —
  // see occt-repair.js for the policies and why they differ per op.
  const { validChamfer, safeOp } = createOcctRepair(measureVolume, recordWarning);

  // name -> { shape, digest } | { error, digest } — imported geometry the framework
  // registers pre-build via `_registerImport` (kernel-lifetime, untracked by the
  // solid cache: imports are the framework's own memo, keyed by name+digest).
  const imports = new Map();

  const cache = createSolidCache();
  // Boundary ops route through cache.lookup. pin is unused here (no cleanup() —
  // GC frees WASM via replicad's FinalizationRegistry) and dispose is a no-op:
  // dropping the evicted reference is all the freeing OCCT needs.
  const cached = (hash, make) => cache.lookup(hash, () => {
    const value = make();
    return { value, pin: value, dispose: () => {} };
  });
  // Function-form selectors (the raw replicad finder escape hatch) can capture
  // params in a closure the source text doesn't show, so they can't be trusted to
  // a content hash: give each call a fresh key, making the op and everything
  // downstream of it a cache miss. Declarative selectors hash normally.
  let unhashable = 0;
  const selKey = (sel) => (typeof sel === "function" ? `fn#${unhashable++}` : sel);

  // Feature labels: each entry snapshots the labeled solid's geometry at the moment
  // the label applies; materialization moves the snapshots along with the shape,
  // booleans merge the two sides' lists. At toMesh() time result faces are
  // classified against the snapshots — in BASE space for a posed solid, which is
  // sound because classification is pose-invariant (both meshes share the frame).
  const cloneLabels = (ls) => ls.map((l) => ({ label: l.label, snapshot: l.snapshot.clone() }));
  const mapLabels = (ls, f) => ls.map((l) => ({ label: l.label, snapshot: f(l.snapshot.clone()) }));

  // Apply pending pose steps to a (freshly cloned) replicad shape.
  const applySteps = (sh, steps) => steps.reduce(
    (cur, st) => (st.t === "translate" ? cur.translate(st.v) : cur.rotate(st.deg, st.center, st.axis)), sh);

  // `hash` is the content hash of the POSED solid; `baseHash` keys the pose-free
  // base (they're equal when `pose` is empty). Every op below that consumes a
  // shape clones it first — cached values must survive reuse across builds.
  const wrap = (shape, labels = [], hash, pose = [], baseHash = hash) => {
    // Materialize the pending pose through replicad, yielding a pose-free wrap.
    // Cached under the posed hash so repeated ops on the same posed solid reuse it.
    const mat = () => (pose.length === 0 ? self : cached(hash, () => wrap(
      applySteps(shape.clone(), pose),
      labels.map((l) => ({ label: l.label, snapshot: applySteps(l.snapshot.clone(), pose) })),
      hash,
    )));

    // The base solid's tessellation (+ label classification), cached per quality.
    // Pose-independent by construction: meshed from the base shape and base-space
    // snapshots, so every pose of the same base reuses one entry.
    const baseMesh = (quality) => cached(h("mesh", baseHash, quality), () => {
      const m = shape.mesh(MESH[quality]);
      const out = {
        positions: Float32Array.from(m.vertices),
        normals: Float32Array.from(m.normals),   // analytic per-face-vertex normals — smooth by construction
        edges: filterBrepEdges(m, shape.meshEdges(MESH[quality])), // true B-rep edges, tangent-filtered
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
    });
    // Fresh posed copies of the cached arrays — jobs.js transfers the buffers to
    // the main thread (detaching them), so the cache must never hand out its own.
    const posedPositions = (base) => {
      const positions = Float32Array.from(base.positions);
      if (pose.length) transformPositions(positions, composePose(pose));
      return positions;
    };
    const posedNormals = (base) => {
      const normals = Float32Array.from(base.normals);
      if (pose.length) rotateNormals(normals, composePose(pose)); // rotation only — normals are directions
      return normals;
    };
    const posedEdges = (base) => {
      const edges = Float32Array.from(base.edges);
      if (pose.length) transformPositions(edges, composePose(pose)); // segment endpoints pose like positions
      return edges;
    };

    const self = addSugar({
      _s: shape,
      _labels: labels,
      _hash: hash,
      _pose: pose,
      _mat: () => mat(),
      label: (name) => {
        const a = mat();
        return wrap(a._s, [...cloneLabels(a._labels), { label: name, snapshot: a._s.clone() }], h("label", hash, name));
      },
      cut: (t) => {
        const key = h("cut", hash, t._hash);
        return cached(key, () => {
          const a = mat(), b = t._mat();
          return wrap(a._s.clone().cut(b._s.clone()), [...cloneLabels(a._labels), ...cloneLabels(b._labels)], key);
        });
      },
      cutAll: (tools) => {
        const key = h("cutAll", hash, tools.map((t) => t._hash));
        return cached(key, () => {
          const a = mat(), bs = tools.map((t) => t._mat());
          if (bs.length === 0) return wrap(a._s.clone(), cloneLabels(a._labels), key);
          const fusedTools = bs
            .slice(1)
            .reduce((acc, b) => acc.fuse(b._s.clone()), bs[0]._s.clone());
          return wrap(
            a._s.clone().cut(fusedTools),
            [...cloneLabels(a._labels), ...bs.flatMap((b) => cloneLabels(b._labels))],
            key,
          );
        });
      },
      intersect: (t) => {
        const key = h("intersect", hash, t._hash);
        return cached(key, () => {
          const a = mat(), b = t._mat();
          return wrap(a._s.clone().intersect(b._s.clone()), [...cloneLabels(a._labels), ...cloneLabels(b._labels)], key);
        });
      },
      union: (t) => {
        const key = h("union", [hash, t._hash]);
        return cached(key, () => {
          const a = mat(), b = t._mat();
          return wrap(a._s.clone().fuse(b._s.clone()), [...cloneLabels(a._labels), ...cloneLabels(b._labels)], key);
        });
      },
      clone: () => wrap(shape.clone(), cloneLabels(labels), hash, pose, baseHash),
      boundingBox: () => {
        const [min, max] = mat()._s.boundingBox.bounds; // addSugar derives center/size
        return { min: [...min], max: [...max] };
      },
      // Pose-lazy: no OCCT work, just a recorded step + the composed hash.
      translate: (v) => wrap(shape, labels, h("translate", hash, v), [...pose, { t: "translate", v }], baseHash),
      rotate: (deg, center, axis) => wrap(shape, labels, h("rotate", hash, deg, center, axis), [...pose, { t: "rotate", deg, center, axis }], baseHash),
      mirror: (plane) => {
        const key = h("mirror", hash, plane);
        return cached(key, () => {
          const a = mat();
          return wrap(a._s.clone().mirror(plane), mapLabels(a._labels, (s) => s.mirror(plane)), key);
        });
      },
      scale: (factor, center) => { // factor validated (and center defaulted) by addSugar
        const key = h("scale", hash, factor, center);
        return cached(key, () => {
          const a = mat();
          return wrap(a._s.clone().scale(factor, center), mapLabels(a._labels, (s) => s.scale(factor, center)), key);
        });
      },
      toMesh: ({ quality = "preview" } = {}) => {
        const base = baseMesh(quality);
        const out = {
          positions: posedPositions(base),
          normals: posedNormals(base), // analytic — the viewer must NOT re-crease these
          edges: posedEdges(base),     // empty array = "no feature edges", not "unknown"
          indices: Uint32Array.from(base.indices),
          triangles: base.triangles,
        };
        if (base.featureIds) { out.featureIds = Uint16Array.from(base.featureIds); out.features = base.features; }
        return out;
      },
      toSTL: ({ quality = "print" } = {}) => {
        const base = baseMesh(quality);
        return Promise.resolve(meshToStl(posedPositions(base), Uint32Array.from(base.indices)));
      },
      fillet: (radius, selector) => {
        const key = h("fillet", hash, radius, selKey(selector));
        return cached(key, () => {
          const a = mat();
          // radius 0 is the identity per the contract — skip the kernel call so it
          // can't trip the repair path's "feature skipped" warning.
          if (radius === 0) return wrap(a._s.clone(), cloneLabels(a._labels), key);
          return wrap(safeOp(a._s.clone(), (sh) => sh.fillet(radius, toEdgeFinder(selector)), `fillet(${radius})`), cloneLabels(a._labels), key);
        });
      },
      chamfer: (distance, selector) => {
        const key = h("chamfer", hash, distance, selKey(selector));
        // validChamfer probes on internal clones and never consumes its input.
        return cached(key, () => {
          const a = mat();
          if (distance === 0) return wrap(a._s.clone(), cloneLabels(a._labels), key); // identity, same as fillet(0)
          return wrap(validChamfer(a._s, toEdgeFinder(selector), distance), cloneLabels(a._labels), key);
        });
      },
      roundAll: (r) => {
        const key = h("roundAll", hash, r);
        return cached(key, () => {
          const a = mat();
          if (r === 0) return wrap(a._s.clone(), cloneLabels(a._labels), key);
          return wrap(occtRoundAll(replicad, a._s, r, recordWarning), cloneLabels(a._labels), key);
        });
      },
      shell: (thickness, openFaces) => {
        if (openFaces == null) throw new Error("shell: openFaces is required (a fully closed hollow is not supported)");
        const key = h("shell", hash, thickness, selKey(openFaces));
        // replicad shells inward with a positive thickness in this version, keeping outer dimensions.
        return cached(key, () => {
          const a = mat();
          return wrap(safeOp(a._s.clone(), (sh) => sh.shell(thickness, toFaceFinder(openFaces)), `shell(${thickness})`), cloneLabels(a._labels), key);
        });
      },
      volume: () => measureVolume(mat()._s),
      // Same default as toSTL: an export is an export, so a .3mf must not ship a
      // coarser tessellation than the .stl of the same solid would.
      toIndexedMesh: ({ quality = "print" } = {}) => {
        const base = baseMesh(quality);
        return { positions: posedPositions(base), indices: Uint32Array.from(base.indices) };
      },
    });
    return self;
  };

  // cylinder OR frustum (loft of two circles) when rb !== rt
  const cylinder = (rb, rt, hgt, { center = false } = {}) => {
    const key = h("cylinder", rb, rt, hgt, center);
    return cached(key, () => {
      const z0 = center ? -hgt / 2 : 0;
      if (Math.abs(rb - rt) < 1e-9) return wrap(makeCylinder(rb, hgt, [0, 0, z0]), [], key);
      const w1 = assembleWire([makeCircle(rb, [0, 0, z0])]);
      const w2 = assembleWire([makeCircle(rt, [0, 0, z0 + hgt])]);
      return wrap(loft([w1, w2]), [], key);
    });
  };

  // Rounded box. side > 0: an arc-exact rounded-rect extrusion (real CIRCLE
  // wall edges in STEP) with each rim rounded by ONE native fillet on its
  // smooth rim loop — exact torus/sphere corner patches, matching the mesh
  // backend's ring semantics by construction. side = 0: rim round-overs are
  // CUT with strip-minus-quarter-cylinder wedges running the full edge
  // length, so corners are the deterministic intersection of adjacent
  // round-overs (native fillet's vertex blend is kernel-specific and the
  // mesh backend could not reproduce it — see the design spec).
  const roundedBox = ({ size, center, round }) => {
    const [w, d, hgt] = size;
    const { side, top, bottom } = round;
    const key = h("roundedBox", size, center, side, top, bottom);
    return cached(key, () => {
      const z0 = center ? -hgt / 2 : 0;
      if (side > 0) {
        let s = contourDrawing(roundedRectContour(w, d, side)).sketchOnPlane("XY", z0).extrude(hgt);
        // A rim fillet can only remove material, never add it — OCCT's fillet is
        // known to produce invalid-but-nonempty geometry at certain degenerate
        // boundaries (e.g. rim radius == side on a stadium profile), so gate
        // acceptance on strict volume reduction rather than just "non-empty".
        const isRimFilletValid = (vol, before) => vol > 0 && vol < before - 1e-9;
        if (top > 0) s = safeOp(s, (sh) => sh.fillet(top, (e) => e.inPlane("XY", z0 + hgt)), `fillet(${top})`, isRimFilletValid);
        if (bottom > 0) s = safeOp(s, (sh) => sh.fillet(bottom, (e) => e.inPlane("XY", z0)), `fillet(${bottom})`, isRimFilletValid);
        return wrap(s, [], key);
      }
      let s = makeBox([-w / 2, -d / 2, z0], [w / 2, d / 2, z0 + hgt]);
      for (const [rim, zFace, into] of [[top, z0 + hgt, -1], [bottom, z0, 1]]) {
        if (!(rim > 0)) continue;
        const zAxis = zFace + into * rim;
        const zMin = Math.min(zFace, zAxis), zMax = Math.max(zFace, zAxis);
        for (const sy of [1, -1]) { // ±Y walls: strip + quarter-cylinder axis along X
          const strip = makeBox([-w / 2, sy > 0 ? d / 2 - rim : -d / 2, zMin],
            [w / 2, sy > 0 ? d / 2 : -d / 2 + rim, zMax]);
          const cyl = makeCylinder(rim, w + 4, [-w / 2 - 2, sy * (d / 2 - rim), zAxis], [1, 0, 0]);
          s = s.cut(strip.cut(cyl));
        }
        for (const sx of [1, -1]) { // ±X walls: strip + axis along Y
          const strip = makeBox([sx > 0 ? w / 2 - rim : -w / 2, -d / 2, zMin],
            [sx > 0 ? w / 2 : -w / 2 + rim, d / 2, zMax]);
          const cyl = makeCylinder(rim, d + 4, [sx * (w / 2 - rim), -d / 2 - 2, zAxis], [0, 1, 0]);
          s = s.cut(strip.cut(cyl));
        }
      }
      return wrap(s, [], key);
    });
  };

  // Draw a closed Drawing from a Contour: a legacy 2-D point list (all straight edges,
  // the former polyDrawing) OR an ArcContour whose { to, via } segments become true
  // OCCT arc edges via threePointsArcTo — so a rounded corner survives to STEP as a
  // real CIRCLE B-rep entity, not a fan of LINEs. Cubic segments ({ to, c1, c2 })
  // map to cubicBezierCurveTo for exact B-rep spline edges. close() joins the last
  // point back to the start with a straight edge (mirrors the implied ArcContour closure).
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

  // Shape2D's tessellation LOD: the segment count toRegions()/simple() discretize
  // curve contours at. 64 preserves the LOD the Drawing-backed Shape2D materialized
  // at, so toRegions() output keeps the resolution parts already depend on.
  const SHAPE2D_SEGS = 64;
  // Region (outer + holes) -> Drawing, exactly like extrude's former inline region
  // path: draw the outer contour, then .cut() each hole Drawing out of it.
  const drawingFromProfile = (profile) => {
    const { outer, holes } = normalizeProfile(profile);
    let region = contourDrawing(outer);
    for (const hole of holes) region = region.cut(contourDrawing(hole));
    return region;
  };
  // Region list -> fused Drawing: draw each region's outer contour, cut its holes
  // out, then fuse every region together — the multi-region generalization of
  // drawingFromProfile above. Used by extrude/revolve (via drawingFor below) to
  // materialize a Shape2D's stored contours into a Drawing.
  const drawingFromRegions = (regions) => regions.reduce((acc, rg) => {
    let region = contourDrawing(rg.outer);
    for (const hole of rg.holes) region = region.cut(contourDrawing(hole));
    return acc ? acc.fuse(region) : region;
  }, null);

  // 2-D boolean value: the SHARED Shape2D (shape2d.js), identical to the Manifold
  // backend's. Storage is the curve-native contour IR and every op — including
  // `offset`, now the shared native engine — runs on it in pure JS; no Drawing
  // exists until a shape is handed to a kernel op. `extrude`/`revolve` are thunks
  // because `kernel` is defined below.
  const shape2d = makeShape2dFactory({
    segs: SHAPE2D_SEGS,
    extrude: (o) => kernel.extrude(o),
    revolve: (o) => kernel.revolve(o),
    recordWarning,
  });
  // Lazy Drawing materialization for the kernel ops that need one. drawingFromRegions
  // draws a FRESH Drawing on every call, so callers never need to .clone() the result
  // before handing it to a consuming replicad op.
  // An empty shape (e.g. the intersection of two disjoint shapes) has no regions to
  // draw; say so rather than letting the null reach replicad as a TypeError.
  const drawingFor = (shape) => drawingFromRegions(shape._regions)
    ?? (() => { throw new Error("Shape2D: the shape is empty — nothing to build"); })();

  // extrude a 2-D polygon from z=0 (arguments validated by the kernel front)
  const prism = (pts, hgt, { twist = 0, scaleTop = 1 } = {}) => {
    const key = h("prism", pts, hgt, twist, scaleTop);
    return cached(key, () => {
      const sketch = contourDrawing(pts).sketchOnPlane("XY");
      if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(hgt), [], key);
      const cfg = {};
      if (twist !== 0) cfg.twistAngle = twist;
      if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
      return wrap(sketch.extrude(hgt, cfg), [], key);
    });
  };

  // revolve a lathe profile [[r,z],…] around the Z axis (degrees defaults to 360)
  const revolve = (pts, { degrees = 360 } = {}) => {
    const key = h("revolve", pts && pts._shape2d ? pts._hash : pts, degrees);
    return cached(key, () => {
      const region = pts && pts._shape2d ? drawingFor(pts) : contourDrawing(pts);
      return wrap(region.sketchOnPlane("XZ").revolve([0, 0, 1], { angle: degrees }), [], key);
    });
  };

  // extrude a polygon-with-holes region from z=0: cut each hole Drawing out of the outer
  // Drawing (winding-agnostic 2-D boolean), sketch it, then extrude (twist/taper via cfg).
  // A Shape2D `profile` (curve-native, possibly multi-region) materializes through
  // drawingFor — a fresh Drawing per call, so no .clone() is needed before the
  // sketch consumes it (replicad booleans/extrude consume their operand).
  const extrude = (profile, hgt, { twist = 0, scaleTop = 1 } = {}) => {
    const key = h("extrude", profile && profile._shape2d ? profile._hash : profile, hgt, twist, scaleTop);
    return cached(key, () => {
      const region = profile && profile._shape2d ? drawingFor(profile) : drawingFromProfile(profile);
      const sketch = region.sketchOnPlane("XY");
      if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(hgt), [], key);
      const cfg = {};
      if (twist !== 0) cfg.twistAngle = twist;
      if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
      return wrap(sketch.extrude(hgt, cfg), [], key);
    });
  };

  // ring loft: mode "curve" (structurally identical curve rings) lofts the ORIGINAL
  // baked contours as true arc/spline wires — STEP stays curve-exact; every other mode
  // lofts the same resolved point rings the Manifold backend stitches, so parity is by
  // construction (ThruSections' own wire-matching never gets to pick a different seam).
  // closed:true loops are Manifold-only (replicad loft is open).
  // ThruSections can hand back a NEGATIVELY-oriented solid for some all-cubic wires
  // even though every input wire is CCW (arc and line wires never trigger this), so a
  // volume latch restores the positive orientation — the OCCT twin of loftMesh's
  // whole-mesh volume<0 rebuild on the Manifold side.
  const loftOp = (rings, { ruled = true, closed = false } = {}) => {
    if (closed) throw new Error("loft: closed:true loops are only supported on the Manifold backend");
    const key = h("loft", loftRingsKey(rings), ruled);
    return cached(key, () => {
      const { mode, resolved } = resolveLoftRings(rings);
      const wires = resolved.map(({ pts2d, contour, z }) =>
        (mode === "curve" ? contourDrawing(contour) : contourDrawing(pts2d)).sketchOnPlane("XY", z).wire);
      const solid = loft(wires, { ruled });
      if (measureVolume(solid) < 0) solid.wrapped.Reverse();
      return wrap(solid, [], key);
    });
  };

  // Sweep a 2-D profile along a 3-D polyline path. DEFAULT (§3A recipe): loft the SAME
  // 3-D stations resolveSweepStations() hands the Manifold backend, as ruled polygon wires
  // — so the two backends produce identical elbow geometry by construction (the loft-parity
  // mechanism, not a tolerance). smooth:true switches to the OCCT-native genericSweep along
  // a spline spine for an exact swept B-rep (STEP-exact / preview-faceted, parity waived —
  // the same contract loft ships for ruled:false). closed:true loops are Manifold-only.
  const sweepSmooth = (profile2D, path3D, cornerRadius, key) => {
    const edges = [];
    for (let i = 0; i < path3D.length - 1; i++) edges.push(makeLine(path3D[i], path3D[i + 1]));
    const spine = assembleWire(edges);
    const t0 = [path3D[1][0] - path3D[0][0], path3D[1][1] - path3D[0][1], path3D[1][2] - path3D[0][2]];
    const profileWire = contourDrawing(profile2D).sketchOnPlane(new Plane(path3D[0], null, t0)).wire;
    return wrap(genericSweep(profileWire, spine, {
      transitionMode: cornerRadius > 0 ? "round" : "right", // sharp miter analogue vs rounded joint
      forceProfileSpineOthogonality: true,
    }), [], key);
  };
  const sweep = (profile2D, path3D, { closed = false, cornerRadius = 0, ruled = true, smooth = false } = {}) => {
    if (closed) throw new Error("sweep: closed:true loops are only supported on the Manifold backend");
    const key = h("sweep", profile2D, path3D, closed, cornerRadius, ruled, smooth);
    return cached(key, () => {
      if (smooth) return sweepSmooth(profile2D, path3D, cornerRadius, key);
      const { stations } = resolveSweepStations(profile2D, path3D, { closed, cornerRadius });
      const wires = stations.map((ring) => assembleWire(ring.map((p, i) => makeLine(p, ring[(i + 1) % ring.length]))));
      return wrap(loft(wires, { ruled }), [], key);
    });
  };

  // circle profile swept along a helix (frenet)
  const helixSweptTube = (o) => {
    const key = h("helixSweptTube", o);
    return cached(key, () => {
      const { pathR, profileR, pitch, turns, z0, lefthand } = o;
      const spine = makeHelix(pitch, pitch * turns, pathR, [0, 0, z0], [0, 0, 1], lefthand);
      const dir = lefthand ? -1 : 1;
      const tangent = [0, dir * pathR, pitch / (2 * Math.PI)];
      const profile = assembleWire([makeCircle(profileR, [pathR, 0, z0], tangent)]);
      return wrap(genericSweep(profile, spine, { frenet: true }), [], key);
    });
  };

  const kernel = finishKernel({
    cylinder, // boredCylinder: the kernel front's default composition is exactly right here
    box: (min, max) => cached(h("box", min, max), () => wrap(makeBox(min, max), [], h("box", min, max))),
    roundedBox,
    prism, extrude, revolve, loft: loftOp, sweep, helixSweptTube,
    sphere: (r) => cached(h("sphere", r), () => wrap(makeSphere(r), [], h("sphere", r))),
    union: (solids) => {
      const key = h("union", solids.map((s) => s._hash));
      return cached(key, () => {
        const ms = solids.map((s) => s._mat());
        return wrap(
          ms.map((m) => m._s.clone()).reduce((a, b) => a.fuse(b)),
          ms.flatMap((m) => cloneLabels(m._labels)),
          key,
        );
      });
    },
    shape2d,
    // Backend-internal region adapter: the shared native engine (contour-offset.js)
    // that Shape2D.offset itself runs on — published here for callers that want the
    // region-in/region-out form directly. `_`-prefixed — not part of the public kernel
    // surface.
    _offsetRegions: offsetRegions,
    toSTEP: (named) => exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._mat()._s }))).arrayBuffer(),
    // Imported geometry, registered pre-build by the framework via `_registerImport`
    // (ensureImports, Task 8). Every call clones the master shape — replicad ops
    // consume their operands, and the master must never be handed out directly, or
    // a second `import(name)` call would see the first caller's transform.
    import: (name) => {
      const e = imports.get(name);
      if (!e) throw new Error(`import: unknown import "${name}" — declare it in the part's \`imports\` field`);
      if (e.error) throw e.error; // lazy: unusable-format entries fail at use, not at registration
      return wrap(e.shape.clone(), [], h("import", name, e.digest));
    },
    // Side-channel (underscore = off-contract, probe-invisible). Registration is
    // TOTAL — it never throws for an unusable format (e.g. an STL/3MF import on
    // this backend); an `{error}` entry is stored verbatim and thrown by
    // `import(name)` above at call time (spec: "Registration is total; errors are
    // lazy"). Re-registering the same name+digest is a no-op EXCEPT an error entry
    // is always upgradable (the post-crossover retry depends on this — see
    // `_importDigest`).
    _registerImport: async ({ name, digest, step, error }) => {
      const prev = imports.get(name);
      if (!prev?.error && prev?.digest === digest) return; // error entries are always upgradable
      if (error) { imports.set(name, { error, digest }); return; }
      imports.set(name, { shape: await importSTEP(new Blob([step])), digest });
    },
    // Registration memo: undefined for an error entry, so a later registration with
    // the same digest can upgrade it rather than being treated as a no-op repeat.
    _importDigest: (name) => { const e = imports.get(name); return e?.error ? undefined : e?.digest; },
    _acceptsStep: true,
    beginSubPart: (name) => cache.begin(name),
    endSubPart: () => cache.end(),
    sweepCache: () => cache.sweep(),
    cacheStats: () => cache.stats(),
    resetCacheStats: () => cache.resetStats(),
    // Drain the feature-skip warnings recorded since the last drain — the
    // Manifold backend's channel, mirrored (see occt-repair.js for the sources).
    takeBuildWarnings: () => buildWarnings.splice(0),
    // Internal: the recorder shared, backend-neutral helpers report through
    // (rim-bevel, roundedBox's clamp, Shape2D corner-op clamps).
    _recordWarning: recordWarning,
  });
  return kernel;
}
