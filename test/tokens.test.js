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
