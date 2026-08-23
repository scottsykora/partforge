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
const MIN_SYMMETRY_MEMBERS = 4; // a mirror plane over 1-2 points restates a midpoint, not a finding
const SYMMETRY_EVIDENCE_MIN = 2; // confirmed mirror PAIRS a candidate needs, including the one that proposed it
const SYMMETRY_PREFILTER_FACTOR = 5; // how much wider the proposer-count pre-filter bucket is than the exact one
const round3 = (v) => Math.round(v * 1000) / 1000;

const posOf = (f) => f.axis?.origin ?? f.center ?? null;
const signature = (f) =>
  `${f.type}:${round3(f.diameter ?? f.radius ?? f.width ?? f.depth ?? 0)}`;

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

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

// Mirror symmetry, tested against candidate planes derived from the DATA rather
// than from `patternFrame`'s axes -- closing the same ruling-R27 gap `asGrid` had.
// `patternFrame`'s w axis is data-derived (the shared drill direction), but its u/v
// are an arbitrary seed-vector choice with no relationship to where a real mirror
// plane sits; testing only those two as candidate normals meant a part whose true
// mirror plane wasn't aligned to that arbitrary in-plane pick reported no symmetry
// at all, the same silent orientation-dependence asGrid had before its rewrite.
//
// Candidates: for every PAIR of same-signature features, the perpendicular
// bisector plane of the segment joining them -- normal along the join direction,
// offset at the midpoint -- is a candidate mirror plane. This set is complete: any
// true mirror plane of the layout must be the bisector of at least one such pair
// (a feature and its own reflected partner), whatever the part's orientation.
//
// Fix round 2 (self-satisfying floor): the bisector of pair (i, j) ALWAYS reflects
// i onto j and j onto i, by construction, for ANY pair, symmetric layout or not --
// that is not evidence, it is a restatement of how the candidate was built. Scoring
// naively (matched/n, no gate) therefore has a guaranteed floor of 2/n before any
// real evidence is considered: coverage=1 at n=2, 0.67 at n=3, both already above
// the 0.6 threshold. Confirmed: the ungated version reports a perfect coverage=1
// mirror plane on the brief's own "two unrelated holes" fixture, and flagged
// spurious symmetry on close to 100% of random small layouts.
//
// The fix is NOT "exclude the pair that proposed the candidate" -- after
// de-duplication (below) a single canonical plane is typically proposed by SEVERAL
// pairs at once in a genuinely symmetric layout (both real pairs on the brief
// rectangle's x=30 plane propose the identical plane), so there is no single
// well-defined "the" proposing pair to exclude post-dedup; picking one arbitrarily
// (e.g. "whichever pair the generation loop reached first") would also make the
// result depend on input ORDER, which is a correctness bug on its own. Instead,
// every candidate is required to be corroborated by evidence beyond a single
// pair's self-consistency: at least `SYMMETRY_EVIDENCE_MIN` confirmed mirror PAIRS
// (the one that proposed the candidate always counts as one; a second, independent
// pair is what makes it evidence rather than a tautology). This is a property of
// the fully-scored candidate, not of "who proposed it first", so it is
// order-independent by construction. `MIN_SYMMETRY_MEMBERS` additionally refuses
// to even consider symmetry below 4 positioned features, per the same reasoning:
// a plane over 1-2 points restates a midpoint rather than finding anything.
//
// On-plane points (a feature landing within tolerance of the candidate plane
// itself, e.g. a centred keyway) are NOT counted toward this gate, only toward
// `coverage` once a candidate has already cleared it via pairs: an on-plane test is
// a 1-DOF proximity-to-a-PLANE check, not the 3-DOF proximity-to-a-specific-POINT
// check a pair match is, so it clears by pure chance far more often on unrelated
// data. Measured directly: gating on pairs-plus-on-plane produced 5 false
// positives across 1500 random trials at n=2/3/4/5/7 (all at n=4, where a single
// stray on-plane coincidence combined with the always-true generating pair to
// clear the threshold); gating on pairs alone dropped that to 0/1500.
//
// Performance (fix round 2, two passes): the first pass -- de-duplicating
// candidates via a rounded bucket instead of an O(candidates^2) pairwise scan, and
// scoring each via a spatial hash instead of an O(n) linear scan per reflected
// point -- still left an O(n^2) candidate count each scored at O(n), i.e. O(n^3)
// overall. Measured: 100-120 holes still took 0.86-3.7s (the wide range is because
// the ORIGINAL O(candidates^2) dedup and O(n) linear-scan lookups were themselves
// large constant factors -- see the cost table in the task report for the
// intermediate numbers). At n=120, ~7100 candidates x ~120 points/candidate is
// ~850k reflect-and-look-up calls; even at O(1)-amortized each, that is the
// dominant cost, and no amount of speeding up that lookup changes the O(n^3) shape.
//
// The actual fix is to avoid running that O(n) scoring pass at all for the
// overwhelming majority of candidates. Key observation: a "confirmed pair" (k, l)
// for a candidate plane P -- a pair that, on scoring, turns out to reflect onto
// itself through P -- is BY DEFINITION a pair whose OWN perpendicular bisector
// equals P. But every same-signature pair's bisector is exactly what the
// generation loop already computes for EVERY (i, j), so the number of DISTINCT
// pairs that propose the same bucket during generation is a free-to-compute proxy
// for the same "confirmed pairs" count the expensive scoring pass exists to find.
// So: tally proposer counts per bucket during the O(n^2) generation pass (already
// cheap, ~5-15ms even at n=120), and only run the O(n) exact scoring pass -- which
// still makes the final accept/reject call, so this tally never itself decides
// correctness -- on candidates whose bucket already has >= SYMMETRY_EVIDENCE_MIN
// proposers. For a layout with no real symmetry this prunes ~7100 candidates down
// to a few hundred; for a genuinely symmetric layout the true planes were always
// going to survive regardless, since their real proposer count clears the bar.
//
// The proposer-count bucket is deliberately WIDER (`SYMMETRY_PREFILTER_FACTOR`x)
// than the exact dedup bucket used for the final output: real position noise
// between two truly-duplicate pairs (e.g. from mesh measurement error, not the
// exact-copy rotations this file's own tests use) could otherwise straddle a
// narrow bucket edge and undercount a genuine candidate's proposers, silently
// dropping a real symmetry finding before the exact pass ever runs. Widening only
// risks the opposite, harmless direction: unrelated pairs coincidentally sharing a
// wide bucket just cost one extra (still individually cheap) exact scoring pass
// that correctly rejects them -- it can never cause a false ACCEPT, since the
// final decision is always the exact `pairs`/`coverage` computation below, not the
// proposer count.
//
// `coverage` is the matched fraction (of ALL positioned features, not just the
// evidence beyond the gate), so a nearly symmetric part reports 0.94 rather than
// silently reporting nothing — the agent can then decide whether the part WANTS
// to be symmetric and the scan is just imperfect.
function detectSymmetry(features, bounds, tol) {
  const positioned = features.filter((f) => posOf(f));
  if (positioned.length < MIN_SYMMETRY_MEMBERS) return [];
  const pts = positioned.map((f) => posOf(f));
  const sigs = positioned.map((f) => signature(f));

  const fineSeen = new Map();     // fine bucket key -> candidate (for de-duplicated output)
  const coarseCounts = new Map(); // coarse bucket key -> proposer count (pre-filter only)
  const candidates = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (sigs[i] !== sigs[j]) continue;
      const d = sub(pts[j], pts[i]);
      const dl = len(d);
      if (dl < tol) continue;                              // coincident, not a mirror pair
      const rawN = [d[0]/dl, d[1]/dl, d[2]/dl];
      const mid = [(pts[i][0]+pts[j][0])/2, (pts[i][1]+pts[j][1])/2, (pts[i][2]+pts[j][2])/2];
      const cand = canonicalPlane(rawN, dot(rawN, mid));

      const ck = planeBucketKey(cand, tol, SYMMETRY_PREFILTER_FACTOR);
      coarseCounts.set(ck, (coarseCounts.get(ck) || 0) + 1);

      const fk = planeBucketKey(cand, tol, 1);
      if (!fineSeen.has(fk)) { const entry = { cand, ck }; fineSeen.set(fk, entry); candidates.push(entry); }
    }
  }
  const survivors = candidates.filter((c) => (coarseCounts.get(c.ck) || 0) >= SYMMETRY_EVIDENCE_MIN);

  const lookup = buildPositionLookup(pts, sigs, tol);
  const out = [];
  for (const { cand } of survivors) {
    const matchOf = pts.map((p, i) => {
      const d2 = 2 * (dot(cand.n, p) - cand.offset);
      const want = [p[0]-d2*cand.n[0], p[1]-d2*cand.n[1], p[2]-d2*cand.n[2]];
      return findNearby(lookup, want, sigs[i], pts, tol);
    });

    let pairs = 0, onPlane = 0;
    for (let i = 0; i < matchOf.length; i++) {
      const j = matchOf[i];
      if (j === -1) continue;
      if (j === i) onPlane++;
      else if (j > i && matchOf[j] === i) pairs++;           // count each mutual pair once
    }
    // The gate is confirmed PAIRS only, not "pairs + on-plane points" (an earlier
    // version of this fix gated on both and measurably regressed: an on-plane match
    // is a 1-DOF test -- is this point within tol of a PLANE -- against a 3-DOF test
    // for a pair -- is this point within tol of a specific reflected POSITION -- so
    // it fires on unrelated random data far more often. Measured directly: gating on
    // pairs+onPlane produced 5/1500 false positives across n=2/3/4/5/7 random
    // trials, concentrated at n=4 where a single stray on-plane coincidence was
    // enough to clear the threshold alongside the always-true generating pair.
    // Gating on pairs alone (a second INDEPENDENT confirmed pair beyond the one that
    // proposed the candidate) dropped that to 0/1500. On-plane points still count
    // toward `coverage` once a candidate has cleared the pairs gate -- a feature
    // genuinely on the mirror plane (a centred keyway) is real supporting evidence
    // once the plane itself is established, just not evidence for ESTABLISHING it.
    if (pairs < SYMMETRY_EVIDENCE_MIN) continue;

    const coverage = (2*pairs + onPlane) / pts.length;
    if (coverage <= 0.6) continue;
    if (out.some((o) => samePlane(o, cand, tol))) continue;   // fine-bucket boundary straddle
    out.push({ n: cand.n, offset: cand.offset, coverage: round3(coverage) });
  }

  // Canonical order: a function of the geometry (offset, then normal), not of
  // which pair the generation loop happened to reach first for a given input order.
  out.sort((a, b) => a.offset - b.offset || a.n[0]-b.n[0] || a.n[1]-b.n[1] || a.n[2]-b.n[2]);
  return out.map(({ n, offset, coverage }) => ({ type: "mirror", plane: { normal: n, offset }, coverage }));
}

