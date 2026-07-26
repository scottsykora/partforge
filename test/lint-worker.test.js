// The worker lint job. The point of this job is that it answers WITHOUT booting a
// kernel: handle() in jobs.js takes an already-booted kernel and worker.js awaits
// that boot before calling it, so lint must be intercepted ahead of both.
import { expect, test, vi } from "vitest";

const goodPart = () => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
});

// Install a fake WorkerGlobalScope, import runWorker, and return the captured hooks.
async function bootWorker(part) {
  const posted = [];
  const self = {
    name: "occt", // the expensive backend: proves lint never triggers its boot
    navigator: { userAgent: "node" },
    onmessage: null,
    postMessage: (m) => posted.push(m),
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("postMessage", self.postMessage);
  const { runWorker } = await import("../src/framework/worker.js");
  runWorker(part);
  return { self, posted };
}

test("a lint message is answered with a lint-report", async () => {
  const { self, posted } = await bootWorker(goodPart());
  await self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report");
  expect(report).toBeDefined();
  expect(report.report.ok).toBe(true);
  expect(report.report.errors).toEqual([]);
});

test("the lint report carries findings for a broken part", async () => {
  const part = goodPart();
  part.parts.body.build = (k, p) => k.box({ sizes: [p.h, p.h, p.h] });
  const { self, posted } = await bootWorker(part);
  await self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report").report;
  expect(report.ok).toBe(false);
  expect(report.errors.map((f) => f.rule)).toContain("invalid-op-options");
});

test("params are forwarded to lintPart", async () => {
  const part = goodPart();
  part.parts.body.build = (k, p) => {
    if (p.mode === "explode") throw new Error("exploded");
    return k.box({ size: [1, 1, 1] });
  };
  part.defaults = { mode: "ok" };
  const { self, posted } = await bootWorker(part);
  await self.onmessage({ data: { type: "lint", params: { mode: "explode" } } });
  const report = posted.find((m) => m.type === "lint-report").report;
  expect(report.errors.map((f) => f.rule)).toContain("build-throws");
});

test("lint does not boot the OCCT kernel", async () => {
  // A cold OCCT boot posts { type: "progress", phase: "loading exact kernel" }
  // before it starts. Its absence is the evidence that no boot was attempted.
  const { self, posted } = await bootWorker(goodPart());
  await self.onmessage({ data: { type: "lint" } });
  expect(posted.find((m) => m.type === "progress" && /exact kernel/.test(m.phase ?? ""))).toBeUndefined();
});
