import { expect, test } from "vitest";
import { detectBackend } from "../src/framework/geometry/probe.js";

const view = { v: { label: "V" } };
const plain = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box([0, 0, 0], [1, 1, 1]) } } };
const fillets = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box([0, 0, 0], [1, 1, 1]).fillet(0.1) } } };
const conditional = {
  defaults: { round: 0 }, views: view,
  parts: { a: { views: ["v"], build: (k, p) => p.round > 0 ? k.box([0, 0, 0], [1, 1, 1]).fillet(p.round) : k.box([0, 0, 0], [1, 1, 1]) } },
};

test("a part using fillet routes to occt", () => { expect(detectBackend(fillets)).toBe("occt"); });
test("a plain part routes to manifold", () => { expect(detectBackend(plain)).toBe("manifold"); });
test("meta.backend overrides detection", () => { expect(detectBackend({ ...plain, meta: { backend: "occt" } })).toBe("occt"); });
test("a conditional fillet is detected only when its param enables it", () => {
  expect(detectBackend(conditional)).toBe("manifold");
  expect(detectBackend(conditional, { round: 1 })).toBe("occt");
});

test("a part using shell routes to occt", () => {
  const shelled = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box([0, 0, 0], [10, 10, 10]).shell(1, { dir: "Z" }) } } };
  expect(detectBackend(shelled)).toBe("occt");
});
