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

// Transfer the big binary buffers (zero-copy) instead of structured-cloning them.
function transferOf(m) {
  if (m.type === "meshes") {
    const t = [];
    for (const x of m.meshes) {
      t.push(x.positions.buffer);
      if (x.normals?.buffer) t.push(x.normals.buffer);
      if (x.indices?.buffer) t.push(x.indices.buffer);
      if (x.edges?.buffer) t.push(x.edges.buffer);
    }
    return t;
  }
  if (m.type === "download-parts") return m.parts.map((p) => (ArrayBuffer.isView(p.data) ? p.data.buffer : p.data));
  if (m.type === "download") return [m.data];
  return [];
}

export function runWorker(part) {
  const backend = self.name === "occt" ? "occt" : "manifold";
  let manifold = null; // { preview, print }
  let occt = null;
  let booting = null;

  // Manifold is cheap to boot — bring it up eagerly and signal readiness.
  if (backend === "manifold") {
    booting = manifoldKernels().then((m) => { manifold = m; postMessage({ type: "ready" }); });
  }

  self.onmessage = async (e) => {
    let kernel;
    if (backend === "manifold") {
      await booting;
      const printJob = e.data.type === "export-stl" || e.data.type === "export-3mf"; // high-res mesh exports
      kernel = printJob ? manifold.print : manifold.preview;
    } else {
      if (!occt) {
        postMessage({ type: "progress", phase: "loading exact kernel" }); // feedback during cold boot
        booting = booting ?? occtKernel().then((k) => (occt = k));
        await booting;
      }
      kernel = occt;
    }
    await handle(kernel, part, e.data, (m) => postMessage(m, transferOf(m)));
  };
}
