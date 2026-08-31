// Group 10 — vector-art call well-formedness, plus vector-control wiring. The
// three call rules catch conditions that throw at build time anyway; they move
// them ahead of the kernel boot, which is where an authoring agent wants them.
// The fourth (vector-control-not-in-vectors) catches the one shape that never
// throws at all — a picker wired to nothing.
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
import { vectorControlAllows } from "../vector-source.js";

const declaredVectors = (part) => Object.keys(part?.vectors ?? {});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A URL-shaped sentinel (has a "://"), not an arbitrary string — some `vectors`
// functions run `new URL(v)` or similar on the value before deciding whether to
// use it, and an arbitrary string would make that throw and short-circuit the
// probe for reasons that have nothing to do with whether the key is read. Same
// device, and the same reason, as rules-images.js's.
const SENTINEL = "pf-lint-sentinel://vector-control-not-in-vectors";

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
      // Only a STATIC `vectors` object has statically-knowable names. A
      // function's return value depends on params lint doesn't enumerate, and
      // `Object.keys(fn)` is `[]` — without this guard every k.vector2d call in
      // a function-form part reports as unknown, and since `partforge measure`
      // runs lint first, the part cannot be measured at all. Exactly the guard
      // rules-fonts.js and rules-images.js already carry; the function form of
      // `vectors` arrived after this rule and nobody carried it across.
      // vector-control-not-in-vectors below is what covers the function form.
      if (typeof part?.vectors === "function") return [];
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
      // Keyed by JSON.stringify([name, shape]) — a JSON array literal cannot be
      // produced by any other (name, shape) pairing, so two distinct pairings can
      // never collide even though both halves are arbitrary author-chosen strings.
      // Same pairing repeated across calls reports once; a DIFFERENT bad shape
      // name on the same vector still reports separately.
      const seen = new Set();
      const out = [];
      for (const call of vectorCalls(probe)) {
        const name = literalName(call.args[0]);
        const opts = optsOf(call.args[1]);
        if (name == null || opts == null || typeof opts.shape !== "string") continue;
        const key = JSON.stringify([name, opts.shape]);
        if (seen.has(key)) continue;
        const doc = Object.hasOwn(vectorDocs, name) ? vectorDocs[name] : null;
        const shapes = doc?.shapes;
        if (!shapes || typeof shapes !== "object" || Array.isArray(shapes)) continue;
        if (Object.hasOwn(shapes, opts.shape)) continue;
        seen.add(key);
        out.push(err("vector-unknown-shape",
          `k.vector2d("${name}", { shape: "${opts.shape}" }) names a shape "${opts.shape}" that "${name}" does not contain: ${Object.keys(shapes).join(", ") || "(none)"}`,
          "Fix the shape name to match one the file declares, or omit `shape` to use the role-composed result — every \"add\" shape unioned, minus every \"subtract\" shape.",
          "build"));
      }
      return out;
    },
  },
  {
    // The vectors twin of image-control-not-in-images / font-control-not-in-fonts:
    // a `type: "vector"` control whose key never reaches `vectors:` changes a
    // param and nothing else — the artwork never moves — and without this the
    // mistake only shows up at build time, or not at all.
    //
    // It covers BOTH shapes of the mistake, because for vectors both are real:
    // a static `vectors` object provably cannot read a param, so a vector
    // control beside one is inert by construction (font-control-not-in-fonts's
    // question); and a function-form `vectors` that simply never returns the
    // picked value is inert too, which can only be established by calling it
    // with a sentinel (image-control-not-in-images's question). Together with
    // vector-unknown-name — which runs only for the static form — every part
    // shape is judged by exactly one of the two rules.
    id: "vector-control-not-in-vectors",
    run: ({ part, p }) => {
      const controls = vectorControlAllows(part);
      if (controls.size === 0) return [];
      const isFn = typeof part?.vectors === "function";
      // A function may wrap the picked value (`new URL(p.art)`) rather than
      // pass it through, so match on the sentinel appearing in the value, not
      // on identity.
      const mentions = (v) => (typeof v === "string" || v instanceof URL) && String(v).includes(SENTINEL);
      const out = [];
      for (const key of controls.keys()) {
        if (isFn) {
          let resolved;
          try { resolved = part.vectors({ ...p, [key]: SENTINEL }); }
          catch { continue; } // can't be probed safely — not evidence either way
          if (isPlainObject(resolved) && Object.values(resolved).some(mentions)) continue;
          out.push(err("vector-control-not-in-vectors",
            `control "${key}" is a vector picker, but this part's \`vectors\` function never returns the picked value — the picked value is never resolved.`,
            `Reference p.${key} from vectors, e.g. vectors: (p) => ({ ${key}: p.${key} }), and consume it with k.vector2d("${key}", { width: 20 }).`,
            "vectors"));
          continue;
        }
        out.push(err("vector-control-not-in-vectors",
          `control "${key}" is a vector picker, but this part's \`vectors\` is ${part?.vectors ? "a static object" : "missing"} — the picked value is never resolved.`,
          `Declare vectors as a function of params, e.g. vectors: (p) => ({ ${key}: p.${key} }), and reference it with k.vector2d("${key}", { width: 20 }).`,
          "vectors"));
      }
      return out;
    },
  },
];
