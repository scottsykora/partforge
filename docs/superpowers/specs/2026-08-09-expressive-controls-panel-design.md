# Expressive control panels

**Date:** 2026-08-09
**Status:** approved design, not yet implemented

## Why

`parameters` is the schema an LLM writes to give a part its control panel, and it
is the weakest part of the authoring surface. Two problems compound.

**The tri-split.** A section is one of three different things depending on which
array the author fills in: `presets` + `advanced` (a preset section), `toggles`
(bare checkboxes, rendered outside the Advanced fold), or `features` (a checkbox
that reveals its own sliders, rendered inside it). Which array a given control
belongs in is a rule the author has to have memorized. Two of the eight schema
lint rules — `features-requires-sliders` and `features-requires-on` — exist only
to catch authors putting something in the wrong one, and their hints are long
because the underlying distinction is genuinely hard to explain.

**Three walkers.** `controls.js` walks `parameters` to render it,
`lint/rules-schema.js` re-implements `visibleFeatures` and `sectionRenders` by
hand, and `lint/rules-animations.js` walks `advanced` and `features[].sliders`
separately to range-check animation keyframes. The duplication is deliberate:
`controls.js` imports `markdown.js`, which pulls in `marked` and `dompurify`, and
`test/lint-purity.test.js` requires lint to stay dependency-free. So every field
added to the schema today has to be added in three places, and the three can
drift.

The result is a schema that is simultaneously hard to write correctly and
expensive to extend. What it can express is thin: four control types, one fixed
fold per section, no conditionals, no nesting, no way to say "this control only
matters when that one is set."

## Goals

- One uniform, recursive shape an author writes, instead of three special-cased
  arrays.
- One pure module that understands the schema, imported by the renderer and by
  both lint rule groups.
- Collapsible sections that start open when the panel is small.
- Author-declared conditional visibility, statically checkable.
- A wider widget set: enums, segmented pickers, checkboxes, read-only readouts,
  and slider refinements.
- Lint that checks a panel is *well-organized*, not merely valid.

## Non-goals

- A layout DSL (rows, columns, spans, density). The rail is ~300px wide; there
  is no layout to express, and it is a lot of grammar for an author to get wrong.
- Color, vector, and stepper widgets. Parts are geometry-only — there is no color
  parameter anywhere in the codebase — and two sliders beat a vector widget in a
  narrow rail.
- Breaking existing parts. Every part that renders today renders after this,
  unmodified.
- Persisting a user's open/closed choices. Collapse state is derived fresh on
  every load, so a part always presents the same way.

---

## 1. The node model

New module `src/framework/panel/model.js`. Pure: no DOM, no `markdown.js`, no
dependencies at all — the same discipline as `part-model.js`, `rail-state.js`,
and `param-deps.js`. It is the only code in the project that understands the
authored schema.

```js
normalizePanel(parameters) -> PanelTree   // authored schema -> node tree
evalWhen(condition, params) -> boolean    // one condition against raw params
resolveOpenState(tree) -> tree            // stamps resolved `open` on containers
controlNodes(tree) -> ControlNode[]       // flat walk, for lint and range checks
```

The tree has exactly two node kinds.

**Group** — a container.

```js
{ kind: "group",
  id, title, description,
  presets,              // name -> param override bundle (top-level groups only)
  collapsed,            // true | false | "auto"
  when, whenFalse,
  children: Node[] }
```

**Control** — a leaf bound to one key in `defaults`.

```js
{ kind: "control",
  key, type, label, description,
  unit, min, max, step,   // numeric types
  options,                // select / radio
  on,                     // checkbox
  derivedKey,             // readout
  scale, ticks, recommended,
  when, whenFalse }
```

Top-level groups are the sections. Groups nest. Controls are always leaves.

`presets` stays a group-level field rather than becoming a node, because
`oracle/cases.js` reads `section.presets` directly to expand verify cases, and
that path should not have to change.

### What an author writes

