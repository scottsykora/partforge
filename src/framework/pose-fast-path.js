// Decision layer of the pose fast path (no DOM, no three.js — viewer/cache are
// injected). At mesh delivery each subpart is STAMPED with its probe result at
// the delivered params; on a later edit, a stale subpart whose baseHash is
// unchanged gets its delivered mesh re-posed in the viewer (delta vs. the
// delivered pose) and is re-stamped current — no worker job. Everything else
// falls through to the normal regen loop.
import { viewSubParts } from "./jobs.js";
import { probePoses } from "./pose-probe.js";
import { poseDelta } from "./geometry/pose.js";

export function createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion }) {
  const stamps = {}; // name -> probe entry captured when that subpart's mesh was delivered

  // Memoize the probe per (paramsVersion, view) — same discipline as
  // createMeshCache's readsFor; params is the live in-place-mutated object.
  let probeKey = null, probeMap = null;
  const probeFor = () => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (probeKey !== key) { probeKey = key; probeMap = probePoses(part, getView(), params); }
    return probeMap;
  };

  return {
    // Stamp a freshly delivered mesh with its probe result at the current params.
    // (The caller only records on non-stale builds — buildDone() guarantees the
    // live params are the ones the worker built with.)
    recordDelivered(name) {
      stamps[name] = probeFor().get(name);
    },

    // Re-pose every visible stale subpart whose base geometry is unchanged.
    // Returns the NAMES repaired (empty = nothing pose-only to do). Names, not a
    // count: a slider drag repairs the same subpart on every input event, so only
    // the caller's set union across a drag is a meaningful "how many were posed".
    repair() {
      const posed = [];
      const poses = probeFor();
      for (const name of viewSubParts(part, getView(), params)) {
        if (cache.isCurrent(name) || !viewer.hasSubMesh(name)) continue;
        const now = poses.get(name), was = stamps[name];
        if (!now?.trusted || !was?.trusted || now.baseHash !== was.baseHash) continue;
        viewer.setSubPose(name, poseDelta(now.pose, was.pose));
        cache.record(name); // current again at these params — regen loop sees nothing missing
        posed.push(name);
      }
      return posed;
    },
  };
}
