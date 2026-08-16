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

// Fix round (task-9 review): a needs-import-mesh reply for an export job's own
// jobId (e.g. a STEP export of a part with an unprimed STEP import) must be
// consumed by the controller here, never reaching mount's live-loop legacy
// path — that path treats needs-import-mesh as a live crossover signal
// (loop.buildDone(), a tessellate-imports request) which would be wrong for a
// build the live regen loop never dispatched.
test("controller consumes needs-import-mesh for its own jobId; legacy path never sees it", async () => {
  const sent = [];
  const ctl = createExportController({ send: (m) => sent.push(m), currentView: () => "all", title: () => "T" });
  const sink = vi.fn();
  const legacy = vi.fn();
  const onMessage = (data) => { if (!ctl.handleMessage(data, sink)) legacy(data); };

  const done = ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() });
  done.catch(() => {}); // rejection is expected and asserted below
  const { jobId } = sent[0];
  onMessage({ type: "needs-import-mesh", jobId, subparts: ["a"] });

  expect(legacy).not.toHaveBeenCalled();
  await expect(done).rejects.toThrow(/STEP import needs tessellation/);
});
