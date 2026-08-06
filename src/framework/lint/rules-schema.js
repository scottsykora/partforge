// Group 2 — the parameter schema that src/framework/controls.js turns into the panel.
// Two failure modes drive this group: a shape controls.js reads without guarding
// (features[].sliders at controls.js:313, an unguarded .filter), and keys that don't
// resolve against `defaults`, which produce a control that silently does nothing.
import { err, warn } from "./finding.js";
import { suggest } from "../geometry/op-options.js";

// Fields controls.js reads on a slider/number descriptor.
const CONTROL_FIELDS = ["key", "label", "unit", "min", "max", "step", "control", "hidden", "description"];
const FEATURE_FIELDS = ["key", "label", "on", "sliders", "hidden", "description"];
const TOGGLE_FIELDS = ["key", "label", "on", "hidden", "description"];

const sections = (part) => (Array.isArray(part?.parameters) ? part.parameters : []);
const arr = (x) => (Array.isArray(x) ? x : []);
const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// Every (descriptor, path, allowed-fields) triple that owns a parameter key, across
// all four section kinds. A feature's own `sliders` are collected too, since each
// slider is a full control descriptor in its own right.
function collectDescriptors(part) {
  const out = [];
  sections(part).forEach((sec, si) => {
    arr(sec?.advanced).forEach((d, i) => {
      if (d) out.push({ d, path: `parameters[${si}].advanced[${i}]`, fields: CONTROL_FIELDS });
    });
    arr(sec?.features).forEach((f, i) => {
      if (!f) return;
      out.push({ d: f, path: `parameters[${si}].features[${i}]`, fields: FEATURE_FIELDS });
      arr(f.sliders).forEach((s, j) => {
        // Tag with the owning feature's key so slider-range-excludes-default can
        // recognise the demo.js flange_d pattern below: a slider sharing its key
        // with the feature is not an independent parameter, it's the feature's own
        // magnitude, and `defaults[key] === 0` there means "off", not "out of range".
        if (s) out.push({ d: s, path: `parameters[${si}].features[${i}].sliders[${j}]`, fields: CONTROL_FIELDS, featureKey: f.key });
      });
    });
    arr(sec?.toggles).forEach((t, i) => {
      if (t) out.push({ d: t, path: `parameters[${si}].toggles[${i}]`, fields: TOGGLE_FIELDS });
    });
  });
  return out;
}

const defaultKeys = (part) => new Set(Object.keys(part?.defaults ?? {}));

// Mirrors src/framework/controls.js's own visibility predicates (visibleFeatures /
// sectionRenders, controls.js:32,36-41) — NOT imported, because controls.js pulls in
// `marked`/`dompurify` (via markdown.js) for its description popovers, which would
// break partforge/lint's zero-bare-dependency purity guarantee (test/lint-purity.test.js).
// `features-requires-sliders` must not flag a `feat.sliders.filter(...)` the panel
// will never reach: controls.js only iterates `visibleFeatures(sec)` (skipping any
// feature marked `hidden: true`), and only builds a section at all when
// `sectionRenders(sec)` is true.
const visibleFeatures = (sec) => arr(sec?.features).filter((f) => f && !f.hidden);
function sectionRenders(sec) {
  if (sec?.hidden) return false;
  if (sec?.features) return visibleFeatures(sec).length > 0;
  const hasPresets = sec?.presets && Object.keys(sec.presets).length > 0;
  return !!hasPresets || arr(sec?.advanced).some((d) => d && !d.hidden) || arr(sec?.toggles).some((t) => t && !t.hidden);
}

