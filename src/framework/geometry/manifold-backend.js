import { helixTube } from "./helix-tube.js";
import { loftMesh } from "./loft.js";
import { sweepMesh } from "./sweep.js";
import { roundedBoxRings } from "./rounded-solids.js";
import { tessellateContour, tessellateProfile } from "./profile.js";
import { h } from "./solid-hash.js";
import { createSolidCache } from "./solid-cache.js";
import { addSugar } from "./solid-sugar.js";
import { makeShape2dFactory } from "./shape2d.js";
import { offsetRegions } from "./contour-offset.js";
import { finishKernel } from "./kernel-front.js";
import { meshToStl } from "./mesh-stl.js";
import { creasedNormals } from "./creased-normals.js";
import { loftShadingPolicy, SMOOTH } from "./shading-policy.js";
import { meshFillet, meshChamfer, UnsupportedEdgeError } from "./mesh-fillet.js";
import { meshRoundAll } from "./mesh-roundall.js";
import { KernelCapabilityError } from "./errors.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
// 'preview' = interactive view (fast); 'print' = STL export (high-res, used only
// by the export path — Manifold meshing is cheap, so we tessellate generously).
const SEGS = { preview: 116, print: 480 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 38, ringSegs: 24 }, print: { stationsPerTurn: 160, ringSegs: 40 } };

// true axis-angle rotation as a column-major 4x4 (manifold Mat4), translation 0
function axisAngleMat4(axis, deg) {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const R00 = c + x*x*C,   R01 = x*y*C - z*s, R02 = x*z*C + y*s;
  const R10 = y*x*C + z*s, R11 = c + y*y*C,   R12 = y*z*C - x*s;
  const R20 = z*x*C - y*s, R21 = z*y*C + x*s, R22 = c + z*z*C;
  // column-major: columns are images of the basis vectors; 4th column = translation (0)
  return [R00, R10, R20, 0,  R01, R11, R21, 0,  R02, R12, R22, 0,  0, 0, 0, 1];
}

