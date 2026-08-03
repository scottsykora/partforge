// Group 5 — the `animations` block (spec 2026-08-02-model-animation-design.md).
// Everything but the last rule is static data validation: the block is pure
// keyframe data by design, so lint can hold every track to the schema without
// executing author code. `animation-track-rebuilds` is the exception — it runs
// the geometry-free pose probe to classify each track as pose-only or
// geometry-rebuilding, and reports the latter at the note tier.
import { err, note } from "./finding.js";
import { EASINGS } from "../animation.js";
import { CANONICAL_VIEWS } from "../view-angles.js";
import { probeSubPartPose } from "../pose-probe-core.js";
import { resolveDerived } from "../derive.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// [name, spec] pairs, only when the block is well-shaped enough to walk.
const animEntries = (part) =>
  isPlainObject(part?.animations)
    ? Object.entries(part.animations).filter(([, a]) => isPlainObject(a))
    : [];

// Steps in normalized-adjacent form for rule walks (does NOT validate — each
// rule checks its own slice). A bare-tracks animation is one anonymous step.
const rawSteps = (a) => (Array.isArray(a.steps) ? a.steps.filter(isPlainObject) : [{ ...a, label: null }]);

// The control descriptor ranges, for value-in-range checks. Mirrors
// rules-schema.js's collectDescriptors walk (not shared: each group owns its
// own walk by design — see lint/index.js header).
function paramRanges(part) {
  const ranges = new Map();
  const secs = Array.isArray(part?.parameters) ? part.parameters : [];
  const add = (d) => {
    if (d && typeof d.key === "string" && !ranges.has(d.key)) ranges.set(d.key, { min: d.min, max: d.max });
  };
  for (const sec of secs) {
    for (const d of Array.isArray(sec?.advanced) ? sec.advanced : []) add(d);
    for (const f of Array.isArray(sec?.features) ? sec.features : []) {
      for (const s of Array.isArray(f?.sliders) ? f.sliders : []) add(s);
    }
  }
  return ranges;
}

const validKeyframes = (kf) =>
  Array.isArray(kf) && kf.length >= 2
  && kf.every((e) => Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]) && Number.isFinite(e[1]))
  && kf[0][0] === 0 && kf[kf.length - 1][0] === 1
  && kf.every((e, i) => i === 0 || e[0] > kf[i - 1][0]);