// Fixes the normal's sign (and offset to match) so a plane's canonical form is a
// function of the geometry, not of which of two pairs on it -- or which direction
// along the segment -- happened to compute it.
function canonicalPlane(n, offset) {
  let idx = 0;
  // `+ TOL_FRAC` (round 3 IMPORTANT fix), not a bare `>`: a true mirror plane at ~45deg
  // to the frame has two normal components equal in magnitude, so two independently
  // -computed proposing pairs for the SAME plane can land on opposite sides of this
  // comparison from float noise alone -- one picks idx=0, the other idx=1, and each
  // then sign-fixes against a DIFFERENT component, canonicalizing to opposite-sign
  // normals that never merge in samePlane/planeBucketKey (the same plane reported
  // twice, each half failing SYMMETRY_EVIDENCE_MIN alone instead of confirming each
  // other). Reproduced directly against a real meshed 2x2-hole plate rotated exactly
  // 45deg about Z: 2 mirror planes at 0/15/30/60/90deg, only 1 at 45deg, with
  // Manifold's own tessellation noise on the surviving/orphaned proposers' normal
  // components measured up to ~2e-8 apart -- large enough that the file's other
  // candidate tie-break (`+ 1e-9`, an earlier draft of this fix) still let the idx pick
  // flip and did not actually merge the two proposers. `TOL_FRAC` is already this
  // file's own established noise floor for a unit-vector component (see
  // `planeBucketKey`'s own comment: "the same dimensionless fraction the frame's own
  // tolerance derives from, appropriate for a unit vector"), five orders of magnitude
  // above the noise actually measured, so reusing it here needs no new magic number
  // and cannot mask a genuinely distinct pair of components (real designs practically
  // never differ by less than TOL_FRAC on a plane normal component without meaning it).
  for (let k = 1; k < 3; k++) if (Math.abs(n[k]) > Math.abs(n[idx]) + TOL_FRAC) idx = k;
  if (n[idx] < 0) return { n: [-n[0], -n[1], -n[2]], offset: -offset };
  return { n, offset };
}

