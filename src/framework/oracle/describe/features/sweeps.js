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
// SHELL: a surface has a matching counter-surface at constant offset. This is the
// hardest detector in the vocabulary and the spec names it as the first thing to cut
// if v1 runs long — so it is written conservatively and reports NOTHING when it is not
// confident, which is always the safe direction: a missed shell is residual, an
// invented shell is a lie the agent will build against. Only PLANE-walled shells are
// attempted (three or more anti-parallel plane pairs at one consistent gap); a curved
// shell (a cup's wall-to-wall thickness, say) is exactly the kind of case this rule
// declines rather than guesses at.
//
// Pure leaf. See spec §2.5.
import { jacobiEigen } from "../fit.js";

// "Same axis" band for the revolve vote, and "anti-parallel" band for the shell pair
// search — both read as |dot| against a line, so one collinearity constant serves both.
const COLLINEAR_DOT = 0.995;
// Wall thickness must be this consistent, as a fraction of its own mean, to count as
// one shell rather than a coincidence of three unrelated plane-pair gaps (a solid box
// has exactly three anti-parallel pairs too — its three different dimensions — which
// is why the GATE is the spread across gaps, not merely having three or more of them).
const OFFSET_SPREAD_FRAC = 0.06;
const round3 = (v) => Math.round(v * 1000) / 1000;
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

// This surface's own axis, if it has one — the vote unit for the revolve rule.
const axisOf = (s) =>
  s.type === "cylinder" ? s.fit.axis.direction :
  s.type === "cone" ? s.fit.direction :
  s.type === "torus" ? s.fit.axis : null;

export function detectSweeps(graph) {
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
  // Pair each plane with an anti-parallel plane and measure the gap. A shell shows up
  // as MANY such pairs sharing one gap; a solid box shows up as three pairs with three
  // different gaps, which is why the spread test — not the pair count — is the gate.
  const planes = graph.surfaces.filter((s) => s.type === "plane");
  const gaps = [];
  for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) {
    const d = dot(planes[i].fit.normal, planes[j].fit.normal);
    if (d > -COLLINEAR_DOT) continue;
    // Once R31 has oriented every plane normal outward, two genuinely opposing plane
    // faces have anti-parallel normals and the SUM of their offsets is their gap — the
    // same identity prismatic.js's base-extrusion depth fallback relies on.
    gaps.push({ gap: Math.abs(planes[i].fit.offset + planes[j].fit.offset), pair: [planes[i].id, planes[j].id] });
  }
  if (gaps.length >= 3) {
    const mean = gaps.reduce((t, g) => t + g.gap, 0) / gaps.length;
    const spread = Math.max(...gaps.map((g) => Math.abs(g.gap - mean)));
    if (mean > 0 && spread / mean < OFFSET_SPREAD_FRAC) {
      out.push({
        id: null,
        key: `shell:${round3(mean)}`,
        type: "shell", thickness: mean,
        surfaces: gaps.flatMap((g) => g.pair),
        evidence: { pairs: gaps.length, spreadFraction: round3(spread / mean) },
      });
    }
  }

  return out;
}
