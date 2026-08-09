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
desugar(parameters) -> CanonicalTree      // legacy shapes -> canonical, KEEPS hidden nodes
buildTree(canonical) -> RenderTree        // drops hidden + empty groups, assigns ids
evalWhen(condition, params) -> boolean     // one condition against raw params
controlNodes(tree) -> ControlNode[]        // flat walk, for lint and range checks
```

**Desugaring and tree-building are separate steps, and must stay separate.** Lint
needs the canonical tree with hidden nodes still in it — `lint-schema.test.js:153`
("a hidden control still counts as exposing its key") fails otherwise, and
`default-not-exposed` would start firing on every deliberate internal constant.
The renderer needs them gone. Collapsing these into one `normalize` call, which
an earlier draft of this spec did, silently breaks lint.

### Node identity

`buildTree` assigns every node a stable `id`: the authored `id` when there is
one, otherwise a path derived from position (`body/advanced/2`). Ids are what the
state pass (§7) keys its output on, and what the disclosure buttons use for
`aria-controls`. They must be stable across a re-render of the same schema.

The tree has exactly four node kinds.

**Group** — a container.

```js
{ kind: "group",
  id, title, description,
  collapsed,            // true | false | "auto"
  bare,                 // no title, no disclosure — just an indented block
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
  scale, ticks, recommended,
  when, whenFalse }
