// Group 10 — image-control well-formedness + heightfield name resolution. The
// sibling of rules-fonts.js for the `type: "image"` control / `images` field /
// `k.heightfield()` triangle: same silent-failure shapes, same source-scheme
// concern, plus one this group owns alone — a `k.heightfield(name, opts)` call
// naming an image the part never declared.
//
// image-control-not-in-images and heightfield-unknown-image are deliberately
// COMPLEMENTARY, not overlapping: each fires in exactly the case the other
// skips. A function-form `images` can depend on a param — good, but its return
// value can't be read without calling it, so image-control-not-in-images
// actually calls it (with a sentinel substituted for the control's key) rather
// than settling for font-control-not-in-fonts's cheaper "is it a function at
// all?" question; a static `images` object provably CANNOT depend on a
// param — that mistake belongs to image-control-not-in-images too, and would
// fire on every correctly-authored fixed-image part if this rule also ran
// there, so it is skipped entirely for a static `images`. Conversely, only a
// static `images` object has statically-knowable keys, so heightfield-unknown-
// image runs only there and skips whenever `images` is a function.
import { err, warn } from "./finding.js";
import { imageControlAllows, imageSourceAllowed, isNoImageSource } from "../image-source.js";

// A URL-shaped sentinel (has a "://"), not an arbitrary string — some `images`
// functions run `new URL(v)` or similar on the value before deciding whether to
// use it, and an arbitrary string would make that throw and short-circuit the
// probe for reasons that have nothing to do with whether the key is read.
const SENTINEL = "pf-lint-sentinel://image-control-not-in-images";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export const IMAGE_RULES = [
  {
    id: "image-control-not-in-images",
    run: ({ part, p }) => {
      // Static-object `images` always fails this check by construction — it
      // cannot read a param at all — so it is a different mistake
      // (image-source-scheme's business, or none) and not this rule's.
      if (typeof part?.images !== "function") return [];
      const controls = imageControlAllows(part);
      if (controls.size === 0) return [];
      const out = [];
      for (const key of controls.keys()) {
        let resolved;
        try { resolved = part.images({ ...p, [key]: SENTINEL }); }
        catch { continue; } // can't be probed safely — not evidence either way
        const reached = isPlainObject(resolved) && Object.values(resolved).includes(SENTINEL);
        if (reached) continue;
        out.push(err("image-control-not-in-images",
          `control "${key}" is an image picker, but this part's \`images\` function never returns the picked value — the picked value is never resolved.`,
          `Reference p.${key} from images, e.g. images: (p) => ({ ${key}: p.${key} }), and consume it with k.heightfield("${key}", opts).`,
          "images"));
      }
      return out;
    },
  },
  {
    id: "heightfield-unknown-image",
    run: ({ part, probe }) => {
      // Only a static `images` object has statically-knowable names; a
      // function's return value depends on params lint doesn't exhaustively
      // enumerate, so it's skipped here (see file header).
      if (typeof part?.images === "function") return [];
      const known = new Set(isPlainObject(part?.images) ? Object.keys(part.images) : []);
      const seen = new Set();
      const out = [];
      for (const call of probe().calls) {
        if (call.scope !== "kernel" || call.op !== "heightfield") continue;
        // k.heightfield(nameOrGrid, opts) also accepts an INLINE grid object as
        // its first argument — args are recorded via JSON.stringify (probe.js's
        // `describe`), so a grid parses back to an object, not a string. Only a
        // string-literal first argument names a declared image; anything else
        // (an inline grid, a computed/non-literal value the probe can't read)
        // is silently skipped rather than flagged — flagging a supported inline
        // grid as an "unknown image" would be a false positive.
        let name;
        try { name = JSON.parse(call.args[0]); } catch { name = null; }
        if (typeof name !== "string" || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("heightfield-unknown-image",
          `build calls k.heightfield with name "${name}", which the part's images field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the source under images: { name: source }, or fix the name to match an existing entry.",
          "images"));
      }
      return out;
    },
  },
  {
    id: "image-source-scheme",
    run: ({ part }) => {
      const out = [];
      for (const [key, allow] of imageControlAllows(part)) {
        const v = part?.defaults?.[key];
        // An empty source declares no image (jobs.js's sanitize hook and
        // heightfield's own "no relief" fallback both treat it that way) — a
        // legitimate way to author an optional relief, not a source the allow
        // list is refusing. A bytes source (ArrayBuffer/typed array) always
        // passes imageSourceAllowed regardless of allow — see image-source.js's
        // header — so it never reaches this branch either.
        if (isNoImageSource(v) || imageSourceAllowed(v, allow)) continue;
        out.push(warn("image-source-scheme",
          `defaults.${key} is "${String(v).slice(0, 120)}", which control "${key}" would refuse (allow: ${allow.join(", ")}).`,
          `Use a source the allow list accepts, or widen \`allow\` on the control. At build time this value is replaced by defaults.${key}, so as written the part has no usable image.`,
          "defaults"));
      }
      return out;
    },
  },
];
