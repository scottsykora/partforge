// PURE heuristic linking a measured dimension to the schema param driving it.
// Candidates come from the sub-part's read keys (param-deps.subPartReadKeys,
// resolved by the caller); a candidate links when its current value matches a
// measured value within the display quantum (0.01), or at value*2 for
// radius-style params against measured diameters. Unique match or nothing —
// never guess between two.
const QUANTUM = 0.005; // half the 0.01 display quantum: |a-b| < 0.005 rounds equal

export function linkParam(keys, params, values) {
  const measured = Object.entries(values)
    .filter(([k, v]) => typeof v === "number" && k !== "partial")
    .map(([, v]) => v);
  const matches = new Set();
  for (const key of keys) {
    const pv = params[key];
    if (typeof pv !== "number") continue;
    for (const mv of measured) {
      if (Math.abs(pv - mv) < QUANTUM) { matches.add(key); break; }
      if ("diameter" in values && Math.abs(pv * 2 - values.diameter) < QUANTUM * 2) { matches.add(key); break; }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}
