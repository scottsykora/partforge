// The `suggestion` layer: a proposed reconstruction in partforge terms.
//
// It is physically separate from the facts and labelled as unverified because it is a
// different KIND of claim. The facts layer says "there is a 5.3mm cylinder here with
// concave arcs to two parallel planes" — a measurement. The suggestion says "so build a
// box and cut a hole" — an interpretation, and one the agent is free to reject.
//
// Its step order is not chosen by a heuristic. It is acceptance order, which is the
// order the candidates actually reduced the error in — the payoff of propose-then-
// confirm (spec §2.8). A build order arrived at this way is one we can defend.
//
// Note on what's absent: this layer proposes dimensions (via snap.js's `snapValue`) but
// deliberately does not propose a design GRID. `inferGrid` (snap.js) no longer offers a
// 0.1mm candidate — it's provably degenerate at SNAP_TOL_FRAC, matching any one-decimal
// value whether or not the part was actually designed on a grid. A part genuinely
// modelled on real 0.1mm grid therefore reports no grid rather than a wrong one, and
// this layer doesn't paper over that by inventing one from bounds or dimensions alone.
//
// Pure leaf. See spec §3.2.

import { snapValue, SNAP_TOL_FRAC } from "./snap.js";

const DISCLAIMER =
  "Proposed reconstruction, not measurement. The facts above are authoritative; " +
  "this is one way to rebuild them and may be wrong about intent.";

// A relative-tolerance "same value" test, on the same band snap.js snaps with (never
// an exact float ==) — used below to tell "the same dimension seen again" apart from
// "a different dimension that happens to want the same name".
const ABS_FLOOR = 1e-4;
const near = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * SNAP_TOL_FRAC, ABS_FLOOR);

export function buildHints(accepted, patterns, bounds) {
  const params = [];
  // name -> raw values already recorded under it, so a same-named, different-valued
  // collision can be told apart from the same value turning up twice.
  const valuesByName = new Map();
  const addParam = (name, value, from) => {
    if (!Number.isFinite(value)) return;
    const existing = valuesByName.get(name);
    if (existing) {
      // The same value under this name already: not a new parameter (e.g. two
      // candidates that share a dimension), so skip it rather than duplicate it.
      if (existing.some((v) => near(v, value))) return;
      // A DIFFERENT value collided with an already-used name — e.g. two
      // distinct-diameter, non-pattern holes both falling back to the same generic
      // paramName. Suffix rather than drop it: a parameter silently missing from the
      // suggestion is worse than one with an ugly name (fix round 1, MINOR).
      existing.push(value);
      params.push({ name: `${name}_${existing.length}`, value: snapValue(value)?.to ?? value, from });
      return;
    }
    valuesByName.set(name, [value]);
    params.push({ name, value: snapValue(value)?.to ?? value, from });
  };

  const size = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]);
  addParam("width", size[0], "bounds.size[0]");
  addParam("depth", size[1], "bounds.size[1]");
  addParam("height", size[2], "bounds.size[2]");

  const byKey = new Map();
  for (const p of patterns) for (const m of p.members) byKey.set(m, p.id);

  const steps = accepted.map((a) => {
    const c = a.candidate;
    const patternId = byKey.get(c.featureKey) ?? null;
    // A candidate covered by a pattern names the pattern instead of repeating itself,
    // which is the whole reason patterns.js runs: four steps become one.
    if (c.dimension) addParam(c.paramName ?? c.key.split(":")[0], c.dimension, patternId ?? c.key);
    return {
      op: c.op === "cut" ? "cut" : c.hintOp ?? "union",
      explains: c.explains ?? [],
      pattern: patternId,
      score: Math.round(a.gain * 1000) / 1000,
      args: c.hintArgs ?? {},
    };
  });

  // Steps a pattern already covers collapse into the first of their group: emitting all
  // four members plus the pattern would tell the agent to cut the same holes twice.
  const emitted = new Set();
  const collapsed = steps.filter((s) => {
    if (!s.pattern) return true;
    if (emitted.has(s.pattern)) return false;
    emitted.add(s.pattern);
    return true;
  });

  return { disclaimer: DISCLAIMER, params, steps: collapsed };
}
