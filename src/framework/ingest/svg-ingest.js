// SVG -> the partforge-vector JSON format. The browser half of k.vector2d, run ONCE
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
import { fromInternalRegions, validateVectorDocument } from "../geometry/vector-format.js";
import { reverseContour } from "../geometry/profile.js";

// A private scope, never paper's package-global project — another consumer in
// the same page may import paper too. Same rule paper-bridge.js follows.
let _scope = null;
function scope() {
  if (!_scope) { _scope = new paper.PaperScope(); _scope.setup(new _scope.Size(1, 1)); }
  return _scope;
}

// SVG is y-down; the model frame is y-up. Applied after paper has baked
// transforms and before arc recovery, so everything downstream is in one frame.
const flipContourRaw = (c) => ({
  start: [c.start[0], -c.start[1]],
  segments: c.segments.map((s) => {
    const m = { to: [s.to[0], -s.to[1]] };
    if (s.via) m.via = [s.via[0], -s.via[1]];
    if (s.c1) { m.c1 = [s.c1[0], -s.c1[1]]; m.c2 = [s.c2[0], -s.c2[1]]; }
    return m;
  }),
});

// Negating y REVERSES orientation, so every contour must also be reversed to
// restore the storage winding invariant (outer CCW, holes CW in the y-up frame)
// that contour-offset.js and contour-winding.js depend on. Without the reverse
// this silently emits outers as CW and holes as CCW, and a later offset would
// grow holes and shrink outers with no crash and no error.
const flipContour = (c) => reverseContour(flipContourRaw(c));

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

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

// paper's <use> importer (paper-core.js's `use:` entry) resolves its target
// through `SvgElement.get(node, "href")`, which is hard-wired to read that
// attribute from the XLINK namespace ONLY (`attributeNamespace.href = xlink`
// in paper-core.js). A bare SVG2 `href="#id"` — what every modern authoring
// tool emits — lives in no namespace at all, so `getAttributeNS(xlink, href)`
// returns null and the `<use>` silently resolves to nothing. This is true in
// any DOM, real browser included; it is not a test-environment gap. Patch it
// ourselves before handing the tree to paper: mirror a bare `href` onto
// `xlink:href` on every `<use>` that doesn't already have one. Do this by
// parsing the markup into a real DOM tree (paper's importSVG accepts a node
// as readily as a string) rather than string-munging the SVG text, so this
// survives whatever quoting/whitespace the source happens to use.
function normalizeUseHref(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const uses = doc.getElementsByTagNameNS(SVG_NS, "use");
  for (let i = 0; i < uses.length; i++) {
    const use = uses[i];
    if (use.hasAttribute("href") && !use.hasAttributeNS(XLINK_NS, "href")) {
      use.setAttributeNS(XLINK_NS, "xlink:href", use.getAttribute("href"));
    }
  }
  return doc;
}

export function ingestSvg(svgText, { strokes = "outline", source = null } = {}) {
  if (typeof svgText !== "string" || !svgText.trim()) {
    throw new Error("svg: ingestSvg needs the SVG document as a non-empty string");
  }
  const sc = scope();
  let root;
  try {
    root = sc.project.importSVG(normalizeUseHref(svgText), { expandShapes: true, insert: false });
  } catch (e) {
    throw new Error(`svg: could not parse the SVG document — ${e?.message ?? e}`);
  }
  if (!root) throw new Error("svg: could not parse the SVG document");

  const resolved = [];
  const visit = (item) => {
    // A <use> that resolves to a <symbol> (rather than a plain element)
    // imports as a paper SymbolItem, not a Group/Path — paper keeps the
    // symbol's geometry in one shared SymbolDefinition and never clones it
    // per <use>, so it has no .children and no .segments of its own and
    // would otherwise fall straight through to the `return` below, silently
    // contributing nothing. Unwrap it: clone the definition's item and bake
    // this particular <use>'s placement matrix into the clone, then recurse
    // into the (now ordinary) Group/Path. Note that fill/stroke set directly
    // on the <use> element does NOT carry over — paper resolves each
    // element's paint from the real DOM's computed style at that element's
    // own position in the document, and a <symbol>'s content is parsed once
    // as a *sibling* of <use>, never as its descendant, so paint must live on
    // the symbol's own shapes (or an ancestor they actually share).
    if (item.className === "SymbolItem") {
      const inner = item.definition.item.clone();
      // A SymbolDefinition's item is kept with applyMatrix=false — its shared
      // geometry stays in LOCAL coordinates and each SymbolItem carries only
      // its own placement matrix, so multiple <use>s of one <symbol> reuse
      // one set of segment points. item.transform(item.matrix) would only
      // update the clone's own decomposed matrix, not its segments — every
      // placement would then read back the same untransformed local points.
      // append + apply(true, true) bakes the placement into real segment
      // coordinates (recursively, and flips applyMatrix to true on the way),
      // which is what itemContours/toContour below actually read.
      inner.matrix.append(item.matrix);
      inner.matrix.apply(true, true);
      visit(inner);
      return;
    }
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
  // fromInternalRegions rounds every coordinate to 6dp itself when it serializes
  // the document, and computes doc.bbox (regionsBbox, vector-format.js) from
  // these UNROUNDED regions first — an EXACT bbox (paper.js's analytic curve
  // bounds), not the fixed-step tessellation this file used to have to
  // pre-round coordinates to work around: that old sampling grid could shift
  // an extremum by ~1e-3 on an unrounded-vs-rounded ULP nudge, which is gone
  // now that the bbox check isn't sampling a grid at all.
  const doc = fromInternalRegions(withArcs, { source, units: "artwork", shape: "artwork" });
  // Ingest must never emit a document its own loader refuses. It used to: a
  // filled half-disc reduced to a ONE-segment contour (the implicit chord is
  // dropped, and arc recovery merged two quarter-cubics into a single ≤180°
  // arc) and validateVectorDocument then required two. The file wrote fine and
  // died at the first build that touched it, telling the author to hand-edit a
  // generated file the docs say never to hand-edit.
  //
  // The rule was the wrong one and is fixed, but the CLASS of bug is closed
  // here: this is the reference implementation VECTOR-FORMAT.md invites third
  // parties to diff against, so the loader's own gate runs on the way out. A
  // throw here is a partforge bug, not an author's — say so.
  try {
    validateVectorDocument(doc, source ?? "(ingested)");
  } catch (e) {
    throw new Error(`svg: ingest produced a document this build cannot load — that is a partforge bug, please report it with the SVG.\n  ${e.message}`);
  }
  return doc;
}
