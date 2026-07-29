// test/export-controller.test.js
import { expect, test, vi } from "vitest";
import { createExportController } from "../src/framework/export-controller.js";
import { triggerDownload, downloadParts } from "../src/framework/download.js";

function setup(overrides = {}) {
  const sent = [];
  const ctl = createExportController({
    send: (msg, backend) => sent.push({ msg, backend }),
    currentView: () => "all",
    title: () => "My Part",
    defaultBackend: () => "manifold",
    ...overrides,
  });
  return { ctl, sent };
}

test("STL export sends jobId + explicit parts on the default backend", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ parts: ["a", "b"], format: "stl", onProgress: vi.fn() });
  expect(sent).toHaveLength(1);
  expect(sent[0].backend).toBe("manifold");
  expect(sent[0].msg).toMatchObject({ type: "export-stl", parts: ["a", "b"], view: "all", name: "My Part" });
  expect(Number.isInteger(sent[0].msg.jobId)).toBe(true);
});

test("STEP export routes to occt", () => {
  const { ctl, sent } = setup();
  ctl.exportParts({ parts: ["a"], format: "step", onProgress: vi.fn() });
  expect(sent[0].backend).toBe("occt");
  expect(sent[0].msg.type).toBe("export-step");
});

test("progress is routed to onProgress; download resolves + hits the sink", async () => {
  const { ctl, sent } = setup();
  const onProgress = vi.fn();
  const sink = vi.fn();
  const done = ctl.exportParts({ parts: ["a"], format: "stl", onProgress });
  const { jobId } = sent[0].msg;
  expect(ctl.handleMessage({ type: "progress", phase: "building A", jobId }, sink)).toBe(true);
  expect(onProgress).toHaveBeenCalledWith("building A");
  ctl.handleMessage({ type: "download-parts", parts: [{ name: "a", data: new Uint8Array([1]).buffer }], ext: "stl", mime: "model/stl", jobId }, sink);
  await expect(done).resolves.toBeUndefined();
  expect(sink).toHaveBeenCalledTimes(1);
});

test("error rejects the pending export", async () => {
  const { ctl, sent } = setup();
  const done = ctl.exportParts({ parts: ["a"], format: "stl", onProgress: vi.fn() });
  const { jobId } = sent[0].msg;
  ctl.handleMessage({ type: "error", message: "boom", jobId }, vi.fn());
  await expect(done).rejects.toThrow("boom");
});

test("messages without a matching jobId are not consumed", () => {
  const { ctl } = setup();
  expect(ctl.handleMessage({ type: "meshes", jobId: undefined }, vi.fn())).toBe(false);
  expect(ctl.handleMessage({ type: "download", jobId: 999 }, vi.fn())).toBe(false);
});
