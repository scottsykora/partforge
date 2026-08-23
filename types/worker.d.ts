// partforge/worker — the geometry Web Worker runtime shared by every part.
//
// The host spawns this entry twice, named "manifold" (preview + STL + 3MF) and
// "occt" (STEP), via the Worker `name` option. Each instance lazily imports only
// its own backend.

import type { PartDefinition } from "./part.js";

/** The rebind handle `runWorker` returns. */
export interface WorkerHandle {
  /**
   * Swap the part this worker builds, cancelling stale builds, sweeping idle
   * cache partitions and re-posting `ready` — so a remounting host gates its
   * first generate exactly as on a fresh worker, without losing the warm kernel.
   * The rebind contract is normative in docs/KERNEL-CONTRACT.md.
   */
  setPart(newPart: PartDefinition): void;
}

/**
 * Run the worker job loop for `part`. Call once, at worker module top level.
 * `opts.loadOracle` injects the closed semantic-mesh-oracle package (a thunk
 * resolving its barrel: `describe`, `describeMemo`, `compactDescribe`); omitted,
 * describe jobs answer with a structured `oracle-unavailable` report.
 */
export function runWorker(
  part: PartDefinition,
  opts?: { loadOracle?: () => Promise<{ describe: Function; describeMemo: () => Map<string, unknown>; compactDescribe: Function }> },
): WorkerHandle;
