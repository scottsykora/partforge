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
// CANDIDATE ATTEMPTS, not raw boolean calls — see the loop's own comment below for
// exactly what one attempt costs in real booleans, which varies by case — and running
// out DEGRADES INTO RESIDUAL rather than throwing: an over-budget describe returns a
// partial, honestly-scored report, which is exactly what a caller can act on.
//
// CONFIDENCE IS THE GAIN. A feature's confidence is the marginal xor reduction that
// admitted it, not a separate estimate invented afterwards. That is what makes the
// number falsifiable — it is a measurement of how much of the part that feature
// explains.
//
// The ONLY kernel-touching file in describe/.

// Named for what it actually counts (see the loop's own comment): CANDIDATE ATTEMPTS,
// not boolean operations. One attempt costs 0-2 real booleans depending on the
// candidate's op and whether a base body exists yet, so this is a bound on search
// WORK, not a boolean-op budget a caller could size against a WASM-call cost model.
export const DEFAULT_ATTEMPT_BUDGET = 48;
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
  const budget = opts.budget ?? DEFAULT_ATTEMPT_BUDGET;
  const sourceVolume = source.volume();
  const accepted = [];
  // Counts CANDIDATE ATTEMPTS (one per pass through the `for` loop below), not real
  // boolean calls — see that loop's own comment for the exact per-attempt cost, which
  // is 0, 1, or 2 real booleans depending on the candidate's op and whether `current`
  // is null. Reported back as `budgetSpent` (name kept as-is — see that field's own
  // comment on why) rather than renamed to `attemptsSpent`.
  let attempts = 0;
  // Every candidate object that reached the loop body at least once — keyed by
  // reference, not by `cand.key`/`cand.featureKey`, since this file never assumes a
  // candidate carries either (test/describe-accept.test.js's own fixtures only give
  // theirs a bare `key`, and other callers may give none at all). This is what lets a
  // caller (describe.js) tell "budget ran out before this candidate ever got a turn"
  // apart from "this candidate got a turn — every round it was in — and never won
  // one" for whatever's left in `pending` at the end (fix round 2, IMPORTANT 2): a
  // rejected feature and a budget-starved one both report `volumeShare: null` and
  // are otherwise indistinguishable, which matters to a rebuilder deciding whether to
  // retry with a bigger `--budget` or accept that a feature genuinely doesn't fit.
  // NOTE on the one case this deliberately does NOT collapse (round 3 CRITICAL fix): a
  // `cut` candidate that gets a turn while `current === null` (`"nothing to cut from
  // yet"`, below) never has a gain computed for it, so it is NOT added here — only a
  // candidate that actually ran a boolean (a real gain measurement) or whose `.build()`
  // genuinely threw counts as attempted. Earlier this Set included the no-base-yet case
  // too, which made a starved `--budget` report `"rejected"` for a feature the search
  // simply never reached with a base to cut from — provably wrong, since raising the
  // budget alone (no code change) turned that same feature into a real, positive share.
  const attempted = new Set();

  // The single bracket. `describe:accept` is deliberately its own partition name, not a
  // display sub-part's: the cross-partition hash index still lets it ADOPT geometry the
  // viewer already built, while its own eviction at end() cannot throw away what the
  // viewer is showing. Same reasoning as oracle/build.js's `oracle:view:` naming.
  kernel.beginSubPart?.("describe:accept");
  try {
    let current = null;                  // the reconstruction so far
    let currentXor = sourceVolume;       // an empty reconstruction differs by the whole part
    const pending = [...candidates];

    while (pending.length && attempts < budget) {
      let best = null;
      for (const cand of pending) {
        if (attempts >= budget) break;
        // Real boolean cost of THIS attempt, not the `attempts` counter below (that
        // counts the attempt itself, always by 1, regardless of how many WASM
        // booleans it took) — spelled out here because it is not uniform and a
        // reader sizing the budget against boolean-call cost needs the real number:
        //   • op "cut",   current === null → 0 booleans (trial is set to null with
        //     no kernel call at all — "nothing to cut from yet" — and skipped below)
        //   • op "union", current === null → 1 boolean (no union call needed either,
        //     trial IS piece; the only boolean is xorVolume's own intersect below)
        //   • either op,  current !== null → 2 booleans (the cut/union that builds
        //     `trial`, plus xorVolume's intersect)
        // So budget=N bounds attempts, and — once any candidate has been accepted,
        // which is the common case for a multi-feature part — real boolean work at
        // roughly 2N, not N. Verified directly: a 4-candidate, 2-op-type search
        // (1 accepted union then 1 accepted cut) reports `budgetSpent: 9` against
        // 12 real boolean calls counted by wrapping the kernel.
        let trial;
        let noBaseYet = false;               // "nothing to cut from yet" — no gain measured
        try {
          const piece = cand.build();
          if (current === null && cand.op === "cut") {
            trial = null;
            noBaseYet = true;
          } else {
            trial = current === null ? piece
              : cand.op === "cut" ? current.cut(piece)
              : current.union(piece);
          }
        } catch {
          // A candidate whose geometry will not build is not an error — it is simply
          // not a description of this mesh. Drop it and keep going.
          trial = null;
        }
        attempts++;
        // Only count this as a real attempt (accept.js's own contract with describe.js
        // — see the Set's declaration comment) when a gain was actually measured or the
        // candidate's own geometry genuinely failed to build. `noBaseYet` is neither: no
        // boolean ever ran and no verdict was reached, so leaving it out of `attempted`
        // is what lets describe.js report `"budget"` instead of `"rejected"` for a cut
        // candidate that only ever got a turn before any base body existed — round 3's
        // CRITICAL finding: with the old blanket `attempted.add(cand)` above, THIS is
        // exactly the case that reported `"rejected"` (`--budget 2`, the washer fixture)
        // for a feature that becomes a real 19% share at `--budget 3` — the search never
        // rejected it, it just never got there.
        if (!noBaseYet) attempted.add(cand);
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
      // Candidate attempts, not real boolean calls — see `attempts`'s own comment
      // above and the per-attempt cost breakdown in the loop. Kept as `budgetSpent`
      // (not renamed to `attemptsSpent`) because it is a documented cross-task
      // interface field T12's orchestrator consumes by this exact name (SDD
      // progress ledger, T10→T12 interface row); the field's MEANING is what moved,
      // not its shape, so a rename here would be a breaking, undocumented surprise
      // for that consumer rather than a fix.
      budgetSpent: attempts,
      budgetExceeded: attempts >= budget && pending.length > 0,
      // Candidate OBJECTS (not keys) that reached at least one build+evaluate attempt
      // — see this Set's own declaration comment above for why by-reference and what
      // it does and doesn't distinguish. Every accepted candidate is trivially a
      // member too (it can't have been accepted without at least one attempt); the
      // caller only needs to consult this for candidates NOT in `accepted`.
      attempted,
    };
  } finally {
    kernel.endSubPart?.();
  }
}
