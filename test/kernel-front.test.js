// The backend-shared kernel front against a fake backend — no WASM. Pins the
// responsibilities finishKernel() takes over from the backends: argument
// validation, the default compound-op compositions, and the toSTEP capability stub.
import { expect, test, vi } from "vitest";
import { finishKernel } from "../src/framework/geometry/kernel-front.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";

function fakeKernel() {
  const calls = [];
  const solid = {
    cut: (t) => { calls.push(["cut", t]); return "bored-result"; },
    translate: (v) => { calls.push(["translate", v]); return "translated-tool"; },
  };
  return {
    calls,
    cylinder: (rb, rt, h) => { calls.push(["cylinder", rb, rt, h]); return solid; },
    prism: vi.fn(() => "prism-result"),
    revolve: vi.fn(() => "revolve-result"),
  };
}

test("prism arguments are validated once, in the front", () => {
  const k = finishKernel(fakeKernel());
  expect(() => k.prism({ points: [[0, 0]], h: 5, scaleTop: -1 })).toThrow(/scaleTop must be/);
  expect(k.prism({ points: [[0, 0]], h: 5 })).toBe("prism-result");
  expect(k.prism({ points: [[0, 0]], h: 5, scaleTop: 0.5, twist: 30 })).toBe("prism-result");
});

test("revolve rejects a negative profile radius in the front", () => {
  const k = finishKernel(fakeKernel());
  expect(() => k.revolve({ profile: [[-1, 0], [10, 0], [10, 20]] })).toThrow(/radius must be/);
  expect(k.revolve({ profile: [[1, 0], [10, 0], [10, 20]] })).toBe("revolve-result");
});

test("boredCylinder defaults to the cylinder-minus-cylinder composition", () => {
  const k = finishKernel(fakeKernel());
  expect(k.boredCylinder({ od: 10, h: 8, bore: 3 })).toBe("bored-result");
  expect(k.calls).toContainEqual(["cylinder", 5, 5, 8]);        // the body
  expect(k.calls).toContainEqual(["cylinder", 1.5, 1.5, 12]);   // the through-tool (h + 4)
  expect(k.calls).toContainEqual(["translate", [0, 0, -2]]);    // centred overshoot
  expect(k.calls).toContainEqual(["cut", "translated-tool"]);
});

test("a backend's own boredCylinder wins over the default composition", () => {
  const k = finishKernel({ ...fakeKernel(), boredCylinder: () => "atomic-cache-node" });
  expect(k.boredCylinder({ od: 10, h: 8, bore: 3 })).toBe("atomic-cache-node");
});

test("toSTEP is stubbed with KernelCapabilityError when the backend lacks it", () => {
  const k = finishKernel(fakeKernel());
  expect(() => k.toSTEP([])).toThrow(KernelCapabilityError);
  const own = finishKernel({ ...fakeKernel(), toSTEP: () => "step-bytes" });
  expect(own.toSTEP([])).toBe("step-bytes");
});
