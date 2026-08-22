// Repetition and symmetry over the feature list.
//
// This is the stage that turns a feature DUMP into design INTENT, and it is worth more
// to the consuming agent than marginal recognition accuracy is. Four holes reported
// individually invite four hard-coded positions; the same four reported as a 2x2 grid
// on a 50x30 pitch invite two parameters. A detected mirror plane tells the agent the
// part wants a symmetric parameterisation. Neither is recoverable from the feature list
// once it has been written out flat, which is why it happens here and not in the model.
//
// Grouping is by feature SIGNATURE (type plus rounded principal dimension) before any
// geometry is considered: two holes of different diameters are never one pattern no
// matter how neatly they line up, and testing that first keeps the position search
// small.
//
// Pure leaf. See spec §2.6.

const TOL_FRAC = 1e-3;          // spacing agreement, as a fraction of the bbox diagonal
const MIN_MEMBERS = 3;          // below this a "pattern" is just two features
const round3 = (v) => Math.round(v * 1000) / 1000;

const posOf = (f) => f.axis?.origin ?? f.center ?? null;
const signature = (f) =>
  `${f.type}:${round3(f.diameter ?? f.radius ?? f.width ?? f.depth ?? 0)}`;

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

// An orthonormal frame to measure repetition in. NOT the world axes (controller ruling
// R27): a 2x2 hole grid drilled into a plate sitting at an arbitrary orientation — which is
// every real part — has no relationship to world X/Y/Z, so bucketing world coordinates
// finds nothing. Holes in one pattern share a drill direction, so that direction is the
// natural third axis and the repetition lives in the plane perpendicular to it.
//
// Falls back to world axes only when no feature carries a direction at all, which keeps
// the axis-aligned fixtures behaving exactly as before.
function patternFrame(members) {
  const dir = members.map((f) => f.axis?.direction).find(Boolean);
  if (!dir) return [[1,0,0],[0,1,0],[0,0,1]];
  const w = unit(dir);
  const seed = Math.abs(w[0]) < 0.9 ? [1,0,0] : [0,1,0];
  const u = unit(cross(w, seed));
  return [u, cross(w, u), w];
}
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = (a) => { const n = len(a) || 1; return [a[0]/n, a[1]/n, a[2]/n]; };
// A position expressed in the frame — this is what every geometric test below reads,
// so all of them are orientation-invariant by construction rather than by inspection.
const inFrame = (frame, p) => frame.map((axis) => p[0]*axis[0] + p[1]*axis[1] + p[2]*axis[2]);

