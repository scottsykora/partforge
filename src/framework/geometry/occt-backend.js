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
import { addShape2dSugar } from "./shape2d-sugar.js";
import { assembleRegions, svgPathToRings, regionsArea, pointInRing, ringArea } from "./shape2d-regions.js";
import { finishKernel } from "./kernel-front.js";
import { createOcctRepair } from "./occt-repair.js";
import { classifyFaceGroups } from "./feature-attribution.js";
import { resolveRings } from "./loft.js";
import { resolveSweepStations } from "./sweep.js";
import { normalizeProfile } from "./profile.js";
import { h } from "./solid-hash.js";
import { createSolidCache } from "./solid-cache.js";
import { composePose, transformPositions } from "./pose.js";
import { meshToStl } from "./mesh-stl.js";
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.5 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP, measureVolume, makeSphere, makeLine, Plane, getOC } = replicad;

  // Fillet/chamfer/shell failure recovery (skip-on-failure, chamfer binary search) —
  // see occt-repair.js for the policies and why they differ per op.
  const { validChamfer, safeOp } = createOcctRepair(measureVolume);

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
          return wrap(
            a._s.clone().cut(makeCompound(bs.map((b) => b._s.clone()))),
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
          normals: new Float32Array(0), // let the main thread crease (matches prior look)
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
          return wrap(safeOp(a._s.clone(), (sh) => sh.fillet(radius, toEdgeFinder(selector)), `fillet(${radius})`), cloneLabels(a._labels), key);
        });
      },
      chamfer: (distance, selector) => {
        const key = h("chamfer", hash, distance, selKey(selector));
        // validChamfer probes on internal clones and never consumes its input.
        return cached(key, () => {
          const a = mat();
          return wrap(validChamfer(a._s, toEdgeFinder(selector), distance), cloneLabels(a._labels), key);
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
      toIndexedMesh: () => {
        const base = baseMesh("preview");
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

  // Region (outer + holes) -> Drawing, exactly like extrude's former inline region
  // path: draw the outer contour, then .cut() each hole Drawing out of it.
  const SHAPE2D_SEGS = 64;   // materialization LOD for toRegions() discretization
  const drawingFromProfile = (profile) => {
    const { outer, holes } = normalizeProfile(profile);
    let region = contourDrawing(outer);
    for (const hole of holes) region = region.cut(contourDrawing(hole));
    return region;
  };
  const liftDrawing = (x) => (x && x._shape2d ? x : shape2d(x));
  // Materialize a replicad Drawing into flat rings ready for the shared
  // assembleRegions (which buckets outer/hole by ring winding SIGN). TWO
  // corrections here, both confirmed against real replicad output rather than
  // guessed (see task-4-report.md's probe results):
  //
  // 1. toSVGPathD() renders in SVG's y-down convention, so every coordinate is
  //    negated back to model space.
  // 2. Drawing.toSVGPaths() nests 0-2 levels deep depending on the result shape,
  //    INCONSISTENTLY — e.g. a single interior hole nests as
  //    [[outerD, holeD]], but two disjoint holes built via sequential .cut()
  //    calls (cutAll) come back as a flat [outerD, hole1D, hole2D] with no
  //    grouping at all. So which array position is "the outer" can't be read off
  //    the nesting shape. Worse: unlike Manifold's CrossSection.toPolygons()
  //    (outer CCW/positive, hole CW/negative), replicad emits EVERY loop of a
  //    region — outer or hole — with the same rotational sense, so ring winding
  //    carries no outer/hole signal either (verified: an interior hole in a
  //    20x20 square, classified by sign alone, came back as 2 disjoint "outer"
  //    regions summing 400+36 instead of one region netting 364).
  //    The one signal that IS reliable is geometric containment DEPTH: classify
  //    each ring by how many OTHER rings contain it (even-odd nesting), then
  //    force each ring's winding to match its depth parity ABSOLUTELY — even depth
  //    is an outer (CCW / positive area), odd depth is a hole (CW / negative area).
  //    Setting the orientation absolutely (rather than reversing relative to the
  //    emitted sense) is what makes this winding-agnostic: a CW-wound cut tool
  //    makes replicad emit the hole loop with the opposite sense, and a relative
  //    reversal would double-flip it back to a positive area — misbucketing the
  //    hole as a second outer (409/2-regions/0-holes instead of 391/1/1).
  const drawingRegionRings = (drawing) => {
    const rings = drawing.toSVGPaths().flat(Infinity)
      .flatMap((d) => svgPathToRings(d, SHAPE2D_SEGS))
      .map((ring) => ring.map(([x, y]) => [x, -y]));
    const containedBy = rings.map((r, i) =>
      rings.reduce((n, other, j) => (i !== j && pointInRing(r[0], other) ? n + 1 : n), 0));
    return rings.map((r, i) => {
      const wantOuter = containedBy[i] % 2 === 0;                 // even depth = outer
      return (ringArea(r) >= 0) === wantOuter ? r : r.slice().reverse();
    });
  };
  // Shape2D carries a content hash (so a Solid op over a profile can key on it)
  // but stays UNCACHED — Drawings already clone before every consuming replicad
  // call, and 2-D booleans are cheap next to the B-rep work they feed.
  const wrapShape2d = (drawing, hash) => {
    const toRegions = () => assembleRegions(drawingRegionRings(drawing));
    return addShape2dSugar({
      _drawing: drawing,
      _shape2d: true,
      _hash: hash,
      union:     (o) => { const t = liftDrawing(o); return wrapShape2d(drawing.clone().fuse(t._drawing.clone()), h("union2d", hash, t._hash)); },
      cut:       (o) => { const t = liftDrawing(o); return wrapShape2d(drawing.clone().cut(t._drawing.clone()), h("cut2d", hash, t._hash)); },
      cutAll:    (os) => {
        const ts = os.map(liftDrawing);
        return wrapShape2d(ts.reduce((acc, t) => acc.cut(t._drawing.clone()), drawing.clone()), h("cutAll2d", hash, ts.map((t) => t._hash)));
      },
      intersect: (o) => { const t = liftDrawing(o); return wrapShape2d(drawing.clone().intersect(t._drawing.clone()), h("intersect2d", hash, t._hash)); },
      // corners map onto replicad's Offset2DConfig.lineJoinType; "chamfer" → "bevel", a
      // true 45° corner cut (a straight chord). Manifold now matches this via a
      // single-chord Round join (see manifold-backend offset) — the two agree to float
      // precision for convex corners with interior angle ≥ 90°; at acute (<90°) corners
      // Manifold uses a 2-facet approximation that departs slightly. See KERNEL-CONTRACT.
      offset: (delta, { corners = "round" } = {}) => {
        const lineJoinType = { round: "round", chamfer: "bevel", sharp: "miter" }[corners];
        if (!lineJoinType) throw new Error('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
        if (!Number.isFinite(delta)) throw new Error("Shape2D.offset: delta must be a finite number");
        const result = drawing.clone().offset(delta, { lineJoinType });   // clone — replicad consumes the operand
        // Collapse doesn't throw and Drawing has no public `blueprints` array (that's on
        // Blueprints/CompoundBlueprint, not Drawing) — replicad instead returns a Drawing
        // whose private `innerShape` is null (confirmed by probe). That's the collapse signal.
        // NB: `innerShape` is replicad-internal; the "collapse throws immediately (OCCT)" test
        // guards this — a replicad upgrade that renames it must keep that test green.
        if (!result || !result.innerShape)
          throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
        return wrapShape2d(result, h("offset2d", hash, delta, corners));
      },
      area: () => regionsArea(toRegions()),                 // no native Drawing area → derive from materialized regions
      boundingBox: () => { const b = drawing.boundingBox; return { min: [b.bounds[0][0], b.bounds[0][1]], max: [b.bounds[1][0], b.bounds[1][1]] }; },
      toRegions,
      clone: () => wrapShape2d(drawing.clone(), hash),
    }, { shape2d, extrude: kernel.extrude, revolve: kernel.revolve });
  };
  const shape2d = (profile) => (profile && profile._shape2d ? profile : wrapShape2d(drawingFromProfile(profile), h("shape2d", profile)));

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
      const region = pts && pts._shape2d ? pts._drawing.clone() : contourDrawing(pts);
      return wrap(region.sketchOnPlane("XZ").revolve([0, 0, 1], { angle: degrees }), [], key);
    });
  };

  // extrude a polygon-with-holes region from z=0: cut each hole Drawing out of the outer
  // Drawing (winding-agnostic 2-D boolean), sketch it, then extrude (twist/taper via cfg).
  // A Shape2D `profile` (already a Drawing, possibly multi-region) extrudes directly off
  // its own `_drawing` (cloned — replicad booleans/extrude consume their operand).
  const extrude = (profile, hgt, { twist = 0, scaleTop = 1 } = {}) => {
    const key = h("extrude", profile && profile._shape2d ? profile._hash : profile, hgt, twist, scaleTop);
    return cached(key, () => {
      const region = profile && profile._shape2d ? profile._drawing.clone() : drawingFromProfile(profile);
      const sketch = region.sketchOnPlane("XY");
      if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(hgt), [], key);
      const cfg = {};
      if (twist !== 0) cfg.twistAngle = twist;
      if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
      return wrap(sketch.extrude(hgt, cfg), [], key);
    });
  };

  // ring loft: each ring becomes a closed polygon wire placed at its z (native loft closes
  // the ends for closed wires). closed:true loops are Manifold-only (replicad loft is open).
  const loftOp = (rings, { ruled = true, closed = false } = {}) => {
    if (closed) throw new Error("loft: closed:true loops are only supported on the Manifold backend");
    const key = h("loft", rings, ruled);
    return cached(key, () => {
      const wires = resolveRings(rings).map(({ pts2d, z }) => contourDrawing(pts2d).sketchOnPlane("XY", z).wire);
      return wrap(loft(wires, { ruled }), [], key);
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
    toSTEP: (named) => {
      // Blob-free STEP: replicad's exportSTEP writes the STEP text to OCCT's
      // virtual FS, reads it, and wraps it in a Blob. Safari's sandbox worker
      // cannot read a Blob, so we intercept the FS read to capture the raw
      // Uint8Array before it is wrapped, and return an ArrayBuffer instead. The
      // interception is synchronous (exportSTEP is sync) and restored in finally.
      const oc = getOC();
      const realRead = oc.FS.readFile.bind(oc.FS);
      let captured = null;
      oc.FS.readFile = (path, ...rest) => {
        const bytes = realRead(path, ...rest);
        if (typeof path === "string" && path.toLowerCase().endsWith(".step")) captured = bytes;
        return bytes;
      };
      try {
        exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._mat()._s })));
      } finally {
        oc.FS.readFile = realRead;
      }
      if (!captured) throw new Error("STEP export produced no bytes");
      return Promise.resolve(captured.buffer.slice(captured.byteOffset, captured.byteOffset + captured.byteLength));
    },
    beginSubPart: (name) => cache.begin(name),
    endSubPart: () => cache.end(),
    sweepCache: () => cache.sweep(),
    cacheStats: () => cache.stats(),
    resetCacheStats: () => cache.resetStats(),
  });
  return kernel;
}
