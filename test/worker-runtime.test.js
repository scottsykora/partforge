// Drives runWorker() with a stubbed `self`/`postMessage` — no real Worker, but the
// real Manifold WASM boot and the real job loop. (Manifold-only: the OCCT test
// below never touches its kernel, so the two-backends-one-process rule holds.)
import { afterEach, expect, test } from "vitest";
import { runWorker } from "../src/framework/worker.js";

const part = {
  defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (k) => k.cylinder({ r: 5, h: 10 }) } },
};

afterEach(() => { delete globalThis.self; delete globalThis.postMessage; });

function bootFakeWorker(name) {
  const posts = [];
  globalThis.self = { name };
  globalThis.postMessage = (m) => posts.push(m);
  runWorker(part);
  return posts;
}

const stlTriangles = (dl) => new DataView(dl.parts[0].data).getUint32(80, true);

test("the manifold worker picks its kernel from msg.quality, not the job type", async () => {
  const posts = bootFakeWorker("manifold");
  await self.onmessage({ data: { type: "export-stl", view: "v", params: {} } }); // no quality → preview
  await self.onmessage({ data: { type: "export-stl", view: "v", params: {}, quality: "print" } });
  const [preview, print] = posts.filter((m) => m.type === "download-parts").map(stlTriangles);
  expect(print).toBeGreaterThan(preview * 3); // print tessellates ~4× finer than preview
});

test("the occt worker announces ready at startup, before its kernel boots", () => {
  // mount gates the first generate on a ready message; if only the manifold worker
  // sends one, boot silently depends on both workers being spawned unconditionally.
  const posts = bootFakeWorker("occt");
  expect(posts).toContainEqual({ type: "ready" });
});
