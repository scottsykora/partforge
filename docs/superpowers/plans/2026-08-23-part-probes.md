# Part probes — declared measurements in the measure report

**Feedback:** "Probes" (partforge-cloud report 335d2f92). An agent rebuilding an
imported STL had no way to get numbers out of the geometry pipeline, so it
authored a dozen throwaway `exportable: false` sub-parts — thin slabs
intersected with both its rebuild and the imported reference — purely to smuggle
cross-section measurements into the `measure` report it reads after every edit.
Ask: extend the measure API / add a way for a part to probe another part live
and feed the result back into parameters.

## What already works (and stays the story for "live")

`k.import(name)` returns a full `Solid` inside any `build`, and `boundingBox()` /
`volume()` / `intersect()` are contract ops on both backends — so a build can
already measure another part live and drive its own geometry from the numbers.
The two real gaps:

1. **Numbers can't get OUT.** `build` returns solids; only rendered sub-parts
   get measured. Hence the slab-sub-part hack (which pollutes views, needs
   `exportable: false`, and reports only in the views it's declared in).
2. Parameter *defaults* measured off a reference must be hand-copied from ad-hoc
   probes into `defaults` (the box-opener chat hard-coded `hookR: 39.66`).

## Design: a `probes` block

```js
probes: {
  // Solid → replaced by a standard fact object in the report
  slab12: (k, p, d) => buildBody(k, p, d).intersect(k.box({ min: [12,-25,-4], max: [13,25,4] })),
  // plain JSON (numbers computed via solid queries) → passes through verbatim
  fit: (k, p, d) => {
    const mine = buildBody(k, p, d), ref = k.import("scan");
    return { xor: mine.volume() + ref.volume() - 2 * mine.clone().intersect(ref).volume() };
  },
}
```

- Each probe is a **pure function of `(k, p, d)`** — same contract as `build`.
  Never rendered, never exported, **view-independent** (part-level, evaluated on
  every measure regardless of view — fixes the "probes only report for the
  default view" annoyance from the chat).
- Evaluated by the oracle's `measure()` — so `npx partforge measure`, the worker
  `inspect` job, and every host built on them (partforge-cloud's checks) get
  them with no further wiring. Report key `probes: { name: value }`, present
  only when the part declares probes.
- Return value walk (depth-capped): a `Solid` anywhere becomes
  `{ empty, bbox, bounds, volume, surfaceArea, centerOfMass, triangleCount,
  watertight, holes }`; numbers/arrays/strings/booleans pass through. An empty
  solid (slab missed the part) reports `{ empty: true, volume: 0, … }` rather
  than infinite bounds.
- A probe that throws reports `{ error: message }` and never crashes the
  measurement or flips `report.ok` — probes are instrumentation, not gates.
- `opts.probes !== false` in `measure()`; verify's internal per-case re-measures
  pass `probes: false` (no gate reads them; skips the per-case boolean cost).
  The inspect job's own measure keeps them ON in quick mode — the agent loop is
  exactly who reads them.

## Out of scope (documented, not built)

- `verify` gates on probe values (`_probes` scope) — natural follow-up if
  refinement loops want CI enforcement; `ref*` deviation metrics already gate
  whole-part fidelity.
- Auto-updating parameter defaults from probes at runtime — `derive` runs on the
  main thread without a kernel; the workflow is: read probe values from the
  measure report, bake into `defaults` (what the agent already does, now with a
  first-class instrument).

## Touch list

- `src/framework/oracle/measure.js` — evaluate `part.probes` (own kernel
  bracket, before `assemblyOverlaps`/`cleanup` frees solids).
- `bin/cli.js` `printMeasure` — probes section.
- `src/framework/oracle/verify.js` — `probes: false` on per-case measures.
- Lint: `rules-shape`/`rules-schema` (probes must be an object of functions);
  `runValidatingProbe` executes probes too (unknown-op / invalid-options /
  throws / runaway / nondeterminism coverage), findings located at
  `probes.<name>`.
- `src/parts/import-demo.js` — becomes the probes reference part as well.
- `docs/AUTHORING-PARTS.md` — new "Probes" section + the live-measurement
  pattern in build.
- Tests: `test/measure.test.js`, lint rules test, verify-opts test.
- Version bump → 0.82.0.
