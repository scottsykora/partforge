// Group 8 — font-control well-formedness. Both conditions here are silent
// failures at runtime rather than errors: a picker bound to a key no `fonts`
// declaration reads changes a param and nothing else (the typeface never
// moves), and a default outside its own `allow` list is swapped for… itself,
// which is to say the part boots with no font at all.
//
// Detecting "does the fonts function read this key?" without executing the
// function is impossible in general, so the rule asks the cheaper, honest
// question: is `fonts` a function at all? A static `fonts` provably cannot
// depend on a param.
import { err, warn } from "./finding.js";
import { fontControlAllows, fontSourceAllowed, isNoFontSource } from "../font-source.js";

export const FONT_RULES = [
  {
    id: "font-control-not-in-fonts",
    run: ({ part }) => {
      const controls = fontControlAllows(part);
      if (controls.size === 0 || typeof part?.fonts === "function") return [];
      return [...controls.keys()].map((key) => err("font-control-not-in-fonts",
        `control "${key}" is a font picker, but this part's \`fonts\` is ${part?.fonts ? "a static object" : "missing"} — the picked value is never resolved.`,
        `Declare fonts as a function of params, e.g. fonts: (p) => ({ ${key}: p.${key} }), and reference it with k.text2d(str, { font: "${key}" }).`,
        "fonts"));
    },
  },
  {
    id: "font-source-scheme",
    run: ({ part }) => {
      const out = [];
      for (const [key, allow] of fontControlAllows(part)) {
        const v = part?.defaults?.[key];
        // An empty source declares nothing (jobs.js filters exactly these out
        // before resolveFonts, and text2d falls back to the bundled Roboto),
        // which is a legitimate way to author an optional typeface — not a
        // source the allow list is refusing.
        if (isNoFontSource(v) || fontSourceAllowed(v, allow)) continue;
        out.push(warn("font-source-scheme",
          `defaults.${key} is "${String(v).slice(0, 120)}", which control "${key}" would refuse (allow: ${allow.join(", ")}).`,
          `Use a source the allow list accepts, or widen \`allow\` on the control. At build time this value is replaced by defaults.${key}, so as written the part has no usable font.`,
          "defaults"));
      }
      return out;
    },
  },
];
