// Geometry-free pose probe over a view — see pose-probe-core.js for the probe
// session itself and the trust model. This wrapper resolves params/derive and
// walks the view's sub-parts; it stays separate so lint can import the core
// without dragging in jobs.js (purity).
import { probeSubPartPose } from "./pose-probe-core.js";
import { viewSubParts, resolveParams } from "./jobs.js";

// Probe every subpart the view shows. Never throws; a failing/queried/weird
// subpart yields { trusted: false } and the others still probe.
export function probePoses(part, view, params) {
  const out = new Map();
  let resolved;
  try { resolved = resolveParams(part, params); }
  catch {
    for (const name of viewSubParts(part, view, params)) out.set(name, { trusted: false });
    return out;
  }
  const { p, d } = resolved;
  for (const name of viewSubParts(part, view, params)) {
    out.set(name, probeSubPartPose(part.parts[name], { view, purpose: "display", p, d }));
  }
  return out;
}
