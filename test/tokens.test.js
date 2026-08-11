import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../src/framework/${rel}`, import.meta.url)), "utf8");

test("tokens.css defines the core palette custom properties in both themes", () => {
  const css = read("tokens.css");
  for (const v of ["--pf-bg", "--pf-text", "--pf-accent", "--pf-mono", "--pf-surface", "--pf-border", "--pf-muted"])
    expect(css, `tokens.css must define ${v}`).toContain(`${v}:`);
  expect(css).toMatch(/:root\s*\{/);                       // default (dark) block
  expect(css).toMatch(/:root\[data-theme="light"\]\s*\{/); // light overrides
  expect(css).toContain("color-scheme: dark");
  expect(css).toContain("color-scheme: light");
});

test("app.css imports tokens.css and no longer defines the palette itself", () => {
  const css = read("app.css");
  // @import present, and it precedes the first real rule (only comments/whitespace before it).
  expect(css).toContain('@import "./tokens.css";');
  const beforeImport = css.slice(0, css.indexOf('@import "./tokens.css";'));
  expect(beforeImport.replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
  // The palette moved out — app.css must NOT still hard-define it (guards against a leftover copy).
  expect(css).not.toContain("--pf-bg:");
  expect(css).not.toContain('data-theme="light"');
});

test("tokens.css defines the layout, shape, and type tokens the rail needs", () => {
  const css = read("tokens.css");
  for (const v of [
    "--pf-sans", "--pf-rail-w", "--pf-rail-pad",
    "--pf-radius-control", "--pf-radius-pill",
    "--pf-shadow-float", "--pf-shadow-rail",
  ]) expect(css, `tokens.css must define ${v}`).toContain(`${v}:`);
  // Geist first, system fallbacks retained, in both stacks.
  expect(css).toMatch(/--pf-sans:\s*"Geist Variable"/);
  expect(css).toContain("system-ui");
  expect(css).toMatch(/--pf-mono:\s*"Geist Mono Variable"/);
  expect(css).toContain("ui-monospace");
  // The rail shadow is INSET (the viewer casts onto the rail — see spec §2.4).
  expect(css).toMatch(/--pf-shadow-rail:\s*inset/);
});

test("tokens.css re-tunes the rail shadow for the light theme", () => {
  const css = read("tokens.css");
  const light = css.slice(css.indexOf('[data-theme="light"]'));
  expect(light, "light theme must override --pf-shadow-rail").toContain("--pf-shadow-rail:");
});

test("app.css sets the body font from the --pf-sans token, not a literal stack", () => {
  const css = read("app.css");
  expect(css).toContain("var(--pf-sans)");
  expect(css).not.toContain("-apple-system, system-ui, sans-serif");
});

test("chrome.css is exported and stays id-free so any host can reuse the layout", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  expect(pkg.exports["./chrome.css"]).toBe("./src/framework/chrome.css");
  // The whole class-based design rests on this: an id-keyed sheet could never be
  // reused by a host that builds its own DOM (partforge-cloud uses #viewer /
  // #pfc-controls), so an id selector sneaking in silently breaks the contract.
  const css = read("chrome.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/#[a-zA-Z]/);
});

// The rail foot's shared button chrome, so a host that drops a button in the
// foot gets the same treatment a built-in one has — the counterpart to
// app.css's `#viewbar button`. Every rule below was duplicated in at least two
// hosts before it moved here.
test("chrome.css gives rail-foot buttons shared chrome, with primary and icon variants", () => {
  const css = read("chrome.css");
  expect(css).toMatch(/\.pf-rail-foot button\s*\{/);
  expect(css).toMatch(/\.pf-rail-foot button\.pf-primary\s*\{/);
  expect(css).toMatch(/\.pf-rail-foot button\.pf-icon\s*\{/);
});

// The bug this whole rule set exists to make unreachable: a disabled button
// that still lights up under the pointer. The two bars reach that guarantee by
// different routes, and both are legitimate — the foot writes
// `:hover:not(:disabled)` on every rule, while the viewbar lets a plain
// `button:hover` stand and neutralizes it with a higher-specificity
// `button:disabled:hover` reset. What must never happen is a bar with hover
// rules and NEITHER protection, which is exactly the state partforge-cloud's
// hand-rolled copy of the foot was in.
test("no hover state in the rail foot or viewbar can fire on a disabled button", () => {
  const css = ["chrome.css", "app.css"]
    .map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
  for (const bar of ["pf-rail-foot", "viewbar"]) {
    const hovers = [...css.matchAll(new RegExp(`^\\s*([^{}]*${bar}[^{}]*:hover[^{}]*)\\{`, "gm"))]
      .map(([, selector]) => selector.trim());
    expect(hovers.length, `${bar} should have hover rules to check`).toBeGreaterThan(0);
    const neutralized = hovers.some((s) => /:disabled:hover/.test(s));
    const guarded = hovers.every((s) => /:hover:not\(:disabled\)|:disabled:hover/.test(s));
    expect(neutralized || guarded,
      `${bar}: hover rules must either all exclude :disabled or be neutralized by a `
      + `:disabled:hover reset. Found:\n  ${hovers.join("\n  ")}`).toBe(true);
  }
});
