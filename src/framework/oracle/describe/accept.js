// The confirm half of propose-then-confirm (spec §2.8). Segmentation and the feature
// rules produce CANDIDATES; this decides which are real, in what order, and how sure
// we are — by building each one and measuring it against the source mesh.
//
// Three properties are load-bearing.
//
// ONE CACHE BRACKET. geometry/solid-cache.js scopes retention to the current build's
// graph: each begin()/end() pair rebuilds the retained set and DISPOSES anything not
// re-used that round. A search loop that opened a bracket per candidate would evict its
// own shared subtrees on every iteration — quadratic rebuilds and WASM churn on a part
// that should be nearly free. So the whole loop runs inside exactly one bracket, and
// every candidate's geometry stays warm and shared for its duration.
//
// HARD BUDGET. Booleans are the cost centre and the candidate list is attacker-shaped
// (it grows with mesh complexity, not with anything we control). The budget counts
// boolean operations, and running out DEGRADES INTO RESIDUAL rather than throwing: an
// over-budget describe returns a partial, honestly-scored report, which is exactly what
// a caller can act on.
//
// CONFIDENCE IS THE GAIN. A feature's confidence is the marginal xor reduction that
// admitted it, not a separate estimate invented afterwards. That is what makes the
// number falsifiable — it is a measurement of how much of the part that feature
// explains.
//
// The ONLY kernel-touching file in describe/.

export const DEFAULT_BUDGET = 48;
// A candidate must explain at least this fraction of the source volume to be worth a
// line in the report. Below it, the "feature" is tessellation noise.
const MIN_GAIN_FRACTION = 1e-4;

// Symmetric-difference volume — the same measure measure.js uses for the `reference`
// deviation fact, so a describe score and a verify ref-gate are directly comparable.
// One boolean and two volume reads; no meshing, no rasterisation. `cut`/`union`/
// `intersect` are binary methods ON A SOLID (`a.intersect(b)`), not kernel-level free
// functions — kernel.js's own JSDoc has the full Solid method table; there is no
// `kernel.intersect(a, b)`. Neither operand needs `.clone()` first: unlike the OCCT
// backend (whose replicad shapes ARE consumed by a transform — see AGENTS.md),
// Manifold's boolean methods return a new solid and leave both operands live and
// reusable, exactly as measure.js's own `solid.intersect(ref).volume()` and
// assembly.js's pairwise overlap check already rely on.
function xorVolume(a, b) {
  const inter = a.intersect(b).volume();
  return a.volume() + b.volume() - 2 * inter;
}

export function acceptCandidates(kernel, source, candidates, opts = {}) {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const sourceVolume = source.volume();
  const accepted = [];
  let spent = 0;

  // The single bracket. `describe:accept` is deliberately its own partition name, not a
  // display sub-part's: the cross-partition hash index still lets it ADOPT geometry the
  // viewer already built, while its own eviction at end() cannot throw away what the
  // viewer is showing. Same reasoning as oracle/build.js's `oracle:view:` naming.
  kernel.beginSubPart?.("describe:accept");
  try {
    let current = null;                  // the reconstruction so far
    let currentXor = sourceVolume;       // an empty reconstruction differs by the whole part
    const pending = [...candidates];

    while (pending.length && spent < budget) {
      let best = null;
      for (const cand of pending) {
        if (spent >= budget) break;
        let trial;
        try {
          const piece = cand.build();
          trial = current === null
            ? (cand.op === "cut" ? null : piece)      // nothing to cut from yet
            : cand.op === "cut" ? current.cut(piece)
            : current.union(piece);
        } catch {
          // A candidate whose geometry will not build is not an error — it is simply
          // not a description of this mesh. Drop it and keep going.
          trial = null;
        }
        spent++;
        if (!trial) continue;
        const xor = xorVolume(trial, source);
        const gain = currentXor - xor;
        if (gain > sourceVolume * MIN_GAIN_FRACTION && (!best || gain > best.gain)) {
          best = { cand, trial, xor, gain };
        }
      }
      if (!best) break;                  // nothing left improves the reconstruction

      current = best.trial;
      currentXor = best.xor;
      accepted.push({
        candidate: best.cand,
        gain: best.gain / sourceVolume,          // normalised: comparable across parts
        cumulativeXor: currentXor,
        order: accepted.length,
      });
      pending.splice(pending.indexOf(best.cand), 1);
    }

    const xorFraction = sourceVolume > 0 ? currentXor / sourceVolume : 1;
    return {
      accepted,
      residual: { xorVolume: currentXor, xorFraction },
      score: {
        explainedVolumeFraction: Math.max(0, 1 - xorFraction),
        xorFraction,
        xorVolume: currentXor,
      },
      budgetSpent: spent,
      budgetExceeded: spent >= budget && pending.length > 0,
    };
  } finally {
    kernel.endSubPart?.();
  }
}