```js
parameters: [
  {
    id: "body",
    title: "Body",
    presets: { "Pen cup": { … }, Vase: { … } },
    controls: [
      { key: "profile", type: "select", label: "Profile",
        options: [
          { value: "round",  label: "Round" },
          { value: "faceted", label: "Faceted" },
        ] },
      { key: "facets", type: "slider", label: "Facets", min: 3, max: 12, step: 1,
        when: { profile: "faceted" } },
      { key: "dia", type: "slider", label: "Diameter", unit: "mm", min: 30, max: 150, step: 1 },

      { type: "group", title: "Wall", collapsed: "auto",
        controls: [
          { key: "wall", type: "slider", label: "Thickness", unit: "mm",
            min: 0.8, max: 4, step: 0.1, recommended: [1.2, 4] },
          { type: "readout", label: "Inner diameter", derivedKey: "innerDia", unit: "mm" },
        ] },
    ],
  },
]
```

A group's children live in `controls`. `type` replaces the old `control` field.
Authored order is render order.

---

## 2. The old shapes become sugar

`normalizePanel` desugars the legacy arrays. Nothing on disk changes; the nine
in-repo parts and every downstream part keep working indefinitely.

| Authored | Normalizes to |
|---|---|
| `advanced: [...]` | a child group `{ title: "Advanced", collapsed: "auto", children: [...] }` |
| `toggles: [{ key, label, on }]` | checkbox controls placed directly in the section, before the Advanced group |
| `features: [{ key, on, sliders }]` | per feature: a checkbox control, followed by a group of its sliders carrying `when: { [key]: { gt: 0 } }` — both inside the Advanced group |
| `control: "slider"` etc. | `type: "slider"` |
| `hidden: true` | node omitted from the tree entirely |

The `features` row is the point of the whole exercise. A feature stops being a
special renderer path and becomes an ordinary conditional group.
`buildFeatureSection` is deleted. `features-requires-sliders` and
`features-requires-on` stop describing a hazard and become legacy-shape
validation only, because an author who wants a bare checkbox now writes a
checkbox instead of guessing which array it goes in.

Sugar and the new shape may be mixed within one part but not within one section:
a section that has both `controls` and any of `advanced` / `toggles` / `features`
is a lint error, because the resulting order would be arbitrary.

A group with no visible children and no presets is dropped from the tree — the
generalization of today's `sectionRenders`.

---

## 3. Collapse and auto-open

Every group's `collapsed` takes `true`, `false`, or `"auto"` (the default).
Explicit values always win. `"auto"` defers to one rule:

> If the panel has **3 or fewer visible top-level sections**, every `"auto"`
> container in the panel starts open. Otherwise they all start closed.

Because legacy `advanced` desugars to `collapsed: "auto"`, existing parts pick
this up for free: `demo.js` and `planter.js` (two sections each) open their
Advanced folds on load, while a part with six sections stays tidy.

`resolveOpenState` computes this and is unit-tested directly, with no DOM.

The section title becomes a disclosure button carrying `aria-expanded`. This is a
visible change to how a panel presents on load, and it is intended.

### Sections stay flat siblings

Top-level sections remain flat siblings in the DOM. This is load-bearing, not
cosmetic: `app.css:64` draws the hairline between sections with

```css
.section:not(.section-hidden) ~ .section:not(.section-hidden) { border-top: … }
```

which walks preceding siblings so that a relevance-hidden first section doesn't
leave a stray rule floating under the rail header. `controls.test.js:392`
asserts the flatness on purpose. Nesting therefore happens only *inside* a
section, reusing the existing `.feat-group` left-border idiom, and that test
stays green unmodified.

---

## 4. Conditions

`when` is valid on any node — control, nested group, or section.

```js
when: { profile: "faceted" }                  // equality
when: { wall: { gte: 1.2 } }                  // gt | gte | lt | lte | ne
when: { style: { in: ["a", "b"] } }           // membership
when: { allOf: [ { drain: { gt: 0 } }, { mode: "planter" } ] }
when: { anyOf: [ … ] }
when: { not: { style: "plain" } }
```

Multiple keys in one object are ANDed.

`when` references **raw parameter keys only** — never derived values. That is
what lets `rules-schema.js` check every referenced key against `defaults`
statically, which no predicate function could support. Readouts get at derived
values through their own explicit `derivedKey` field, so there is no ambiguity
about which namespace a name is in.

