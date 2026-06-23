// Main-thread side of the two geometry workers. Spawns both (manifold/occt),
// funnels their messages to one handler, and routes outbound jobs to the right one.
//
// `createWorker(name)` must be supplied by the app and build the worker with the
// `new Worker(new URL("./part-worker.js", import.meta.url), { type:"module", name })`
// pattern INLINE — Vite only bundles a worker (and its backend chunks) when it sees
// that literal call, so the framework can't construct it from a passed-in URL.
export function createGeometryService({ createWorker, onMessage }) {
  const workers = { manifold: createWorker("manifold"), occt: createWorker("occt") };
  workers.manifold.onmessage = onMessage;
  workers.occt.onmessage = onMessage;
  return {
    generate: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    exportStl: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    export3mf: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    exportStep: (msg) => workers.occt.postMessage(msg), // STEP is always OCCT
  };
}
