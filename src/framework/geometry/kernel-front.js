// The backend-shared kernel front. Each backend builds its primitive mapping and
// returns finishKernel(kernel), which layers on everything that is NOT
// backend-specific:
//   - argument validation (previously copy-pasted into both backends);
//   - default compound-op compositions — a backend only overrides one when it has
//     a reason to (Manifold's boredCylinder hashes atomically for its solid cache);
//   - a KernelCapabilityError stub for toSTEP when the backend can't write B-rep.
// The per-Solid twin of this layer is addSugar() in solid-sugar.js.
import { KernelCapabilityError } from "./errors.js";

export function finishKernel(k) {
  const rawPrism = k.prism;
  k.prism = (pts, h, opts) => {
    if ((opts?.scaleTop ?? 1) < 0) throw new Error("prism: scaleTop must be ≥ 0");
    return rawPrism(pts, h, opts);
  };

  const rawExtrude = k.extrude;
  k.extrude = (profile, h, opts) => {
    if ((opts?.scaleTop ?? 1) < 0) throw new Error("extrude: scaleTop must be ≥ 0");
    return rawExtrude(profile, h, opts);
  };

  const rawRevolve = k.revolve;
  k.revolve = (pts, opts) => {
    for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
    return rawRevolve(pts, opts);
  };

  // Compound: bored-through cylinder (tool overshoots 2 mm each end for a clean cut).
  k.boredCylinder ??= ({ od, h, bore }) =>
    k.cylinder(od / 2, od / 2, h).cut(k.cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2]));

  k.toSTEP ??= () => { throw new KernelCapabilityError("toSTEP requires the OCCT backend"); };

  return k;
}
