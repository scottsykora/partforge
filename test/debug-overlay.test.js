// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createDebugOverlay } from "../src/framework/debug-overlay.js";

afterEach(() => { document.getElementById("pf-debug")?.remove(); });

test("creating the overlay adds #pf-debug with a checkbox reflecting initialCachingOn", () => {
  createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  const box = document.getElementById("pf-debug");
  expect(box).toBeTruthy();
  expect(box.querySelector("input[type=checkbox]").checked).toBe(true);
});

test("ticking the checkbox calls onToggle with the new value", () => {
  const onToggle = vi.fn();
  createDebugOverlay({ initialCachingOn: true, onToggle });
  const cb = document.querySelector("#pf-debug input[type=checkbox]");
  cb.checked = false;
  cb.dispatchEvent(new Event("change"));
  expect(onToggle).toHaveBeenCalledWith(false);
});

test("update() writes the build time and counts", () => {
  const o = createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  o.update({ ms: 123, hits: 12, misses: 3, skipped: 1, rebuilt: 2 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("123 ms");
  expect(text).toContain("12 hit / 3 miss");
  expect(text).toContain("1 skipped / 2 rebuilt");
});

test("when caching is off, the L2 line reads 'off'", () => {
  const o = createDebugOverlay({ initialCachingOn: false, onToggle: () => {} });
  o.update({ ms: 50, hits: 0, misses: 0, skipped: 0, rebuilt: 1 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("L2 ops: off");
});
