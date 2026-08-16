// Chooses which geometry backend (manifold vs occt) a part should build against.
// This is framework-level policy, not geometry-kernel plumbing: it knows the full
// PartDefinition shape (meta.backend, defaults, parts[name].build), unlike
// everything in geometry/, which is part-agnostic.
import { createProbeKernel } from "./geometry/probe.js";
import { isZeroMagnitudeCadOp } from "./geometry/op-options.js";
import { resolveDerived } from "./derive.js";

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  let d = {};
  // A throwing derive must not escape here — this runs on the main thread mid
  // regen (after the busy spinner goes up). Probe with an empty `d`; the worker
  // build hits the same throw and posts a proper error for the UI.
  try { d = resolveDerived(part, p); } catch { /* fall through with d = {} */ }
  const { kernel, cadCalls } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  // cadCalls holds only Solid-handle fillet/chamfer/shell — `Shape2D.fillet`/
  // `.chamfer` are the shared pure-JS implementation (backend-identical) and must
  // not drag a part onto OCCT. A provably zero magnitude is the identity (see
  // KERNEL-CONTRACT.md) and doesn't route either, so a fillet param dialed to 0
  // drops the part back onto Manifold with no `if (r > 0)` guard in the build.
  for (const { op, args } of cadCalls) {
    if (!isZeroMagnitudeCadOp(op, args)) return "occt";
  }
  return "manifold";
}

// The mount-time backend chooser. detectBackend() re-runs per regen with live
// params, so backend choice already follows the parameters in both directions —
// this wrapper exists for the runtime backstop: when the probe under-detects
// (a CAD-only call it can't reach — e.g. gated on a real geometry query the
// probe answers with dummies) the Manifold build throws NEEDS_OCCT and the
// worker asks for a reroute. That must not pin OCCT for the rest of the session,
// or turning the OCCT-only feature off never reverts to Manifold. Instead the
// reroute is latched per params snapshot: the exact params that failed skip the
// doomed Manifold retry, and ANY param change re-consults the probe. A part the
// probe chronically under-detects costs one cheap failed Manifold dispatch per
// param change — the price of automatic reversion.
export function createBackendPolicy(part, { forced = null } = {}) {
  let latchedParams = null; // JSON snapshot of the params proven at runtime to need OCCT
  return {
    backendFor: (params) => forced
      ?? (latchedParams !== null && latchedParams === JSON.stringify(params)
        ? "occt"
        : detectBackend(part, params)),
    noteNeedsOcct: (params) => { latchedParams = JSON.stringify(params); },
  };
}
