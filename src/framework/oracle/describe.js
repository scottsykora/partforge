// The describe orchestrator: mesh in, semantic report out. Sits beside measure.js and
// plays the same role for an imported mesh that measure plays for a built part.
//
// THE MEMO IS THE POINT OF THE WHOLE CACHING STORY (spec §4.1). measure and verify
// depend on part source AND params, so they must re-run on every apply. describe depends
// on NOTHING BUT THE MESH BYTES. So it keys on the import's content digest and an edit
// can never invalidate it: computed once per mesh per worker, reused for the entire
// session, across every turn. The memo Map is caller-owned rather than module-level so
// a worker can scope it to its own lifetime and a test can get a clean one — the same
// reasoning bvh.js's cachedBVH documents for its cache.
//
// Errors come from a CLOSED SET and are returned, never thrown, for anything short of a
// programming mistake. A mesh describe cannot read is a finding about the mesh, and the
// caller (a CLI, an agent) can act on `{error: "not-manifold"}` far better than on an
// exception. Every code has an ERROR-PATTERNS.md entry.
import { buildTopology } from "./describe/topology.js";
import { segment } from "./describe/segment.js";
import { surfaceGraph } from "./describe/surface-graph.js";
import { detectHoles } from "./describe/features/holes.js";
import { detectDressups } from "./describe/features/dressups.js";
import { detectPrismatic } from "./describe/features/prismatic.js";
import { detectSweeps } from "./describe/features/sweeps.js";
import { detectPatterns } from "./describe/patterns.js";
import { snapValue, snapHoleDiameter } from "./describe/snap.js";
import { acceptCandidates, DEFAULT_ATTEMPT_BUDGET } from "./describe/accept.js";
import { buildReport } from "./describe/report.js";
import { buildHints } from "./describe/hints.js";
import { bounds, meshArea } from "./mesh.js";
import { buildBVH } from "./bvh.js";

export const DESCRIBE_ERRORS = Object.freeze(
  ["not-manifold", "too-large", "empty", "budget-exceeded", "unreadable"]);

// Above this the segmentation cost stops being worth the wait in an interactive loop.
// Not a correctness limit — a responsiveness one, reported as `too-large` so the caller
// can decimate and retry rather than wonder why nothing happened.
const MAX_TRIANGLES = 400_000;

export const describeMemo = () => new Map();

// A closed-set error, shaped as the repo's structured diagnostic triple (spec §5, and
// the same (cause, location, correctiveAction) contract measure/verify emit). The
// research behind it is blunt about why: structured triples cut average agent retries
// 2.62 -> 1.86 against the same failures reported as prose. `error` stays a bare code so
// a caller can switch on it exhaustively.
const fail = (error, opts, source, cause, location, correctiveAction) => ({
  error,
  detail: cause,
  diagnostic: { cause, location, correctiveAction },
  source: { name: opts.name ?? null, digest: opts.digest ?? null, ...source },
});

// --- vec3 helpers for orienting acceptance candidates ------------------------
// toCandidate builds every solid in a canonical local frame (holes and cylinder
// bosses along local Z; boxes with local Z as depth and local X as one wall) and
// then rotates it onto the part's OWN frame, wherever a rigid rotation of the
// whole input mesh happened to put that frame. Kept together, and separate from
// the per-feature logic below, because every one of them is pure coordinate math
// with no feature-vocabulary knowledge of its own.
const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross3 = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const unit3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const scale3 = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const add3 = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
// The component of `u` perpendicular to `w` (w assumed unit) — cleans up a wall
// normal that is perpendicular to the extrusion axis only up to fit residual.
const orthogonalize = (u, w) => unit3([u[0] - w[0]*dot3(u,w), u[1] - w[1]*dot3(u,w), u[2] - w[2]*dot3(u,w)]);

// Aligns a Z-based primitive (a kernel cylinder's own local axis) with an arbitrary
// unit `dir` — the axis/angle rotation `.rotate(deg, [0,0,0], axis)` needs. A hole's
// bore can point anywhere once the whole part is rotated (the orientation-invariance
// test below exercises exactly this), so a candidate cylinder built assuming a world-Z
// axis would miss a tilted bore entirely: it would still be built, still get measured
// by acceptCandidates' own xor-volume gain, and would simply score ~0 and never be
// accepted — a silent, hard-to-diagnose loss of the feature from `suggestion.steps`,
// not a crash. Returns null when `dir` already IS +Z (no rotation needed) and a
// 180°-about-X rotation for the -Z case, where the cross product degenerates to zero.
function alignZTo(dir) {
  const d = unit3(dir);
  const cosT = d[2]; // dot([0,0,1], d)
  const axis = [-d[1], d[0], 0]; // cross([0,0,1], d)
  const sinT = Math.hypot(axis[0], axis[1], axis[2]);
  if (sinT < 1e-9) return cosT > 0 ? null : { axis: [1, 0, 0], deg: 180 };
  return { axis, deg: (Math.atan2(sinT, cosT) * 180) / Math.PI };
}

