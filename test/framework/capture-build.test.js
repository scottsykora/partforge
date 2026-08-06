import { expect, test, vi } from "vitest";
import { createCaptureBuild } from "../../src/framework/capture-build.js";

test("request resolves with the meshes from the matching capture-meshes reply", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  const p = cb.request({ subparts: ["a", "b"], view: "assembly", params: {}, backend: "manifold" });

  expect(sent).toHaveLength(1);
  const { jobId, type } = sent[0];
  expect(type).toBe("capture-generate");

  const meshes = [{ name: "a" }, { name: "b" }];
  const consumed = cb.handleMessage({ type: "capture-meshes", jobId, meshes });
  expect(consumed).toBe(true);
  await expect(p).resolves.toEqual(meshes);
});

test("handleMessage ignores non-capture and unknown-jobId messages", () => {
  const cb = createCaptureBuild({ send: () => {} });
  expect(cb.handleMessage({ type: "meshes", meshes: [] })).toBe(false);
  expect(cb.handleMessage({ type: "capture-meshes", jobId: 999, meshes: [] })).toBe(false);
});
