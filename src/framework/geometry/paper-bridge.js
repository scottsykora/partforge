// Lazy, private PaperScope: built on first use (not at module load), so parts that never
// call k.text2d don't pull paper-core's setup onto the geometry worker. Never paper's
// package-global project — another consumer in the same worker may import paper too.
import paper from "paper/dist/paper-core.js";

let _scope = null;
function paperScope() {
  if (!_scope) { _scope = new paper.PaperScope(); _scope.setup(new _scope.Size(1, 1)); }
  return _scope;
}

export function toPaperPath(scope, contour, segMap = null) {
  const path = new scope.Path({ insert: false });
  path.moveTo(new scope.Point(contour.start[0], contour.start[1]));
  contour.segments.forEach((s, i) => {
    if (s.c1) path.cubicCurveTo(
      new scope.Point(s.c1[0], s.c1[1]),
      new scope.Point(s.c2[0], s.c2[1]),
      new scope.Point(s.to[0], s.to[1]));
    else path.lineTo(new scope.Point(s.to[0], s.to[1]));
    if (segMap) segMap.push(i);
  });
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

export { paperScope, toContour, groupPaperPaths };
