// SVG path data (`d`) → curve-native contours. The front end of k.svg2d, and
// the exact analogue of text2d.js's glyphContours: same job (a foreign path
// language → this engine's contour IR), same y-up convention question, same
// "never flatten a curve" rule.
//
// Curve-native by design: C/S stay cubic, Q/T degree-elevate to cubic (the
// same elevation text2d.js already does for TrueType quadratics), and A
// becomes <=90-degree cubic pieces. Nothing is sampled to points here — that
// happens later and only where a backend asks for it.
//
// Coordinates come out in SVG user space, INCLUDING its y-down convention.
// The y flip happens once, in svg2d.js, after transforms are applied — doing
// it here would invert every transform matrix's shear and rotation terms.
//
// Pure leaf: DOM-free, node:-free, no kernel.
import { pathProfile } from "./polygon.js";

const NUM = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// Tokenize into [{ cmd, args }]. Handles implicit repeats (a command's args
// repeated without re-stating the letter) and SVG's rule that a repeat after M
// is L (after m, l).
//
// Arc flags are scanned specially, and this is not a nicety. In minified path
// data — what SVGO emits, which is most real-world artwork — `a2,2 0 01-4,0`
// is legal: the large-arc and sweep flags are single characters needing no
// separator. A plain number scanner reads "01" as one, every following argument
// shifts by a place, and the result is silently wrong geometry with no error
// anywhere. Positions 3 and 4 of each 7-argument A group therefore consume
// exactly one '0' or '1'.
//
// Anything that is neither a command letter, a separator, nor a number THROWS.
// Skipping it (the obvious regex-scan design) turns "M0,0 X10,10" into a valid
// two-command path — a typo that silently draws a different shape.
const CMD_CHAR = /[MmLlHhVvCcSsQqTtAaZz]/;
const NUM_AT = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;

function tokenize(d) {
  const out = [];
  let i = 0, pending = null, args = [];

  const flush = () => {
    if (!pending) return;
    const need = ARG_COUNT[pending.toUpperCase()];
    if (need === 0) { out.push({ cmd: pending, args: [] }); args = []; return; }
    if (args.length === 0 || args.length % need !== 0)
      throw new Error(`svg: command "${pending}" expects a multiple of ${need} numbers, got ${args.length}`);
    for (let k = 0; k < args.length; k += need) {
      let cmd = pending;
      if (k > 0 && (pending === "M" || pending === "m")) cmd = pending === "M" ? "L" : "l";
      out.push({ cmd, args: args.slice(k, k + need) });
    }
    args = [];
  };

  while (i < d.length) {
    const c = d[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") { i++; continue; }
    if (CMD_CHAR.test(c)) { flush(); pending = c; i++; continue; }
    if (!pending) throw new Error("svg: path data begins with a coordinate, not a command");
    if ((pending === "A" || pending === "a") && (args.length % 7 === 3 || args.length % 7 === 4)) {
      if (c !== "0" && c !== "1") throw new Error(`svg: arc flag must be 0 or 1, got "${c}"`);
      args.push(Number(c)); i++; continue;
    }
    NUM_AT.lastIndex = i;
    const m = NUM_AT.exec(d);
    if (!m || m[0] === "") throw new Error(`svg: unexpected character "${c}" in path data`);
    args.push(parseFloat(m[0]));
    i = NUM_AT.lastIndex;
  }
  flush();
  if (out.length === 0 && d.trim()) throw new Error("svg: unparseable path data");
  return out;
}

// SVG elliptical arc (endpoint parameterization, W3C SVG 1.1 notes F.6) → cubic
// pieces of at most 90 degrees each. Centre-form recovery is the same math as
// shape2d-regions.js's sampleSvgArc — which the tests use as the truth oracle —
// but this emits curves instead of points, with the standard
// k = (4/3)tan(dTheta/4) handle construction (the same one
// paper-bridge.js's arcToCubicSegments uses for circular arcs).
export function svgArcToCubics(from, rx, ry, rotDeg, largeArc, sweep, to) {
  const [x1, y1] = from, [x2, y2] = to;
  if (!rx || !ry) return [{ to: [x2, y2] }];                 // zero radius → line, per spec
  const phi = (rotDeg * Math.PI) / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let RX = Math.abs(rx), RY = Math.abs(ry);
  const lambda = (x1p * x1p) / (RX * RX) + (y1p * y1p) / (RY * RY);
  if (lambda > 1) { const s = Math.sqrt(lambda); RX *= s; RY *= s; }   // spec: scale radii up
  const num = RX * RX * RY * RY - RX * RX * y1p * y1p - RY * RY * x1p * x1p;
  const den = RX * RX * y1p * y1p + RY * RY * x1p * x1p;
  if (den === 0) return [{ to: [x2, y2] }];
  let coef = Math.sqrt(Math.max(0, num / den));
  if (Boolean(largeArc) === Boolean(sweep)) coef = -coef;
  const cxp = (coef * RX * y1p) / RY, cyp = (-coef * RY * x1p) / RX;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dotv = ux * vx + uy * vy, l = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12;
    let a = Math.acos(Math.min(1, Math.max(-1, dotv / l)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = angle(1, 0, (x1p - cxp) / RX, (y1p - cyp) / RY);
  let dT = angle((x1p - cxp) / RX, (y1p - cyp) / RY, (-x1p - cxp) / RX, (-y1p - cyp) / RY);
  if (!sweep && dT > 0) dT -= 2 * Math.PI;
  if (sweep && dT < 0) dT += 2 * Math.PI;

  // Point and derivative on the rotated ellipse at parameter t.
  const P = (t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [cx + RX * c * cosP - RY * s * sinP, cy + RX * c * sinP + RY * s * cosP];
  };
  const D = (t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [-RX * s * cosP - RY * c * sinP, -RX * s * sinP + RY * c * cosP];
  };

  const pieces = Math.max(1, Math.ceil(Math.abs(dT) / (Math.PI / 2) - 1e-9));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const a0 = t1 + dT * (i / pieces), a1 = t1 + dT * ((i + 1) / pieces);
    const k = (4 / 3) * Math.tan((a1 - a0) / 4);             // magic-number Bézier handle scale
    const p0 = P(a0), p1 = P(a1), d0 = D(a0), d1 = D(a1);
    out.push({
      to: p1,
      c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]],
      c2: [p1[0] - k * d1[0], p1[1] - k * d1[1]],
    });
  }
  out.at(-1).to = [x2, y2];                                   // pin the exact endpoint
  return out;
}

