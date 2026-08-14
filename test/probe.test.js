import { expect, test } from "vitest";
import { detectBackend } from "../src/framework/backend-select.js";

const view = { v: { label: "V" } };
const plain = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } } };
const fillets = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(0.1) } } };
const conditional = {
  defaults: { round: 0 }, views: view,
  parts: { a: { views: ["v"], build: (k, p) => p.round > 0 ? k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(p.round) : k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } },
};

test("a part using fillet routes to occt", () => { expect(detectBackend(fillets)).toBe("occt"); });
test("a plain part routes to manifold", () => { expect(detectBackend(plain)).toBe("manifold"); });
test("meta.backend overrides detection", () => { expect(detectBackend({ ...plain, meta: { backend: "occt" } })).toBe("occt"); });
test("a conditional fillet is detected only when its param enables it", () => {
  expect(detectBackend(conditional)).toBe("manifold");
  expect(detectBackend(conditional, { round: 1 })).toBe("occt");
});

test("a part using shell routes to occt", () => {
  const shelled = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).shell({ t: 1, open: { dir: "Z" } }) } } };
  expect(detectBackend(shelled)).toBe("occt");
});

test("Shape2D.fillet does not route to OCCT (shared pure-JS implementation)", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(2).extrude({ h: 3 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});

test("Solid.fillet after a Shape2D chain still routes to OCCT", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).extrude({ h: 3 }).fillet(1) } } };
  expect(detectBackend(part)).toBe("occt");
});

test("a text2d chain (Shape2D handle) does not route to OCCT", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.text2d("Hi", { size: 10 }).chamfer(0.5).extrude({ h: 2 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});

test("Shape2D.fillet on one sub-part does not mask Solid.fillet on another", () => {
  const part = { defaults: {}, views: view, parts: {
    a: { views: ["v"], build: (k) => k.shape2d([[0, 0], [1, 0], [1, 1]]).fillet(0.1).extrude({ h: 1 }) },
    b: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(0.1) },
  } };
  expect(detectBackend(part)).toBe("occt");
});

test("label() chains on the probe kernel and does not force OCCT", () => {
  const part = {
    defaults: { a: 5 },
    parts: { p: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.a, p.a, p.a] }).label("Body") } },
    views: { v: {} },
  };
  expect(detectBackend(part)).toBe("manifold");
});
