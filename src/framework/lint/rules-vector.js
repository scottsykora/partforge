// Group 10 — vector-art call well-formedness. All three conditions throw at
// build time anyway; these rules move them ahead of the kernel boot, which is
// where an authoring agent wants them.
//
// All read `probe().calls`, whose `args` are JSON.stringify of the RESOLVED
// argument values under the part's default params (probe.js's `describe`), not
// source text. So these judge what the part actually builds by default — the
// same basis rules-imports.js's import-unknown-name already uses. A call that
// only goes wrong for non-default params is not caught here and still fails
// correctly at build time; this catches the common case early, it does not
// replace that authority.
//
// vector-size-missing and vector-unknown-shape additionally need `ctx.vectorDocs`
// — the caller's parsed vector files (see lint/index.js's normalizeVectorDocs,
// vectors.js's resolveVectorDocs). Lint itself never reads a file (this
// package's header), so without a supplied document neither rule can tell
// units from shapes and both stay silent rather than guess.
import { err } from "./finding.js";

const declaredVectors = (part) => Object.keys(part?.vectors ?? {});

// The name arrives JSON-serialized, so JSON.parse recovers it — and yields null
// for anything that is not a string (import-unknown-name reads its name the same way).
const literalName = (src) => {
  try { const v = JSON.parse(src); return typeof v === "string" ? v : null; } catch { return null; }
};

// Probe args are JSON-serialized resolved VALUES (probe.js's `describe`), not
// source text — so an options object arrives as `{"width":10,"shape":"body"}`.
// Parsing it back is exact for the literal cases these rules judge; anything
// that does not parse to a plain object means "cannot tell", and the rule stays
// quiet rather than guessing. A missing argument (`src == null`) is not
// malformed — it means "no options object" — so it reads as `{}`, not "unknown".
const optsOf = (src) => {
  if (src == null) return {};
  try { const v = JSON.parse(src); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
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
    run: ({ probe, vectorDocs }) => {
      if (!vectorDocs) return [];                       // caller supplied nothing — cannot judge units
      const out = [];
      for (const call of vectorCalls(probe)) {
        const name = literalName(call.args[0]);
        if (name == null) continue;
        const doc = Object.hasOwn(vectorDocs, name) ? vectorDocs[name] : null;
        if (doc?.units !== "artwork") continue;         // mm files place as authored; a size is optional
        const opts = optsOf(call.args[1]);
        if (opts == null) continue;
        if (opts.width != null || opts.height != null || opts.fit != null) continue;
        out.push(err("vector-size-missing",
          `k.vector2d("${name}", …) declares no size, and "${name}" has units "artwork" — one of { width }, { height }, or { fit } is required, in millimetres`,
          "Artwork units have no physical meaning, so there is no safe default to fall back on (unlike k.text2d's cap-height `size`). "
          + `Add one, e.g. k.vector2d("${name}", { width: 20 }) — or re-author the file with "units": "mm" if its coordinates really are millimetres.`,
          "build"));
      }
      return out;
    },
  },
  {
    id: "vector-unknown-shape",
    run: ({ probe, vectorDocs }) => {
      if (!vectorDocs) return [];
      const out = [];
      for (const call of vectorCalls(probe)) {
        const name = literalName(call.args[0]);
        const opts = optsOf(call.args[1]);
        if (name == null || opts == null || typeof opts.shape !== "string") continue;
        const doc = Object.hasOwn(vectorDocs, name) ? vectorDocs[name] : null;
        const shapes = doc?.shapes;
        if (!shapes || typeof shapes !== "object" || Array.isArray(shapes)) continue;
        if (Object.hasOwn(shapes, opts.shape)) continue;
        out.push(err("vector-unknown-shape",
          `k.vector2d("${name}", { shape: "${opts.shape}" }) names a shape "${opts.shape}" that "${name}" does not contain: ${Object.keys(shapes).join(", ") || "(none)"}`,
          "Fix the shape name to match one the file declares, or omit `shape` to use the union of every shape.",
          "build"));
      }
      return out;
    },
  },
];
