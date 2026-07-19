// The backend-shared kernel front. Each backend builds its primitive mapping and
// returns finishKernel(kernel), which layers on everything that is NOT
// backend-specific:
//   - the options-object calling convention (op-options.js): one wrapper per
//     factory op normalizes an options-form call to positional args, then runs
//     the op's semantic check on the normalized args (both calling forms), then
//     calls the raw backend op — so backends stay positional and the solid
//     cache hashes normalized args;
//   - default compound-op compositions — a backend only overrides one when it has
//     a reason to (Manifold's boredCylinder hashes atomically for its solid cache);
//   - a KernelCapabilityError stub for toSTEP / shape2d when the backend lacks that
//     capability (OCCT can't do shape2d; Manifold can't do toSTEP).
// The per-Solid twin of this layer is addSugar() in solid-sugar.js.
import { KernelCapabilityError } from "./errors.js";
import { isPlainOptions, KERNEL_OP_SPECS } from "./op-options.js";

export function finishKernel(k) {
  // Compound default: bored-through cylinder (tool overshoots 2 mm each end for
  // a clean cut). Assigned BEFORE the wrap loop so the fallback composition gets
  // the same key validation as a backend-native override.
  k.boredCylinder ??= ({ od, h, bore }) =>
    k.cylinder(od / 2, od / 2, h).cut(k.cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2]));

  for (const [op, { toArgs, check }] of Object.entries(KERNEL_OP_SPECS)) {
    const raw = k[op];
    if (!raw) continue;
    k[op] = (...a) => {
      const pos = a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0]) : a;
      check?.(...pos);
      return raw(...pos);
    };
  }

  k.toSTEP ??= () => { throw new KernelCapabilityError("toSTEP requires the OCCT backend"); };
  k.shape2d ??= () => { throw new KernelCapabilityError("shape2d requires the Manifold backend"); };

  return k;
}
