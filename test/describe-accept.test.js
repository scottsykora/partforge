import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { acceptCandidates, DEFAULT_BUDGET } from "../src/framework/oracle/describe/accept.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

// Candidates are thunks so acceptance controls WHEN geometry is built — nothing is
// materialised for a candidate the loop never reaches.
//
// NOTE on kernel API: the task brief's own draft called `k.box(sx, sy, sz)` /
// `k.cylinder(r, h)` (bare positional numbers) and `kernel.cut(a, b)` /
// `kernel.union(a, b)` / `kernel.intersect(a, b)` as free functions. Neither
// exists on the real kernel (see kernel.js's own JSDoc): `box`/`cylinder` take
// an OPTIONS object (`{size:[...]}`, `{r,h}` — a bare positional call skips
// the options normalizer entirely and silently produces a degenerate solid,
// verified directly: `k.box(10,20,5)` measures `volume() === 0`), and
// `cut`/`union`/`intersect` are binary methods ON A SOLID (`a.cut(b)`), not
// kernel-level functions — `kernel.cut` is `undefined` and `kernel.intersect`
// is `undefined` (confirmed against a booted kernel). `kernel.union` DOES
// exist at the top level, but only as the n-ary array form
// (`kernel.union([a,b])`), not `kernel.union(a, b)`. Fixed here to the real
// contract; `accept.js` is written against the same real contract.
const boxCand = (k, sx, sy, sz, at = [0,0,0]) =>
  ({ key: `box:${sx}x${sy}x${sz}`, op: "union", build: () => k.box({ size: [sx, sy, sz] }).translate(at) });
const holeCand = (k, r, h, at) =>
  ({ key: `hole:${r}`, op: "cut", build: () => k.cylinder({ r, h }).translate(at) });

test("a single exact candidate is accepted and leaves near-zero residual", () => {
  const source = kernel.box({ size: [10, 20, 5] });
  const r = acceptCandidates(kernel, source, [boxCand(kernel, 10, 20, 5)]);
  expect(r.accepted.length).toBe(1);
  expect(r.score.xorFraction).toBeLessThan(1e-6);
});

test("acceptance is greedy: the better base body is taken first", () => {
  const source = kernel.box({ size: [10, 20, 5] });
  const r = acceptCandidates(kernel, source, [boxCand(kernel, 4, 4, 4), boxCand(kernel, 10, 20, 5)]);
  expect(r.accepted[0].candidate.key).toBe("box:10x20x5");
});

test("a candidate that does not reduce xor volume is rejected", () => {
  const source = kernel.box({ size: [10, 20, 5] });
  const r = acceptCandidates(kernel, source, [boxCand(kernel, 10, 20, 5), boxCand(kernel, 40, 40, 40)]);
  expect(r.accepted.length).toBe(1);
});

test("every accepted candidate strictly reduces cumulative xor volume", () => {
  const source = kernel.box({ size: [20, 20, 10] }).cut(kernel.cylinder({ r: 3, h: 30 }).translate([10, 10, -10]));
  const r = acceptCandidates(kernel, source, [
    boxCand(kernel, 20, 20, 10),
    holeCand(kernel, 3, 30, [10, 10, -10]),
  ]);
  let prev = Infinity;
  for (const a of r.accepted) { expect(a.cumulativeXor).toBeLessThan(prev); prev = a.cumulativeXor; }
});

test("the hole candidate carries a positive gain", () => {
  const source = kernel.box({ size: [20, 20, 10] }).cut(kernel.cylinder({ r: 3, h: 30 }).translate([10, 10, -10]));
  const r = acceptCandidates(kernel, source, [
    boxCand(kernel, 20, 20, 10),
    holeCand(kernel, 3, 30, [10, 10, -10]),
  ]);
  expect(r.accepted.find((a) => a.candidate.key === "hole:3").gain).toBeGreaterThan(0);
});

test("the budget caps boolean work and is reported", () => {
  const source = kernel.box({ size: [10, 20, 5] });
  const many = Array.from({ length: 40 }, (_, i) => boxCand(kernel, 10 + i * 0.01, 20, 5));
  const r = acceptCandidates(kernel, source, many, { budget: 6 });
  expect(r.budgetSpent).toBeLessThanOrEqual(6);
});

test("DEFAULT_BUDGET is a finite positive number", () => {
  expect(Number.isFinite(DEFAULT_BUDGET)).toBe(true);
  expect(DEFAULT_BUDGET).toBeGreaterThan(0);
});