export function detectPatterns(features, bounds) {
  const diag = len(sub(bounds.max, bounds.min));
  const tol = diag * TOL_FRAC;
  const patterns = [];
  const groups = new Map();
  for (const f of features) {
    if (!posOf(f)) continue;
    const k = signature(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  for (const members of groups.values()) {
    if (members.length < MIN_MEMBERS) continue;
    const frame = patternFrame(members);
    const pts = members.map((f) => inFrame(frame, posOf(f)));

    // Grid: the positions factor into two independent spacings. Detected before linear
    // so a 2x2 layout is not reported as two unrelated 2-member lines.
    // Directions reported back out are rotated OUT of the frame, so a consumer never has
    // to know the frame existed.
    const outOfFrame = (v) => v && [0,1,2].reduce((acc, i) =>
      [acc[0] + v[i]*frame[i][0], acc[1] + v[i]*frame[i][1], acc[2] + v[i]*frame[i][2]], [0,0,0]);

    const grid = asGrid(members, pts, tol);
    if (grid) { patterns.push({ id: `p${patterns.length}`, ...grid, axis: outOfFrame(grid.axis) }); continue; }

    const linear = asLinear(members, pts, tol);
    if (linear) { patterns.push({ id: `p${patterns.length}`, ...linear, axis: outOfFrame(linear.axis) }); continue; }

    const circular = asCircular(members, pts, tol);
    if (circular) patterns.push({ id: `p${patterns.length}`, ...circular, axis: outOfFrame(circular.axis) });
  }

  return { patterns, symmetry: detectSymmetry(features, bounds, tol) };
}

// Two distinct coordinate values on each of two PERPENDICULAR axes, every
// combination present.
//
// The axes are NOT the frame's own u/v (unlike asLinear/asCircular below, which are
// isometry-invariant and so don't care which in-plane basis the frame happened to
// pick). `patternFrame` chooses u/v from an arbitrary seed vector perpendicular to
// the shared drill direction -- it fixes the plane the pattern lives in, not the
// rotation WITHIN that plane. A grid's own row/column directions can sit at any
// angle inside that plane relative to u/v, so bucketing coordinates against u/v
// directly only works by accident (exactly the axis-aligned case, which is why the
// bug the R27 regression test exists for passed every earlier axis-aligned fixture
// silently). Round 8 review: the brief's own reference `asGrid` bucketed along u/v
// and failed the rotated 2x2 fixture -- verified failing before this rewrite,
// `grid.pitch` came back undefined because the search fell through to `asCircular`
// (a rectangle's 4 corners are also equidistant from its centre, so that branch
// fires "successfully" on the wrong pattern type instead of erroring loudly).
//
// Fix: search for the grid's actual axes among the directions the DATA itself
// exhibits. Every pairwise offset between two members is a candidate row/column
// direction; there are only O(n^2) of them for a feature-count-sized n (not
// triangle-count), so trying each is cheap. The first candidate whose bucketing
// (it, and its single in-plane perpendicular) accounts for every point with two
// evenly spaced axes is the grid.
function asGrid(members, pts, tol) {
  const w = uniqueSorted(pts.map((p) => p[2]), tol);
  if (w.length > 1) return null;               // members aren't coplanar perpendicular to the shared drill axis

  const planar = pts.map((p) => [p[0], p[1]]);
  const n = planar.length;
  if (n < 4) return null;                       // a 2-axis grid needs at least 2x2

  const candidates = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = planar[j][0] - planar[i][0], dy = planar[j][1] - planar[i][1];
      const m = Math.hypot(dx, dy);
      if (m < tol) continue;
      candidates.push([dx / m, dy / m]);
    }
  }

  for (const e1 of candidates) {
    const e2 = [-e1[1], e1[0]];                 // the plane's only perpendicular, up to sign
    const a0 = uniqueSorted(planar.map((p) => p[0]*e1[0] + p[1]*e1[1]), tol);
    const a1 = uniqueSorted(planar.map((p) => p[0]*e2[0] + p[1]*e2[1]), tol);
    if (a0.length < 2 || a1.length < 2 || a0.length * a1.length !== n) continue;
    const p0 = spacing(a0, tol), p1 = spacing(a1, tol);
    if (p0 === null || p1 === null) continue;
    // Canonical order (larger pitch first) so the reported shape doesn't depend on
    // which pairwise offset happened to seed the search.
    const [pitch, counts] = p0 >= p1 ? [[p0, p1], [a0.length, a1.length]] : [[p1, p0], [a1.length, a0.length]];
    return {
      type: "grid", members: members.map((m) => m.key),
      counts, pitch, plane: null, axis: null, confidence: 1,
    };
  }
  return null;
}

