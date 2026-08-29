// SVG `transform=` attributes: parse, compose down the element tree, and apply
// to a contour.
//
// The one non-obvious rule is arc survival. A circular arc ({to,via}) stays a
// circular arc only under a SIMILARITY - rotation, uniform scale, reflection.
// Under a non-uniform scale or a skew it becomes an ellipse, which this
// engine's contour IR cannot represent, so applyMatrixToContour degrades such
// arcs to cubics FIRST (cubics being closed under affine transform). Uniform
// matrices keep arcs symbolic, which is what lets OCCT build true circular
// B-rep edges from transformed artwork.
//
// Matrices are SVG-ordered [a,b,c,d,e,f]:  x' = a*x + c*y + e
//                                          y' = b*x + d*y + f
//
// Pure leaf: DOM-free, node:-free.
import { arcToCubicSegments } from "./paper-bridge.js";

export const IDENTITY = [1, 0, 0, 1, 0, 0];

const UNIFORM_EPS = 1e-9;

// parent compose child - the parent's matrix applied AFTER the child's, which is the
// order an ancestor-to-descendant walk needs.
export function composeMatrix(p, c) {
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
}

const rad = (deg) => (deg * Math.PI) / 180;

function primitive(name, a) {
  const n = (i, dflt = 0) => (a.length > i ? a[i] : dflt);
  switch (name) {
    case "matrix":
      if (a.length !== 6) throw new Error("svg: matrix() takes exactly 6 numbers");
      return [...a];
    case "translate": return [1, 0, 0, 1, n(0), n(1)];
    case "scale":     return [n(0, 1), 0, 0, a.length > 1 ? a[1] : n(0, 1), 0, 0];
    case "rotate": {
      const c = Math.cos(rad(n(0))), s = Math.sin(rad(n(0)));
      const R = [c, s, -s, c, 0, 0];
      if (a.length < 3) return R;
      const cx = a[1], cy = a[2];
      // translate(cx,cy) compose R compose translate(-cx,-cy)
      return composeMatrix(composeMatrix([1, 0, 0, 1, cx, cy], R), [1, 0, 0, 1, -cx, -cy]);
    }
    case "skewx": return [1, 0, Math.tan(rad(n(0))), 1, 0, 0];
    case "skewy": return [1, Math.tan(rad(n(0))), 0, 1, 0, 0];
    default: throw new Error(`svg: unsupported transform function "${name}()"`);
  }
}

export function parseTransform(spec) {
  if (typeof spec !== "string" || !spec.trim()) return [...IDENTITY];
  let m = [...IDENTITY];
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  let hit = null, consumed = 0;
  while ((hit = re.exec(spec))) {
    const nums = (hit[2].match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    // Left-to-right in the attribute means each successive primitive composes
    // on the RIGHT - it is applied to the point earlier.
    m = composeMatrix(m, primitive(hit[1].toLowerCase(), nums));
    consumed += hit[0].length;
  }
  if (consumed === 0) throw new Error(`svg: unparseable transform "${spec}"`);
  return m;
}

// A similarity: columns orthogonal and of equal length. That is precisely the
// condition under which circles map to circles.
export function isUniformMatrix(m) {
  const [a, b, c, d] = m;
  const col1 = a * a + b * b, col2 = c * c + d * d;
  const scale = Math.max(col1, col2, 1);
  return Math.abs(col1 - col2) <= UNIFORM_EPS * scale
      && Math.abs(a * c + b * d) <= UNIFORM_EPS * scale;
}

const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function applyMatrixToContour(contour, m) {
  const uniform = isUniformMatrix(m);
  const start = apply(m, contour.start);
  const segments = [];
  let prev = contour.start;
  for (const s of contour.segments) {
    if (s.via && !uniform) {
      // Ellipse-under-affine: expand to cubics in SOURCE space (where the arc
      // is still circular), then transform the cubics, which are closed under
      // affine maps.
      for (const piece of arcToCubicSegments(prev, s.via, s.to)) {
        segments.push(piece.c1
          ? { to: apply(m, piece.to), c1: apply(m, piece.c1), c2: apply(m, piece.c2) }
          : { to: apply(m, piece.to) });
      }
    } else if (s.via) segments.push({ via: apply(m, s.via), to: apply(m, s.to) });
    else if (s.c1) segments.push({ to: apply(m, s.to), c1: apply(m, s.c1), c2: apply(m, s.c2) });
    else segments.push({ to: apply(m, s.to) });
    prev = s.to;
  }
  return { start, segments };
}
