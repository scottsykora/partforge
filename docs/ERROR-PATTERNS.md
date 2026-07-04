# Error patterns — symptom-indexed lookup

When a build, test, `measure`, or `verify` run fails confusingly: **grep this file
for the symptom first** — the literal error text, or a phrase describing the
misbehavior — before debugging from scratch.

**How to add a pattern** (`##` headings are reserved for pattern entries — the lint
test parses every one; keep prose like this as plain paragraphs):

- One pattern per `## <id>` heading. The heading is a **stable kebab-case ID**:
  permanent once committed — never renamed, never reused. External consumers
  (issue #27 diagnostics, HARDWARE.md, skills) cite `ERROR-PATTERNS.md#<id>`.
- **Namespaces:** core framework patterns are bare slugs. Subsystem patterns take
  a reserved prefix — `hardware-*` is reserved for the parts library (issue #30).
  One `#`-level section per namespace.
- Entry shape — exactly these three list lines, then optional note paragraphs:
  - **Symptom:** the literal string an agent would see, verbatim in backticks,
    when one exists; otherwise the observable misbehavior. This is the grep target.
  - **Cause:** one sentence.
  - **Fix:** the concrete change, linking the governing rule
    ([AUTHORING-PARTS.md](AUTHORING-PARTS.md) section) rather than restating it.
- No tables inside entries.
- Code that throws should throw greppable strings: an error message thrown by
  partforge should match its pattern's Symptom line verbatim.
- `test/error-patterns.test.js` lints this file's structure.

# Core framework

## worker-imports-main-entry

- **Symptom:** `ReferenceError: document is not defined` thrown from a worker build.
- **Cause:** The part (or a helper it imports) imports `partforge` instead of `partforge/geometry`, and the main entry pulls in the DOM viewer/controls.
- **Fix:** Import geometry helpers only from `partforge/geometry` in anything a worker loads. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

# Hardware library

Reserved for `hardware-*` patterns (issue #30). No entries yet.
