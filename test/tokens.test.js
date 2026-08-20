import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../src/framework/${rel}`, import.meta.url)), "utf8");

// Every rule block in a sheet, as { selector, body } with comments stripped —
// enough to ask "which file declares this property for this selector?", which is
// the only question the placement/appearance split can be tested by.
const rules = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));

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

// The rail toggle floats at the stage's TOP RIGHT, on its own, rather than
// riding in #viewbar's pill (2026-08-20). Same file split as every other piece
// of floating chrome: chrome.css says where it sits, app.css says what it looks
// like, so partforge-cloud can re-anchor it and still inherit its appearance.
test("chrome.css places the floating rail toggle without restating the stage margin", () => {
  const css = read("chrome.css");
  const own = rules(css).filter((r) => r.selector === ".pf-float-rail-toggle");
  expect(css, "chrome.css must place .pf-float-rail-toggle").toContain(".pf-float-rail-toggle");
  // The insets come from declarations SHARED with .pf-float-tabs (top: 12px) and
  // .pf-float-viewbar (right: 12px) — the top-right and bottom-right corners of
  // one stage, off one margin. A solo rule here would be a second copy of that
  // margin, free to drift away from the corner it is supposed to mirror.
  for (const rule of own) {
    expect(rule.body, `.pf-float-rail-toggle must not restate its own insets: ${rule.body.trim()}`)
      .not.toMatch(/\b(top|right|bottom|left)\s*:/);
  }
  const shares = (prop) => rules(css).some((r) =>
    r.selector.includes(".pf-float-rail-toggle") && new RegExp(`\\b${prop}\\s*:\\s*12px`).test(r.body));
  expect(shares("top"), "the toggle must take top: 12px from a shared rule").toBe(true);
  expect(shares("right"), "the toggle must take right: 12px from a shared rule").toBe(true);
  expect(rules(css).some((r) =>
    r.selector.includes(".pf-float-rail-toggle") && /position\s*:\s*absolute/.test(r.body)),
  "the toggle must be absolutely positioned within the stage").toBe(true);
});

test("app.css gives the floating rail toggle its appearance, and only that", () => {
  const css = read("app.css");
  const own = rules(css).filter((r) => r.selector === ".pf-float-rail-toggle");
  expect(own.length, "app.css must style .pf-float-rail-toggle").toBe(1);
  const [{ body }] = own;
  // The viewbar's own height, so it reads as a peer of the viewer controls.
  expect(body).toMatch(/width\s*:\s*44px/);
  expect(body).toMatch(/height\s*:\s*44px/);
  // A bare floating icon at rest: no card of any kind.
  expect(body).toMatch(/background\s*:\s*transparent/);
  expect(body).toMatch(/border\s*:\s*0/);
  expect(body).toMatch(/box-shadow\s*:\s*none/);
  // A rounded rect, NOT the projection toggle's circle — two different controls.
  expect(body).toMatch(/border-radius\s*:\s*var\(--pf-radius-control\)/);
  expect(body).not.toMatch(/border-radius\s*:\s*50%/);
  // Placement stays in chrome.css.
  expect(body, "placement belongs in chrome.css").not.toMatch(/\bposition\s*:/);
  expect(body, "placement belongs in chrome.css").not.toMatch(/\b(top|right|bottom|left)\s*:/);
  // The card appears on hover only.
  expect(rules(css).some((r) =>
    r.selector === ".pf-float-rail-toggle:hover" && /background\s*:/.test(r.body)),
  "a hover background is the whole affordance").toBe(true);
});

// The trap `#viewbar button[hidden]` already guards against, inherited: this
// button's author-origin `display: flex` (it centres an icon) outranks the UA's
// `[hidden] { display: none }`, so rail.js's `toggle.hidden = narrow` would
// leave it fully visible below the narrow breakpoint — where the pane tab bar
// owns pane selection and a second collapse affordance must not compete.
test("app.css keeps the floating rail toggle hideable via the hidden property", () => {
  const css = read("app.css");
  expect(rules(css).some((r) =>
    r.selector === ".pf-float-rail-toggle[hidden]" && /display\s*:\s*none/.test(r.body)),
  ".pf-float-rail-toggle[hidden] must be display: none").toBe(true);
});

// All fourteen of the framework's own pages carry this markup by hand, so they
// can silently disagree — one page left with the button inside the pill would
// look like a bug in the CSS rather than in that page.
test("every part page floats the rail toggle outside #viewbar", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pages = readdirSync(root).filter((f) => f.endsWith(".html"))
    .map((f) => [f, readFileSync(`${root}${f}`, "utf8")])
    .filter(([, html]) => html.includes('id="rail-toggle"'));
  expect(pages.length, "expected the framework's part pages to carry #rail-toggle").toBeGreaterThanOrEqual(14);
  for (const [name, html] of pages) {
    const bar = html.slice(html.indexOf('id="viewbar"'));
    const viewbar = bar.slice(0, bar.indexOf("</div>"));
    expect(viewbar, `${name}: #rail-toggle must not sit inside #viewbar`).not.toContain('id="rail-toggle"');
    expect(html, `${name}: #rail-toggle needs the .pf-float-rail-toggle class`)
      .toContain('<button id="rail-toggle" class="pf-float-rail-toggle"');
  }
});
