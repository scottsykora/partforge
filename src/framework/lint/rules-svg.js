// Group 10 — vector-art call well-formedness. Both conditions throw at build
// time anyway; these rules move them ahead of the kernel boot, which is where an
// authoring agent wants them.
//
// Both are conservative in the same way rules-imports.js is: only LITERAL
// arguments are judged. A name computed from a param, or an options object
// passed by reference, carries no statically-visible answer, and guessing would
// produce false errors on good parts. Those cases still fail correctly at build
// time — this catches the common case early, it does not replace that authority.
import { err } from "./finding.js";

const declaredSvgs = (part) => Object.keys(part?.svgs ?? {});

// A name is only knowable when it is a string literal — which JSON.parse
// recognizes and nothing else does (import-unknown-name reads its name the same way).
const literalName = (src) => {
  try { const v = JSON.parse(src); return typeof v === "string" ? v : null; } catch { return null; }
};

const svgCalls = (probe) => probe().calls.filter((c) => c.scope === "kernel" && c.op === "svg2d");

export const SVG_RULES = [
  {
    id: "svg-unknown-name",
    run: ({ part, probe }) => {
      const known = new Set(declaredSvgs(part));
      const seen = new Set();
      const out = [];
      for (const call of svgCalls(probe)) {
        const name = literalName(call.args[0]);
        if (name == null || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("svg-unknown-name",
          `build calls k.svg2d with name "${name}", which the part's svgs field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the ingested artwork under svgs: { name: source }, or fix the name to match an existing entry.",
          "svgs"));
      }
      return out;
    },
  },
  {
    id: "svg-size-missing",
    run: ({ probe }) => {
      const out = [];
      for (const call of svgCalls(probe)) {
        const opts = call.args[1]?.trim();
        if (opts != null && !opts.startsWith("{")) continue;      // not a literal — skip
        // `opts` is a probe call arg — JSON.stringify of the resolved options
        // object (see probe.js's `describe()`), not JS source text — so an
        // object key is quoted: `{"width":10}`, not `{ width: 10 }`. The
        // optional `"?` accounts for that; without it this never matches a
        // real call and every k.svg2d call would misreport as size-missing.
        if (opts && /\b(width|height|fit)"?\s*:/.test(opts)) continue;
        const name = literalName(call.args[0]) ?? "…";
        out.push(err("svg-size-missing",
          `k.svg2d("${name}", …) declares no size — one of { width }, { height }, or { fit } is required, in millimetres`,
          "An artwork's units have no physical meaning, so there is no safe default to fall back on (unlike k.text2d's cap-height `size`). "
          + `Add one, e.g. k.svg2d("${name}", { width: 20 }).`,
          "build"));
      }
      return out;
    },
  },
];
