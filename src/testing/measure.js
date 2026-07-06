import { buildView } from "./build.js";
import { assemblyOverlaps } from "../framework/assembly.js";
import { meshGaps, CONTACT_EPS } from "./gaps.js";
import { bounds, meshArea } from "./mesh.js";
import { minWall } from "./min-wall.js";

const size = ({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
const unionBounds = (list) => list.reduce(
  (acc, b) => ({ min: acc.min.map((v, i) => Math.min(v, b.min[i])), max: acc.max.map((v, i) => Math.max(v, b.max[i])) }),
  { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
);

// Headless geometric report for one view of a part (Manifold-only). Reads exact
// solid facts (volume/genus/emptiness) and mesh facts (bbox/area/triangles), plus
// the assembly overlap check plus pair gap distances (near misses are reported,
// never folded into `ok`). All solid facts are read BEFORE assemblyOverlaps,
// which frees the shared kernel's objects at its end.
//   → { part, view, subparts[], aggregate, overlaps[], gaps[], nearMisses[], ok }
export function measure(kernel, part, view = Object.keys(part.views)[0], params = {}, opts = {}) {
  const built = buildView(kernel, part, view, params);
  const subBounds = [];
  const subparts = built.map(({ name, solid, mesh }) => {
    const b = bounds(mesh.positions);
    subBounds.push(b);
    const mw = opts.minWall ? minWall(mesh) : null;
    return {
      name,
      bbox: size(b),
      volume: solid.volume(),
      surfaceArea: meshArea(mesh.positions, mesh.indices),
      triangleCount: mesh.triangles,
      watertight: typeof solid.isEmpty === "function" ? !solid.isEmpty() : null,
      holes: typeof solid.genus === "function" ? solid.genus() : null,
      minWall: mw?.value ?? null,
      minWallAt: mw?.location ?? null,
    };
  });

  // Pair surface distances from the meshes already built — no kernel dependency,
  // so this reads on OCCT too. nearMisses = the issue-#29 signal: pairs that
  // *almost* touch; overlapping pairs are excluded by name (a fully-contained
  // sub-part has surface distance > 0 but is the overlap gate's business).
  const gaps = built.length > 1 ? meshGaps(built) : [];

  // Rebuilds with the same kernel and cleans up at its end — every solid fact
  // above is already read, so this is safe.
  const canIntersect = built.length > 0 && typeof built[0].solid.intersect === "function";
  const overlaps = canIntersect ? assemblyOverlaps(kernel, part, view, params) : [];
  kernel.cleanup?.();

  const pairKey = (a, b) => [a, b].sort().join("×");
  const overlapping = new Set(overlaps.map((o) => pairKey(o.a, o.b)));
  const gapThreshold = opts.gapThreshold ?? 0.5;
  const nearMisses = gaps.filter(
    (g) => g.distance > CONTACT_EPS && g.distance < gapThreshold && !overlapping.has(pairKey(g.a, g.b)),
  );

  const aggregate = {
    bbox: subparts.length ? size(unionBounds(subBounds)) : [0, 0, 0],
    volume: subparts.reduce((a, s) => a + s.volume, 0),
    surfaceArea: subparts.reduce((a, s) => a + s.surfaceArea, 0),
    triangleCount: subparts.reduce((a, s) => a + s.triangleCount, 0),
  };
  return {
    part: part.meta?.title ?? view,
    view,
    subparts,
    aggregate,
    overlaps,
    gaps,
    nearMisses,
    ok: subparts.every((s) => s.watertight !== false) && overlaps.length === 0,
  };
}
