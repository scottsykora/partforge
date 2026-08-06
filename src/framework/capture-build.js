// Correlated one-shot geometry builds for captureView — a private channel that
// does NOT go through the regen loop. Same shape as export-controller's pending
// Map (export-controller.js): allocate a jobId, resolve when the matching
// capture-meshes reply arrives. Pure — no DOM, no worker; `send` is injected.
export function createCaptureBuild({ send }) {
  let nextId = 1;
  const pending = new Map(); // jobId -> resolve

  function request({ subparts, view, params, backend }) {
    const jobId = nextId++;
    return new Promise((resolve) => {
      pending.set(jobId, resolve);
      // cache:true so the worker reuses its per-sub-part geometry memo (the
      // expensive CSG); only the per-view place() + meshing re-run.
      send({ type: "capture-generate", jobId, subparts, view, params, cache: true }, backend);
    });
  }

  // Returns true iff this message was a capture reply this controller owns
  // (so the caller — mount.js's onWorkerMessage — can skip it entirely).
  function handleMessage(data) {
    if (data?.type !== "capture-meshes") return false;
    const resolve = pending.get(data.jobId);
    if (!resolve) return false;
    pending.delete(data.jobId);
    resolve(data.meshes);
    return true;
  }

  // Teardown / worker death: in-flight requests just never settle (matches
  // captureView's expected usage — no caller awaits across a viewer dispose).
  function dispose() {
    pending.clear();
  }

  return { request, handleMessage, dispose };
}
