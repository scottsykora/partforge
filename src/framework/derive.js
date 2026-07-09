// Resolve a part's `derive` into the derived-values object `d` that builds receive.
//
// Two authoring forms:
//   derive: (p) => d                      — one function, computed in a single pass.
//   derive: { name: (p, d) => {...}, … }  — named GROUPS, run in declaration order;
//     each group gets the params plus the merged outputs of the groups before it.
// The grouped form exists so the relevance layer (param-deps.js) can attribute each
// derived value to just its own group's inputs instead of every param derive touches.
export function resolveDerived(part, p) {
  const derive = part.derive;
  if (!derive) return {};
  if (typeof derive === "function") return derive(p) ?? {};
  const d = {};
  for (const fn of Object.values(derive)) Object.assign(d, fn(p, d) ?? {});
  return d;
}
