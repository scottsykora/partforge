// Group 10 — vector-art call well-formedness. Both conditions throw at build
// time anyway; these rules move them ahead of the kernel boot, which is where an
// authoring agent wants them.
//
// Both read `probe().calls`, whose `args` are JSON.stringify of the RESOLVED
// argument values under the part's default params (probe.js's `describe`), not
// source text. So these judge what the part actually builds by default — the
// same basis rules-imports.js's import-unknown-name already uses. A call that
// only goes wrong for non-default params is not caught here and still fails
// correctly at build time; this catches the common case early, it does not
// replace that authority.
//
// Because values are JSON-serialized, an options object arrives as
// `{"width":10}` — note the quote before the colon, which the size regex has to
// tolerate.
import { err } from "./finding.js";

const declaredVectors = (part) => Object.keys(part?.vectors ?? {});

// The name arrives JSON-serialized, so JSON.parse recovers it — and yields null
// for anything that is not a string (import-unknown-name reads its name the same way).
const literalName = (src) => {
  try { const v = JSON.parse(src); return typeof v === "string" ? v : null; } catch { return null; }
};

const vectorCalls = (probe) => probe().calls.filter((c) => c.scope === "kernel" && c.op === "vector2d");

export const VECTOR_RULES = [
  {
    id: "vector-unknown-name",
    run: ({ part, probe }) => {
      const known = new Set(declaredVectors(part));
      const seen = new Set();
      const out = [];
      for (const call of vectorCalls(probe)) {
        const name = literalName(call.args[0]);
        if (name == null || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("vector-unknown-name",
          `build calls k.vector2d with name "${name}", which the part's vectors field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the ingested artwork under vectors: { name: source }, or fix the name to match an existing entry.",
          "vectors"));
      }
      return out;
    },
  },
  {
    id: "vector-size-missing",
    run: ({ probe }) => {
      const out = [];
      for (const call of vectorCalls(probe)) {
        const opts = call.args[1]?.trim();
        if (opts != null && !opts.startsWith("{")) continue;      // not an object — skip
        // `"?` because probe args are JSON-serialized: `{"width":10}`, not `{ width: 10 }`.
        if (opts && /\b(width|height|fit)"?\s*:/.test(opts)) continue;
        const name = literalName(call.args[0]) ?? "…";
        out.push(err("vector-size-missing",
          `k.vector2d("${name}", …) declares no size — one of { width }, { height }, or { fit } is required, in millimetres`,
          "An artwork's units have no physical meaning, so there is no safe default to fall back on (unlike k.text2d's cap-height `size`). "
          + `Add one, e.g. k.vector2d("${name}", { width: 20 }).`,
          "build"));
      }
      return out;
    },
  },
];
