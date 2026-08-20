import { buildView } from "./build.js";
import { cachedBVH } from "./bvh.js";
import { assemblyOverlaps } from "../assembly.js";
import { meshGaps, pairKey, CONTACT_EPS, GAP_THRESHOLD } from "./gaps.js";
import { bounds, meshArea, meshCentroid } from "./mesh.js";
import { minWall, DIAGNOSTIC_SAMPLES } from "./min-wall.js";
import { partGatesMinWall } from "./gates.js";

const size = ({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
const unionBounds = (list) => list.reduce(
  (acc, b) => ({ min: acc.min.map((v, i) => Math.min(v, b.min[i])), max: acc.max.map((v, i) => Math.max(v, b.max[i])) }),
  { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
);

// Headless geometric report for one view of a part (Manifold-only). Reads exact
// solid facts (volume/genus/emptiness) and mesh facts (bbox/area/triangles), plus
// the assembly overlap check plus pair gap distances (near misses are reported,
// never folded into `ok`). All solid facts are read BEFORE assemblyOverlaps,
// which frees the shared kernel's objects at its end. A sub-part that declares
// `reference: "<import name>"` also gets a `deviation` fact — the posed solid's
// symmetric-difference volume, volume delta %, and bbox-corner drift against
// that import — for the `ref*` gate metrics (verify-metrics.js); every other
// sub-part gets `deviation: null`.
//   → { part, view, measuredMinWall, subparts[], aggregate, overlaps[], gaps[],
//       nearMisses[], ok }
export function measure(kernel, part, view = Object.keys(part.views)[0], params = {}, opts = {}) {
  // `opts.built` is a build of this view the caller already has. The inspect job
  // needs those meshes anyway — it rasterizes them for silhouette match scoring —
  // and a second buildView here would be a whole duplicate build of the part for
  // nothing. Absent, this measures its own build exactly as it always did.
  const built = opts.built ?? buildView(kernel, part, view, params);
  // ONE BVH per sub-part mesh for this call, shared by the two passes that need
  // one: min-wall (inward rays per triangle) and meshGaps (pair distances). They
  // used to index the same mesh objects independently, so every sub-part of a
  // multi-part view was built into a BVH twice — at ~77 bytes/triangle that is a
  // whole second index's worth of build time and peak memory for nothing.
  //
  // This Map is the caller-owned cache cachedBVH documents — see there for why it
  // is a Map of ours and not a module-level WeakMap. It dies with the call. Peak
  // memory is unchanged (meshGaps already held every sub-part's index at once);
  // the cache just fills it earlier. min-wall indexes exactly one mesh, so it is
  // handed the resolved BVH rather than the Map.
  const bvhCache = new Map();
  // Sample budget for the min-wall pass. A part that declares a min-wall gate (a
  // process profile or an `expect` mentioning it) gets the full resolution, because
  // a gate's verdict rides on the reading. Everything else gets the diagnostic
  // budget: min wall is the single most expensive thing the oracle does — one
  // inward ray per sampled triangle plus the BVH those rays need — and on an
  // ungated part it buys a fact nobody checks, at full price, on every agent edit.
  const minWallSamples = partGatesMinWall(part) ? undefined : DIAGNOSTIC_SAMPLES;
  const subBounds = [];
  const subparts = built.map(({ name, solid, mesh }) => {
    const b = bounds(mesh.positions);
    subBounds.push(b);
    // Resolved lazily and only when asked for: without min-wall, a single-sub-part
    // view (no meshGaps) must still build no index at all.
    const mw = opts.minWall ? minWall(mesh, { bvh: cachedBVH(mesh, bvhCache), maxSamples: minWallSamples }) : null;
    const vol = solid.volume();
    // Deviation-from-reference: only for a sub-part that declares `reference:
    // "<import name>"` (Task 12 — the gate that holds a parametric rebuild to
    // its imported reference), and only when this kernel can import at all (a
    // bare/third-party kernel may lack `import`). Read here, alongside every
    // other solid fact, so it is captured before assemblyOverlaps/cleanup below
    // frees the shared kernel's objects.
    const refName = part.parts[name]?.reference;
    let deviation = null;
    if (refName && typeof kernel.import === "function") {
      const ref = kernel.import(refName);
      const refVol = ref.volume();
      const rb = ref.boundingBox();
      const inter = solid.intersect(ref).volume();
      deviation = {
        ref: refName,
        xorVolume: vol + refVol - 2 * inter, // symmetric difference, one boolean
        volumeDeltaPct: refVol > 1e-9 ? (100 * Math.abs(vol - refVol)) / refVol : null,
        bboxDelta: [0, 1, 2].map((i) => Math.max(Math.abs(b.min[i] - rb.min[i]), Math.abs(b.max[i] - rb.max[i]))),
      };
    }
    return {
      name,
      bbox: size(b),
      bounds: { min: b.min, max: b.max },
      centerOfMass: meshCentroid(mesh.positions, mesh.indices),
      volume: vol,
      surfaceArea: meshArea(mesh.positions, mesh.indices),
      triangleCount: mesh.triangles,
      watertight: typeof solid.isEmpty === "function" ? !solid.isEmpty() : null,
      holes: typeof solid.genus === "function" ? solid.genus() : null,
      deviation,
      minWall: mw?.value ?? null,
      minWallAt: mw?.location ?? null,
      // Sampling accounting, so a report can tell a guaranteed minimum from an
      // upper bound: on a dense mesh min-wall casts from a spread subset rather
      // than every triangle (see min-wall.js). Exact readings say so explicitly,
      // and a sampled run that found no wall still fills these in — `minWall`
      // null with samples accounted for is "looked, found nothing"; null with
      // `measuredMinWall` false is "never looked".
      minWallSampled: mw?.sampled ?? false,
      minWallSamples: mw ? { sampled: mw.sampledTriangles, total: mw.totalTriangles } : null,
    };
  });

  // Pair surface distances from the meshes already built — no kernel dependency,
  // so this reads on OCCT too. nearMisses = the issue-#29 signal: pairs that
  // *almost* touch; overlapping pairs are excluded by name (a fully-contained
  // sub-part has surface distance > 0 but is the overlap gate's business).
  // `opts.gaps: false` is the quick lap's second half (see jobs.js): pair distances
  // are the other ray-casting pass, and they and min-wall share the BVH, so skipping
  // only one leaves the index build standing. The result is `undefined`, NEVER `[]`:
  // pairGapChecks reads an empty table as "measured, and this pair has no distance"
  // and fails a declared gate on it, while an absent table reads as no reading.
  const measuredGaps = opts.gaps !== false;
  const gaps = measuredGaps ? (built.length > 1 ? meshGaps(built, { bvhCache }) : []) : undefined;

  // Rebuilds with the same kernel and cleans up at its end — every solid fact
  // above is already read, so this is safe.
  const canIntersect = built.length > 0 && typeof built[0].solid.intersect === "function";
  const overlaps = canIntersect ? assemblyOverlaps(kernel, part, view, params) : [];
  kernel.cleanup?.();

  const overlapping = new Set(overlaps.map((o) => pairKey(o.a, o.b)));
  const gapThreshold = opts.gapThreshold ?? GAP_THRESHOLD;
  const nearMisses = (gaps ?? []).filter(
    (g) => g.distance > CONTACT_EPS && g.distance < gapThreshold && !overlapping.has(pairKey(g.a, g.b)),
  );

  const ub = subparts.length ? unionBounds(subBounds) : { min: [0, 0, 0], max: [0, 0, 0] };
  const weighted = subparts.filter((s) => s.centerOfMass !== null);
  const totalVol = weighted.reduce((a, s) => a + s.volume, 0);
  const aggCom = weighted.length && Math.abs(totalVol) > 1e-9
    ? [0, 1, 2].map((i) => weighted.reduce((a, s) => a + s.volume * s.centerOfMass[i], 0) / totalVol)
    : null;
  const aggregate = {
    bbox: size(ub),
    bounds: { min: ub.min, max: ub.max },
    centerOfMass: aggCom,
    volume: subparts.reduce((a, s) => a + s.volume, 0),
    surfaceArea: subparts.reduce((a, s) => a + s.surfaceArea, 0),
    triangleCount: subparts.reduce((a, s) => a + s.triangleCount, 0),
  };
  return {
    part: part.meta?.title ?? view,
    view,
    // Whether this measurement cast min-wall rays at all — stamped by the pass
    // that did (or didn't) do the work, so a consumer never has to be told. A
    // result with this false carries `minWall: null` on every sub-part because
    // nothing measured it, which reads identically to "no reading available";
    // verify's seeding rule turns on exactly this distinction (see verify.js).
    measuredMinWall: !!opts.minWall,
    // Companion stamp to measuredMinWall, and read the same way: whether the pass
    // ran, said by the pass itself rather than claimed by whoever holds the result.
    measuredGaps,
    subparts,
    aggregate,
    overlaps,
    gaps,
    nearMisses,
    ok: subparts.every((s) => s.watertight !== false) && overlaps.length === 0,
  };
}
