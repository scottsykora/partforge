// Group 1 — definition shape and view wiring. This group is the shared replacement
// for partforge-cloud's hand-rolled sandbox validate(), which checks meta.title,
// defaults and build but not `views`, and had already drifted from the eval runner's
// separate views check. One source of truth ends that split.
import { err, warn } from "./finding.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const partEntries = (part) => (isPlainObject(part?.parts) ? Object.entries(part.parts) : []);

export const SHAPE_RULES = [
  {
    id: "missing-meta-title",
    run: ({ part }) => (typeof part?.meta?.title === "string" && part.meta.title.length > 0 ? [] : [
      err("missing-meta-title", "the part has no `meta.title`",
        "Add a `meta` object with a `title` string — it names the part in the viewer and in export filenames.",
        "meta.title"),
    ]),
  },
  {
    id: "missing-defaults",
    run: ({ part }) => (isPlainObject(part?.defaults) ? [] : [
      err("missing-defaults", "the part has no `defaults` object",
        "Add a `defaults` object giving every parameter its starting value; the control panel and every build read from it.",
        "defaults"),
    ]),
  },
  {
    id: "no-buildable-parts",
    run: ({ part }) => {
      const entries = partEntries(part);
      if (entries.length === 0) {
        return [err("no-buildable-parts", "the part declares no sub-parts in `parts`",
          "Add at least one entry to `parts`, each with a `build(k, p, d)` function returning a solid.",
          "parts")];
      }
      return entries
        .filter(([, sp]) => typeof sp?.build !== "function")
        .map(([name]) => err("no-buildable-parts", `sub-part "${name}" has no \`build\` function`,
          "Every entry in `parts` needs a `build(k, p, d)` function that returns a solid.",
          `parts.${name}.build`));
    },
  },
  {
    id: "missing-views",
    run: ({ part }) => (isPlainObject(part?.views) && Object.keys(part.views).length > 0 ? [] : [
      err("missing-views", "the part has no `views` map",
        "Add a top-level `views` object — e.g. `views: { main: { label: \"Main\" } }` — and list each view name in the owning sub-part's `views` array.",
        "views"),
    ]),
  },
  {
    id: "part-view-unknown",
    run: ({ part }) => {
      const known = isPlainObject(part?.views) ? new Set(Object.keys(part.views)) : new Set();
      if (known.size === 0) return []; // missing-views already reported it; don't pile on
      const out = [];
      for (const [name, sp] of partEntries(part)) {
        if (!Array.isArray(sp?.views)) continue;
        sp.views.forEach((v, i) => {
          if (!known.has(v)) {
            out.push(err("part-view-unknown",
              `sub-part "${name}" lists view "${v}", which is not in the \`views\` map`,
              `Add "${v}" to the top-level \`views\` map, or correct the name to one of: ${[...known].join(", ")}.`,
              `parts.${name}.views[${i}]`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "view-unused",
    run: ({ part }) => {
      if (!isPlainObject(part?.views)) return [];
      const used = new Set();
      for (const [, sp] of partEntries(part)) {
        if (Array.isArray(sp?.views)) for (const v of sp.views) used.add(v);
      }
      return Object.keys(part.views)
        .filter((v) => !used.has(v))
        .map((v) => warn("view-unused", `view "${v}" is not listed by any sub-part`,
          `Either add "${v}" to a sub-part's \`views\` array or remove it from the \`views\` map — as it stands the view renders empty.`,
          `views.${v}`));
    },
  },
];
