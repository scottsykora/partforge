// PURE heuristic linking a measured dimension to the schema param driving it.
// Candidates come from the sub-part's read keys (param-deps.subPartReadKeys,
// resolved by the caller); a candidate links when its current value matches a
// measured value within the display quantum (0.01), or at value*2 for
// radius-style params against measured diameters. Unique match or nothing —
// never guess between two.
const QUANTUM = 0.005; // half the 0.01 display quantum: |a-b| < 0.005 rounds equal

// Every candidate whose current value matches a measured value (or matches
// diameter at value*2, the radius-style rule) — the set a measurement click
// flashes. linkParam keeps the stricter unique-or-nothing rule for focus.
export function paramMatches(keys, params, values) {
  const measured = Object.entries(values)
    .filter(([k, v]) => typeof v === "number" && k !== "partial")
    .map(([, v]) => v);
  const hasDiameter = "diameter" in values;
  const matches = new Set();
  for (const key of keys) {
    const pv = params[key];
    if (typeof pv !== "number") continue;
    for (const mv of measured) {
      if (Math.abs(pv - mv) < QUANTUM) { matches.add(key); break; }
      if (hasDiameter && Math.abs(pv * 2 - values.diameter) < QUANTUM) { matches.add(key); break; }
    }
  }
  return [...matches];
}

export function linkParam(keys, params, values) {
  const matches = paramMatches(keys, params, values);
  return matches.length === 1 ? matches[0] : null;
}
