// Finding constructors. The shape mirrors the diagnostics contract that verify's
// checks already satisfy (docs/AUTHORING-PARTS.md "The diagnostics contract"):
// a self-contained `hint` on every finding, plus an optional stable ERROR-PATTERNS.md
// `pattern` id. Verify's [x,y,z] `location` is replaced by `path`, an accessor path
// into the PartDefinition — nothing parses it, it is for navigation only.
const make = (severity) => (rule, message, hint, path = "", pattern) => ({
  rule, severity, message, hint, path, ...(pattern ? { pattern } : {}),
});

// error → the part PROVABLY cannot work; this condition already fails at runtime
// today, so reporting it early can never block a part that would have built.
export const err = make("error");
// warning → suspicious or lossy, but the part still builds.
export const warn = make("warning");
