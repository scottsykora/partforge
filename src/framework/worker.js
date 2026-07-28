// Worker runtime shared by every part. The host spawns this entry twice, named
// "manifold" (preview + STL) and "occt" (STEP), via the Worker `name` option.
// Each instance lazily imports only its own backend, so OCCT's ~11 MB WASM loads
// only in the worker that needs it, and only on first use.
//
// runWorker() returns a rebind handle — { setPart(newPart) } — so a host that
// swaps parts (an embedder, the cloud runner) can keep this worker and its warm
// kernel instead of tearing it down. The rebind contract (what setPart
// guarantees about epochs, cache sweeps, and the re-posted ready) is normative
// in docs/KERNEL-CONTRACT.md.
import { handle } from "./jobs.js";
import { lintPart } from "../lint.js";

async function manifoldKernels() {
  const [{ default: Module }, { createManifoldKernel }] = await Promise.all([
    import("manifold-3d"),
    import("./geometry/manifold-backend.js"),
  ]);
  const wasm = await Module();
  wasm.setup();
  return {
    preview: createManifoldKernel(wasm, { quality: "preview" }), // fast interactive view
    print: createManifoldKernel(wasm, { quality: "print" }),     // high-res STL export
  };
}

async function occtKernel() {
  const [{ default: opencascade }, wasmUrlMod, replicad, { createOcctKernel }] = await Promise.all([
    import("replicad-opencascadejs/src/replicad_single.js"),
    import("replicad-opencascadejs/src/replicad_single.wasm?url"),
    import("replicad"),
    import("./geometry/occt-backend.js"),
  ]);
  const OC = await opencascade({ locateFile: () => wasmUrlMod.default });
  replicad.setOC(OC);
  return createOcctKernel(replicad);
}

export function runWorker(part) {
  const backend = self.name === "occt" ? "occt" : "manifold";
  let manifold = null; // { preview, print }
  let occt = null;
  let booting = null;
  let current = part; // rebindable via the returned handle's setPart()
  let epoch = 0;      // bumped per incoming generate and per setPart
  const queue = [];   // { data, part, epoch } — jobs run against the part current at arrival
  let pumping = false;

  // Manifold is cheap to boot — bring it up eagerly and signal readiness.
  if (backend === "manifold") {
    booting = manifoldKernels().then((m) => { manifold = m; postMessage({ type: "ready" }); });
  } else {
    // OCCT boots lazily (its ~11 MB WASM loads on the first job), but the worker can
    // accept jobs as soon as its module graph is up — messages queue in the port.
    // EVERY worker must post ready: mount gates the first generate on it, so if only
    // the manifold worker signalled, boot would silently depend on the manifold
    // worker always being spawned alongside this one.
    postMessage({ type: "ready" });
  }

  async function kernelFor(data) {
    if (backend === "manifold") {
      await booting;
      // The sender declares the job's mesh quality; the worker knows nothing about
      // job-type semantics (mount marks STL/3MF exports quality:"print").
      return data.quality === "print" ? manifold.print : manifold.preview;
    }
    if (!occt) {
      postMessage({ type: "progress", phase: "loading exact kernel" }); // feedback during cold boot
      booting = booting ?? occtKernel().then((k) => (occt = k));
      await booting;
    }
    return occt;
  }

  // Serial pump: exactly one job at a time. Jobs yield between sub-parts
  // (jobs.js) so newer messages can enqueue — without this queue two handle()
  // calls could interleave on the same kernel.
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        // A generate superseded while it sat in the queue never builds at all.
        if (job.epoch !== null && job.epoch !== epoch) continue;
        const kernel = await kernelFor(job.data);
        // handle() declares each message's transferables (the big binary buffers).
        await handle(kernel, job.part, job.data, (m, transfer = []) => postMessage(m, transfer),
          job.epoch === null ? {} : { isStale: () => job.epoch !== epoch });
      }
    } finally {
      pumping = false;
    }
  }

  self.onmessage = (e) => {
    // Lint is geometry-free by construction, so answer it before touching — or
    // booting — a kernel. handle() in jobs.js takes an already-booted kernel, and
    // the pump awaits that boot, so routing lint through the queue would drag in
    // OCCT's ~11 MB WASM to run a check that never calls the kernel at all.
    if (e.data?.type === "lint") {
      postMessage({ type: "lint-report", report: lintPart(current, { params: e.data.params }) });
      return;
    }
    // Only generates supersede each other; exports/inspect always run (cancelling
    // a user's export because an edit landed would be wrong).
    const supersedes = e.data?.type === "generate";
    if (supersedes) epoch++;
    queue.push({ data: e.data, part: current, epoch: supersedes ? epoch : null });
    void pump();
  };

  return {
    // Rebind contract (docs/KERNEL-CONTRACT.md): swap the part, cancel stale
    // builds, sweep idle cache partitions, and re-post ready so a remounting
    // host gates its first generate exactly as on a fresh worker.
    //
    // Never runs mid-bracket, so the sweep is always safe: setPart runs
    // synchronously on the worker's own turn, and jobs.js opens and closes each
    // sub-part's beginSubPart/endSubPart bracket inside a single synchronous
    // turn (its only awaits are between sub-parts). The serial pump keeps at
    // most one handle() in flight, so there is no second bracket to land in
    // either. An in-flight generate sees the bumped epoch at its next sub-part
    // boundary and stops there.
    setPart(newPart) {
      current = newPart;
      epoch++;
      manifold?.preview.sweepCache?.();
      manifold?.print.sweepCache?.();
      occt?.sweepCache?.();
      postMessage({ type: "ready" });
    },
  };
}