// Rotates a plain vector by the SAME axis-angle convention `.rotate()` itself uses
// (manifold-backend.js's own axisAngleMat4 — copied here, not imported, since this
// file stays kernel-agnostic pure math and the OCCT backend's `.rotate()` honours
// the identical (deg, center, axis) contract per KERNEL-CONTRACT.md). Used below to
// work out where a candidate's own local X axis has already landed after the first
// of two composed rotations, so the second can be computed exactly.
function rotateVector(v, axis, deg) {
  const [x, y, z] = unit3(axis);
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  return [
    (c + x*x*C)*v[0]   + (x*y*C - z*s)*v[1] + (x*z*C + y*s)*v[2],
    (y*x*C + z*s)*v[0] + (c + y*y*C)*v[1]   + (y*z*C - x*s)*v[2],
    (z*x*C - y*s)*v[0] + (z*y*C + x*s)*v[1] + (c + z*z*C)*v[2],
  ];
}

// Degrees to rotate unit vector `a` onto unit vector `b` about `axis`, where both
// a and b are already perpendicular to `axis` — the "roll" half of orienting a box
// candidate below. A signed angle (atan2, not acos) because the roll can go either way.
const angleAbout = (a, b, axis) => (Math.atan2(dot3(cross3(a, b), axis), dot3(a, b)) * 180) / Math.PI;

// Rotates `solid` (built with local Z along `direction` and local X along `uAxis`)
// onto the world orientation those two vectors actually have, as TWO single-axis
// rotations composed: tip local Z onto `direction` (alignZTo), then roll about
// `direction` so local X lands on `uAxis`. Two single-axis rotations rather than one
// general 3x3 basis change because `.rotate()`/`.rotateAbout()` only accept a single
// axis-angle pair, and Euler's rotation theorem guarantees this composition reaches
// every orientation a 3x3 change could (recovering axis/angle from an arbitrary
// rotation matrix directly is the harder, more error-prone equivalent this avoids).
function orientOnto(solid, direction, uAxis) {
  const tip = alignZTo(direction);
  const tipped = tip ? solid.rotate(tip.deg, [0, 0, 0], tip.axis) : solid;
  const x1 = tip ? rotateVector([1, 0, 0], tip.axis, tip.deg) : [1, 0, 0];
  const rollDeg = angleAbout(x1, uAxis, direction);
  return Math.abs(rollDeg) < 1e-9 ? tipped : tipped.rotate(rollDeg, [0, 0, 0], direction);
}

// Bounding extent of every vertex in `positions` (flat x,y,z triples — either
// backend's form; duplicated shared vertices don't skew a min/max) projected onto
// each of three (assumed orthonormal) `axes`. `bounds()` (mesh.js) is the same
// idea specialised to the world axes; this is its general-frame twin, needed
// because a rotated part's own extrusion axis is not world Z (segment.js/
// surface-graph.js already read every OTHER measurement this same way).
function projectedBounds(positions, axes) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const p = [positions[i], positions[i+1], positions[i+2]];
    for (let a = 0; a < 3; a++) {
      const proj = dot3(p, axes[a]);
      if (proj < lo[a]) lo[a] = proj;
      if (proj > hi[a]) hi[a] = proj;
    }
  }
  return { min: lo, max: hi };
}

// Vertex positions (flat x,y,z triples, duplicates and all — `projectedBounds` only
// needs a min/max) belonging to ONE feature's own surfaces, not the whole mesh.
// Round 2 review's CRITICAL finding: a two-box stepped part (two "extrusion"-family
// features) fed the WHOLE mesh into `projectedBounds` for both candidates, so both
// came out identically sized to the full-part bbox — 62500mm3 each against a true
// 38500mm3 combined — and `acceptCandidates` (which greedily takes the better of two
// near-duplicate candidates and never revisits) accepted one and silently dropped the
// other: no error, no warning, just missing from `volumeShare`/`suggestion.steps`. A
// feature's `wallFaces`/`floorFace` name exactly the surfaces that belong to IT, and
// each surface already carries its own triangle list (`surface-graph.js`'s `faces`),
// so this reads the actual footprint each feature bounds rather than the part's.
function surfaceVertices(topo, surfById, ids) {
  const out = [];
  for (const id of ids) {
    const surf = surfById.get(id);
    if (!surf) continue;
    for (const t of surf.faces) {
      for (let k = 0; k < 3; k++) {
        const v = topo.tris[3*t + k] * 3;
        out.push(topo.verts[v], topo.verts[v+1], topo.verts[v+2]);
      }
    }
  }
  return out;
}