When a condition is false the node is removed from the layout. `whenFalse:
"disable"` greys it in place instead, for the case where the author wants the
user to see that an option exists but needs something else enabled first. A
false group takes its subtree with it.

### Relationship to relevance dimming

This is a **second, independent** mechanism alongside the automatic dimming in
`param-deps.js`, and both stay:

- **Relevance** answers "does the geometry currently on screen actually read this
  parameter?" It is computed by probing the build, requires no authoring, and
  dims with `.irrelevant`.
- **`when`** answers "did the author say this control applies right now?" It is
  declared, and hides or disables.

A control can be relevant but conditioned away, or vice versa. `mount.js:510`
already re-runs relevance on every param change; conditions re-evaluate on the
same tick.

---

## 5. Widgets

Existing four keep working: `slider`, `number`, `text`, `textarea`.

| New type | What it is |
|---|---|
| `select` | Dropdown over `options`. Long form `[{ value, label, description? }]`, or the shorthand `["round", "faceted"]` where each string is both value and label. Values may be strings or numbers. |
| `radio` | Same data as `select`, rendered as a segmented control. For 2–4 options where seeing all of them matters. |
| `checkbox` | A bare on/off bound to `on` (default `1`) / `0`. The honest home for a boolean, and what `toggles` desugars to. |
| `readout` | Read-only display of a `derive()` output named by `derivedKey`. Not bound to `defaults`; shows what the part computed. |

Three slider refinements:

- `scale: "log"` — logarithmic response, for a range like 0.1–100 where linear
  dragging is useless at the low end.
- `ticks: [...]` / `snap: true` — marked values the thumb prefers.
- `recommended: [lo, hi]` — draws a band on the track; outside it the value box
  takes a warning tint. This is the visual companion to the DFM checks that
  already flag things like sub-1.2mm walls, surfaced before the user builds
  rather than after.

---

## 6. Lint

`rules-schema.js` and `rules-animations.js` both switch to consuming
`normalizePanel` / `controlNodes` instead of hand-walking. `panel/model.js` is
dependency-free, so `test/lint-purity.test.js` keeps passing — its allowlist
gains that one module.

Existing rules keep working against the normalized tree. `unknown-control-field`
allow-lists extend to the new fields.

New rules:

| Rule | Severity | Catches |
|---|---|---|
| `when-key-not-in-defaults` | error | a condition on a key that doesn't exist |
| `when-unknown-operator` | error | a typo'd operator, with did-you-mean |
| `select-options-missing` | error | `select`/`radio` with no `options` |
| `select-default-not-in-options` | error | the default value can't be selected |
| `readout-unknown-derived-key` | warn | `derivedKey` no `derive()` group produces |
| `mixed-section-shape` | error | one section using both `controls` and legacy arrays |
| `presets-not-top-level` | error | `presets` on a nested group, where nothing reads it |
| `group-depth` | warn | nesting past two levels |
| `section-too-many-controls` | warn | one section showing more than ~12 visible controls, suggesting groups |

The last two are the LLM-facing ones: they push toward a panel that is
*organized*, which no amount of field validation can do.

---

## 7. Files

```
src/framework/panel/model.js     pure: normalize, evalWhen, resolveOpenState, controlNodes
src/framework/panel/widgets.js   one DOM factory per control type
src/framework/panel/render.js    tree -> DOM; relevance, conditions, sync
src/framework/panel/info.js      createInfoPopover, attachInfo (moved)
src/framework/controls.js        public entry; re-exports the above
```

`controls.js` stays at its path and keeps exporting `buildControls`,
`createInfoPopover`, `attachInfo`, `clampToRange`, `popoverTop`,
`sectionRenders`, `visibleAdvanced`, `visibleFeatures`, and `visibleToggles`.
The popover exports matter beyond the panel: `animation-controls.js:9` imports
them for the transport bar's ⓘ.

Splitting `controls.js` (364 lines, currently doing schema interpretation, widget
construction, DOM assembly, and popover management at once) is what keeps each
piece small enough to reason about — and it is what makes the schema layer
testable without a DOM at all.

## 8. Runtime handle

`buildControls(root, parameters, params, onDirty)` keeps its signature. The
returned handle gains one method and keeps the rest:

