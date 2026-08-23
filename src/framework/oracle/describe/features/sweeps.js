// Revolve and uniform-wall shell rules — the two additions past the prismatic core
// (spec decisions table), both mapping directly onto partforge ops that already exist.
//
// REVOLVE: every surface's own axis is collinear with one shared axis. Turned parts,
// vases, and washers all satisfy this, and when they do, a revolve of the axial
// half-profile is a far better parameterisation than a stack of extrusions. Two
// families of surface feed the vote: cylinders/cones/tori contribute their own fitted
// axis directly, and planes perpendicular to the winning axis (the caps a lathe cuts
// square to the spindle) count as agreeing too rather than as evidence against — a
// plain cylinder's end caps are exactly this case. This is a candidate reading, not an
// exclusive one: the same cylinder that reads as a revolve here also reads as an
// extrusion in prismatic.js, and reconciling overlapping readings across families is a
// later stage's job, not this rule's.
//
// SHELL: this is the hardest detector in the vocabulary and the spec names it as the
// first thing to cut if v1 runs long — so it is written conservatively and reports
// NOTHING when it is not confident, which is always the safe direction: a missed shell
// is residual, an invented shell is a lie the agent will build against.
//
// MEASURED BY RAYCAST, not by pairing anti-parallel planes at a matching offset — a
// first version tried the pairing approach and it was wrong in BOTH directions,
// verified directly against fixtures (numbers below, at each threshold constant): it
// called `boxMesh(10,10,10)` (a solid cube) a shell, because a
// cube's three anti-parallel plane pairs happen to share one gap purely because a
// cube's three dimensions happen to be equal — the pairing test has no notion of
// "thin", only "consistent", and a solid's own consistent full-size gap satisfies it
// exactly as well as a genuine wall thickness would. And it missed every GENUINE
// uniform-wall shell, because pairing every anti-parallel plane combination on a real
// shell (inner AND outer walls both present) also produces the outer envelope's own
// gaps and the inner cavity's own gaps alongside the true wall-thickness gaps, and no
// spread threshold can separate "these three gaps are one shell" from "these three
// gaps are the cube's three dimensions" using gap values alone — both are perfectly
// self-consistent for the wrong reason.
//
// The fix: measure actual material thickness, the way `min-wall.js` already does for
// the whole mesh, at the scale of one SURFACE rather than one triangle. For each plane
// surface, cast a ray from a handful of its own face centroids inward (reverse of its
// own outward normal) into `bvh.raycast` and take the nearest hit as that surface's own
// local wall reading. A genuine shell reads the SAME small distance from nearly every
// plane; a solid does not read "inconsistent" this way (a cube reads a perfectly
// consistent full 10mm from every one of its six faces) — which is why a SECOND,
// independent gate is required: the reading must also be THIN relative to the part's
// own size (bbox diagonal), not merely consistent. Two-part gate: (1) the large
// majority of per-plane readings agree with each other (a shell's own CLOSING faces —
// a tray's rim, see `openTrayMesh` — read a wildly different, unrelated distance along
// their own normal, since their normal points along the wall's run rather than across
// its thickness, so "majority" rather than "all" is deliberate); (2) that agreed value
// is small relative to the part's own bbox diagonal. Both thresholds were picked
// against real measurements on this file's own fixtures, not guessed — see the
// constants below.
//
// Requires `topo` (the welded mesh topology `buildTopology` produces) to raycast
// against; omit it and this half of the rule is skipped rather than guessing (the
// revolve rule above needs no mesh access and still runs).
//
// `opts.bvh`, if given, is used instead of building one here — the orchestrator
// (describe.js, Task 12 / ruling R39) builds exactly ONE BVH per describe() call
// and passes it down, since buildBVH is O(n log n) over the WHOLE mesh regardless
// of how few rays a caller casts (measured 9.8ms at 10.8k triangles, 48ms at
// 43k) and this rule's own handful of per-plane rays would otherwise pay that
// cost again for nothing. Falls back to building its own so every existing
// `detectSweeps(graph, topo)` call (this file's own tests included) keeps working
// unchanged.
//
// Pure leaf. See spec §2.5.
import { intrinsicScale } from "../fit.js";
import { buildBVH } from "../../bvh.js";

