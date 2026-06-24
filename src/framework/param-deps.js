// Which raw parameters affect the parts on screen in the active view. A removable
// relevance layer: the panel uses this to dim controls / hide sections that don't
// affect what's visible. Pure — no DOM, no real geometry (reuses the geometry-free
// probe kernel). Errs toward RELEVANT_ALL whenever it can't analyze a build.
import { createProbeKernel } from "./geometry/probe.js";
import { viewSubParts } from "./jobs.js";

export const RELEVANT_ALL = Symbol("relevant-all");

// A read-recording Proxy over a shallow clone of `obj`: records each top-level
// property key read into `seen`, returns the real value so the build's conditionals
// evaluate correctly, and never mutates the original `obj` (writes hit the clone).
function recorder(obj, seen) {
  return new Proxy({ ...obj }, {
    get(target, key) {
      if (typeof key === "string") seen.add(key);
      return Reflect.get(target, key);
    },
  });
}

export function relevantParamKeys(part, view, params) {
  try {
    const relevant = new Set();

    // derive: record which raw params feed it; produce real derived values once.
    const deriveInputs = new Set();
    const derived = part.derive ? (part.derive(recorder(params, deriveInputs)) ?? {}) : {};

    // gate params: a param read by a view sub-part's enabled() changes what's on screen.
    for (const name of Object.keys(part.parts)) {
      const sp = part.parts[name];
      if (sp.views.includes(view) && sp.enabled) sp.enabled(recorder(params, relevant));
    }

    // direct build reads across the on-screen (enabled) sub-parts.
    const { kernel } = createProbeKernel();
    let anyDerivedRead = false;
    for (const name of viewSubParts(part, view, params)) {
      const dSeen = new Set();
      part.parts[name].build(kernel, recorder(params, relevant), recorder(derived, dSeen));
      if (dSeen.size > 0) anyDerivedRead = true;
    }
    if (anyDerivedRead) for (const k of deriveInputs) relevant.add(k);

    return relevant;
  } catch {
    return RELEVANT_ALL; // couldn't analyze — treat everything as relevant
  }
}

// Per-sub-part version of relevantParamKeys: which raw params each ON-SCREEN
// sub-part of the active view reads. Used by Layer 1 (mount.js) to skip
// regenerating sub-parts whose inputs are unchanged. Errs to RELEVANT_ALL on any
// analysis failure (caller then treats every param as relevant — safe, just slower).
export function subPartReadKeys(part, view, params) {
  try {
    const deriveInputs = new Set();
    const derived = part.derive ? (part.derive(recorder(params, deriveInputs)) ?? {}) : {};
    const { kernel } = createProbeKernel();
    const map = new Map();
    for (const name of viewSubParts(part, view, params)) {
      const sp = part.parts[name];
      const reads = new Set();
      const dSeen = new Set();
      if (sp.enabled) sp.enabled(recorder(params, reads)); // gate params change presence too
      sp.build(kernel, recorder(params, reads), recorder(derived, dSeen));
      if (dSeen.size > 0) for (const k of deriveInputs) reads.add(k);
      map.set(name, reads);
    }
    return map;
  } catch {
    return RELEVANT_ALL;
  }
}

// Stable string of the given param keys' current values — the cache-validity key
// for one sub-part. Sorted so key order never affects the result.
export function relevanceHash(keys, params) {
  return JSON.stringify(keys.slice().sort().map((k) => [k, params[k]]));
}
