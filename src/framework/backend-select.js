// Chooses which geometry backend (manifold vs occt) a part should build against.
// This is framework-level policy, not geometry-kernel plumbing: it knows the full
// PartDefinition shape (meta.backend, defaults, parts[name].build), unlike
// everything in geometry/, which is part-agnostic.
import { OCCT_ONLY_OPS } from "./geometry/kernel.js";
import { createProbeKernel } from "./geometry/probe.js";
import { resolveDerived } from "./derive.js";

const OCCT_ONLY = new Set(OCCT_ONLY_OPS);

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  let d = {};
  // A throwing derive must not escape here — this runs on the main thread mid
  // regen (after the busy spinner goes up). Probe with an empty `d`; the worker
  // build hits the same throw and posts a proper error for the UI.
  try { d = resolveDerived(part, p); } catch { /* fall through with d = {} */ }
  const { kernel, used } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  for (const op of used) if (OCCT_ONLY.has(op)) return "occt";
  return "manifold";
}