```

**Display** — a leaf bound to nothing. Currently just `readout`.

```js
{ kind: "display", type: "readout", label, unit, derivedKey, when, whenFalse }
```

A display node is a separate kind rather than a control because it differs on
every axis that matters to the machinery: it has no `key`, never writes `params`,
never appears in `syncValues`, never participates in relevance (which is computed
over parameter keys), and can never be the target of a preset. Modelling it as a
control would put a `key == null` branch in all five of those paths. Splitting the
kind means each path simply filters to `kind === "control"` once.

**Preset** — a picker that writes a bundle of parameters at once.

```js
{ kind: "preset", id, label, presets, when, whenFalse, hidden }
// presets: { "Pen cup": { dia: 80, height: 100 }, Vase: { … } }
```

Top-level groups are the sections. Groups nest. Controls, displays, and presets
are leaves.

Making the picker a node — rather than a `presets` field pinned to the top of a
section, which is where an earlier draft left it — is what lets a section put a
preset *among* its controls, and lets one section carry more than one. It also
removes the last thing in the schema that wasn't a node, so "everything in the
panel is a node in `children`" becomes true without exception.

The cost is `oracle/cases.js`, which expands one verify case per declared preset
and today reads `section.presets` directly (`presetMap`, `cases.js:4-14`). It
switches to walking the desugared tree for `kind === "preset"` nodes. That is ten
lines, and it keeps its existing guard that a preset name may not repeat across
the part.

Because the legacy `presets` field desugars to a node at position 0, an existing
part's picker lands exactly where it renders today — first, right under the
section title — while a new-style part is free to place one anywhere.

### What an author writes

```js
parameters: [
  {
    id: "body",
    title: "Body",
    controls: [
      { type: "preset", presets: { "Pen cup": { … }, Vase: { … } } },

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
**Authored order is render order** — which is the whole answer to "can presets and
settings sit together?" They can, in whatever order you write them, and a section
has a collapsible fold only if you nest a group with `collapsed: true`. There is
no "Advanced" concept in the model; it exists solely as the shape legacy
`advanced: [...]` desugars into.

---

## 2. The old shapes become sugar

`desugar` translates the legacy arrays. Nothing on disk changes; the nine
in-repo parts and every downstream part keep working indefinitely.

| Authored | Normalizes to |
|---|---|
| `advanced: [...]` | a child group `{ title: "Advanced", collapsed: "auto", children: [...] }` |
| `toggles: [{ key, label, on }]` | checkbox controls placed directly in the section, before the Advanced group |
| `features: [{ key, on, sliders }]` | per feature: a checkbox control, followed by a group of its sliders carrying `when: { [key]: { gt: 0 } }` — both inside the Advanced group |
| `presets: {...}` | a `preset` node at position 0 — first child, exactly where the picker renders today |
| `control: "slider"` etc. | `type: "slider"` |
| `hidden: true` | kept by `desugar` (lint needs it), dropped by `buildTree` |

The `features` row is the point of the whole exercise. A feature stops being a
special renderer path and becomes an ordinary conditional group.
`buildFeatureSection` is deleted. `features-requires-sliders` and
`features-requires-on` stop describing a hazard and become legacy-shape
validation only, because an author who wants a bare checkbox now writes a
checkbox instead of guessing which array it goes in.

Sugar and the new shape may be mixed within one part but not within one section:
a section that has both `controls` and any of `advanced` / `toggles` / `features`
is a lint error, because the resulting order would be arbitrary.

A group with no visible children is dropped from the tree — the generalization of
today's `sectionRenders`. Note this gets *simpler* once the picker is a node: the
old predicate had to special-case "has presets but no controls", and now a
preset-only section simply has one child.

---

## 3. Collapse and auto-open

Every group's `collapsed` takes `true`, `false`, or `"auto"` (the default).
Explicit values always win. `"auto"` defers to one rule:

> If the panel has **3 or fewer visible top-level sections**, every `"auto"`
> container in the panel starts open. Otherwise they all start closed.

Because legacy `advanced` desugars to `collapsed: "auto"`, existing parts pick
this up for free: `demo.js` and `planter.js` (two sections each) open their
Advanced folds on load, while a part with six sections stays tidy.

The rule is evaluated inside `computeState` (§7) and is unit-tested directly,
with no DOM.

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

Operators live in a lookup table (`{ gt: (a, b) => a > b, … }`), not a `switch`.
That table is the single source of truth: `evalWhen` dispatches through it, and
`when-unknown-operator` builds its did-you-mean list from its keys, so adding an
operator can never leave lint behind.

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

Two mechanisms that can both grey something out is a standing source of "why is
this control like that?" confusion, for users and for whoever debugs it later.
So they must never share a visual treatment: relevance-dimming keeps `.irrelevant`
(opacity only, no interaction change), while `whenFalse: "disable"` renders as a
genuinely disabled control — real `disabled` attributes, no hover response, and
its own class. If the two ever converge visually, the panel becomes unreadable
in exactly the situation where you most need to read it.

---

## 5. Widgets

Existing four keep working: `slider`, `number`, `text`, `textarea`.

| New type | What it is |
|---|---|
| `select` | Dropdown over `options`. Long form `[{ value, label, description? }]`, or the shorthand `["round", "faceted"]` where each string is both value and label. Values may be strings or numbers. |
| `radio` | Same data as `select`, rendered as a segmented control. For 2–4 options where seeing all of them matters. |
| `checkbox` | A bare on/off bound to `on` (default `1`) / `0`. The honest home for a boolean, and what `toggles` desugars to. |
| `readout` | Read-only display of a `derive()` output named by `derivedKey`. Not bound to `defaults`; shows what the part computed. A `display` node, not a control — see §1. |

### The widget registry

Every type — old and new — is declared once, as a pure spec:

```js
// panel/widget-specs.js — pure, DOM-free, dependency-free
{ type: "slider",
  kind: "control",
  fields: ["key","label","unit","min","max","step","scale","ticks",
           "recommended","description","when","whenFalse","hidden"],
  validate(def, ctx) { … }   // returns findings, no DOM
}
```

The DOM factory for each type lives beside it in `panel/widgets/<type>.js` and is
imported only by the renderer.

This is the piece that decides whether the schema stays maintainable. Right now
`rules-schema.js:9-11` hardcodes three field allow-lists (`CONTROL_FIELDS`,
`FEATURE_FIELDS`, `TOGGLE_FIELDS`) that have to be updated by hand whenever a
field is added — and `unknown-control-field` silently warns on any legitimate
field somebody forgot to add there. Deriving those lists from the registry
removes the whole class of bug. Adding a widget becomes: one spec entry, one DOM
factory, one type. Lint, the field allow-list, and the did-you-mean suggestions
all follow automatically, and nothing else is edited.

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

`rules-schema.js` and `rules-animations.js` both switch to consuming `desugar` /
`controlNodes` instead of hand-walking. Both that module and `widget-specs.js`
are dependency-free, so `test/lint-purity.test.js` keeps passing — its allowlist
gains those two.

Existing rules keep working against the canonical tree. `unknown-control-field`
stops carrying hardcoded allow-lists and reads them off the widget registry.

New rules:

| Rule | Severity | Catches |
|---|---|---|
| `when-key-not-in-defaults` | error | a condition on a key that doesn't exist |
| `when-unknown-operator` | error | a typo'd operator, with did-you-mean |
| `select-options-missing` | error | `select`/`radio` with no `options` |
| `select-default-not-in-options` | error | the default value can't be selected |
| `readout-unknown-derived-key` | warn | `derivedKey` no `derive()` group produces |
| `mixed-section-shape` | error | one section using both `controls` and legacy arrays |
| `duplicate-preset-name` | error | the same preset name twice in one part — today this throws from `cases.js:9` at verify time, which is a worse place to find out |
| `group-depth` | warn | nesting past two levels |
| `section-too-many-controls` | warn | one section showing more than ~12 visible controls, suggesting groups |

The last two are the LLM-facing ones: they push toward a panel that is
*organized*, which no amount of field validation can do.

---

## 7. Files

```
src/framework/panel/model.js         pure: buildTree, evalWhen, controlNodes
src/framework/panel/legacy.js        pure: desugar — the only code that knows the old shapes
src/framework/panel/widget-specs.js  pure: the type registry (fields + validators)
src/framework/panel/panel-state.js   pure: computeState(tree, {params, relevant}) -> Map
src/framework/panel/widgets/*.js     one DOM factory per type
src/framework/panel/render.js        thin binder: build DOM, apply state
src/framework/panel/info.js          createInfoPopover, attachInfo (moved)
src/framework/controls.js            public entry; re-exports the above
```

Two things about this shape are deliberate.

**`legacy.js` is quarantined.** All knowledge of `advanced` / `toggles` /
`features` / `control:` lives in exactly one file with a known shelf life. When
the old shapes are eventually dropped, that is one file deleted and one call site
removed — not an archaeology dig through a model module that had grown half
historical.

**`panel-state.js` mirrors `rail-state.js`.** The repo already has this pattern
and it works: `rail-state.js` is a pure drag/collapse state machine and `rail.js`
is the thin thing that binds it to the DOM. The panel has four cross-cutting
concerns that would otherwise tangle inside one render function — relevance
dimming, conditions, open/closed state, and value sync. Instead, one pure
function takes the tree plus the current params and relevant-key set and returns
a `Map<nodeId, { visible, disabled, dimmed, open }>`; `render.js` does nothing
but apply it.

The payoff is that the interaction between conditions and relevance — the part
most likely to produce a subtle bug, since they are two independent systems
acting on the same nodes — becomes testable as a pure function, with no DOM and
no `happy-dom` quirks in the way. It is also why `render.js` can stay small
enough to hold in your head, which the current 364-line `controls.js` (doing
schema interpretation, widget construction, DOM assembly, and popover management
at once) is not.

`controls.js` stays at its path and keeps exporting `buildControls`,
`createInfoPopover`, `attachInfo`, `clampToRange`, `popoverTop`,
`sectionRenders`, `visibleAdvanced`, `visibleFeatures`, and `visibleToggles`.
The popover exports matter beyond the panel: `animation-controls.js:9` imports
them for the transport bar's ⓘ.

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
- **Model unit tests**, no DOM: `desugar` of each legacy shape, `evalWhen` across
  every operator and combinator, `computeState` at the auto-open threshold
  boundary and for every conditions × relevance combination.
- **Registry coherence test**: every type in `widget-specs.js` has a DOM factory,
  a type declaration, and appears in the authoring guide. This is what stops the
  three from drifting the way the three schema walkers did.
- **Widget tests** per new type: renders, binds, syncs, fires `onDirty`.
- **Condition tests**: hide vs. disable, group subtrees, interaction with
  `.irrelevant`.
- **Lint tests** for each new rule, in `test/lint-schema.test.js`.
- **`test/lint-purity.test.js`** must still pass with lint importing
  `panel/model.js`.

## 12. Phasing

Each phase is a reviewable PR. Per `AGENTS.md`, the version bump rides on the
branch.

1. **Pure refactor.** Extract `panel/`, add `legacy.js` + `model.js` +
   `widget-specs.js` + `panel-state.js`, render from the tree. **Zero behavior
   change** — all 27 tests in `test/framework/controls.test.js` pass completely
   unmodified, and the DOM is byte-identical. Nothing new is authorable.
2. **Lint onto the shared model.** `rules-schema.js` and `rules-animations.js`
   switch to `desugar` / `controlNodes`; allow-lists derive from the registry.
   `test/lint-schema.test.js` passes unmodified.
3. **Collapsible sections.** Disclosure markup, `collapsed`, the auto-open rule.
   The first phase with a visible change, and the only one that touches
   `app.css`.
4. **The authorable shape.** Accept `controls`, nested groups, `collapsed`, and
   `preset` nodes from authors; `oracle/cases.js` walks the tree; types and the
   `mixed-section-shape` and `duplicate-preset-name` lint rules.
5. **Widgets.** `select`, `radio`, `checkbox`, `readout`, and the three slider
   refinements — each with its registry spec, lint validator, and type.
6. **Conditions.** `when` / `whenFalse`, `refresh`, the four condition lint rules.
7. **Docs and parts.** Rewrite the authoring guide, add the remaining structural
   lint rules, enrich `bracket.js` and `planter.js`.

**Phase 4 was missing from an earlier draft of this spec**, which went straight
from collapsible sections to widgets. Nothing in it made the new shape
*authorable* — `desugar` handled the old shapes and no phase handled the new one,
so the design's central feature was unscheduled. It belongs before widgets, not
after: a new control type with nowhere good to put it is half a feature, and
flat sections with opt-in folds are worth more to an author than any single
widget.

Phases 1–3 replace what an earlier draft called a single "model + parity" phase.
That phase bundled a module extraction, a desugaring layer, a rendering rewrite,
a lint migration, and a visible UI change — while claiming a regression in it
would be easy to bisect, which is plainly false. Split this way, each phase is
independently revertible, and phases 1 and 2 are provable: if any existing test
needed editing, something changed that shouldn't have.

**No phase ships a schema capability without the lint rule that guards it.**
Every field added here is a field an LLM can get wrong, so shipping phase 4 or 5
with validators deferred to phase 6 would make authoring measurably worse in the
interim. The validators travel with their widget specs, which is most of why the
registry is shaped the way it is.

## 13. Risks

- **Parity regressions in phase 1** are the main hazard — the desugar of
  `features` in particular has to reproduce the exact check/reveal behavior
  including the `syncs.forEach` on enable and the `params[key] = 0` on disable.
  The mitigation is that phase 1 is a pure refactor with an unmodified test
  suite: any test that needs editing is a regression by definition.
- **Two systems acting on the same nodes.** Conditions and relevance are
  independent by design, but that means every node has two reasons to be
  unavailable. `computeState` returning both flags from one pure function is what
  keeps that debuggable; if it ever grows a third mechanism, revisit.
- **`section-too-many-controls` is a judgment call.** Twelve is a guess. It ships
  as a warning, and the threshold should be revisited after seeing real
  LLM-authored parts.
- **Downstream corpus.** `partforge-cloud` regenerates its prompt corpus against
  the installed package, so the `AUTHORING-PARTS.md` rewrite in phase 4 is what
  actually changes what LLMs write. The publish must land before the dep bump
  there.