export const ANIMATION_RULES = [
  {
    id: "animations-not-object",
    run: ({ part }) => {
      if (part?.animations === undefined) return [];
      if (!isPlainObject(part.animations)) {
        return [err("animations-not-object", "`animations` is not a plain object",
          "Declare animations as `animations: { <name>: { duration, tracks } }` — see docs/AUTHORING-PARTS.md \"Animations\".",
          "animations")];
      }
      return Object.entries(part.animations)
        .filter(([, a]) => !isPlainObject(a))
        .map(([name]) => err("animations-not-object", `animation "${name}" is not a plain object`,
          "Each animations entry must be an object with `duration` + `tracks`, or `steps`.",
          `animations.${name}`));
    },
  },
  {
    id: "animation-tracks-or-steps",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        const hasTracks = a.tracks !== undefined;
        const hasSteps = a.steps !== undefined;
        if (hasTracks === hasSteps) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" must have exactly one of \`tracks\` or \`steps\``,
            "A single-phase animation declares `tracks` directly; a stepped one declares `steps: [{ label, duration, tracks }]`. Never both, never neither.",
            `animations.${name}`));
          continue;
        }
        if (hasSteps && (!Array.isArray(a.steps) || a.steps.length === 0 || !a.steps.every(isPlainObject))) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" has an empty or malformed \`steps\` array`,
            "`steps` must be a non-empty array of `{ label, duration, tracks }` objects.",
            `animations.${name}.steps`));
          continue;
        }
        rawSteps(a).forEach((s, i) => {
          const path = hasSteps ? `animations.${name}.steps[${i}].tracks` : `animations.${name}.tracks`;
          if (!isPlainObject(s.tracks) || Object.keys(s.tracks).length === 0) {
            out.push(err("animation-tracks-or-steps",
              `animation "${name}"${hasSteps ? ` step ${i}` : ""} has no tracks`,
              "Every step needs a non-empty `tracks` object mapping a param key to keyframes.",
              path));
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-unknown-param",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = new Set(Object.keys(part.defaults));
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!known.has(key)) {
              out.push(err("animation-unknown-param",
                `animation "${name}" tracks "${key}", which is not in \`defaults\``,
                `Animations drive existing params — add "${key}" to \`defaults\` (and a control for it), or correct the key.`,
                `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-param-not-numeric",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (key in part.defaults && typeof part.defaults[key] !== "number") {
              out.push(err("animation-param-not-numeric",
                `animation "${name}" tracks "${key}", whose default is not a number`,
                "v1 animations interpolate numeric params only — text/choice params cannot be keyframed.",
                `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-keyframes-invalid",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!validKeyframes(kf)) {
              out.push(err("animation-keyframes-invalid",
                `animation "${name}" track "${key}" has invalid keyframes`,
                "Keyframes are `[[t, value], …]` with finite numbers, at least two entries, `t` strictly ascending from exactly 0 to exactly 1.",
                `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-value-out-of-range",
    run: ({ part }) => {
      const ranges = paramRanges(part);
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            const r = ranges.get(key);
            if (!r || !validKeyframes(kf)) continue;
            for (const [, v] of kf) {
              if ((typeof r.min === "number" && v < r.min) || (typeof r.max === "number" && v > r.max)) {
                out.push(err("animation-value-out-of-range",
                  `animation "${name}" track "${key}" keyframe value ${v}, outside the control's range ${r.min ?? "-∞"}..${r.max ?? "∞"}`,
                  "Keyframe values are applied as-is (the engine does not clamp) — widen the control's range or move the keyframe inside it.",
                  `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
                break; // one finding per track
              }
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-duration-invalid",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          if (!(typeof s.duration === "number" && Number.isFinite(s.duration) && s.duration > 0)) {
            out.push(err("animation-duration-invalid",
              `animation "${name}"${a.steps ? ` step ${i}` : ""} has no positive \`duration\``,
              "Every animation (or step) needs a finite `duration` in seconds, greater than 0.",
              `animations.${name}${a.steps ? `.steps[${i}]` : ""}.duration`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-loop-invalid",
    run: ({ part }) => animEntries(part)
      .filter(([, a]) => a.loop === true && Array.isArray(a.steps) && a.steps.length > 1)
      .map(([name]) => err("animation-loop-invalid",
        `animation "${name}" sets \`loop: true\` on a multi-step animation`,
        "Loop is for continuous single-phase motion (gears). A stepped sequence replays via the transport instead — drop `loop` or collapse to one step.",
        `animations.${name}.loop`)),
  },
  {
    id: "animation-step-label-duplicate",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        if (!Array.isArray(a.steps)) continue;
        const seen = new Set();
        a.steps.forEach((s, i) => {
          const label = s?.label;
          if (typeof label !== "string") return;
          if (seen.has(label)) {
            out.push(err("animation-step-label-duplicate",
              `animation "${name}" repeats the step label "${label}"`,
              "Step labels identify steps in the transport UI and the CLI's `--step <label>` — make each unique.",
              `animations.${name}.steps[${i}].label`));
          }
          seen.add(label);
        });
      }
      return out;
    },
  },
  {
    id: "animation-easing-unknown",
    run: ({ part }) => {
      const out = [];
      const check = (easing, path) => {
        if (easing !== undefined && !(easing in EASINGS)) {
          out.push(err("animation-easing-unknown",
            `unknown easing "${easing}"`,
            `Use one of: ${Object.keys(EASINGS).join(", ")}.`,
            path));
        }
      };
      for (const [name, a] of animEntries(part)) {
        check(a.easing, `animations.${name}.easing`);
        if (Array.isArray(a.steps)) a.steps.forEach((s, i) => check(s?.easing, `animations.${name}.steps[${i}].easing`));
      }
      return out;
    },
  },
  {
    id: "animation-camera-invalid",
    run: ({ part }) => {
      const out = [];
      const badName = (v) => typeof v !== "string" || !CANONICAL_VIEWS.includes(v);
      for (const [name, a] of animEntries(part)) {
        const stepCameras = Array.isArray(a.steps)
          ? a.steps.map((s, i) => [s?.camera, i]).filter(([c]) => c !== undefined && c !== null)
          : [];
        if (a.camera !== undefined && stepCameras.length) {
          out.push(err("animation-camera-invalid",
            `animation "${name}" mixes an animation-level \`camera\` with per-step cameras`,
            "One camera mechanism per animation: either the animation-level name/cue-list, or per-step names — not both.",
            `animations.${name}.camera`));
        }
        for (const [cam, i] of stepCameras) {
          if (badName(cam)) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" step ${i} camera "${cam}" is not a canonical angle`,
              `Camera cues use the canonical angles: ${CANONICAL_VIEWS.join(", ")}.`,
              `animations.${name}.steps[${i}].camera`));
          }
        }
        if (a.camera === undefined) continue;
        if (typeof a.camera === "string") {
          if (badName(a.camera)) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" camera "${a.camera}" is not a canonical angle`,
              `Camera cues use the canonical angles: ${CANONICAL_VIEWS.join(", ")}.`,
              `animations.${name}.camera`));
          }
        } else if (Array.isArray(a.camera)) {
          const cues = a.camera;
          const wellFormed = cues.length > 0 && cues.every((c) =>
            Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && c[0] >= 0 && c[0] <= 1 && !badName(c[1]));
          const sorted = cues.every((c, i) => i === 0 || (Array.isArray(c) && Array.isArray(cues[i - 1]) && c[0] > cues[i - 1][0]));
          if (!wellFormed || !sorted) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" has an invalid camera cue list`,
              `Cues are \`[[t, angle], …]\` with t strictly ascending in 0..1 and angles from: ${CANONICAL_VIEWS.join(", ")}.`,
              `animations.${name}.camera`));
          }
        } else {
          out.push(err("animation-camera-invalid",
            `animation "${name}" \`camera\` is neither an angle name nor a cue list`,
            "Use a canonical angle string, or `[[t, angle], …]` cues.",
            `animations.${name}.camera`));
        }
      }
      return out;
    },
  },
  {
    id: "animation-description-invalid",
    run: ({ part }) => animEntries(part)
      .filter(([, a]) => a.description !== undefined && typeof a.description !== "string")
      .map(([name]) => err("animation-description-invalid",
        `animation "${name}" \`description\` is not a string`,
        "The description is CommonMark shown behind the ⓘ glyph — supply a string or omit it.",
        `animations.${name}.description`)),
  },
  {
    // note tier: performance shape, not correctness. A track whose param feeds
    // real geometry still plays — just best-effort at worker cadence instead
    // of frame rate — and the authoring agent should know which it wrote.
    id: "animation-track-rebuilds",
    run: ({ part, p }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        const steps = rawSteps(a);
        // value range per key: the min and max across every keyframe value the
        // key ever takes, over every step that tracks it — not just the first
        // and last keyframe, so an out-and-back track (e.g. a hinge cycle that
        // returns to its start) still compares two genuinely different values.
        const valueRange = new Map();
        for (const s of steps) {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!validKeyframes(kf)) continue; // keyframes rule already reported it
            for (const [, v] of kf) {
              if (!valueRange.has(key)) valueRange.set(key, [v, v]);
              else {
                const range = valueRange.get(key);
                if (v < range[0]) range[0] = v;
                if (v > range[1]) range[1] = v;
              }
            }
          }
        }
        for (const [key, [v0, v1]] of valueRange) {
          if (typeof part?.defaults?.[key] !== "number") continue; // other rules own that
          const cls = classifyTrack(part, p, key, v0, v1);
          if (cls === "pose") continue;
          out.push(note("animation-track-rebuilds",
            cls === "rebuild"
              ? `animation "${name}" track "${key}" rebuilds geometry — playback is best-effort, not frame-rate`
              : `animation "${name}" track "${key}" cannot use the pose fast path (untrusted probe) — playback is best-effort`,
            "Frame-rate playback needs the param to feed only rigid placement (translate/rotate in `place()` or at the end of `build`). If that's the intent, restructure so the param never feeds a geometry op, a query, or a function selector; if geometry morphing is the intent, this is expected.",
            `animations.${name}`));
        }
      }
      return out;
    },
  },
];

