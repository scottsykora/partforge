// Review fix 4: the worker's pump-level error boundary (kernelFor / WASM-boot failures)
// must carry the failing job's jobId. Otherwise a correlated caller — captureView's
// capture-build channel, or exportParts — never sees the error and its promise hangs
// forever, and mount misroutes the job-less error into the live regen handler.
//
// We force a boot failure by mocking manifold-3d's WASM module to throw, so the eager
// manifold boot rejects and the first job hits the pump's error boundary. Manifold-only
// (the occt kernel is never touched), so the two-backends-one-process rule holds.
import { afterEach, expect, test, vi } from "vitest";

vi.mock("manifold-3d", () => ({ default: () => { throw new Error("wasm boot failed"); } }));

import { runWorker } from "../src/framework/worker.js";

const part = {
  defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (k) => k.cylinder({ r: 5, h: 10 }) } },
};

afterEach(() => { delete globalThis.self; delete globalThis.postMessage; vi.restoreAllMocks(); });

test("a kernel-boot failure posts the error WITH the job's jobId so the capture channel can correlate it", async () => {
  const posts = [];
  globalThis.self = { name: "manifold", navigator: { userAgent: "node" } };
  globalThis.postMessage = (m) => posts.push(m);
  runWorker(part);

  // A capture-generate (jobId "cap-1") whose kernel never boots must come back as an
  // error carrying that jobId — not a job-less error that hangs the correlated request.
  self.onmessage({ data: { type: "capture-generate", jobId: "cap-1", subparts: ["a"], view: "v", params: {} } });

  const err = await vi.waitFor(() => {
    const e = posts.find((m) => m.type === "error");
    expect(e).toBeTruthy();
    return e;
  }, { timeout: 10_000 });

  expect(err.jobId).toBe("cap-1");
});

test("a job-less job (a live generate) still posts a job-less error, unchanged", async () => {
  const posts = [];
  globalThis.self = { name: "manifold", navigator: { userAgent: "node" } };
  globalThis.postMessage = (m) => posts.push(m);
  runWorker(part);

  // Regen-loop generates carry no jobId; the pump error must not invent one.
  self.onmessage({ data: { type: "generate", subparts: ["a"], view: "v", params: {} } });

  const err = await vi.waitFor(() => {
    const e = posts.find((m) => m.type === "error");
    expect(e).toBeTruthy();
    return e;
  }, { timeout: 10_000 });

  expect("jobId" in err).toBe(false);
});
