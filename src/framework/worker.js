// Worker runtime shared by every part. The host spawns this entry twice, named
// "manifold" (preview + STL) and "occt" (STEP), via the Worker `name` option.
// Each instance lazily imports only its own backend, so OCCT's ~11 MB WASM loads
// only in the worker that needs it, and only on first use.
import { handle } from "./jobs.js";

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

  self.onmessage = async (e) => {
    let kernel;
    if (backend === "manifold") {
      await booting;
      // The sender declares the job's mesh quality; the worker knows nothing about
      // job-type semantics (mount marks STL/3MF exports quality:"print").
      kernel = e.data.quality === "print" ? manifold.print : manifold.preview;
    } else {
      if (!occt) {
        postMessage({ type: "progress", phase: "loading exact kernel" }); // feedback during cold boot
        booting = booting ?? occtKernel().then((k) => (occt = k));
        await booting;
      }
      kernel = occt;
    }
    // handle() declares each message's transferables (the big binary buffers).
    await handle(kernel, part, e.data, (m, transfer = []) => postMessage(m, transfer));
  };
}
