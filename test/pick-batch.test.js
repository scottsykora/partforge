import { expect, test } from "vitest";
import { createBatch, view, resolve, cancel, timeout, result } from "../src/framework/pick-request/batch.js";

const sel = (n) => ({ subPart: n, point: [0, 0, 0], normal: [0, 0, 1], params: {} });

test("createBatch starts collecting at index 0", () => {
  const b = createBatch(["click A", "click B"]);
  expect(view(b)).toMatchObject({ index: 0, total: 2, prompt: "click A", status: "collecting" });
  expect(typeof b.id).toBe("string");
});

test("resolving in order advances, then completes with ordered picks echoing prompts", () => {
  const b = createBatch(["click A", "click B"]);
  resolve(b, 0, sel("a"));
  expect(view(b)).toMatchObject({ index: 1, prompt: "click B", status: "collecting" });
  resolve(b, 1, sel("b"));
  expect(view(b).status).toBe("done");
  expect(result(b)).toEqual({
    status: "done",
    picks: [{ prompt: "click A", selection: sel("a") }, { prompt: "click B", selection: sel("b") }],
  });
});

test("a stale/duplicate index is ignored", () => {
  const b = createBatch(["click A", "click B"]);
  resolve(b, 1, sel("x")); // not the current index (0)
  expect(view(b).index).toBe(0);
  resolve(b, 0, sel("a"));
  resolve(b, 0, sel("a-again")); // index already advanced past 0
  expect(view(b).index).toBe(1);
});

test("cancel and timeout freeze with partial picks", () => {
  const b = createBatch(["click A", "click B"]);
  resolve(b, 0, sel("a"));
  cancel(b);
  expect(result(b)).toEqual({ status: "cancelled", picks: [{ prompt: "click A", selection: sel("a") }] });
  expect(view(b)).toMatchObject({ status: "cancelled", prompt: null });

  const c = createBatch(["click A"]);
  timeout(c);
  expect(result(c).status).toBe("timeout");
});