// "Same axis" band for the revolve vote.
const COLLINEAR_DOT = 0.995;
// A per-plane thickness reading counts as agreeing with the shell's own median if it
// is within this fraction of it. Measured on `hollowBoxMesh(20,20,20,2)` (every one of
// 12 planes reads exactly 2mm, 0% spread) and `openTrayMesh(20,20,10,2)` (10 of 11
// planes read exactly 2mm; the rim reads ~10mm, 400% off) — a band this tight only
// ever excludes the rim's own genuine outlier, never a true wall reading.
const SHELL_READING_AGREE_FRAC = 0.1;
// How much of a candidate shell's own plane readings must agree (see above) for the
// shell to be reported at all. Measured: `hollowBoxMesh` clears 12/12 = 100%;
// `openTrayMesh` clears 10/11 = 90.9% (the rim is the one dissenting reading, exactly
// as its own geometry predicts); `boxMesh(10,10,30)` (a non-cube solid, three
// different gaps) clears only 4/6 = 66.7% (its two 30mm faces dissent from the
// four 10mm ones). Set at 85%, comfortably below the tray's 90.9% and above the
// non-cube solid's 66.7%.
const SHELL_INLIER_FRAC = 0.85;
// The agreed thickness must be small relative to the part's own size, or "consistent"
// is just describing a solid. Originally measured against a world/PCA bbox diagonal:
// `boxMesh(10,10,10)` (a solid cube) reads a perfectly consistent 10mm from all six
// faces — 10 / (10*sqrt(3)) = 57.7% of its own bbox diagonal. `hollowBoxMesh(20,20,20,2)`
// reads 2 / (20*sqrt(3)) = 5.8%; `openTrayMesh(20,20,10,2)` reads 2 / 30 = 6.7% (bbox
// diagonal sqrt(20^2+20^2+10^2) = 30). Set at 25% against those numbers, comfortably
// below the cube's 57.7% and well above either genuine shell's own reading.
//
// Retuned (fix round 5, ONE-TIME DELIBERATE, not an invariant — see `FIT_TOL_FRAC`'s
// comment in segment.js for the full reasoning, which applies identically here):
// `diag` (this file, below) is `intrinsicFrame`'s `diagonal`, now a bare radius of
// gyration with no calibration folded in, reading smaller than the bbox-diagonal
// figures above on the same mesh. `0.25 * 1.0879082239773115 = 0.271977` carries this
// constant's original tuning forward onto the new scale, measured on the same
// reference shape `FIT_TOL_FRAC` uses; it is not a claim that every part's shell
// gate is unchanged.
const SHELL_MAX_RELATIVE_THICKNESS = 0.271977;
// Sample budget per plane surface — a handful of its own faces, not every one (that is
// min-wall.js's job, at whole-mesh scale, with its own much larger budget). Once a
// surface is already known to be one plane, a few widely-spread samples are enough to
// catch it reading something other than its neighbours' consistent value.
const MAX_SAMPLES_PER_PLANE = 5;
const round3 = (v) => Math.round(v * 1000) / 1000;
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function faceCentroid(topo, t) {
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    c[0] += topo.verts[v]/3; c[1] += topo.verts[v+1]/3; c[2] += topo.verts[v+2]/3;
  }
  return c;
}

// This plane surface's own local wall reading: cast a ray from a spread of its own
// face centroids along the reverse of its fitted normal (straight into whatever
// material or cavity lies immediately behind it — `bvh.raycast`, the same primitive
// min-wall.js casts one of per triangle) and take the MEDIAN hit distance. `skipTri`
// keeps the originating triangle from reporting a spurious zero-distance self-hit.
function planeInwardThickness(topo, bvh, surf) {
  const faces = surf.faces, n = faces.length;
  if (n === 0) return null;
  const step = Math.max(1, Math.floor(n / MAX_SAMPLES_PER_PLANE));
  const nrm = surf.fit.normal, dir = [-nrm[0], -nrm[1], -nrm[2]];
  const dists = [];
  for (let i = 0; i < n; i += step) {
    const t = faces[i];
    const hit = bvh.raycast(faceCentroid(topo, t), dir, { skipTri: t });
    if (hit) dists.push(hit.t);
  }
  return dists.length ? medianOf(dists) : null;
}

// This surface's own axis, if it has one — the vote unit for the revolve rule.
const axisOf = (s) =>
  s.type === "cylinder" ? s.fit.axis.direction :
  s.type === "cone" ? s.fit.direction :
  s.type === "torus" ? s.fit.axis : null;