export function createManifoldKernel(wasm, { quality = "preview" } = {}) {
  const { Manifold, CrossSection } = wasm;
  const segs = SEGS[quality], tube = TUBE[quality];

  // Manifold/CrossSection are WASM objects with no garbage collection — every
  // primitive and boolean op allocates a new one. Track them all and free them
  // per job via cleanup(); otherwise repeated generates exhaust the WASM heap
  // (manifests as "Out of bounds memory access").
  const tracked = [];
  const T = (obj) => { tracked.push(obj); return obj; };
  const unionRaw = (ms) => ms.reduce((a, b) => T(a.add(b))); // track each reduce step

  const cache = createSolidCache();
  const featureLabels = new Map(); // originalID -> label string (grows per label(); tiny)
  const oidPolicies = new Map();   // originalID -> shading policy (grows per faceted/hinted loft; tiny)
  // Boundary ops route through cache.lookup; on a miss `make` runs the WASM op,
  // tracks the result, and returns the triple the cache needs to pin/dispose it.
  const cached = (hash, computeM) => cache.lookup(hash, () => {
    const m = computeM();                 // already T()-tracked by the op
    return { value: wrap(m, hash), pin: m, dispose: () => m.delete?.() };
  });

  // Contour-IR region list -> flat point rings at `nSeg` (outer + holes, even/odd
  // fill sorts them out). The one place the IR meets CrossSection.ofPolygons.
  const regionPolys = (regions, nSeg) => regions.flatMap((rg) =>
    [tessellateContour(rg.outer, nSeg), ...rg.holes.map((hl) => tessellateContour(hl, nSeg))]);

  // 2-D boolean value: the SHARED Shape2D (shape2d.js). Storage is the curve-native
  // contour IR and every op — including `offset`, now the shared native engine — runs
  // on it in pure JS; no CrossSection is built until a shape is handed to a kernel op.
  // `extrude`/`revolve` are thunks because `kernel` below is defined after this.
  const shape2d = makeShape2dFactory({
    segs,
    extrude: (o) => kernel.extrude(o),
    revolve: (o) => kernel.revolve(o),
  });
  // Lazy CrossSection materialization, memoized through the solid cache by content
  // hash + LOD: the same shape extruded twice (or extruded and revolved) tessellates
  // once, and the cache's pin/dispose keeps the WASM object alive exactly as long as
  // the entry (cleanup() skips pinned objects).
  const csFor = (shape) => cache.lookup(h("cs2d", shape._hash, segs), () => {
    const cs = T(CrossSection.ofPolygons(regionPolys(shape._regions, segs), "EvenOdd"));
    return { value: cs, pin: cs, dispose: () => cs.delete?.() };
  });

  // Copy the mesh out into JS-owned arrays (so it survives cleanup) and free the
  // transient mesh handle.
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, { policies: oidPolicies, featureLabels });
    g.delete?.();
    return r;
  }

  // Raw indexed mesh (positions x,y,z per vertex + triangle indices) for 3MF.
  function indexedMeshOut(m) {
    const g = m.getMesh();
    const np = g.numProp, vp = g.vertProperties;
    const nVert = (vp.length / np) | 0;
    let positions;
    if (np === 3) {
      positions = Float32Array.from(vp);
    } else {
      positions = new Float32Array(nVert * 3);
      for (let i = 0; i < nVert; i++) { positions[i * 3] = vp[i * np]; positions[i * 3 + 1] = vp[i * np + 1]; positions[i * 3 + 2] = vp[i * np + 2]; }
    }
    const indices = Uint32Array.from(g.triVerts);
    g.delete?.();
    return { positions, indices };
  }

  // Mesh fillet/chamfer (mesh-fillet.js): the tool solids are built through the
  // kernel's own cached loft/revolve/boolean ops, so the whole op memoizes at
  // this boundary — and the result is simplify()ed to drop the zero-area sliver
  // triangles booleans legitimately leave behind (they are invisible but their
  // degenerate normals poison the crease pass into drawing phantom edge lines).
  // Unsupported edge classes (helical edges, varying dihedral, …) surface as
  // KernelCapabilityError so the framework reroutes that sub-part to OCCT.
  // simplify() will not collapse triangles across run (originalID) boundaries,
  // and the boolean's sliver triangles sit exactly on them — so the result is
  // re-originaled first. That folds every surface into one fresh original,
  // which is also the documented B-rep semantic: fillet/chamfer produce new
  // surfaces, so feature-label attribution downstream of the op uses the
  // fallback path (AUTHORING-PARTS.md), and the blend shades SMOOTH.
  const SIMPLIFY_EPS = 1e-4; // 0.1 µm — must exceed the boolean's sliver widths (~2e-5)
  const meshCadOp = (op, run) => {
    try {
      return T(T(run()._m.asOriginal()).simplify(SIMPLIFY_EPS));
    } catch (e) {
      if (e instanceof UnsupportedEdgeError) throw new KernelCapabilityError(`${op}: ${e.message}`);
      throw e;
    }
  };

  const wrap = (m, hash) => addSugar({
    _m: m,
    _hash: hash,
    cut: (t) => cached(h("cut", hash, t._hash), () => T(m.subtract(t._m))),
    fillet: (r, selector) => {
      if (typeof selector === "function") throw new KernelCapabilityError("fillet: function selectors need the OCCT backend");
      if (r === 0) return wrap(m, hash); // contract: zero magnitude is the identity
      return cached(h("fillet", hash, r, selector ?? null, segs), () =>
        meshCadOp("fillet", () => meshFillet(kernel, wrap(m, hash), { r, edges: selector, segs })));
    },
    chamfer: (d, selector) => {
      if (typeof selector === "function") throw new KernelCapabilityError("chamfer: function selectors need the OCCT backend");
      if (d === 0) return wrap(m, hash);
      return cached(h("chamfer", hash, d, selector ?? null, segs), () =>
        meshCadOp("chamfer", () => meshChamfer(kernel, wrap(m, hash), { d, edges: selector, segs })));
    },
    roundAll: (r) => {
      if (r === 0) return wrap(m, hash); // contract: zero magnitude is the identity
      return cached(h("roundAll", hash, r, quality), () => T(meshRoundAll(wasm, m, r, quality)));
    },
    cutAll: (tools) => cached(h("cutAll", hash, tools.map((t) => t._hash)),
      () => T(m.subtract(unionRaw(tools.map((t) => t._m))))),
    intersect: (t) => cached(h("intersect", hash, t._hash), () => T(m.intersect(t._m))),
    union: (t) => cached(h("union", [hash, t._hash]), () => unionRaw([m, t._m])),
    clone: () => wrap(m, hash),
    // Name this solid's surface for hover/pick feature attribution. asOriginal()
    // stamps a fresh originalID that survives transforms and booleans, so every
    // surviving triangle of this surface can be traced back to the label. The
    // registry entry lives exactly as long as the cache pins the solid — eviction
    // disposes both, so the registry can't grow unboundedly across regenerates.
    label: (name) => {
      const lh = h("label", hash, name);
      return cache.lookup(lh, () => {
        const prevId = typeof m.originalID === "function" ? m.originalID() : -1;
        const o = T(m.asOriginal());
        const id = o.originalID();
        featureLabels.set(id, name);
        // labeling re-stamps the originalID — carry the surface's shading policy along.
        // A boolean upstream of this label() (e.g. a faceted loft().intersect(tool),
        // as the vase does to hollow itself) leaves the solid spanning more than one
        // original surface, so originalID() reports -1 ("mixed") rather than a single
        // id — the direct lookup below misses even though the loft's policy is right
        // there. Fall back to the mesh's own run table and recover it via a
        // triangle-count-weighted majority vote across all surfaces feeding this
        // mesh (a plain tool like a box has no registered policy of its own, but
        // still votes SMOOTH — see below).
        let inherited = prevId !== -1 ? oidPolicies.get(prevId) : undefined;
        // Skip the mesh scan entirely when no surface anywhere has a registered
        // policy (e.g. planter's labeled prism compound) — getMesh() forces a
        // full mesh materialization and parts with no lofts must not pay for it.
        if (inherited === undefined && prevId === -1 && oidPolicies.size > 0) {
          const g = m.getMesh();
          // Triangle-count-weighted majority: walk the run table with runIndex
          // (each run r spans triangles ri[r]/3..ri[r+1]/3 — same arithmetic
          // creased-normals.js uses) and tally triangle counts per registered
          // policy, keyed by VALUE (creaseAngle/sameSurfaceLines), not object
          // reference — a majority-by-object-identity check would silently
          // break if policies were ever constructed per-op instead of shared
          // singletons. A run whose original surface has NO registered policy
          // (a plain boolean tool, e.g. a box) still gets a vote: at render
          // time an unregistered surface shades SMOOTH (buildGeometry's
          // default), so counting it as an abstention would let the vote
          // disagree with what's actually drawn — it contributes its triangle
          // weight to SMOOTH instead. The policy spanning the most triangles
          // wins; an exact tie favors the FACETED-like policy
          // (sameSurfaceLines: false) — deterministic, and biased toward
          // honest-print rendering over silently smoothing facets away.
          const ri = g.runIndex, roid = g.runOriginalID;
          const weightByKey = new Map();  // policy key -> triangle count
          let bestWeight = -1, bestPol;
          for (let r = 0; r < roid.length; r++) {
            const pol = oidPolicies.get(roid[r]) ?? SMOOTH;
            const key = `${pol.creaseAngle}/${pol.sameSurfaceLines}`;
            const weight = (weightByKey.get(key) || 0) + (ri[r + 1] / 3 - ri[r] / 3);
            weightByKey.set(key, weight);
            const better = weight > bestWeight || (weight === bestWeight && !pol.sameSurfaceLines && bestPol?.sameSurfaceLines);
            if (better) { bestWeight = weight; bestPol = pol; }
          }
          g.delete?.();
          inherited = bestPol;
        }
        if (inherited !== undefined) oidPolicies.set(id, inherited);
        return { value: wrap(o, lh), pin: o, dispose: () => { featureLabels.delete(id); oidPolicies.delete(id); o.delete?.(); } };
      });
    },
    boundingBox: () => {
      const b = m.boundingBox();           // { min: Vec3, max: Vec3 } — addSugar derives center/size
      return { min: [...b.min], max: [...b.max] };
    },
    volume: () => m.volume(),
    genus: () => m.genus(),
    isEmpty: () => m.isEmpty(),
    translate: (v) => wrap(T(m.translate(v)), h("translate", hash, v)),
    rotate: (deg, center, axis) => {
      const nz = (axis[0] !== 0) + (axis[1] !== 0) + (axis[2] !== 0);
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = nz <= 1
        ? T(a.rotate([axis[0] * deg, axis[1] * deg, axis[2] * deg]))   // basis axis — euler is exact; unchanged
        : T(a.transform(axisAngleMat4(axis, deg)));                    // general axis-angle
      return wrap(T(b.translate(center)), h("rotate", hash, deg, center, axis));
    },
    mirror: (plane) => wrap(T(m.mirror(PLANE_NORMAL[plane])), h("mirror", hash, plane)),
    scale: (factor, center) => { // factor validated (and center defaulted) by addSugar
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.scale([factor, factor, factor]));
      return wrap(T(b.translate(center)), h("scale", hash, factor, center));
    },
    toMesh: () => meshOut(m, false),
    toSTL: () => Promise.resolve(meshOut(m, true)),
    toIndexedMesh: () => indexedMeshOut(m),
  });

  const kernel = finishKernel({
    cylinder: (rb, rt, h2, { center = false } = {}) =>
      wrap(T(Manifold.cylinder(h2, rb, rt, segs, center)), h("cylinder", rb, rt, h2, center, segs)),
    // Compound op: hashed ATOMICALLY from its own args, so it is a single cache
    // node — its internal cylinders/cut are never retained. The template for
    // future compounds: build internals with T(), return the final tracked solid.
    boredCylinder: ({ od, h: height, bore }) => cached(h("boredCylinder", od, height, bore, segs), () => {
      const body = T(Manifold.cylinder(height, od / 2, od / 2, segs, false));
      const tool0 = T(Manifold.cylinder(height + 4, bore / 2, bore / 2, segs, false));
      const tool = T(tool0.translate([0, 0, -2])); // raw ops: track each result
      return T(body.subtract(tool));
    }),
    // Rounded box: ONE hand-meshed ring stack (no booleans) whose cross-
    // sections follow the normative formula (rounded-solids.js / the design
    // spec). Reuses loftMesh's stitch/cap/winding machinery. Atomic cache
    // node hashed from its own args, like boredCylinder.
    roundedBox: ({ size, center, round }) => cached(
      h("roundedBox", size, center, round.side, round.top, round.bottom, segs),
      () => {
        const solid = T(loftMesh(wasm, roundedBoxRings(size, round, segs)));
        return center ? T(solid.translate([0, 0, -size[2] / 2])) : solid;
      }),
    sphere: (r) => wrap(T(Manifold.sphere(r, segs)), h("sphere", r, segs)),
    box: (min, max) => {
      const cube = T(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
      return wrap(T(cube.translate(min)), h("box", min, max));
    },
    prism: (pts, height, { twist = 0, scaleTop = 1 } = {}) =>
      cached(h("prism", pts, height, twist, scaleTop, segs), () => {
        const cs = T(CrossSection.ofPolygons([tessellateContour(pts, segs)]));
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
        // Manifold's extrude scaleTop is a Vec2 — a scalar is NOT broadcast (it scales
        // X and drives Y to 0, squishing the top to a line). Broadcast for a uniform taper.
        return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
      }),
    // Polygon-with-holes extrude in one op: even/odd fill turns the extra contours into
    // holes regardless of their winding (outer + holes, no per-hole boolean cut).
    // A Shape2D `profile` (curve-native, possibly multi-region) materializes through
    // csFor — one memoized tessellation per shape+LOD — and folds into the cache key
    // by `_hash` like any other solid operand.
    extrude: (profile, height, { twist = 0, scaleTop = 1 } = {}) => {
      const shape = profile && profile._shape2d ? profile : null;
      return cached(h("extrude", shape ? shape._hash : profile, height, twist, scaleTop, segs), () => {
        const cs = shape ? csFor(shape) : (() => {
          const { outer, holes } = tessellateProfile(profile, segs);
          return T(CrossSection.ofPolygons([outer, ...holes], "EvenOdd"));
        })();
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
        return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
      });
    },
    // Ring loft: hand-meshed via the shared ring-mesh helpers (helix-tube recipe).
    // Cached atomically; the hash folds every ring's points/z/rotate/scale and the
    // opts (including `shading`, so toggling the hint is a fresh cache node).
    // asOriginal() stamps a stable originalID; the shading policy (inferred from
    // the rings, or forced by `shading`) registers under it for the crease pass
    // and lives exactly as long as the cache pins the solid.
    loft: (rings, opts = {}) => {
      const key = h("loft", rings, opts);
      return cache.lookup(key, () => {
        const raw = T(loftMesh(wasm, rings, opts));
        const m = T(raw.asOriginal());
        const id = m.originalID();
        oidPolicies.set(id, loftShadingPolicy(rings, opts));
        return { value: wrap(m, key), pin: m, dispose: () => { oidPolicies.delete(id); m.delete?.(); } };
      });
    },
    // Sweep a fixed 2-D profile along a 3-D polyline: hand-meshed from the shared station
    // list (sweep.js), so it agrees with OCCT's ruled loft of the same stations by
    // construction. Cached atomically; the hash folds profile pts, path pts, and opts
    // (closed/cornerRadius) so a shape change is a fresh node and an identical rebuild hits.
    sweep: (profile, path, opts = {}) => cached(h("sweep", profile, path, opts), () => T(sweepMesh(wasm, profile, path, opts))),
    helixSweptTube: (o) => cached(h("helixSweptTube", o, tube), () => T(helixTube(wasm, { ...o, ...tube }))),
    revolve: (pts, { degrees = 360 } = {}) => {
      if (pts && pts._shape2d)
        return cached(h("revolve", pts._hash, degrees, segs), () => T(csFor(pts).revolve(segs, degrees)));
      return cached(h("revolve", pts, degrees, segs), () => T(Manifold.revolve([pts], segs, degrees)));
    },
    // A one-solid union is an identity — no new WASM / cache entry (avoids double-free):
    // unionRaw's reduce returns the operand's own Manifold untouched, so caching it
    // would pin one WASM object under two entries and eviction would dispose it twice.
    union: (solids) => solids.length === 1
      ? solids[0]
      : cached(h("union", solids.map((s) => s._hash)), () => unionRaw(solids.map((s) => s._m))),
    shape2d,
    // Backend-internal region adapter: the shared native engine (contour-offset.js)
    // that Shape2D.offset itself runs on — published here for callers that want the
    // region-in/region-out form directly. `_`-prefixed — not part of the public kernel
    // surface.
    _offsetRegions: offsetRegions,
    beginSubPart: (name) => cache.begin(name),
    endSubPart: () => cache.end(),
    sweepCache: () => cache.sweep(),
    cacheStats: () => cache.stats(),
    resetCacheStats: () => cache.resetStats(),
    // Free every WASM object created since the last cleanup EXCEPT solids the cache
    // still pins (they must survive for the next build to resume from them).
    cleanup: () => { for (const o of tracked) if (!cache.isPinned(o)) o.delete?.(); tracked.length = 0; },
  });
  return kernel;
}

function stlFromMesh(g) {
  const vp = g.vertProperties, np = g.numProp;
  const nVert = (vp.length / np) | 0;
  let positions;
  if (np === 3) {
    positions = vp; // already x,y,z per vertex
  } else {
    positions = new Float32Array(nVert * 3);
    for (let i = 0; i < nVert; i++) { positions[i*3] = vp[i*np]; positions[i*3+1] = vp[i*np+1]; positions[i*3+2] = vp[i*np+2]; }
  }
  return meshToStl(positions, g.triVerts);
}