export const SCHEMA_RULES = [
  {
    id: "features-requires-sliders",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        // A feature the panel will never reach can't crash it: skip the whole
        // section when it never renders at all (sectionRenders), and skip any
        // individual feature the panel skips via `hidden: true` (visibleFeatures'
        // own filter condition, restated inline rather than built into a Set).
        if (!sectionRenders(sec)) return;
        arr(sec?.features).forEach((f, i) => {
          if (f && !f.hidden && !Array.isArray(f.sliders)) {
            out.push(err("features-requires-sliders",
              `section "${sec.id ?? si}" feature ${i} has no \`sliders\` array`,
              "A `features` entry must carry a `sliders` array — the control panel reads it unguarded, so a missing one throws \"Cannot read properties of undefined (reading 'filter')\". A bare on/off control belongs in `toggles` instead.",
              `parameters[${si}].features[${i}]`,
              "features-missing-sliders"));
          }
        });
      });
      return out;
    },
  },
  {
    id: "features-requires-on",
    run: ({ part }) => {
      const out = [];
      sections(part).forEach((sec, si) => {
        if (!sectionRenders(sec)) return;
        arr(sec?.features).forEach((f, i) => {
          // The panel treats "enabled" as `params[key] > 0`, so `on` has to be a
          // positive number: a missing one writes undefined (NaN in the build),
          // and 0 or a negative writes a value the panel reads straight back as
          // "still off", leaving a checkbox that won't stay ticked.
          if (f && !f.hidden && !(typeof f.on === "number" && f.on > 0)) {
            out.push(err("features-requires-on",
              `section "${sec.id ?? si}" feature ${i}${f.key ? ` ("${f.key}")` : ""} has no positive numeric \`on\` value`,
              "Ticking a feature's checkbox writes `on` into the feature's own parameter, so a missing one writes `undefined` and the build reads it as NaN. Unlike a `toggles` entry — a plain flag that falls back to 1 — a feature's `on` is the real value the parameter takes when enabled (a diameter, a count), so there is no safe default to guess. It must be greater than 0, because the panel reads `> 0` as \"enabled\". Give the feature the value it should switch on to.",
              `parameters[${si}].features[${i}]`));
          }
        });
      });
      return out;
    },
  },
  {
    id: "control-key-not-in-defaults",
    run: ({ part }) => {
      // Only skip when `defaults` isn't a plain object at all (missing-defaults
      // already reports that) — an explicit `defaults: {}` must still be checked,
      // otherwise every control key in the part is silently unreachable and dead.
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      return collectDescriptors(part)
        .filter(({ d }) => typeof d.key === "string" && !known.has(d.key))
        .map(({ d, path }) => err("control-key-not-in-defaults",
          `control key "${d.key}" is not in \`defaults\``,
          `Add "${d.key}" to \`defaults\`${suggest(d.key, [...known]) ? `, or correct it to "${suggest(d.key, [...known])}"` : ""} — a control whose key is absent from defaults is silently dead and never reaches the build.`,
          `${path}.key`));
    },
  },
  {
    id: "preset-key-not-in-defaults",
    run: ({ part }) => {
      // Same guard as control-key-not-in-defaults: only bail when `defaults` is
      // entirely absent (or not an object), not merely empty.
      if (!isPlainObject(part?.defaults)) return [];
      const known = defaultKeys(part);
      const out = [];
      sections(part).forEach((sec, si) => {
        const presets = sec?.presets;
        if (!presets || typeof presets !== "object") return;
        for (const [name, bundle] of Object.entries(presets)) {
          if (!bundle || typeof bundle !== "object") continue;
          for (const key of Object.keys(bundle)) {
            if (known.has(key)) continue;
            const hint = suggest(key, [...known]);
            out.push(err("preset-key-not-in-defaults",
              `preset "${name}" sets "${key}", which is not in \`defaults\``,
              `Add "${key}" to \`defaults\`${hint ? `, or correct it to "${hint}"` : ""} — a preset field absent from defaults is dropped, so selecting the preset silently does nothing for it.`,
              `parameters[${si}].presets[${JSON.stringify(name)}].${key}`));
          }
        }
      });
      return out;
    },
  },
  {
    id: "slider-range-excludes-default",
    run: ({ part }) => {
      const defaults = part?.defaults ?? {};
      return collectDescriptors(part)
        // A slider that shares its key with the feature that owns it (demo.js's
        // flange_d) is exempt ONLY when the default is actually the feature's
        // off-sentinel: controls.js sets `params[feat.key] = 0` on uncheck (and
        // reads `params[feat.key] > 0` to decide checked state), so `0` there means
        // "off", not "out of range". Matching keys alone isn't enough — a mistyped
        // non-zero "on" default (e.g. 999 against an 8..50 slider) is exactly the
        // authoring mistake this rule exists to catch, and must still warn.
        .filter(({ d, featureKey }) => !(featureKey !== undefined && featureKey === d.key && defaults[d.key] === 0))
        .filter(({ d }) => typeof d.key === "string"
          && typeof defaults[d.key] === "number"
          && (typeof d.min === "number" || typeof d.max === "number")
          && ((typeof d.min === "number" && defaults[d.key] < d.min)
            || (typeof d.max === "number" && defaults[d.key] > d.max)))
        .map(({ d, path }) => warn("slider-range-excludes-default",
          `\`defaults.${d.key}\` is ${defaults[d.key]}, outside this control's range ${d.min ?? "-∞"}..${d.max ?? "∞"}`,
          `Widen the control's min/max or move \`defaults.${d.key}\` inside the range — as it stands the panel clamps the value on first render, so the geometry the user sees is not the geometry the defaults describe.`,
          path));
    },
  },
  {
    id: "unknown-control-field",
    run: ({ part }) => {
      const out = [];
      for (const { d, path, fields } of collectDescriptors(part)) {
        for (const key of Object.keys(d)) {
          if (fields.includes(key)) continue;
          const hint = suggest(key, fields);
          out.push(warn("unknown-control-field",
            `unrecognised control field "${key}"`,
            `The control panel ignores "${key}"${hint ? ` — did you mean "${hint}"?` : ` (recognised: ${fields.join(", ")}).`}`,
            `${path}.${key}`));
        }
      }
      return out;
    },
  },
  {
    id: "duplicate-control-key",
    run: ({ part }) => {
      const seen = new Map();
      const out = [];
      for (const { d, path } of collectDescriptors(part)) {
        if (typeof d.key !== "string") continue;
        // A feature and its own slider legitimately share a key (see demo.js's
        // flange_d), so only flag a repeat that crosses to a different owner path.
        const root = path.replace(/\.sliders\[\d+\]$/, "");
        if (seen.has(d.key) && seen.get(d.key) !== root) {
          out.push(warn("duplicate-control-key",
            `parameter key "${d.key}" is owned by more than one control`,
            `Two controls writing "${d.key}" fight over the same value — rename one, or remove the duplicate.`,
            path));
        } else if (!seen.has(d.key)) {
          seen.set(d.key, root);
        }
      }
      return out;
    },
  },
  {
    id: "default-not-exposed",
    run: ({ part }) => {
      if (sections(part).length === 0) return []; // no panel declared at all — nothing to expose
      const exposed = new Set(collectDescriptors(part).map(({ d }) => d.key).filter(Boolean));
      for (const sec of sections(part)) {
        for (const bundle of Object.values(sec?.presets ?? {})) {
          for (const key of Object.keys(bundle ?? {})) exposed.add(key);
        }
      }
      return Object.keys(part?.defaults ?? {})
        .filter((key) => !exposed.has(key))
        .map((key) => warn("default-not-exposed",
          `\`defaults.${key}\` is not referenced by any control`,
          `Either add a control for "${key}" or leave it as an intentional internal constant — a hidden control (\`hidden: true\`) counts as exposing it, and is the documented way to keep a build-only value out of the panel.`,
          `defaults.${key}`));
    },
  },
];
