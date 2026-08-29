// SVG -> the partforge-vector JSON format. The browser half of k.svg2d, run ONCE
// per artwork by the host — never at build time, never in the geometry worker.
//
// This is the ONLY DOM-dependent file in the feature, and that is the whole
// point: with a real DOM, paper.js's importSVG does the work six hand-rolled
// modules would otherwise do. It bakes ancestor transforms into coordinates,
// resolves per-item style, and handles <use>, <defs> and CSS — none of which a
// DOM-free parser could reach.
//
// Never import this from the worker graph. test/worker-layering.test.js proves
// you have not: it walks the worker's import closure and fails on any module
// that so much as names `document`.
import paper from "paper/dist/paper-core.js";
import { toContour, toOpenContour, booleanRegions } from "../geometry/paper-bridge.js";
import { resolveCurveFill } from "../geometry/curve-fill.js";
import { outlineStroke } from "../geometry/stroke-outline.js";
import { recoverArcs } from "../geometry/arc-fit.js";
import { fromInternalRegions } from "../geometry/vector-format.js";

// Matches vector-format.js's own round6 exactly (6 decimal places). Rounding
// HERE, before fromInternalRegions, makes the emitted document self-consistent
// under its own round-trip: fromInternalRegions computes doc.bbox from these
// same rounded numbers, so re-loading the document and recomputing the bbox
// from the (already-rounded) stored coordinates reproduces the identical
// floats — no residual sub-micron drift left for validateVectorDocument's
// BBOX_TOL to trip over. Without this, an unrounded arc `via` that happens to
// land a hair off an exact circle can shift `recoverArcs`'s fitted sweep by a
// few ULPs; round-tripped through JSON that nudge can cross an integer
// boundary in sampleArc's `Math.ceil(segs * sweep / 2π)` step count, which
// changes which angle the tessellation grid actually samples and moves a
// bbox extremum by ~1e-3 — well past the 1e-3 tolerance validateVectorDocument
// checks against. Rounding first removes the discrepancy at its source.
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const roundPt = (p) => [round6(p[0]), round6(p[1])];
const roundContour = (c) => ({
  start: roundPt(c.start),
  segments: c.segments.map((s) => {
    const m = { to: roundPt(s.to) };
    if (s.via) m.via = roundPt(s.via);
    if (s.c1) { m.c1 = roundPt(s.c1); m.c2 = roundPt(s.c2); }
    return m;
  }),
});
const roundRegion = (r) => ({ outer: roundContour(r.outer), holes: r.holes.map(roundContour) });

// A private scope, never paper's package-global project — another consumer in
// the same page may import paper too. Same rule paper-bridge.js follows.
let _scope = null;
function scope() {
  if (!_scope) { _scope = new paper.PaperScope(); _scope.setup(new _scope.Size(1, 1)); }
  return _scope;
}

// SVG is y-down; the model frame is y-up. Applied after paper has baked
// transforms and before arc recovery, so everything downstream is in one frame.
const flipContour = (c) => ({
  start: [c.start[0], -c.start[1]],
  segments: c.segments.map((s) => {
    const m = { to: [s.to[0], -s.to[1]] };
    if (s.via) m.via = [s.via[0], -s.via[1]];
    if (s.c1) { m.c1 = [s.c1[0], -s.c1[1]]; m.c2 = [s.c2[0], -s.c2[1]]; }
    return m;
  }),
});

const flipRegion = (r) => ({ outer: flipContour(r.outer), holes: r.holes.map(flipContour) });

// A paper Path/CompoundPath -> this engine's contours, one per subpath.
function itemContours(item) {
  const paths = item.className === "CompoundPath" ? item.children : [item];
  return paths
    .filter((p) => p.segments && p.segments.length >= 2)
    .map((p) => ({ contour: p.closed ? toContour(p) : toOpenContour(p), closed: !!p.closed }));
}

const LINECAP = { butt: "butt", round: "round", square: "square" };
const LINEJOIN = { miter: "miter", round: "round", bevel: "bevel" };

export function ingestSvg(svgText, { strokes = "outline", source = null } = {}) {
  if (typeof svgText !== "string" || !svgText.trim()) {
    throw new Error("svg: ingestSvg needs the SVG document as a non-empty string");
  }
  const sc = scope();
  let root;
  try {
    root = sc.project.importSVG(svgText, { expandShapes: true, insert: false });
  } catch (e) {
    throw new Error(`svg: could not parse the SVG document — ${e?.message ?? e}`);
  }
  if (!root) throw new Error("svg: could not parse the SVG document");

  const resolved = [];
  const visit = (item) => {
    // A CompoundPath has .children too (its subpaths), but it is ONE paintable
    // item — recursing into its children would split it into independent
    // single-subpath items and lose the fill-rule relationship between them
    // (e.g. the counter of an "O" would stop being a hole). Only Groups and
    // Layers get walked; CompoundPath and Path are both handled as leaves.
    if (item.className !== "CompoundPath" && item.children && item.children.length) {
      item.children.forEach(visit);
      return;
    }
    if (!item.segments && item.className !== "CompoundPath") return;   // the root clip Shape lands here

    const subpaths = itemContours(item);
    if (subpaths.length === 0) return;

    // Colour is read only as present-or-absent: this produces geometry, not paint.
    if (item.fillColor) {
      // Per ITEM, not per subpath: a fill rule applies across an item's own
      // subpaths, which is what makes the counter of an "O" a hole.
      resolved.push(...resolveCurveFill(subpaths.map((s) => s.contour),
        { fillRule: item.fillRule === "evenodd" ? "evenodd" : "nonzero" }));
    }
    if (strokes !== "ignore" && item.strokeColor && item.strokeWidth > 0) {
      const style = {
        strokeWidth: item.strokeWidth,
        linecap: LINECAP[item.strokeCap] ?? "butt",
        linejoin: LINEJOIN[item.strokeJoin] ?? "miter",
      };
      // Per SUBPATH: each is stroked on its own, with its own open/closed sense.
      for (const { contour, closed } of subpaths) resolved.push(...outlineStroke(contour, closed, style));
    }
  };
  visit(root);

  if (resolved.length === 0) {
    throw new Error('svg: no painted geometry — every element is fill="none" with no stroke, hidden, or empty');
  }

  // One union across every item. `resolved` entries are already RESOLVED
  // regions (each item's own fill/stroke geometry, holes included) — folding
  // them together needs an actual planar boolean union, not another
  // resolveCurveFill("nonzero") pass over the flattened contour list: paper's
  // `compound.unite(compound)` self-unite trick (which resolveCurveFill uses
  // internally to normalize crossings under a fill rule) special-cases the
  // "unite with itself" call and does not correctly union two *disjoint*
  // same-winding shapes — two overlapping same-fill rects came back with the
  // overlap cancelled (evenodd-shaped) instead of merged, undercounting the
  // union's area. booleanRegions performs a real A.unite(B) between distinct
  // paper compound paths per pair, which does not hit that case, and it
  // already carries the storage winding invariant on its output.
  let union = [];
  for (const r of resolved) union = booleanRegions(union, [r], "unite");
  if (union.length === 0) throw new Error("svg: geometry cancelled to nothing under the fill rule");

  const flipped = union.map(flipRegion);
  const withArcs = flipped.map((r) => ({ outer: recoverArcs(r.outer), holes: r.holes.map(recoverArcs) }));
  const rounded = withArcs.map(roundRegion);
  return fromInternalRegions(rounded, { source });
}
