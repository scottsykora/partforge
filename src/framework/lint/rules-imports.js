// Group 5 — geometry-import well-formedness. Each condition here is a static
// early-catch for something that otherwise throws only later: `k.import()` on
// an undeclared name throws mid-build (kernel.js), a declared mesh import
// under an OCCT-routed part throws lazily from the `{error}` registration
// entry the first time `k.import` reads it (imports.js), an unknown
// `reference` breaks the deviation gate silently (measure.js just reports no
// deviation), and a `ref*` verify metric with no `reference` always reports
// status "skip" (verify-metrics.js) rather than the gate the author intended.
//
// `import-mesh-on-occt` is deliberately conservative: only extension-detectable
// sources (a `URL` or a string path) are checked. Bytes and thunks carry no
// format information without actually resolving them, which lint — geometry-
// free and synchronous — cannot do; those cases (and any per-sub-part routing
// split a whole-part `detectBackend` can't see) still fail correctly at build
// time via imports.js's lazy `{error}` entry. This rule exists to catch the
// common case early, not to replace that runtime authority.
import { err, warn } from "./finding.js";
import { detectBackend } from "../backend-select.js";
import { SUBPART_METRICS } from "../verify-metrics.js";

const MESH_EXT = /\.(stl|3mf)$/i;

const REF_METRICS = new Set(Object.keys(SUBPART_METRICS).filter((k) => k.startsWith("ref")));

const declaredImports = (part) => Object.keys(part?.imports ?? {});

// Only URL/string sources carry a statically-visible extension; a thunk or raw
// bytes source is skipped (see file header).
const meshDeclared = (part) => Object.entries(part?.imports ?? {}).filter(([, src]) => {
  const path = src instanceof URL ? src.pathname : typeof src === "string" ? src.split("?")[0] : null;
  return path != null && MESH_EXT.test(path);
});

export const IMPORT_RULES = [
  {
    id: "import-unknown-name",
    run: ({ part, probe }) => {
      const known = new Set(declaredImports(part));
      const seen = new Set();
      const out = [];
      for (const call of probe().calls) {
        if (call.scope !== "kernel" || call.op !== "import") continue;
        let name;
        try { name = JSON.parse(call.args[0]); } catch { name = null; }
        if (typeof name !== "string" || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("import-unknown-name",
          `build calls k.import with name "${name}", which the part's imports field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the file under imports: { name: source }, or fix the name to match an existing entry.",
          "imports"));
      }
      return out;
    },
  },
  {
    id: "import-mesh-on-occt",
    run: ({ part, p }) => {
      const mesh = meshDeclared(part);
      if (mesh.length === 0 || detectBackend(part, p) !== "occt") return [];
      const cause = part?.meta?.backend === "occt"
        ? "meta.backend forces OCCT"
        : "a fillet/chamfer/shell op routes this part to OCCT";
      return mesh.map(([name]) => err("import-mesh-on-occt",
        `import "${name}" is a mesh (STL/3MF) but ${cause} — mesh imports need the Manifold backend`,
        "Move the mesh import into a Manifold-routed part, replace it with a STEP source, or drop the CAD-only op / meta.backend pin.",
        "imports"));
    },
  },
  {
    id: "reference-unknown",
    run: ({ part }) => {
      const known = new Set(declaredImports(part));
      return Object.entries(part?.parts ?? {})
        .filter(([, sp]) => sp?.reference && !known.has(sp.reference))
        .map(([name, sp]) => err("reference-unknown",
          `sub-part "${name}" declares reference: "${sp.reference}" but no such import exists`,
          "reference must name a key of the part's imports field.",
          `parts.${name}.reference`));
    },
  },
  {
    id: "ref-metric-without-reference",
    // Deliberately resolves function-form `verify.expect` via `resolveExpectOnce()`
    // (same memoized, try/caught call the Group 4 verify rules share) rather than
    // skipping it — the plan's anchor guarded with a bare `typeof expect ===
    // "object"` check on the assumption a function-form `expect` "can't be
    // inspected statically", but `resolveExpectOnce()` already does exactly that
    // inspection safely (a throw is reported separately by `verify-expect-throws`
    // and short-circuits here via `!expect`). A ref* metric surfaced from a
    // function-form expect with no `reference` is just as real a finding as one
    // from the static-object form, so skipping it would be a false negative, not
    // caution.
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const names = new Set(Object.keys(part?.parts ?? {}));
      return Object.entries(expect)
        // `sub` must name a real sub-part — a typo'd name is already reported by
        // `verify-unknown-subpart`; skip it here so the two rules don't double-report
        // the same typo under two different ids.
        .filter(([sub, metrics]) => sub !== "_view" && names.has(sub) && metrics && typeof metrics === "object" &&
          Object.keys(metrics).some((k) => REF_METRICS.has(k)) && !part?.parts?.[sub]?.reference)
        .map(([sub]) => warn("ref-metric-without-reference",
          `verify.expect.${sub} uses a ref* metric but sub-part "${sub}" declares no reference`,
          `Add reference: "<import name>" to sub-part "${sub}", or the ref* checks always report status "skip".`,
          `verify.expect.${sub}`));
    },
  },
];