export function detectSweeps(graph, topo, opts = {}) {
  const out = [];

  // --- revolve ---------------------------------------------------------------
  const axial = graph.surfaces.map((s) => ({ s, a: axisOf(s) })).filter((x) => x.a);
  if (axial.length >= 1) {
    // Vote: the axis most surfaces agree with, weighted by area. Antipodal directions
    // are the same axis, so compare on |dot|.
    let best = null;
    for (const cand of axial) {
      const agree = axial.filter((x) => Math.abs(dot(x.a, cand.a)) > COLLINEAR_DOT);
      const area = agree.reduce((t, x) => t + x.s.area, 0);
      if (!best || area > best.area) best = { axis: cand.a, agree, area };
    }
    const axialArea = best ? best.area : 0;
    const total = graph.surfaces.reduce((t, s) => t + s.area, 0);
    // Planes perpendicular to the axis (caps) are consistent with a revolve too, so
    // count their area as agreeing rather than as evidence against.
    const capArea = graph.surfaces
      .filter((s) => s.type === "plane" && best && Math.abs(dot(s.fit.normal, best.axis)) > COLLINEAR_DOT)
      .reduce((t, s) => t + s.area, 0);
    if (best && (axialArea + capArea) / total > 0.9) {
      const origin = best.agree[0].s.type === "cylinder" ? best.agree[0].s.fit.axis.origin
                   : best.agree[0].s.type === "cone" ? best.agree[0].s.fit.apex
                   : best.agree[0].s.fit.center;
      out.push({
        id: null,
        key: `revolve:${best.axis.map(round3).join(",")}`,
        type: "revolve",
        axis: { origin, direction: best.axis },
        profile: { kind: "mixed" },
        surfaces: best.agree.map((x) => x.s.id),
        evidence: { axialAreaFraction: round3((axialArea + capArea) / total), agreeing: best.agree.length },
      });
    }
  }

  // --- shell -----------------------------------------------------------------
  // See the header for why this measures actual material thickness by raycast rather
  // than pairing anti-parallel planes. Skipped entirely without `topo` — no mesh, no
  // rays to cast — rather than falling back to a method already found wrong twice.
  if (topo) {
    const planes = graph.surfaces.filter((s) => s.type === "plane");
    if (planes.length >= 3) {
      const bvh = opts.bvh ?? buildBVH({ positions: topo.verts, indices: topo.tris });
      const readingsBySurface = planes
        .map((s) => ({ s, reading: planeInwardThickness(topo, bvh, s) }))
        .filter((r) => r.reading != null);
      if (readingsBySurface.length >= 3) {
        const readings = readingsBySurface.map((r) => r.reading);
        const median = medianOf(readings);
        // Agreement against the MEDIAN, not the mean — a shell's own closing faces
        // (see header) can read far enough off that a mean would already be dragged
        // away from the true wall value before anything gets compared to it.
        const inliers = median > 0
          ? readingsBySurface.filter((r) => Math.abs(r.reading - median) / median < SHELL_READING_AGREE_FRAC)
          : [];
        const inlierFrac = readingsBySurface.length ? inliers.length / readingsBySurface.length : 0;
        // intrinsicScale(), not a plain world-axis min/max: this gate gets MORE
        // permissive (a smaller relativeThickness) when a naive AABB diagonal
        // inflates under rotation, which is the identical failure mode fit.js's own
        // comment documents — here it would make shell detection accept a thicker
        // wall as "thin" purely because the part is tilted, not because anything
        // about the wall changed.
        const diag = intrinsicScale(topo.verts);
        if (median > 0 && inlierFrac >= SHELL_INLIER_FRAC && diag > 0 && median / diag < SHELL_MAX_RELATIVE_THICKNESS) {
          const thickness = medianOf(inliers.map((r) => r.reading));
          out.push({
            id: null,
            key: `shell:${round3(thickness)}`,
            type: "shell", thickness,
            surfaces: inliers.map((r) => r.s.id),
            evidence: {
              planesSampled: readingsBySurface.length, agreeing: inliers.length,
              inlierFraction: round3(inlierFrac), relativeThickness: round3(thickness / diag),
            },
          });
        }
      }
    }
  }

  return out;
}