// Rounding bucket for a plane, at `widen`x the base granularity (1x for the exact
// output-dedup bucket, `SYMMETRY_PREFILTER_FACTOR`x for the coarse proposer-count
// pre-filter -- see the performance note above `detectSymmetry` for why the latter
// needs to be wider). Can, in principle, fail to merge two duplicates that
// straddle a bucket edge; for the fine (1x) bucket that's a performance-only risk
// (the final `samePlane` check on the small accepted list is what actually
// guarantees no duplicate plane reaches the output), and for the coarse bucket the
// `SYMMETRY_PREFILTER_FACTOR` margin is what keeps it a non-issue in practice.
// Base width for the normal is `TOL_FRAC` (the same dimensionless fraction the
// frame's own tolerance derives from, appropriate for a unit vector); for the
// offset it's `tol`.
function planeBucketKey(cand, tol, widen) {
  const ng = TOL_FRAC * widen, og = tol * widen;
  const nb = cand.n.map((v) => Math.round(v / ng));
  const ob = Math.round(cand.offset / og);
  return `${nb.join(",")}|${ob}`;
}

// Same plane within tolerance: normals parallel up to sign, offsets equal (sign
// flipped to match the normal's flip, since offset is defined relative to it).
function samePlane(a, b, tol) {
  if (len(sub(a.n, b.n)) < 1e-6) return Math.abs(a.offset - b.offset) <= tol;
  if (len(sub(a.n, [-b.n[0], -b.n[1], -b.n[2]])) < 1e-6) return Math.abs(a.offset + b.offset) <= tol;
  return false;
}

