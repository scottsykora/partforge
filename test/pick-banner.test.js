// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

// Stub the picker so we can drive onPick directly without a real raycast.
let captured;
vi.mock("../src/framework/selection/pick.js", () => ({
  attachPicker: (viewer, opts) => { captured = opts; return { setActive: vi.fn(), detach: vi.fn() }; },
}));

afterEach(() => { document.body.innerHTML = ""; captured = undefined; });

const { createPromptBanner } = await import("../src/framework/pick-request/prompt-banner.js");

test("request shows the banner with avatar/label/text and arms the picker", () => {
  const b = createPromptBanner({ viewer: {}, part: {}, getContext: () => ({}) });
  b.request({ avatar: "📋", label: "Copy to clipboard", text: "Click a part", onResolve: () => {} });
  const banner = document.querySelector("#pf-pick-banner");
  expect(banner.style.display).toBe("block");
  expect(banner.textContent).toContain("📋");
  expect(banner.textContent).toContain("Copy to clipboard");
  expect(banner.textContent).toContain("Click a part");
  expect(b.isOpen()).toBe(true);
});

test("a pick calls onResolve once with the selection; a stray pick after is ignored", () => {
  const b = createPromptBanner({ viewer: {}, part: {}, getContext: () => ({}) });
  const onResolve = vi.fn();
  b.request({ avatar: "📋", label: "x", text: "y", onResolve });
  captured.onPick({ subPart: "a" });
  captured.onPick({ subPart: "a" }); // resolved once already — no-op
  expect(onResolve).toHaveBeenCalledTimes(1);
  expect(onResolve).toHaveBeenCalledWith({ subPart: "a" });
});

test("the × runs onDismiss and hides the banner", () => {
  const b = createPromptBanner({ viewer: {}, part: {}, getContext: () => ({}) });
  const onDismiss = vi.fn();
  b.request({ avatar: "🤖", label: "x", text: "y", onDismiss });
  document.querySelector("#pf-pick-close").click();
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(b.isOpen()).toBe(false);
});

test("message shows a transient note and clears any pending pick", () => {
  const b = createPromptBanner({ viewer: {}, part: {}, getContext: () => ({}) });
  const onResolve = vi.fn();
  b.request({ avatar: "📋", label: "x", text: "y", onResolve });
  b.message("✓ Copied to clipboard");
  expect(document.querySelector("#pf-pick-banner").textContent).toContain("Copied");
  captured.onPick({ subPart: "a" }); // no pending resolve after a message
  expect(onResolve).not.toHaveBeenCalled();
});
