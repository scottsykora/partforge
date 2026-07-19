// Resolve raw glyph outlines (self-intersecting / overlapping cubic contours) into
// simple, correctly-nested {outer,holes} curve regions under the requested font fill
// rule. Beziers are split where needed but never flattened.
//
// The required recipe is:
//   1. resolveCrossings() each contour individually;
//   2. CompoundPath of all the simple sub-paths;
//   3. set the font's nonzero/evenodd rule;
//   4. unite(self) to normalize overlaps and crossings into simple paths.
import paper from "paper/dist/paper-core.js";

// Never use paper's package-global project: another consumer in the same worker may import
// paper too. This resolver owns and clears only this private, headless scope.
const scope = new paper.PaperScope();
scope.setup(new scope.Size(1, 1));

function toPaperPath(contour) {
  const path = new scope.Path({ insert: false });
  path.moveTo(new scope.Point(contour.start[0], contour.start[1]));
  for (const s of contour.segments) {
    if (s.c1) path.cubicCurveTo(
      new scope.Point(s.c1[0], s.c1[1]),
      new scope.Point(s.c2[0], s.c2[1]),
      new scope.Point(s.to[0], s.to[1]));
    else path.lineTo(new scope.Point(s.to[0], s.to[1]));
  }
  path.closePath();
  return path;
}

function toContour(path) {
  const segs = path.segments;
  const start = [segs[0].point.x, segs[0].point.y];
  const out = { start, segments: [] };
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i], b = segs[(i + 1) % segs.length];
    const straight = a.handleOut.isZero() && b.handleIn.isZero();
    const closing = i === segs.length - 1;
    if (closing && straight) continue;                 // implicit straight close
    const to = [b.point.x, b.point.y];
    if (straight) out.segments.push({ to });
    else out.segments.push({ to, c1: [a.point.x + a.handleOut.x, a.point.y + a.handleOut.y], c2: [b.point.x + b.handleIn.x, b.point.y + b.handleIn.y] });
  }
  return out;
}

// Group while paths are still Paper geometry. Path.area includes cubic handles and
// interiorPoint is guaranteed to lie inside the curve; never reduce curves to endpoint rings.
function groupPaperPaths(paths) {
  const largest = paths.reduce((a, b) => Math.abs(b.area) > Math.abs(a.area) ? b : a);
  const outerClockwise = largest.clockwise;
  const outers = paths.filter((p) => p.clockwise === outerClockwise)
    .map((path) => ({ path, holes: [] }));
  for (const hole of paths.filter((p) => p.clockwise !== outerClockwise)) {
    const home = outers.filter((o) => o.path.contains(hole.interiorPoint))
      .sort((a, b) => Math.abs(a.path.area) - Math.abs(b.path.area))[0];
    if (!home) throw new Error("curve-fill: resolved hole has no containing outer");
    home.holes.push(hole);
  }
  return outers.map(({ path, holes }) => ({
    outer: toContour(path),
    holes: holes.map(toContour),
  }));
}

export function resolveCurveFill(contours, { fillRule = "nonzero" } = {}) {
  if (fillRule !== "nonzero" && fillRule !== "evenodd")
    throw new Error('curve-fill: fillRule must be "nonzero" or "evenodd"');
  if (!contours || contours.length === 0) return [];
  try {
    const simple = [];
    for (const ct of contours) {
      const resolved = toPaperPath(ct).resolveCrossings();
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
