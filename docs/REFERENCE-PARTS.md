# Reference parts — library contract & vendoring convention

> **Status: draft contract (2026-07-05).** This supersedes the `docs/HARDWARE.md` /
> npm-subpath plan from issue #30: reference designs live in an open **forge
> library** (searched, then vendored) rather than shipping inside the npm package.
> The library and the `partforge lib` tooling are not yet implemented — do not wire
> this into AUTHORING-PARTS.md or the skill until they are, so agents aren't told
> to search a library that doesn't exist. Infrastructure plan:
> `partforge-cloud/docs/plans/reference-library.md`.

A **reference part** is a reusable design ingredient — a screw, heat-set insert,
magnet, bearing, motor interface — that real parts mate with. It is not an app
and not a `PartDefinition`; it is data plus pure geometry functions that a
consuming part **vendors** (copies in whole, with provenance) so the consuming
part stays a single self-contained module.

Why vendoring instead of imports: the worker statically imports one part module;
the preview kernel memoizes by content hash; partforge-cloud compiles exactly the
source string it is sent; and a manufactured part must never change geometry
because a library entry was edited upstream. Copying is version pinning. The
integration lives in tooling (search, vendor, update-diff), not the module graph.

## Entry module shape

One entry = one ESM module, default-exporting:

```js
export default {
  meta: {
    id: "hardware/m2-5x8-pincopen-std005",  // stable, kebab-case, namespaced by kind
    title: "M2.5×8 thermoplastic screw (PincOpen STD005)",
    kind: "screw",                          // one of the library's kind taxonomy
    tags: ["m2.5", "self-tapping", "phillips", "plastic"],
    standard: "PincOpen STD005",            // cited standard/datasheet, if any
    license: "CC0-1.0",
    units: "mm",
  },
  spec: {                                   // frozen dimension data, from the cited source
    d: 2.5, length: 8, headD: 4.5, headH: 1.7,
  },
  build: (k, opts) => Solid,                // the full/ghost solid (see conventions)
  tools: {                                  // negative shapes, ready to .cut()
    pilotBore:   (k, { fit = "pla" } = {}) => Solid,
    clearanceBore: (k, { fit = "normal" } = {}) => Solid,
  },
  attach: {                                 // how things mate with this part
    interfaces: [
      { name: "pilot", type: "bore", d: 2.05, minDepth: 6, minWall: 1.2,
        note: "self-tap pilot for PLA; use tools.pilotBore" },
    ],
    orientation: "+Z is the insertion direction; origin at the seat plane under the head",
    notes: "Head seats flush on a flat face; no countersink. Boss OD ≥ d + 2·minWall.",
  },
};
```

- `spec` and `attach.interfaces` are **data first** — they are what the library
  index serves to search, and what an agent reads before touching geometry.
- Library CI wraps `build` (and each tool) in a generated throwaway
  `PartDefinition` to run `measure` / `verify` / `render` — entries themselves
  stay lean.

## Geometry conventions (same rules as any part, plus)

- **Canonical pose:** +Z is the build/insertion axis; origin at the entry's seat
  or mount plane. Consumers place with `along(dir).at([x,y,z])`.
- **Pure functions** of `(k, opts)`; DOM-free; millimetres; kernel-agnostic
  (`partforge/geometry` vocabulary only).
- **Cutters overcut**: every tool extends past the faces it pierces (the
  `boolean-not-watertight` rule) and takes a `fit` preset with an overridable
  numeric clearance — clearance policy lives in the entry, not scattered as
  magic `+0.2`s in consumers.
- **Ghosts are display-only**: `build` output is intended for
  `display: { opacity }` sub-parts and collision checks, simplified is fine
  (no thread helices).
- **Errors are patterns**: library builders own the `hardware-*` namespace in
  `docs/ERROR-PATTERNS.md` (reserved by #28); validation throws lead with their
  Symptom literal (the leading-literal matching rule).

## Vendoring convention

A consumer copies the **whole entry** into its own module as one delimited
region:

```js
// pf-vendor: hardware/m2-5x8-pincopen-std005 @ a1b2c3d (CC0-1.0) https://<forge>/library/…
const m25screw = { /* …entire entry, verbatim… */ };
// pf-vendor-end: hardware/m2-5x8-pincopen-std005
```

Rules:

1. **The markers are the contract.** Grammar:
   `// pf-vendor: <id> @ <commit-short> (<license>) <url>` … `// pf-vendor-end: <id>`.
   `grep pf-vendor` finds every vendored copy in a codebase; future tooling
   (`partforge lib outdated` / `lib update`) diffs the region against the entry
   at upstream HEAD and proposes the refresh as an explicit, reviewable edit.
2. **Don't hand-edit inside the region.** Parameterize at the call site
   (`tools.pilotBore(k, { fit: "petg" })`), or — if the entry genuinely needs
   changing — **fork it**: delete the markers, rename, and it's yours (note the
   origin in a plain comment). Never leave markers on modified code; a later
   `lib update` would silently revert it.
3. **One region per entry, whole entry.** Partial copies lose the `attach`
   documentation, which is half the point.
4. The `partforge lib vendor <id>` command (planned) fetches, stamps the
   markers, and pastes — agents and humans get the convention for free.

## Search & tooling (planned surface)

- `partforge lib search <terms>` — keyword search over the Supabase index
  (kind, tags, title, dimensions, attach summaries).
- `partforge lib show <id>` — print an entry's `meta`/`spec`/`attach` and source.
- `partforge lib vendor <id> [file]` — stamp + paste into a part module.
- partforge-cloud exposes the same index to its agent as server-side
  `search_library` / `fetch_library_part` tools.

Storage, index schema, CI, and publishing flow: see
`partforge-cloud/docs/plans/reference-library.md`.
