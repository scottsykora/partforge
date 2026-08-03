// Finding constructors. The shape mirrors the diagnostics contract that verify's
// checks already satisfy (docs/AUTHORING-PARTS.md "The diagnostics contract"):
// a self-contained `hint` on every finding, plus an optional stable ERROR-PATTERNS.md
// `pattern` id. Verify's [x,y,z] `location` is replaced by `path`, an accessor path
// into the PartDefinition — nothing parses it, it is for navigation only.
const make = (severity) => (rule, message, hint, path = "", pattern) => ({
  rule, severity, message, hint, path, ...(pattern ? { pattern } : {}),
});

// error → the part is PROVABLY broken: it cannot behave as authored, whether or
// not that surfaces as a thrown exception. A dead control (control-key-not-in-
// defaults), a view that renders nothing (part-view-unknown), or a verify
// expectation that's silently dropped so its gate never runs (verify-unknown-
// subpart) build/measure/verify cleanly today and still earn error — the defect
// is real even though nothing throws. Because `measure` gates on this tier, a
// part with one of these silent defects now exits non-zero where it previously
// didn't; that's the point, not a regression.
export const err = make("error");
// warning → suspicious or lossy, but the part behaves as authored.
export const warn = make("warning");
// note → neither broken nor suspicious; informational context an authoring
// agent should see (e.g. "this animated track rebuilds geometry"). Notes never
// gate measure or --strict.
export const note = make("note");
