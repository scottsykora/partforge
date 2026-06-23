import { expect, test } from "vitest";
import { createGeometryService } from "../src/framework/geometry-service.js";

function fakeWorkers() {
  const posts = { manifold: [], occt: [] };
  const createWorker = (name) => ({ postMessage: (m) => posts[name].push(m), onmessage: null });
  return { posts, createWorker };
}

test("generate routes to the named backend; default is manifold", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.generate({ type: "generate", a: 1 }, "occt");
  s.generate({ type: "generate", a: 2 });
  expect(posts.occt).toEqual([{ type: "generate", a: 1 }]);
  expect(posts.manifold).toEqual([{ type: "generate", a: 2 }]);
});

test("exportStep always routes to occt", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.exportStep({ type: "export-step" });
  expect(posts.occt).toEqual([{ type: "export-step" }]);
});

test("exportStl routes to the named backend", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.exportStl({ type: "export-stl" }, "occt");
  expect(posts.occt).toEqual([{ type: "export-stl" }]);
});
