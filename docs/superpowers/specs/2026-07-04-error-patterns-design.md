# Error-pattern library (issue #28) — design

**Issue:** [#28 — docs: symptom-indexed error→solution pattern library](https://github.com/scottsykora/partforge/issues/28)
**Related:** #27 (structured measure/verify diagnostics — will cite pattern IDs), #30
(hardware library — drafted below, filed 2026-07-04 — first subsystem authored against
the symptom-string contract this file establishes).

## Goal

Create `docs/ERROR-PATTERNS.md`: a single grep-first lookup from *what an agent sees*
(literal error text or observable misbehavior) to *what went wrong and how to fix it*.
Do it with conventions strong enough that two future consumers can hook in without
format drift: issue #27's diagnostics (cite patterns by ID) and the `partforge/hardware`
parts library (contributes its own `hardware-*` patterns and throws greppable errors).

## Decisions made during brainstorming

1. **Plain Markdown, no structured source / generator** (Approach A). Agents consume
   grep'd Markdown directly; #27 only needs stable anchors. Stable IDs are the contract,
   so a later migration to structured data stays possible.
2. **Hardware library = spec catalog + pure builders** (not full PartDefinitions, not
   bare data tables) exposed as a worker-safe `partforge/hardware` subpath, mirroring
   `partforge/geometry`.
3. The hardware library gets its **own GitHub issue**, filed in the house style after
   text approval; this spec carries the draft.

## `docs/ERROR-PATTERNS.md` format

A preamble ("How to add a pattern") defines the contract, then one pattern per `##`
heading, grouped by namespace section:

```markdown
## worker-imports-main-entry

- **Symptom:** `ReferenceError: document is not defined` thrown from a worker build.
- **Cause:** The part (or a helper it imports) imports `partforge` instead of
  `partforge/geometry`; the main entry pulls in the DOM viewer.
- **Fix:** Import geometry helpers only from `partforge/geometry` in anything a worker
  loads. See AUTHORING-PARTS.md § "Geometry: the kernel / Solid API".
```

Contract rules (stated verbatim in the preamble):

- **Heading = stable kebab-case ID.** IDs are permanent: never renamed, never reused.
  External consumers (issue #27 diagnostics, HARDWARE.md, skills) cite
  `ERROR-PATTERNS.md#<id>`.
- **Symptom line carries the literal string** an agent would see, verbatim in backticks,
  when one exists; otherwise the observable misbehavior. This line is the grep target.
- **Namespacing:** core framework patterns are bare slugs; subsystem patterns take a
  prefix. `hardware-*` is reserved for the parts library. One file, one `#`-level
  section per namespace.
- **Shape:** exactly the three labeled lines (Symptom / Cause / Fix); optional extra
  note paragraphs after them. Cause is one sentence. Fix states the concrete change and
  links the governing rule (AUTHORING-PARTS.md section) rather than restating it.
  No tables.
- **Subsystems that throw should throw greppable strings:** an error message thrown by
  partforge code should match its pattern's Symptom line verbatim, so the grep is a
  one-step lookup. (The hardware library is the first subsystem designed to this rule.)

## Seed patterns (~18)

The 10 from the issue body:

| ID (proposed) | Symptom |
|---|---|
| `worker-imports-main-entry` | `document is not defined` in a worker |
| `impure-build-stale-preview` | stale/unchanged preview after an edit |
| `replicad-consumed-operand` | OCCT solid unexpectedly empty / crash after transform |
| `probe-routed-to-occt` | part quietly on the slow backend (dead fillet/chamfer/shell code) |
| `boolean-not-watertight` | `NOT watertight ✗` after a boolean (coplanar/grazing cut) |
| `dual-kernel-same-process` | test file crashes when both kernels boot |
| `view-dependent-display-place` | geometry fine in one view, misplaced in another |
| `wrong-node-version` | confusing WASM/install failures (needs Node 24) |
| `worker-url-not-inline` | Vite doesn't bundle the worker |
| `minwall-sliver-triangles` | `verify` minWall warnings on faceted parts |

Plus ~8 mined from AUTHORING-PARTS.md while reading it (final set confirmed during
implementation):

| ID (proposed) | Symptom |
|---|---|
| `param-key-missing-from-defaults` | control missing/broken — `key` not in `defaults` |
| `dimmed-control-vestigial-param` | control renders dimmed — no on-screen sub-part reads it |
| `linked-checkout-wasm-403` | 403 on WASM, kernel never boots (npm-linked partforge; `server.fs.allow`) |
| `ring-sector-full-circle` | `ringSectorPolygon` at 360° fails — use contour-with-hole |
| `smooth-geometry-faceted-preview` | `ruled:false` loft / `smooth` sweep looks faceted in preview (OCCT/STEP-only) |
| `scale-moved-the-part` | `scale()` relocated an off-origin part — pass a center |
| `occt-holes-watertight-na` | `holes`/`watertight` report `n/a` on OCCT parts; verify assertions skip |
| `html-page-missing-in-prod` | part page 404s in production build — extra `*.html` are dev-only |

**Verification rule:** every entry is checked against actual behavior before it's
written — reproduce the failure where cheap, otherwise confirm the mechanism in source.
No speculative entries.

## Wiring

- **CLAUDE.md** — "Non-obvious invariants" keeps its one-liners, gains: *"On any
  build/measure/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom before
  debugging."*
- **skills/partforge/SKILL.md** — currently the request-a-pick skill only; add a short
  pointer note (the full "grep first" workflow instruction lives in CLAUDE.md, which
  every agent session loads).
- **AUTHORING-PARTS.md** — "Conventions & gotchas" slims to one-line invariants that
  link pattern IDs instead of duplicating prose.

## Format-lint test

A small vitest (`test/error-patterns.test.js`) parses `docs/ERROR-PATTERNS.md` and
asserts: every `##` heading is a unique kebab-case ID; every entry has the three
labeled lines in order; every Symptom line is non-empty. This keeps the contract
honest for future contributors (including the hardware library).

## Acceptance (from the issue, plus the lint test)

- `docs/ERROR-PATTERNS.md` exists with ≥15 patterns in the uniform shape.
- Each Symptom line contains the literal string an agent would see, where one exists.
- SKILL.md and AUTHORING-PARTS.md reference it; CLAUDE.md carries the grep-first rule.
- The format-lint vitest passes.

---

## Companion issue draft: `partforge/hardware` parts library

To be filed as a new issue after text approval. Draft body:

> **Title:** feat: `partforge/hardware` — spec catalog + builders for off-the-shelf hardware (screws, inserts, magnets, bushings)
>
> ## Why
>
> Every part that mates with real hardware re-derives the same numbers (clearance
> holes, counterbore diameters, insert hole sizes, magnet pockets) and re-implements
> the same cutter geometry, with print clearances scattered as magic `+0.2`s in each
> part's `derive`. A curated hardware library turns that into one import: published
> standards as data, plus canonical builder solids that compose with the existing
> `along`/`at`/`label` vocabulary. For agent authoring this is the "pre-defined parts
> and fixtures" half of the in-context documentation strategy
> (`docs/research/llm-cad-generation-strategies.md`) — the model references a spec
> instead of hallucinating dimensions.
>
> ## What this means in practice
>
> A part that needs an M3 counterbore writes
> `body.cut(counterbore(k, M3({ length: 12 }), { fit: "normal" }).at([10, 0, 0]).label("M3 counterbore"))`
> and optionally shows the screw as a translucent ghost sub-part — no dimension
> lookups, no hand-rolled clearance math.
>
> ## Spec
>
> 1. **New worker-safe subpath export `partforge/hardware`** (pure data + pure
>    functions, DOM-free — the `partforge/geometry` precedent).
> 2. **Spec catalog** — frozen spec objects from published standards, via factories
>    (`M3({ length: 12, head: "socket" })`):
>    - Metric machine screws: socket-head (DIN 912) + countersunk (DIN 7991), M2–M6,
>      ISO 273 close/normal/loose clearance classes.
>    - Heat-set inserts M2–M6: insert OD, length, recommended hole ⌀, min boss wall.
>    - Disc magnets: common d×h sizes.
>    - Plain sleeve bushings: parametric ID/OD/length/flange.
> 3. **Builders** — pure `(k, spec, opts) => Solid`, canonical (+Z, origin):
>    - Ghosts: `screwGhost`, `insertGhost`, `magnetGhost` — simplified reference
>      solids for `display:{color, opacity}` ghost sub-parts.
>    - Cutters: `clearanceBore`, `counterbore`, `countersink`, `insertBoss` +
>      `insertPocket`, `magnetPocket` (optional retention lip / capture),
>      `bushingBore` (press/slide fit). Every cutter takes a `fit` preset with an
>      overridable numeric clearance — print-clearance policy in one place.
> 4. **Error-pattern contract (pairs with #28):** the library owns the `hardware-*`
>    namespace in `docs/ERROR-PATTERNS.md`; every builder documents its failure modes
>    there, and builder validation errors throw the pattern's Symptom string verbatim,
>    so an agent's grep is a one-step lookup.
> 5. **Docs + example:** `docs/HARDWARE.md` (catalog + builder reference, citing
>    pattern IDs), a short AUTHORING-PARTS.md section, and one worked example part —
>    a mounting plate with screw counterbores, a magnet pocket, and an insert boss,
>    with ghosts.
> 6. **Tests:** vitest measuring cutter dimensions against the spec tables (e.g. an
>    M3 normal-fit clearance bore is ⌀3.4 mm), plus `measure`/`verify` on the example
>    part.
>
> ## Acceptance
>
> - `partforge/hardware` exports the four spec families and the builders above.
> - Cutter dimensions match the cited standards in tests.
> - Builder validation errors appear verbatim as `hardware-*` Symptom lines in
>   ERROR-PATTERNS.md.
> - Example part passes `npx partforge measure` with a `verify` block.
>
> ## Out of scope (v1)
>
> - Thread modeling, imperial sizes, bearings/washers/nuts (nut pockets are a natural
>   v2), verify-block auto-assertions derived from specs.
>
> Depends on #28 (the ID/namespace conventions and Symptom-string contract).

## Build order

1. **#28 first** — it defines the conventions the library writes against.
2. File the hardware issue (cross-linking #28) once its text is approved.
3. The hardware library is its own spec → plan → implementation cycle later.