export function describe(kernel, solid, opts = {}) {
  // A live Solid in, not a mesh. The kernel exposes no public mesh->solid constructor —
  // geometry only enters through `_registerImport` + `import(name)` — and acceptance needs
  // a Solid to diff against. Both real callers (the worker job and the CLI) already hold
  // one from `k.import(name)`, so taking the Solid and deriving the mesh here is both the
  // honest signature and the shorter path.
  let mesh;
  try {
    mesh = solid.toMesh();
  } catch (err) {
    return fail("unreadable", opts, { triangles: 0 },
      `solid.toMesh() threw: ${err?.message ?? err}`,
      `import "${opts.name ?? "?"}"`,
      "the geometry could not be read back off the kernel; re-export the source file and retry");
  }
  // Both backends' toMesh() carries its own triangle count directly (kernel.js's
  // toMesh JSDoc) — no need to re-derive it from positions/indices length.
  const triangles = mesh?.triangles ?? 0;
  if (!triangles) {
    return fail("empty", opts, { triangles: 0 },
      "the mesh has no triangles",
      `import "${opts.name ?? "?"}"`,
      "check that the `imports` source resolves to a real file; see ERROR-PATTERNS.md#describe-empty");
  }
  if (triangles > MAX_TRIANGLES) {
    return fail("too-large", opts, { triangles },
      `${triangles} triangles exceeds the ${MAX_TRIANGLES} describe limit`,
      `import "${opts.name ?? "?"}"`,
      "re-export or decimate at a coarser chord tolerance; the feature rules read surfaces, not facets");
  }

  const memo = opts.memo;
  const key = opts.digest ? `${opts.digest}:${opts.budget ?? DEFAULT_ATTEMPT_BUDGET}` : null;
  if (memo && key && memo.has(key)) return memo.get(key);

  const topo = buildTopology(mesh);

  // Every edge in a genuine solid is shared by exactly two triangles; a boundary edge
  // (`triB < 0`, topology.js's own convention) means the mesh still has an open seam
  // after vertex-merge and winding repair, so it does not bound a solid and acceptance
  // has nothing to diff against. Checked here, before any of the expensive stages run.
  const openEdges = topo.edges.reduce((n, e) => n + (e.triB < 0 ? 1 : 0), 0);
  if (openEdges > 0) {
    return fail("not-manifold", opts, { triangles, openEdges },
      `${openEdges} open edge${openEdges === 1 ? "" : "s"} after vertex-merge and winding repair`,
      `import "${opts.name ?? "?"}"`,
      "repair the mesh before describing it; see ERROR-PATTERNS.md#describe-not-manifold");
  }

  const { patches, unassigned } = segment(topo);
  const graph = surfaceGraph(topo, patches);

  // ONE BVH for this call, shared by every stage that needs one (controller ruling R39).
  // `detectSweeps`'s shell rule raycasts inward from each plane, and `buildBVH` is
  // O(n log n) over the WHOLE mesh regardless of how few rays are cast — measured at 9.8ms
  // on 10.8k triangles and 48ms on 43k. Letting each stage build its own would pay that
  // repeatedly for nothing. This is the same caller-owned-cache pattern `measure.js` uses
  // to stop min-wall and meshGaps indexing the same mesh twice; see `cachedBVH`'s own
  // comment for why a caller-owned Map rather than a module-level WeakMap.
  const bvh = buildBVH({ positions: topo.verts, indices: topo.tris });

  // Feature families run in a fixed order and their results are concatenated in that
  // order, then sorted by each rule's own geometry-derived `key`. So f-numbering depends
  // on the MESH, never on iteration order or on which family happened to run first.
  const raw = [
    ...detectHoles(graph),
    ...detectDressups(graph),
    ...detectPrismatic(graph),
    ...detectSweeps(graph, topo, { bvh }),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const features = raw.map((f, i) => {
    const snapped = {};
    if (Number.isFinite(f.diameter)) { const s = snapHoleDiameter(f.diameter); if (s) snapped.diameter = s; }
    for (const k of ["depth", "radius", "width", "thickness"]) {
      if (Number.isFinite(f[k])) { const s = snapValue(f[k]); if (s) snapped[k] = s; }
    }
    return { ...f, id: `f${i}`, snapped };
  });

  const b = bounds(mesh.positions);
  const { patterns, symmetry } = detectPatterns(features, b);

  // Candidates for acceptance, in the order the rules produced them. `featureKey` is what
  // hints.js joins against to collapse a pattern's members into one step. `surfById` and
  // `topo` let a prismatic candidate orient itself onto THAT FEATURE'S OWN frame and
  // extent (see toCandidate's own comment) instead of assuming the extrusion runs along
  // world Z, or — round 2 review's CRITICAL finding — reading the whole mesh's bounds
  // for every feature and building every candidate the same full-part size.
  const surfById = new Map(graph.surfaces.map((s) => [s.id, s]));
  const candidates = features
    .map((f) => toCandidate(kernel, f, b, { surfById, topo }))
    .filter(Boolean);

  const graded = acceptCandidates(kernel, solid, candidates, { budget: opts.budget });

  const totalArea = meshArea(mesh.positions, mesh.indices);
  const explainedArea = totalArea > 0
    ? graph.surfaces.reduce((a, s) => a + s.area, 0) / totalArea
    : 0;
  const residualArea = unassigned.reduce((a, t) => a + topo.faceArea[t], 0);

  const report = buildReport({
    source: { name: opts.name ?? null, digest: opts.digest ?? null, triangles, watertight: true },
    bounds: b,
    surfaces: graph.surfaces.map((s) => ({
      id: s.id, type: s.type, area: s.area, triangles: s.faces.length,
      rms: s.fit.rms, maxDev: s.fit.maxDev, fit: s.fit,
    })),
    arcs: graph.arcs,
    // NAMED `volumeShare`, not `confidence` (round 2 review, IMPORTANT): the value
    // is accept.js's own volume-normalised marginal xor-volume gain — how much of
    // the PART'S VOLUME this feature accounts for, not how sure the description is.
    // A "confidence" label reads backwards for exactly the features a rebuilder
    // most needs to trust: a precise 3mm hole in a large plate is CERTAIN (its fit
    // rms is tiny) but SMALL, so it legitimately reports a low share — see
    // `score.note` for the same point stated for a reader who never gets this far.
    features: features.map((f) => ({
      ...f, volumeShare: graded.accepted.find((a) => a.candidate.featureKey === f.key)?.gain ?? null,
    })),
    patterns, symmetry,
    residual: {
      areaFraction: totalArea > 0 ? residualArea / totalArea : 0,
      regions: residualRegions(topo, unassigned),
    },
    score: {
      // TWO DIFFERENT MEASUREMENTS, and conflating them breaks the report's honesty
      // property (controller ruling R45). `explainedArea` is how much of the mesh SURFACE
      // segmentation fitted to some analytic primitive. `explainedVolumeFraction` is how
      // much of the part's SHAPE the accepted features actually reconstruct. They diverge
      // hard: a hemisphere dome segments to 1.0 area coverage and reconstructs 0.0 of its
      // volume, because a sphere is not a candidate-eligible type. Both must be carried —
      // the low-coverage banner gates on the WORSE of the two, since an agent rebuilding a
      // part cares whether the shape is accounted for, not whether primitives were fitted.
      explainedArea,
      explainedVolumeFraction: graded.score.explainedVolumeFraction,
      xorFraction: graded.score.xorFraction,
      xorVolume: graded.score.xorVolume,
    },
    suggestion: buildHints(graded.accepted, patterns, b),
  });
  if (graded.budgetExceeded) report.warning = "budget-exceeded";

  if (memo && key) memo.set(key, report);
  return report;
}

// Unassigned faces grouped into connected islands, each reported with its own extent.
// A count alone tells the agent nothing actionable; "290 triangles, here" does.
function residualRegions(topo, unassigned) {
  const pool = new Set(unassigned), out = [];
  for (const seed of unassigned) {
    if (!pool.has(seed)) continue;
    const stack = [seed], faces = [];
    pool.delete(seed);
    while (stack.length) {
      const t = stack.pop();
      faces.push(t);
      for (const ei of topo.faceEdges[t]) {
        const e = topo.edges[ei];
        const nb = e.triA === t ? e.triB : e.triA;
        if (nb >= 0 && pool.has(nb)) { pool.delete(nb); stack.push(nb); }
      }
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const c = [0, 0, 0];
    for (const t of faces) for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      for (let a = 0; a < 3; a++) {
        const val = topo.verts[v + a];
        if (val < lo[a]) lo[a] = val;
        if (val > hi[a]) hi[a] = val;
        c[a] += val / (faces.length * 3);
      }
    }
    out.push({ triangles: faces.length, centroid: c, bounds: { min: lo, max: hi } });
  }
  return out.sort((a, b) => b.triangles - a.triangles);
}

// One acceptance candidate per feature. `build` is a thunk so nothing is materialised
// for a candidate the greedy loop never reaches. `ctx.surfById` (a graph.surfaces
// lookup) and `ctx.topo` (the welded mesh topology, for reading a SPECIFIC feature's
// own surfaces' vertices via `surfaceVertices` — never the whole mesh's) are what let
// a candidate read the part's OWN frame and THAT FEATURE'S OWN extent, rather than
// assuming a frame or reading the whole-mesh bbox for every feature alike; see the
// extrusion/boss branch's own comment for both failure modes this avoids.
//
// kernel.box/kernel.cylinder take OPTIONS OBJECTS ({size:[...]}/{min,max} and {r,h}) —
// the positional legacy forms are silently accepted by the kernel front-end but resolve
// to a DIFFERENT signature (box(min,max); cylinder(rBottom,rTop,h)) and hand back a
// zero-volume solid rather than erroring. Verified directly against a live kernel:
// `kernel.box(60,40,12).volume()` and `kernel.cylinder(2.65,40).volume()` both read 0.
function toCandidate(kernel, f, b, ctx) {
  const size = [0,1,2].map((i) => b.max[i] - b.min[i]);
  if (f.type === "throughHole" || f.type === "blindHole") {
    const depth = f.type === "throughHole" ? Math.max(...size) * 2 : f.depth;
    // Oriented along the hole's OWN axis, not world Z — a bore can point anywhere once
    // the part is rotated (alignZTo's own comment has the full reasoning).
    const rot = alignZTo(f.axis.direction);
    return {
      key: f.key, featureKey: f.key, op: "cut", explains: [f.id],
      dimension: f.diameter, paramName: "holeDia", hintOp: "cut",
      hintArgs: { shape: "cylinder", diameter: f.diameter, depth },
      build: () => {
        const cyl = kernel.cylinder({ r: f.diameter / 2, h: depth });
        const oriented = rot ? cyl.rotate(rot.deg, [0, 0, 0], rot.axis) : cyl;
        return oriented.translate([
          f.axis.origin[0] - f.axis.direction[0] * depth / 2,
          f.axis.origin[1] - f.axis.direction[1] * depth / 2,
          f.axis.origin[2] - f.axis.direction[2] * depth / 2,
        ]);
      },
    };
  }
  if (f.type === "extrusion" || f.type === "boss") {
    // Oriented onto the part's OWN extrusion frame, not the WORLD-axis-aligned bbox —
    // measured directly against a box+bore fixture rotated 29° about an oblique axis:
    // a bbox-aligned candidate built from the rotated mesh's own (now-larger, tilted)
    // AABB scored a NEGATIVE xor-volume gain (candidate 52796mm³ vs a 28535mm³ source,
    // intersecting only 6632mm³) and was correctly rejected — leaving the base
    // extrusion, and therefore the bore that can only be cut FROM it (acceptCandidates'
    // loop never attempts a `cut` against a null base), unexplained: 0% of the part's
    // volume, not merely a worse fit. Reading the true frame off one of this feature's
    // own wall surfaces (below) reproduces a ~28800mm³ candidate containing ~99.999%
    // of the 28535mm³ source and restores the same ~100% reconstruction the
    // axis-aligned case already gets.
    const direction = unit3(f.direction);
    if (f.profile.kind === "circle") {
      // Rotationally symmetric about its own axis, so — unlike the box branch below —
      // no roll correction is needed, only the axis itself: the same alignZTo a hole
      // uses. Reads the true axis (and its exact base point) off this boss's own
      // cylindrical wall surface when the graph has one; falls back to the bbox-centre
      // approximation only when it doesn't (e.g. a bare disc with no side wall fitted).
      const wallCyl = ctx?.surfById && f.wallFaces
        ? f.wallFaces.map((id) => ctx.surfById.get(id)).find((s) => s?.type === "cylinder")
        : null;
      const axisDir = wallCyl ? unit3(wallCyl.fit.axis.direction) : direction;
      // fit.js's `extent` is always [min, max] along the axis (fitCylinder sorts it),
      // so index 0 is the wall's own lower/base end regardless of which way the
      // fitted axis direction happens to point.
      const base = wallCyl
        ? add3(wallCyl.fit.axis.origin, scale3(axisDir, wallCyl.fit.extent[0]))
        : [b.min[0] + size[0]/2, b.min[1] + size[1]/2, b.min[2]];
      const rot = alignZTo(axisDir);
      return {
        key: f.key, featureKey: f.key, op: "union", explains: [f.id],
        dimension: f.depth, paramName: "height", hintOp: f.type === "boss" ? "union" : "box",
        hintArgs: { shape: "circle", depth: f.depth },
        build: () => {
          const cyl = kernel.cylinder({ r: f.profile.radius, h: f.depth });
          const oriented = rot ? cyl.rotate(rot.deg, [0, 0, 0], rot.axis) : cyl;
          return oriented.translate(base);
        },
      };
    }
    // Polygon/mixed profile: `profileOf` (prismatic.js) reports only a POINT COUNT for
    // a polygon, never its vertices, so the footprint's own IN-PLANE rotation (its
    // "roll" about `direction`) cannot be read from the profile fact. It CAN be read
    // off one of this feature's own wall PLANES: `isSideWallOf` (prismatic.js)
    // guarantees every wall normal is already perpendicular to `direction`, which is
    // exactly one of this box's own true edge directions. Depth and footprint size
    // then come from THIS FEATURE'S OWN vertices (its `floorFace` cap plus its
    // `wallFaces`, via `surfaceVertices` — NOT the whole mesh; round 2 review's
    // CRITICAL finding, see that function's own comment for the two-box repro)
    // projected onto that exact (u, v, direction) frame — `projectedBounds`, this
    // file's general-frame twin of mesh.js's `bounds()` — rather than the world-axis
    // bbox `size`/`f.depth` used above for the (rotation-insensitive) circle case.
    const wallPlane = ctx?.surfById && f.wallFaces
      ? f.wallFaces.map((id) => ctx.surfById.get(id)).find((s) => s?.type === "plane")
      : null;
    if (!wallPlane || !ctx?.topo) {
      // No wall plane to read a true in-plane axis from (or no topology handed in)
      // — fall back to the axis-aligned bbox approximation, honest about being one:
      // still worth proposing, since a low-gain candidate is simply never accepted
      // (acceptCandidates' own MIN_GAIN_FRACTION gate), never a false positive.
      return {
        key: f.key, featureKey: f.key, op: "union", explains: [f.id],
        dimension: f.depth, paramName: "height", hintOp: f.type === "boss" ? "union" : "box",
        hintArgs: { shape: f.profile.kind, depth: f.depth },
        build: () => kernel.box({ min: b.min, max: [b.min[0] + size[0], b.min[1] + size[1], b.min[2] + f.depth] }),
      };
    }
    const u = orthogonalize(wallPlane.fit.normal, direction);
    const v = cross3(direction, u);
    const ownSurfaces = [f.floorFace, ...(f.wallFaces ?? [])].filter(Boolean);
    return {
      key: f.key, featureKey: f.key, op: "union", explains: [f.id],
      dimension: f.depth, paramName: "height", hintOp: f.type === "boss" ? "union" : "box",
      hintArgs: { shape: f.profile.kind, depth: f.depth },
      build: () => {
        const verts = surfaceVertices(ctx.topo, ctx.surfById, ownSurfaces);
        const bnd = projectedBounds(verts, [u, v, direction]);
        const [uSize, vSize, depth] = [0, 1, 2].map((i) => bnd.max[i] - bnd.min[i]);
        const local = kernel.box({ min: [0, 0, 0], max: [uSize, vSize, depth] });
        const oriented = orientOnto(local, direction, u);
        const origin = add3(add3(scale3(u, bnd.min[0]), scale3(v, bnd.min[1])), scale3(direction, bnd.min[2]));
        return oriented.translate(origin);
      },
    };
  }
  // Fillets, chamfers, pockets, revolves and shells are described but not yet proposed
  // as acceptance candidates: each needs an edge or profile selector the facts layer
  // does not yet carry, and a candidate that cannot be built is worse than none. They
  // still appear in `features` with a null volumeShare, which is the honest report.
  return null;
}
