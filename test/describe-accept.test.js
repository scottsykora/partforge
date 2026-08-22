import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { acceptCandidates, DEFAULT_ATTEMPT_BUDGET } from "../src/framework/oracle/describe/accept.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

// Wraps a live kernel so every REAL `.cut`/`.union`/`.intersect` call — the WASM
// booleans accept.js's `attempts` counter does NOT count 1-for-1 with (see
// accept.js's own comment on the loop, and the fix-round report) — increments a
// counter this test can read back. Solid-returning methods are re-wrapped so a
// chain (`.translate(...).cut(...)`) stays instrumented all the way through; a
// bare Proxy around `kernel.box`/`kernel.cylinder`'s RESULT is enough here since
// these tests never call any other solid-returning kernel factory.
function countingKernel(k) {
  let calls = 0;
  const wrapSolid = (s) => {
    if (s === null || typeof s !== "object") return s;
    return new Proxy(s, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== "function") return v;
        if (prop === "cut" || prop === "union" || prop === "intersect") {
          return (...args) => { calls++; return wrapSolid(v.apply(target, args)); };
        }
        return (...args) => wrapSolid(v.apply(target, args));
      },
    });
  };
  const wrapped = new Proxy(k, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (prop === "box" || prop === "cylinder") return (...args) => wrapSolid(v.apply(target, args));
      return v.bind(target);
    },
  });
  return { kernel: wrapped, booleans: () => calls };
}

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

test("the budget caps candidate attempts and is reported", () => {
  const source = kernel.box({ size: [10, 20, 5] });
  const many = Array.from({ length: 40 }, (_, i) => boxCand(kernel, 10 + i * 0.01, 20, 5));
  const r = acceptCandidates(kernel, source, many, { budget: 6 });
  expect(r.budgetSpent).toBeLessThanOrEqual(6);
});

test("DEFAULT_ATTEMPT_BUDGET is a finite positive number", () => {
  expect(Number.isFinite(DEFAULT_ATTEMPT_BUDGET)).toBe(true);
  expect(DEFAULT_ATTEMPT_BUDGET).toBeGreaterThan(0);
});

// --- Cost-model locking tests (fix round 1) ------------------------------------
//
// `budgetSpent` counts candidate ATTEMPTS, not real boolean calls (see accept.js's
// own comment on the loop for the full case breakdown). Nothing previously pinned
// that ratio, so a future refactor of the loop's op sequencing could silently
// change it. These wrap the kernel to count real `.cut`/`.union`/`.intersect`
// calls and check them against `budgetSpent` in both regimes the comment
// documents: a null base body (round 1, mixing the 0-boolean cut case and the
// 1-boolean union case) and a non-null one (steady state, 2 booleans/attempt).

test("cost model, null base body: a cut attempt costs 0 real booleans, a union attempt costs 1", () => {
  const source = kernel.box({ size: [10, 20, 5] });

  // Op "cut" against a null current: `trial` is set to `null` directly ("nothing
  // to cut from yet") with no kernel call at all, and the attempt is dropped via
  // `if (!trial) continue`. Budget 1 forces exactly one attempt so the count below
  // is unambiguous.
  const cutRun = countingKernel(kernel);
  const cutOnly = { key: "hole:decoy", op: "cut", build: () => cutRun.kernel.cylinder({ r: 1, h: 30 }).translate([0, 0, -10]) };
  const rCut = acceptCandidates(cutRun.kernel, source, [cutOnly], { budget: 1 });
  expect(rCut.budgetSpent).toBe(1);
  expect(cutRun.booleans()).toBe(0);

  // Op "union" against a null current: `trial` IS `piece` (no union call needed —
  // there is nothing yet to union it with), so the only real boolean is
  // `xorVolume`'s own `intersect`.
  const unionRun = countingKernel(kernel);
  const unionOnly = { key: "box:10x20x5", op: "union", build: () => unionRun.kernel.box({ size: [10, 20, 5] }) };
  const rUnion = acceptCandidates(unionRun.kernel, source, [unionOnly], { budget: 1 });
  expect(rUnion.budgetSpent).toBe(1);
  expect(unionRun.booleans()).toBe(1);
});

