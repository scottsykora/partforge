// test/export-mount-wiring.test.js
// mount() needs DOM+WASM, so we test the wiring seam: onWorkerMessage must give
// the controller first refusal on jobId-tagged messages. We reproduce that seam.
import { expect, test, vi } from "vitest";
import { createExportController } from "../src/framework/export-controller.js";

test("controller consumes jobId messages; legacy path handles the rest", () => {
  const sent = [];
  const ctl = createExportController({ send: (m) => sent.push(m), currentView: () => "all", title: () => "T" });
  const sink = vi.fn();
  const legacy = vi.fn();

  // simulate mount's onWorkerMessage dispatch:
  const onMessage = (data) => { if (!ctl.handleMessage(data, sink)) legacy(data); };

  ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  const { jobId } = sent[0];
  onMessage({ type: "progress", phase: "x", jobId });          // consumed
  onMessage({ type: "meshes", triangles: 1 });                  // legacy
  onMessage({ type: "download-parts", parts: [{ name: "a", data: new ArrayBuffer(2) }], ext: "stl", mime: "model/stl", jobId });
  expect(legacy).toHaveBeenCalledTimes(1);
  expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ type: "meshes" }));
  expect(sink).toHaveBeenCalledTimes(1);
});
