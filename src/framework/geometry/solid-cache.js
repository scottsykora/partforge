// Worker-side cache of boundary-op solids, partitioned per sub-part. Retention is
// bounded to the CURRENT build's graph: each begin()/end() bracket rebuilds a
// sub-part's retained set from scratch, disposing any entry not re-used this round.
// WASM-agnostic — it stores opaque {value, pin, dispose} triples supplied by the
// caller (the Manifold backend), so it is unit-testable with plain objects.
export function createSolidCache() {
  const caches = new Map(); // name -> Map(hash -> { value, pin, dispose })
  const pinned = new Set();  // every live `pin` across all sub-parts
  const lastBuilt = new Map(); // name -> rebind generation of the partition's last begin()
  let generation = 0;          // bumped only by sweep() (i.e. per part rebind)
  let name = null, active = null, prev = null;
  let hits = 0, misses = 0;

  return {
    begin(n) { name = n; lastBuilt.set(n, generation); prev = caches.get(n) ?? new Map(); active = new Map(); },

    end() {
      if (name == null) return;
      for (const [hash, entry] of prev) {
        if (!active.has(hash)) { pinned.delete(entry.pin); entry.dispose(); } // evict
      }
      caches.set(name, active);
      name = null; active = prev = null;
    },

    // Rebind hygiene: called once per setPart() (never mid-bracket — the worker's
    // job queue is serial). Partitions a rebind renamed or deleted would otherwise
    // pin their last build's solids until worker death; three idle generations is
    // the eviction line, so recently-viewed views stay warm across edits.
    sweep() {
      generation++;
      for (const [n, entries] of caches) {
        if (generation - (lastBuilt.get(n) ?? 0) < 3) continue;
        for (const entry of entries.values()) { pinned.delete(entry.pin); entry.dispose(); }
        caches.delete(n);
        lastBuilt.delete(n);
      }
    },

    lookup(hash, make) {
      if (name == null) return make().value; // not bracketed → no caching
      if (active.has(hash)) { hits++; return active.get(hash).value; }
      if (prev.has(hash)) { hits++; const e = prev.get(hash); active.set(hash, e); return e.value; }
      misses++;
      const entry = make();
      active.set(hash, entry);
      pinned.add(entry.pin);
      return entry.value;
    },

    isPinned: (pin) => pinned.has(pin),
    stats: () => ({ hits, misses }),
    resetStats: () => { hits = 0; misses = 0; },
  };
}
