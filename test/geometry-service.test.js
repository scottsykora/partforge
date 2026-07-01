import { expect, test } from "vitest";
import { createGeometryService } from "../src/framework/geometry-service.js";

function fakeWorkers() {
  const posts = { manifold: [], occt: [] };
  const createWorker = (name) => ({ postMessage: (m) => posts[name].push(m), onmessage: null });
  return { posts, createWorker };
}

test("send routes to the named backend; default is manifold", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.send({ type: "generate", a: 1 }, "occt");
  s.send({ type: "generate", a: 2 });
  expect(posts.occt).toEqual([{ type: "generate", a: 1 }]);
  expect(posts.manifold).toEqual([{ type: "generate", a: 2 }]);
});

test("STEP export routes to occt when the caller passes that backend", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.send({ type: "export-step" }, "occt");
  expect(posts.occt).toEqual([{ type: "export-step" }]);
});

test("STL export routes to the named backend", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.send({ type: "export-stl" }, "occt");
  expect(posts.occt).toEqual([{ type: "export-stl" }]);
});