// Classify one animated param by probing every sub-part it can show, at the
// track's two endpoint values: identical trusted baseHashes at both ends →
// the param only re-poses ("pose"); differing hashes → real geometry
// ("rebuild"); any untrusted probe → "untrusted" (the fast path will decline
// it at runtime too). Mirrors the runtime trust model in pose-probe-core.js.
function classifyTrack(part, p, key, v0, v1) {
  let result = "pose";
  for (const view of Object.keys(isPlainObject(part?.views) ? part.views : {})) {
    for (const sp of Object.values(isPlainObject(part?.parts) ? part.parts : {})) {
      if (!Array.isArray(sp?.views) || !sp.views.includes(view)) continue;
      const probes = [];
      for (const v of [v0, v1]) {
        const pv = { ...p, [key]: v };
        let dv;
        try { dv = resolveDerived(part, pv) ?? {}; } catch { return "untrusted"; }
        try { if (sp.enabled && !sp.enabled(pv)) { probes.push(null); continue; } } catch { return "untrusted"; }
        probes.push(probeSubPartPose(sp, { view, purpose: "display", p: pv, d: dv }));
      }
      if (probes.some((x) => x && !x.trusted)) return "untrusted";
      const [a, b] = probes;
      if (a && b && a.baseHash !== b.baseHash) result = "rebuild";
    }
  }
  return result;
}
