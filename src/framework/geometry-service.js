// Main-thread side of the two geometry workers. Spawns both (manifold/occt),
// funnels their messages to one handler, and routes outbound jobs to the right one.
//
// `createWorker(name)` must be supplied by the app and build the worker with the
// `new Worker(new URL("./part-worker.js", import.meta.url), { type:"module", name })`
// pattern INLINE — Vite only bundles a worker (and its backend chunks) when it sees
// that literal call, so the framework can't construct it from a passed-in URL.
export function createGeometryService({ createWorker, onMessage, occtPreview = false }) {
  const preview = createWorker("manifold"); // preview meshes + STL
  const exporter = createWorker("occt");    // STEP (and preview when occtPreview)
  preview.onmessage = onMessage;
  exporter.onmessage = onMessage;
  const genWorker = occtPreview ? exporter : preview;
  return {
    generate: (msg) => genWorker.postMessage(msg),
    exportStl: (msg) => preview.postMessage(msg),
    export3mf: (msg) => preview.postMessage(msg), // mesh export → Manifold worker
    exportStep: (msg) => exporter.postMessage(msg),
  };
}
