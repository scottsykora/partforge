// test/solid-cache.test.js
import { describe, expect, it, test, vi } from "vitest";
import { createSolidCache } from "../src/framework/geometry/solid-cache.js";

const make = (value) => () => ({ value, pin: value, dispose: vi.fn() });

test("a repeated hash within a sub-part is a hit and does not recompute", () => {
  const c = createSolidCache();
  c.begin("a");
  const v1 = c.lookup("h1", make({ id: 1 }));
  c.end();

  c.begin("a");
  const second = vi.fn(() => ({ value: { id: 99 }, pin: {}, dispose: vi.fn() }));
  const v2 = c.lookup("h1", second);
  c.end();

  expect(v2).toBe(v1);            // carried over from the previous round
  expect(second).not.toHaveBeenCalled();
  expect(c.stats()).toEqual({ hits: 1, misses: 1 });
});

test("an entry not re-used next round is disposed (evicted)", () => {
  const c = createSolidCache();
  const dispose = vi.fn();
  c.begin("a");
  c.lookup("old", () => ({ value: {}, pin: {}, dispose }));
  c.end();

  c.begin("a");
  c.lookup("new", make({}));      // different hash → "old" not re-used
  c.end();

  expect(dispose).toHaveBeenCalledTimes(1);
});

test("sub-parts are isolated — A's eviction never touches B", () => {
  const c = createSolidCache();
  const disposeB = vi.fn();
  c.begin("b"); c.lookup("hb", () => ({ value: {}, pin: {}, dispose: disposeB })); c.end();
  c.begin("a"); c.lookup("ha", make({})); c.end();      // rebuild A only
  c.begin("a"); c.lookup("ha2", make({})); c.end();     // A changes; evicts A's old
  expect(disposeB).not.toHaveBeenCalled();              // B untouched
});

test("isPinned reflects live cached pins", () => {
  const c = createSolidCache();
  const pin = { id: 1 };
  c.begin("a");
  c.lookup("h1", () => ({ value: {}, pin, dispose: vi.fn() }));
  expect(c.isPinned(pin)).toBe(true);
  c.end();
  expect(c.isPinned(pin)).toBe(true);   // still cached after commit
});

test("lookup outside a bracket computes without caching", () => {
  const c = createSolidCache();
  const v = c.lookup("h1", make({ id: 7 }));
  expect(v).toEqual({ id: 7 });
  expect(c.isPinned({ id: 7 })).toBe(false);
  expect(c.stats()).toEqual({ hits: 0, misses: 0 });
});

describe("sweep (rebind-generation eviction)", () => {
  function makeEntry(value, disposed) {
    return { value, pin: value, dispose: () => disposed.push(value) };
  }

  it("evicts partitions idle for >= 3 generations, keeps recently built ones", () => {
    const c = createSolidCache();
    const disposed = [];
    c.begin("stale"); c.lookup("h1", () => makeEntry("s1", disposed)); c.end();
    c.sweep(); // stale idle 1
    c.begin("fresh"); c.lookup("h2", () => makeEntry("f1", disposed)); c.end();
    c.sweep(); // stale idle 2, fresh idle 1
    expect(disposed).toEqual([]);
    c.sweep(); // stale idle 3 -> evicted; fresh idle 2 -> kept
    expect(disposed).toEqual(["s1"]);
  });

  it("building a partition re-stamps it (never evicted while in use)", () => {
    const c = createSolidCache();
    const disposed = [];
    for (let i = 0; i < 5; i++) {
      c.begin("live"); c.lookup("h", () => makeEntry("v", disposed)); c.end();
      c.sweep();
    }
    expect(disposed).toEqual([]);
  });

  it("unpins evicted entries", () => {
    const c = createSolidCache();
    const disposed = [];
    c.begin("a"); c.lookup("h", () => makeEntry("v", disposed)); c.end();
    expect(c.isPinned("v")).toBe(true);
    c.sweep(); c.sweep(); c.sweep();
    expect(c.isPinned("v")).toBe(false);
    expect(disposed).toEqual(["v"]);
  });
});
