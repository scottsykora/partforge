// test/solid-cache.test.js
import { expect, test, vi } from "vitest";
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
