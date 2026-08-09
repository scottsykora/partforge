// Everything this project knows about the ORIGINAL parameter-schema shapes —
// `advanced`, `toggles`, `features`, and the `control:` field — lives here and
// nowhere else. Those shapes still work and still ship; when they are eventually
// retired, this is one file to delete rather than an archaeology dig through the
// model.
//
// Imports author.js, on purpose: partforge/lint consumes desugar() and
// test/lint-purity.test.js asserts lint's whole import closure has zero bare
// dependencies.

import { authoredSection } from "./author.js";

const arr = (x) => (Array.isArray(x) ? x : []);

// --- the legacy visibility predicates (unchanged behavior) ------------------
// Guarded per-entry (`x && !x.hidden`) and per-section (`sec?.`) because a null
// entry or a missing section is anticipated malformed input here: lint's
// collectDescriptors walks the very same arrays with the same per-entry guard,
// and it must be able to walk a broken part in order to report on it, rather
// than have the walk itself throw.
export const visibleAdvanced = (sec) => arr(sec?.advanced).filter((d) => d && !d.hidden);
export const visibleFeatures = (sec) => arr(sec?.features).filter((f) => f && !f.hidden);
export const visibleToggles = (sec) => arr(sec?.toggles).filter((t) => t && !t.hidden);

export function sectionRenders(sec) {
  if (sec?.hidden) return false;
  if (sec?.features) return visibleFeatures(sec).length > 0;
  const hasPresets = sec?.presets && Object.keys(sec.presets).length > 0;
  return !!hasPresets || visibleAdvanced(sec).length > 0 || visibleToggles(sec).length > 0;
}

// --- desugaring -------------------------------------------------------------

// One legacy control descriptor -> a control node. `marksCustom` records the
// legacy split at controls.js:302 vs :346 — a preset-section control drops its
// picker to "Custom" when synced externally, a feature's own slider does not.
const toControl = (d, marksCustom) => ({
  kind: "control",
  key: d.key,
  type: d.control ?? "slider",
  label: d.label,
  description: d.description,
  unit: d.unit,
  min: d.min,
  max: d.max,
  step: d.step,
  hidden: !!d.hidden,
  marksCustom,
});

const toCheckbox = (d, { preserveOn, on }) => ({
  kind: "control",
  key: d.key,
  type: "checkbox",
  label: d.label,
  description: d.description,
  on,
  preserveOn,
  hidden: !!d.hidden,
});

// A legacy feature -> [checkbox, bare group of its sliders gated on the checkbox].
// This is the whole point of the exercise: a feature stops being a special
// renderer path and becomes an ordinary conditional group.
function featureNodes(f) {
  const box = toCheckbox(f, { preserveOn: true, on: f.on });
  const group = {
    kind: "group",
    bare: true,
    hidden: !!f.hidden,
    when: { [f.key]: { gt: 0 } },
    children: arr(f.sliders).filter(Boolean).map((s) => toControl(s, false)),
  };
  return [box, group];
}

export function desugar(parameters) {
  return arr(parameters).map((sec) => {
    // The NEW shape: children live in `controls`. author.js owns it entirely;
    // when both `controls` and legacy arrays appear (a lint error,
    // mixed-section-shape), `controls` wins — same winner-takes-all routing the
    // features branch below applies to the legacy shapes.
    if (Array.isArray(sec?.controls)) return authoredSection(sec);

    const children = [];

    // controls.js:180 routes any section with a truthy `features` field
    // exclusively to buildFeatureSection, which never reads `presets`,
    // `toggles`, or `advanced` — so a features section desugars to ONLY its
    // Advanced group of feature nodes, matching that legacy routing exactly.
    if (sec?.features) {
      const advChildren = [];
      for (const f of arr(sec.features)) {
        if (f) advChildren.push(...featureNodes(f));
      }
      if (advChildren.length) {
        children.push({ kind: "group", title: "Advanced", collapsed: "auto",
          legacyAdvanced: true, children: advChildren }); // read by nothing yet; phase 4's migration tooling will key on it
      }
      return {
        kind: "group",
        id: sec?.id,
        title: sec?.title,
        description: sec?.description,
        collapsed: "auto",
        hidden: !!sec?.hidden,
        children,
      };
    }

    // The picker is a node like everything else, placed first — which is exactly
    // where controls.js:264-274 rendered it, so an existing part is unchanged
    // while a new-style part can position one anywhere in `controls`.
    const presetNames = sec?.presets ? Object.keys(sec.presets) : [];
    if (presetNames.length) {
      children.push({ kind: "preset", presets: sec.presets, hidden: false });
    }

    // Toggles sit directly in the section, before the Advanced fold, exactly as
    // controls.js:278-289 rendered them.
    for (const t of arr(sec?.toggles)) {
      if (t) children.push(toCheckbox(t, { preserveOn: false, on: t.on ?? 1 }));
    }

    // Everything else lands inside an "Advanced" group. `collapsed: "auto"` is
    // what later hands these folds to the small-panel auto-open rule.
    const advChildren = [];
    for (const d of arr(sec?.advanced)) {
      if (d) advChildren.push(toControl(d, true));
    }
    if (advChildren.length) {
      children.push({ kind: "group", title: "Advanced", collapsed: "auto",
        legacyAdvanced: true, children: advChildren });
    }

    return {
      kind: "group",
      id: sec?.id,
      title: sec?.title,
      description: sec?.description,
      collapsed: "auto",
      hidden: !!sec?.hidden,
      children,
    };
  });
}
