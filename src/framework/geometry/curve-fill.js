// Resolve raw glyph outlines (self-intersecting / overlapping cubic contours) into
// simple, correctly-nested {outer,holes} curve regions under the requested font fill
// rule. Beziers are split where needed but never flattened.
//
// TWO ROUTES, because paper.js cannot evaluate either fill rule directly on a
// self-overlapping CompoundPath.
//
// The original recipe was: build a CompoundPath of every subpath, set its
// fillRule, and unite it with itself. paper documents that trick and it resolves
// NESTING correctly — a counter drawn against its outline becomes a hole, which
// is what every glyph relies on. But it does not merge two subpaths that wind
// the SAME way and overlap: it returns the even-odd answer regardless of the
// fillRule set. Measured on two 10x10 squares overlapping in a 5x10 band, as two
// subpaths of one <path>: area 100 (the band cancelled) where nonzero is 150.
// Measured identical for both orientations, and for every compound-level variant
// tried — unite against a clone, unite against an empty path, intersect with a
// covering rectangle, resolveCrossings on the compound, reorient after it.
//
// So:
//
//   evenodd — XOR every subpath together. That IS the even-odd rule: a point is
//     inside when an odd number of subpaths contain it, whatever their
//     direction. Exact, and it replaces a path that used to THROW (see below).
//
//   nonzero, all subpaths wound alike — their union, folded pairwise. With no
//     subpath wound against the others, no winding can cancel, so every point
//     any of them covers has |winding| >= 1. Union is therefore exactly nonzero,
//     and this is the case the compound recipe got wrong.
//
//   nonzero, mixed winding — the original compound recipe. Counters exist, so
//     nesting has to be resolved rather than unioned away, and this is exact for
//     the whole bundled charset (verified against Manifold's NonZero fill,
//     glyph by glyph, in test/curve-fill.test.js).
//
// The mixed-winding route keeps one known divergence from true winding-number
// nonzero, unchanged from before this split and documented under
// docs/ERROR-PATTERNS.md#svg-overlapping-subpaths: where a subpath wound against
// the others covers area that two or more same-wound subpaths already cover,
// true nonzero keeps it (2 - 1 = 1) and this drops it. Fixing that needs a real
// planar arrangement, not a fold of pairwise booleans.
//
// Both routes reorient before grouping: paper's booleans can hand back disjoint
// pieces with OPPOSITE orientations (measured: an XOR returning +50 and -50 for
// two disjoint rectangles), and groupPaperPaths reads orientation to tell an
// outer from a hole — so ungrouped it called the second piece a hole with
// nothing to contain it and threw "resolved hole has no containing outer". That
// was a crash on ordinary even-odd artwork, not merely a wrong area.
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

    const fold = (xs, op) => (xs.length ? xs.reduce((a, b) => a[op](b, { insert: false })) : null);
    let united;
    if (fillRule === "evenodd") {
      united = fold(simple, "exclude");
    } else if (simple.every((p) => p.clockwise === simple[0].clockwise)) {
      united = fold(simple, "unite");
    } else {
      const compound = new scope.CompoundPath({ children: simple, fillRule });
      united = compound.unite(compound, { insert: false });
    }
    if (!united) return [];
    united = united.reorient(fillRule === "nonzero", true);

    const paths = (united.className === "CompoundPath" ? united.children : [united])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    return paths.length ? groupPaperPaths(paths) : [];
  } finally {
    scope.project.clear();
  }
}
