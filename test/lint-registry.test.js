// The rule registry is the documented catalog. Like test/kernel-contract.test.js, this
// pins the code to the docs so the two can't drift. The docs-coverage assertion lands
// in Task 10 with the catalog it checks, so every task in this plan ends green.
import { expect, test } from "vitest";
import { RULES } from "../src/lint.js";

test("every rule has a unique id", () => {
  const ids = RULES.map((r) => r.id);
  expect(ids.length).toBe(new Set(ids).size);
});

test("every rule id is kebab-case", () => {
  for (const r of RULES) expect(r.id, `${r.id} is not kebab-case`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
});

test("every rule exposes a run function", () => {
  for (const r of RULES) expect(typeof r.run, `${r.id} has no run()`).toBe("function");
});

test("the registry covers all four rule groups", () => {
  const ids = RULES.map((r) => r.id);
  for (const id of ["missing-views", "features-requires-sliders", "invalid-op-options", "verify-unknown-metric"]) {
    expect(ids, `registry is missing ${id}`).toContain(id);
  }
  expect(RULES.length).toBeGreaterThanOrEqual(27);
});
