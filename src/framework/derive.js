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
  // Groups read earlier groups' outputs through this guard: a key nothing has
  // produced yet is a wiring mistake (group order / typo), and silently reading
  // undefined would surface as NaN geometry far downstream — throw here instead.
  // (Builds still receive the plain merged object, unguarded.)
  const guard = new Proxy(d, {
    get(t, key) {
      if (typeof key === "string" && key !== "then" && !(key in t)) {
        throw new Error(`derive: group read "${key}" before any earlier group produced it`);
      }
      return Reflect.get(t, key);
    },
  });
  for (const fn of Object.values(derive)) Object.assign(d, fn(p, guard) ?? {});
  return d;
}