// Collinear and evenly spaced.
function asLinear(members, pts, tol) {
  if (pts.length < MIN_MEMBERS) return null;
  const dir = sub(pts[1], pts[0]);
  const dl = len(dir);
  if (dl < tol) return null;
  const u = [dir[0]/dl, dir[1]/dl, dir[2]/dl];
  const ts = [];
  for (const p of pts) {
    const d = sub(p, pts[0]);
    const t = d[0]*u[0] + d[1]*u[1] + d[2]*u[2];
    if (len(sub(d, [t*u[0], t*u[1], t*u[2]])) > tol) return null;   // off the line
    ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const step = spacing(ts, tol);
  if (step === null) return null;
  return {
    type: "linear", members: members.map((m) => m.key),
    counts: [pts.length], pitch: [step], axis: u, plane: null, confidence: 1,
  };
}

// Equidistant from a common centre, evenly spaced in angle.
//
// Equal radius from the CENTROID is not sufficient on its own -- for n >= 4 it is
// satisfiable by clusters (e.g. three antipodal pairs of holes, each pair 8 degrees
// apart, the pairs 120 degrees apart: every point is still equidistant from the
// centroid by the 3-fold symmetry, but the layout is nothing like an evenly spaced
// bolt circle). Confirmed against exactly that construction before adding the
// angular check below: the brief's reference `asCircular`, which only tests radius,
// reported it as a clean 6-hole/60-degree pattern. For n == 3 this can't happen --
// three equal-magnitude vectors summing to zero (which is what "equidistant from
// their own centroid" forces) are necessarily 120 degrees apart -- so the gap is
// invisible on every fixture this small, exactly the kind of thing that passes a
// minimal suite silently.
function asCircular(members, pts, tol) {
  if (pts.length < MIN_MEMBERS) return null;
  const w = uniqueSorted(pts.map((p) => p[2]), tol);
  if (w.length > 1) return null;   // not coplanar perpendicular to the shared axis -- not a bolt circle

  const c = pts.reduce((a, p) => [a[0]+p[0]/pts.length, a[1]+p[1]/pts.length, a[2]+p[2]/pts.length], [0,0,0]);
  const radii = pts.map((p) => len(sub(p, c)));
  const rm = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (rm < tol || Math.max(...radii.map((r) => Math.abs(r - rm))) > tol) return null;

  const angles = pts.map((p) => Math.atan2(p[1] - c[1], p[0] - c[0])).sort((a, b) => a - b);
  const gaps = angles.map((a, i) => (i === angles.length - 1 ? angles[0] + 2*Math.PI : angles[i+1]) - a);
  const meanGap = (2 * Math.PI) / pts.length;
  const angleTol = tol / rm;   // linear tolerance, converted to angular via the mean radius
  if (!gaps.every((g) => Math.abs(g - meanGap) <= angleTol)) return null;

  return {
    type: "circular", members: members.map((m) => m.key),
    counts: [pts.length], pitch: [round3(360 / pts.length)],
    // Frame-LOCAL, like asGrid and asLinear, so the caller's single `outOfFrame` step
    // handles all three uniformly. A circular pattern's axis is the frame's own third
    // axis by construction — the drill direction its members share is exactly what
    // `patternFrame` built the frame around — so in frame coordinates it is [0,0,1].
    // Returning a world-space direction here instead (say, from a member's own axis)
    // would be silently inconsistent with its siblings and would double-transform the
    // moment anyone routed it through the same step.
    axis: [0, 0, 1], plane: null, confidence: 1,
  };
}

// Distinct values, merged within tol.
function uniqueSorted(values, tol) {
  const s = [...values].sort((a, b) => a - b), out = [];
  for (const v of s) if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  return out;
}

// The common step of a sorted sequence, or null when the steps disagree.
function spacing(sorted, tol) {
  if (sorted.length < 2) return null;
  const steps = sorted.slice(1).map((v, i) => v - sorted[i]);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  return steps.every((s) => Math.abs(s - mean) <= tol) ? mean : null;
}

// Mirror symmetry about each of the FRAME's mid-planes — same reasoning as the grid
// search (ruling R27): a symmetric part at an arbitrary orientation has no symmetry plane
// aligned to world X/Y/Z. The mid-plane is the midpoint of the features' own extent along
// each frame axis, not the mesh bbox's, so the test does not depend on how much unrelated
// geometry happens to surround them.
//
// `coverage` is the matched fraction, so a nearly symmetric part reports 0.94 rather than
// silently reporting nothing — the agent can then decide whether the part WANTS to be
// symmetric and the scan is just imperfect.
function detectSymmetry(features, bounds, tol) {
  const positioned = features.filter((f) => posOf(f));
  if (positioned.length < 2) return [];
  const frame = patternFrame(positioned);
  const local = positioned.map((f) => inFrame(frame, posOf(f)));
  const out = [];
  for (let a = 0; a < 3; a++) {
    const vals = local.map((p) => p[a]);
    const mid = (Math.min(...vals) + Math.max(...vals)) / 2;
    let matched = 0;
    for (let i = 0; i < positioned.length; i++) {
      const want = [...local[i]];
      want[a] = 2 * mid - local[i][a];
      const hit = local.some((q, j) =>
        signature(positioned[j]) === signature(positioned[i]) && len(sub(q, want)) <= tol);
      if (hit) matched++;
    }
    const coverage = matched / positioned.length;
    if (coverage > 0.6) {
      out.push({ type: "mirror", plane: { normal: frame[a], offset: mid }, coverage: round3(coverage) });
    }
  }
  return out;
}