```js
panel.refresh({ relevant, derived })   // new: relevance + conditions + readouts
panel.applyRelevance(relevant)         // retained, delegates to refresh
panel.syncValues(keys?)                // unchanged
panel.dispose()                        // unchanged
```

`mount.js` calls `refresh` where it currently calls `updateRelevance`. `derived`
comes from the existing `resolveDerived` — cheap and pure, so recomputing it per
param change is fine.

---

## 9. Types

`types/part.d.ts` gains `GroupNode`, `ControlNode`, `WhenCondition`, and
`ControlType`. The existing `ParameterSection` union widens to admit a
`controls`-bearing section. `ControlDef`, `FeatureDef`, and `ToggleDef` stay
exported and get `@deprecated` JSDoc pointing at the replacement — soft
deprecation, so `test/partforge.test-d.ts` keeps compiling.

Note the existing discrimination trick at `types/part.d.ts:125`: `PresetSection`
carries `features?: undefined` to make the union discriminate. The new member
needs the same treatment.

## 10. Docs

`docs/AUTHORING-PARTS.md:446–545` — the "Parameters" section — gets rewritten
around the node model, with the legacy shapes moved to a clearly-marked
compatibility subsection at the end. `:548+` "Designing the control panel" gains
guidance on when to reach for a group, a `select`, or a condition.

`skills/partforge/SKILL.md` is unrelated (it is the request-a-pick skill) and is
not touched. `AUTHORING-PARTS.md` is the LLM-facing surface here.

`docs/ERROR-PATTERNS.md` gains entries for the new lint rules.

At least two in-repo parts should be enriched to demonstrate the new shape —
`bracket.js` (its shape ops want a `select`) and `planter.js` (its body wants
groups and a `recommended` band on wall thickness). The rest stay on legacy
shapes deliberately, as live proof that compatibility holds.

---

## 11. Testing

- **Legacy parity.** Golden tests rendering all nine in-repo parts through the
  new pipeline, asserting the same controls, same bindings, same behavior. Not
  byte-identical DOM — section titles gain a disclosure affordance — but the
  existing 27 tests in `test/framework/controls.test.js` should pass with at most
  mechanical changes.
- **Model unit tests**, no DOM: normalization of each legacy shape, `evalWhen`
  across every operator and combinator, `resolveOpenState` at the threshold
  boundary.
- **Widget tests** per new type: renders, binds, syncs, fires `onDirty`.
- **Condition tests**: hide vs. disable, group subtrees, interaction with
  `.irrelevant`.
- **Lint tests** for each new rule, in `test/lint-schema.test.js`.
- **`test/lint-purity.test.js`** must still pass with lint importing
  `panel/model.js`.

## 12. Phasing

Each phase is a reviewable PR. Per `AGENTS.md`, the version bump rides on the
branch.

1. **Model + parity.** Extract `panel/`, render from the tree, desugar all legacy
   shapes, collapsible sections, `collapsed: "auto"`. No new authored features.
   Lint switches to the shared model. This is the risky phase; everything after
   it is additive.
2. **Widgets.** `select`, `radio`, `checkbox`, `readout`, and the three slider
   refinements. Types and lint allow-lists.
3. **Conditions.** `when` / `whenFalse`, `refresh`, the four condition lint rules.
4. **Docs and parts.** Rewrite the authoring guide, add the structural lint
   rules, enrich `bracket.js` and `planter.js`.

## 13. Risks

- **Parity regressions in phase 1** are the main hazard — the desugar of
  `features` in particular has to reproduce the exact check/reveal behavior
  including the `syncs.forEach` on enable and the `params[key] = 0` on disable.
  The golden tests are the mitigation, and phase 1 ships nothing else so a
  regression is easy to bisect.
- **`section-too-many-controls` is a judgment call.** Twelve is a guess. It ships
  as a warning, and the threshold should be revisited after seeing real
  LLM-authored parts.
- **Downstream corpus.** `partforge-cloud` regenerates its prompt corpus against
  the installed package, so the `AUTHORING-PARTS.md` rewrite in phase 4 is what
  actually changes what LLMs write. The publish must land before the dep bump
  there.
