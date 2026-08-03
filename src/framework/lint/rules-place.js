// Group 6 — the two place() invariants (docs/AUTHORING-PARTS.md "Display vs
// export placement"), promoted from doc-only conventions to lint because the
// animation system leans on place() for every pose-only track:
//   1. Display placement must not depend on the active view (display meshes
//      are cached across views; a view-dependent pose serves stale geometry).
//   2. Display vs export may differ only by a rigid motion (translate/rotate).
// Both checks run the geometry-free pose probe; an untrusted probe (query op /
// function selector in build or place) proves nothing and stays silent — the
// runtime declines the fast path for those sub-parts anyway.
import { err } from "./finding.js";
import { probeSubPartPose } from "../pose-probe-core.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The sub-part names visible in a view at params p — restated locally (like
// rules-schema.js restates controls.js's visibility predicates) rather than
// imported from jobs.js, which would break the lint purity closure.
function viewNames(part, view, p) {
  return Object.entries(isPlainObject(part?.parts) ? part.parts : {})
    .filter(([, sp]) => Array.isArray(sp?.views) && sp.views.includes(view))
    .filter(([, sp]) => { try { return sp.enabled ? !!sp.enabled(p) : true; } catch { return false; } })
    .map(([name]) => name);
}

const poseKey = (pose) => JSON.stringify(pose);

export const PLACE_RULES = [
  {
    id: "view-dependent-display-place",
    run: ({ part, p, d }) => {
      const out = [];
      const views = Object.keys(isPlainObject(part?.views) ? part.views : {});
      if (views.length < 2) return out;
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        const inViews = views.filter((v) => viewNames(part, v, p).includes(name));
        if (inViews.length < 2) continue;
        const probes = inViews.map((view) => probeSubPartPose(sp, { view, purpose: "display", p, d }));
        if (probes.some((x) => !x.trusted)) continue;
        const first = probes[0];
        const differs = probes.some((x) => x.baseHash !== first.baseHash || poseKey(x.pose) !== poseKey(first.pose));
        if (differs) {
          out.push(err("view-dependent-display-place",
            `sub-part "${name}" display placement differs between views (${inViews.join(", ")})`,
            "Display meshes are built once per sub-part and cached across views, so a view-dependent display pose shows stale geometry after a tab switch. Only `place(..., { purpose: \"export\" })` may vary; keep the display branch view-independent.",
            `parts.${name}.place`,
            "view-dependent-display-place"));
        }
      }
      return out;
    },
  },
  {
    id: "place-not-rigid",
    run: ({ part, p, d }) => {
      const out = [];
      for (const view of Object.keys(isPlainObject(part?.views) ? part.views : {})) {
        for (const name of viewNames(part, view, p)) {
          const sp = part.parts[name];
          if (!sp?.place) continue;
          const display = probeSubPartPose(sp, { view, purpose: "display", p, d });
          const exportP = probeSubPartPose(sp, { view, purpose: "export", p, d });
          if (!display.trusted || !exportP.trusted) continue;
          if (display.baseHash !== exportP.baseHash) {
            out.push(err("place-not-rigid",
              `sub-part "${name}" display and export placements differ by more than a rigid motion (view "${view}")`,
              "place() may move a solid between purposes (translate/rotate) but never reshape it — a geometry op on one branch means the exported part is not the previewed part. Move the op into build().",
              `parts.${name}.place`,
              "place-not-rigid"));
            break; // one finding per sub-part
          }
        }
      }
      return out;
    },
  },
];
