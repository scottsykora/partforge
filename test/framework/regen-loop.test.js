// The auto-regenerate state machine, extracted from mount.js. These tests pin the
// behavior mount has always had: builds gate on kernel readiness, slider drags
// debounce into one build, builds never overlap, and a parameter edit that lands
// mid-build marks the finished result stale so it is discarded and redone.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRegenLoop } from "../../src/framework/regen-loop.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function makeLoop({ missing = ["a"] } = {}) {
  const send = vi.fn();
  const state = { missing };
  const loop = createRegenLoop({ missingParts: () => state.missing, send });
  return { loop, send, state };
}

test("nothing is sent before the kernel is ready", () => {
  const { loop, send } = makeLoop();
  loop.markDirty();
  vi.runAllTimers();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
  loop.ready();
  expect(send).toHaveBeenCalledTimes(1);
});

test("ready() builds the missing parts immediately", () => {
  const { loop, send } = makeLoop({ missing: ["a", "b"] });
  loop.ready();
  expect(send).toHaveBeenCalledWith(["a", "b"]);
});

test("nothing is sent when no parts are missing", () => {
  const { loop, send } = makeLoop({ missing: [] });
  loop.ready();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
});

test("rapid edits debounce into a single build", () => {
  const { loop, send, state } = makeLoop({ missing: [] });
  loop.ready();
  state.missing = ["a"];
  loop.markDirty();
  vi.advanceTimersByTime(100);
  loop.markDirty();
  loop.markDirty();
  vi.advanceTimersByTime(179);
  expect(send).not.toHaveBeenCalled(); // still inside the debounce window
  vi.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test("builds never overlap: kicks while generating are ignored until buildDone", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  expect(send).toHaveBeenCalledTimes(1);
  loop.kick();
  loop.markDirty();
  vi.runAllTimers();
  expect(send).toHaveBeenCalledTimes(1); // still the one in-flight build
  loop.buildDone();
  loop.kick();
  expect(send).toHaveBeenCalledTimes(2);
});

test("buildDone reports fresh when nothing changed mid-build", () => {
  const { loop } = makeLoop();
  loop.ready();
  expect(loop.buildDone()).toBe(true);
});

test("a mid-build edit makes the result stale; the follow-up kick rebuilds", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  loop.markDirty();          // edit lands while the build is in flight
  vi.runAllTimers();         // its debounce fires but the in-flight build blocks it
  expect(loop.buildDone()).toBe(false); // result is stale — caller must discard it
  loop.kick();
  expect(send).toHaveBeenCalledTimes(2); // rebuilt with the new params
});

test("version() increments once per edit (drives the mesh cache's validity stamps)", () => {
  const { loop } = makeLoop();
  expect(loop.version()).toBe(0);
  loop.markDirty();
  loop.markDirty();
  expect(loop.version()).toBe(2);
});

test("dispose() cancels a pending debounced kick", () => {
  const { loop, send } = makeLoop();
  loop.ready();
  send.mockClear();
  loop.buildDone();
  loop.markDirty();       // queues a debounced kick
  loop.dispose();
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
});

test("after dispose(), ready() and kick() send nothing", () => {
  const { loop, send } = makeLoop();
  loop.dispose();
  loop.ready();
  loop.kick();
  expect(send).not.toHaveBeenCalled();
});
