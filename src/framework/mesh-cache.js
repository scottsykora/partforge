import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "./param-deps.js";

// Tracks whether each sub-part's cached display mesh is still valid for the current
// params ("Layer 1" of the cache — skipping regeneration of sub-parts whose inputs
// didn't change). A sub-part's mesh is stamped with a relevance hash over just the
// params that sub-part reads; it's current while that hash is unchanged and the mesh
// is still in the viewer.
//
// The view/paramsVersion/caching state lives in mount and changes over time, so it's
// passed as getters. `params` is a stable object mutated in place, so it's passed by
// reference.
export function createMeshCache(part, viewer, { params, getView, getParamsVersion, isCaching }) {
  const cacheHash = {}; // name -> relevance hash the cached mesh was built at

  // Memoize the per-sub-part read-key map per (paramsVersion, view): subPartReadKeys
  // runs probe builds, so we compute it once per change, not per sub-part.
  let readsKey = null, readsMap = null;
  const readsFor = () => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (readsKey !== key) { readsKey = key; readsMap = subPartReadKeys(part, getView(), params); }
    return readsMap;
  };

  // The relevance hash for one sub-part at the current params (RELEVANT_ALL → hash
  // over ALL params, so any edit invalidates it — the safe fallback).
  const hashFor = (name) => {
    if (!isCaching()) return `v${getParamsVersion()}`; // caching off: any edit invalidates every sub-part
    const reads = readsFor();
    const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(name) ?? Object.keys(params))];
    return relevanceHash(keys, params);
  };

  return {
    // A cached sub-part is current only if its relevance hash is unchanged.
    isCurrent: (name) => viewer.hasSubMesh(name) && cacheHash[name] === hashFor(name),
    // Stamp a freshly built mesh with the hash it was built at.
    record: (name) => { cacheHash[name] = hashFor(name); },
    // Drop a sub-part's stamp so it rebuilds next generate.
    forget: (name) => { delete cacheHash[name]; },
  };
}