test("cost model, non-null base body: an attempt costs 2 real booleans (the trial op plus xorVolume's intersect)", () => {
  // Same box+hole fixture as the "every accepted candidate…" test above, but run
  // to completion (budget 3 exactly covers it) with boolean calls counted. Traced
  // exactly: round 1 evaluates both candidates against a null current — the box
  // (union) costs 1, the hole (cut) costs 0, for 1 real boolean over 2 attempts —
  // and accepts the box (only feasible candidate: the hole's trial was null).
  // Round 2 evaluates the one remaining candidate (the hole) against the now
  // non-null current: 1 boolean to build `current.cut(piece)`, 1 more for
  // `xorVolume`'s intersect — 2 real booleans for that 1 attempt. Total: 3
  // attempts, 1 + 2 = 3 real booleans, so round 2's own attempt-to-boolean ratio
  // is exactly the documented 2, even though the whole-run ratio (3/3) is diluted
  // by round 1's cheaper null-current attempts.
  const run = countingKernel(kernel);
  const source = kernel.box({ size: [20, 20, 10] }).cut(kernel.cylinder({ r: 3, h: 30 }).translate([10, 10, -10]));
  const exactBox = { key: "box", op: "union", build: () => run.kernel.box({ size: [20, 20, 10] }) };
  const exactHole = { key: "hole", op: "cut", build: () => run.kernel.cylinder({ r: 3, h: 30 }).translate([10, 10, -10]) };

  const r = acceptCandidates(run.kernel, source, [exactBox, exactHole], { budget: 3 });
  expect(r.accepted.map((a) => a.candidate.key)).toEqual(["box", "hole"]);
  expect(r.budgetSpent).toBe(3);
  expect(run.booleans()).toBe(3);
});

test("cost model, reproduction: a 4-candidate two-round search reports budgetSpent 9 against 12 real booleans", () => {
  // The exact scenario measured during the fix round's own instrumentation
  // (2 real per attempt once a base body exists, applied across 2 accepted
  // rounds): a box, a matching hole, and one dimensionally-close decoy of each.
  const run = countingKernel(kernel);
  const source = kernel.box({ size: [20, 20, 10] }).cut(kernel.cylinder({ r: 3, h: 30 }).translate([10, 10, -10]));
  const boxAt = (sx, sy, sz) => ({ key: `box:${sx}`, op: "union", build: () => run.kernel.box({ size: [sx, sy, sz] }) });
  const holeAt = (r) => ({ key: `hole:${r}`, op: "cut", build: () => run.kernel.cylinder({ r, h: 30 }).translate([10, 10, -10]) });
  const candidates = [boxAt(20, 20, 10), holeAt(3), boxAt(19, 19, 10), holeAt(2)];

  const result = acceptCandidates(run.kernel, source, candidates);
  expect(result.accepted.map((a) => a.candidate.key)).toEqual(["box:20", "hole:3"]);
  expect(result.budgetSpent).toBe(9);
  expect(run.booleans()).toBe(12);
});

test("a candidate whose build() throws is dropped, and the remaining candidate is still evaluated and accepted under a budget tight enough that the drop matters", () => {
  const source = kernel.box({ size: [10, 20, 5] });
  const broken = { key: "broken", op: "union", build: () => { throw new Error("geometry will not build"); } };
  const working = boxCand(kernel, 10, 20, 5);
  // Budget 2 is exactly enough to cover one failed attempt plus one working
  // attempt — tight enough that if the failed attempt were mishandled (e.g. not
  // incrementing the attempt count, or aborting the round instead of continuing)
  // the working candidate would never be reached at all.
  const r = acceptCandidates(kernel, source, [broken, working], { budget: 2 });
  expect(r.accepted.length).toBe(1);
  expect(r.accepted[0].candidate.key).toBe(working.key);
  expect(r.budgetSpent).toBe(2);
});
