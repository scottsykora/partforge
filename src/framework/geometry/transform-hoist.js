// Pure suffix-matching for boolean transform hoisting. A solid carries the trailing
// transform chain applied to its canonical base (`canon.chain`, oldest first, so the
// LAST record is the outermost transform). Booleans commute with any invertible
// affine map, so a transform every operand ends with can be lifted out of the boolean
// and applied to its result instead — which is what lets 30 identically-built cells
// share ONE evaluated union instead of 30.
//
// Matching is SYMBOLIC (compare the recorded arguments), never numeric: deriving a
// residual as X⁻¹·xᵢ would make rotations disagree in the last bits from copy to copy
// and the hoist would silently stop firing. Comparing arguments is exact.

const same = (a, b) => {
  if (a.op !== b.op) return false;
  if (a.op === "translate") return vecEq(a.v, b.v);
  return a.deg === b.deg && vecEq(a.center, b.center) && vecEq(a.axis, b.axis);
};
const vecEq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export function hoistCommonSuffix(chains) {
  const rest = chains.map((c) => c.slice());
  const hoisted = [];
  for (;;) {
    if (rest.some((c) => c.length === 0)) break;
    const last = rest.map((c) => c[c.length - 1]);
    if (last.every((r) => same(r, last[0]))) {
      hoisted.unshift(last[0]);
      for (const c of rest) c.pop();
      continue;
    }
    // Trailing translations that DISAGREE still share a common part, and splitting it
    // out is what the grid case needs: a cell's hub ends .at([cx,cy,0]) while its
    // support ends .at([cx,cy,z]), so exact matching alone would hoist nothing.
    // Translations commute, so translate(vᵢ) = translate(v₀) ∘ translate(vᵢ−v₀), and
    // subtracting shared coordinates is exact. Splitting leaves a translate behind on
    // every other operand, so nothing deeper can match — this always ends the loop.
    if (!last.every((r) => r.op === "translate")) break;
    const v0 = last[0].v;
    for (const [i, c] of rest.entries()) {
      const d = [last[i].v[0] - v0[0], last[i].v[1] - v0[1], last[i].v[2] - v0[2]];
      c.pop();
      if (d[0] !== 0 || d[1] !== 0 || d[2] !== 0) c.push({ op: "translate", v: d });
    }
    hoisted.unshift({ op: "translate", v: v0 });
    break;
  }
  return { hoisted, residuals: rest };
}