// A spatial hash over (signature, position), built once and reused by every
// candidate's scoring pass. Cell size = tol, so any real match (within tol of some
// feature) is guaranteed to fall in the query point's own cell or one of its 26
// neighbours -- turning "find the matching feature" from an O(n) linear scan into
// an O(1)-amortized lookup. Keys are packed into a single integer (`packCell`)
// rather than a template-literal string: at survivor-scan volume this is called
// tens of thousands of times, and a fresh string allocation plus its hash on every
// call was, measured directly, the dominant cost even after the pre-filter above
// cut the candidate count down -- switching to integer keys turned a ~0.86s pass
// (already down from 3.7s via the pre-filter and hash alone) into a ~0.13s one.
// `CELL_RANGE`/`CELL_OFFSET` give +-65536 cells of headroom per axis, about 65x a
// typical extent/tol ratio (tol is `bounds` diagonal x 1e-3, so a feature spread
// across the full bounding box is already only ~1000 cells wide); a pathological
// input that overflows this just collides two distant cells into one bucket,
// which the exact `len(...) <= tol` check inside `findNearby` still filters
// correctly -- degrades to a slightly bigger bucket to scan, never a wrong match.
function buildPositionLookup(pts, sigs, tol) {
  const sigIds = new Map();
  const bySig = [];
  for (let i = 0; i < pts.length; i++) {
    let sid = sigIds.get(sigs[i]);
    if (sid === undefined) { sid = bySig.length; sigIds.set(sigs[i], sid); bySig.push(new Map()); }
    const key = packCell(Math.round(pts[i][0]/tol), Math.round(pts[i][1]/tol), Math.round(pts[i][2]/tol));
    const cellMap = bySig[sid];
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push(i);
  }
  return { sigIds, bySig };
}
const CELL_OFFSET = 1 << 16;
const CELL_RANGE = 1 << 17;
const packCell = (cx, cy, cz) =>
  ((cx + CELL_OFFSET) * CELL_RANGE + (cy + CELL_OFFSET)) * CELL_RANGE + (cz + CELL_OFFSET);

function findNearby(lookup, q, sig, pts, tol) {
  const sid = lookup.sigIds.get(sig);
  if (sid === undefined) return -1;
  const cellMap = lookup.bySig[sid];
  const cx = Math.round(q[0]/tol), cy = Math.round(q[1]/tol), cz = Math.round(q[2]/tol);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const bucket = cellMap.get(packCell(cx+dx, cy+dy, cz+dz));
    if (!bucket) continue;
    for (const idx of bucket) if (len(sub(pts[idx], q)) <= tol) return idx;
  }
  return -1;
}
