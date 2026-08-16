// STEP → triangle mesh for the Node crossover (Manifold part importing STEP).
// OCCT boots in a worker_thread — a separate isolate is a separate WASM world,
// so the "never both kernels in one process" invariant holds by construction.
import { Worker } from "node:worker_threads";

export function tessellateStepAssets(entries) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./step-mesh-thread.js", import.meta.url),
      { workerData: entries.map(({ name, bytes, digest }) => ({ name, bytes, digest })) });
    w.once("message", (out) => {
      resolve(new Map(out.map((m) => [m.name, { digest: m.digest, positions: m.positions, indices: m.indices }])));
      w.terminate();
    });
    w.once("error", reject);
    w.once("exit", (code) => { if (code !== 0) reject(new Error(`step tessellation thread exited ${code}`)); });
  });
}
