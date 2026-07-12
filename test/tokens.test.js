import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../src/framework/${rel}`, import.meta.url)), "utf8");

test("tokens.css defines the core palette custom properties in both themes", () => {
  const css = read("tokens.css");
  for (const v of ["--bg", "--text", "--accent", "--mono", "--surface", "--border", "--muted"])
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
  expect(css).not.toContain("--bg:");
  expect(css).not.toContain('data-theme="light"');
});