export function svgPathToContours(d) {
  if (typeof d !== "string" || !d.trim()) return [];
  const tokens = tokenize(d);
  const subs = [];
  let pen = null;                 // pathProfile builder for the open subpath
  let cur = [0, 0];               // current point (spec: a relative moveto with no prior
                                   // current point is equivalent to absolute — defaulting
                                   // to [0,0] here reproduces exactly that)
  let sub = null;                 // this subpath's start point
  let prevCubicC2 = null;         // for S
  let prevQuadC = null;           // for T
  let closed = false;

  const finish = () => {
    if (!pen) return;
    // A subpath with no segments (a lone M) contributes nothing.
    try { subs.push({ contour: pen.close(), closed }); } catch { /* no segments */ }
    pen = null;
  };
  const need = (args, n, cmd) => {
    if (args.length < n) throw new Error(`svg: command "${cmd}" is short of coordinates`);
  };

  for (const { cmd, args } of tokens) {
    const rel = cmd === cmd.toLowerCase() && cmd !== "Z";
    const C = cmd.toUpperCase();
    const ax = (v) => (rel ? cur[0] + v : v);
    const ay = (v) => (rel ? cur[1] + v : v);

    if (C === "Z") {
      if (pen) { closed = true; finish(); }
      cur = sub ? [sub[0], sub[1]] : cur;      // per spec the pen returns to the subpath start
      prevCubicC2 = prevQuadC = null;
      continue;
    }

    if (C === "M") {
      need(args, 2, cmd);
      finish();
      cur = [ax(args[0]), ay(args[1])];
      sub = [cur[0], cur[1]];
      closed = false;
      pen = pathProfile(cur);
      prevCubicC2 = prevQuadC = null;
      continue;
    }

    if (!pen) throw new Error(`svg: command "${cmd}" before any moveto`);

    if (C === "L") { need(args, 2, cmd); cur = [ax(args[0]), ay(args[1])]; pen.lineTo(cur); prevCubicC2 = prevQuadC = null; }
    else if (C === "H") { need(args, 1, cmd); cur = [rel ? cur[0] + args[0] : args[0], cur[1]]; pen.lineTo(cur); prevCubicC2 = prevQuadC = null; }
    else if (C === "V") { need(args, 1, cmd); cur = [cur[0], rel ? cur[1] + args[0] : args[0]]; pen.lineTo(cur); prevCubicC2 = prevQuadC = null; }
    else if (C === "C") {
      need(args, 6, cmd);
      const c1 = [ax(args[0]), ay(args[1])], c2 = [ax(args[2]), ay(args[3])], to = [ax(args[4]), ay(args[5])];
      pen.cubicTo(to, c1, c2); cur = to; prevCubicC2 = c2; prevQuadC = null;
    }
    else if (C === "S") {
      need(args, 4, cmd);
      // The implied first handle is the reflection of the previous cubic's
      // second handle about the current point; with no previous cubic the spec
      // says use the current point itself.
      const c1 = prevCubicC2 ? [2 * cur[0] - prevCubicC2[0], 2 * cur[1] - prevCubicC2[1]] : [cur[0], cur[1]];
      const c2 = [ax(args[0]), ay(args[1])], to = [ax(args[2]), ay(args[3])];
      pen.cubicTo(to, c1, c2); cur = to; prevCubicC2 = c2; prevQuadC = null;
    }
    else if (C === "Q" || C === "T") {
      let q, to;
      if (C === "Q") { need(args, 4, cmd); q = [ax(args[0]), ay(args[1])]; to = [ax(args[2]), ay(args[3])]; }
      else {
        need(args, 2, cmd);
        q = prevQuadC ? [2 * cur[0] - prevQuadC[0], 2 * cur[1] - prevQuadC[1]] : [cur[0], cur[1]];
        to = [ax(args[0]), ay(args[1])];
      }
      // Degree elevation, identical to text2d.js's TrueType quadratic handling.
      const c1 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
      const c2 = [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])];
      // prevCubicC2 is CLEARED, not set: per SVG 1.1 §8.3.6, `S` reflects only
      // when the previous command was C/c/S/s. After Q/q/T/t its implied first
      // handle is the current point. Setting it to the elevated c2 here makes
      // a following S bend the wrong way, silently, on legal input.
      pen.cubicTo(to, c1, c2); cur = to; prevQuadC = q; prevCubicC2 = null;
    }
    else if (C === "A") {
      need(args, 7, cmd);
      const to = [ax(args[5]), ay(args[6])];
      for (const piece of svgArcToCubics(cur, args[0], args[1], args[2], !!args[3], !!args[4], to)) {
        if (piece.c1) pen.cubicTo(piece.to, piece.c1, piece.c2);
        else pen.lineTo(piece.to);
      }
      cur = to; prevCubicC2 = prevQuadC = null;
    }
    else throw new Error(`svg: unsupported path command "${cmd}"`);
  }
  finish();
  return subs;
}
