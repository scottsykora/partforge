// Main-thread side of the two geometry workers. Spawns both (manifold/occt),
// funnels their messages to one handler, and routes outbound jobs to the right one.
//
// `createWorker(name)` must be supplied by the app and build the worker with the
// `new Worker(new URL("./part-worker.js", import.meta.url), { type:"module", name })`
// pattern INLINE — Vite only bundles a worker (and its backend chunks) when it sees
// that literal call, so the framework can't construct it from a passed-in URL.
function terminateWorkers(workers) {
  const errors = [];
  for (const worker of workers) {
    try { worker.terminate(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "geometry worker termination failed");
  }
}

export function createGeometryService({ createWorker, onMessage }) {
  const manifold = createWorker("manifold");
  let occt;
  try {
    occt = createWorker("occt");
  } catch (error) {
    try { terminateWorkers([manifold]); } catch { /* preserve the worker creation error */ }
    throw error;
  }
  const workers = { manifold, occt };
  workers.manifold.onmessage = onMessage;
  workers.occt.onmessage = onMessage;
  // Post a job to the chosen backend's worker. The message's own `type` says what to
  // do (generate / export-stl / export-3mf / export-step); `backend` picks the worker
  // — manifold for preview/STL/3MF, occt for STEP (the caller passes "occt" for that).
  return {
    send: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    terminate: () => terminateWorkers([workers.manifold, workers.occt]),
  };
}
