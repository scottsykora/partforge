// Resolve raw glyph outlines (self-intersecting / overlapping cubic contours) into
// simple, correctly-nested {outer,holes} curve regions under the requested font fill
// rule. Beziers are split where needed but never flattened.
//
// The required recipe is:
//   1. resolveCrossings() each contour individually;
//   2. CompoundPath of all the simple sub-paths;
//   3. set the font's nonzero/evenodd rule;
//   4. unite(self) to normalize overlaps and crossings into simple paths.
import { paperScope, toPaperPath, groupPaperPaths } from "./paper-bridge.js";

export function resolveCurveFill(contours, { fillRule = "nonzero" } = {}) {
  if (fillRule !== "nonzero" && fillRule !== "evenodd")
    throw new Error('curve-fill: fillRule must be "nonzero" or "evenodd"');
  if (!contours || contours.length === 0) return [];
  const scope = paperScope();
  try {
    const simple = [];
    for (const ct of contours) {
      const resolved = toPaperPath(scope, ct).resolveCrossings();
      const kids = resolved.className === "CompoundPath" ? resolved.children : [resolved];
      for (const k of kids) if (k.segments && k.segments.length >= 2) simple.push(k.clone({ insert: false }));
    }
    if (simple.length === 0) return [];
    const compound = new scope.CompoundPath({ children: simple, fillRule });
    const united = compound.unite(compound, { insert: false });
    const paths = (united.className === "CompoundPath" ? united.children : [united])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    return paths.length ? groupPaperPaths(paths) : [];
  } finally {
    scope.project.clear();
  }
}
