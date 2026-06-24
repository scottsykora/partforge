# Control Metadata UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-section/per-control Markdown descriptions (surfaced via an info-glyph click popover) and a `hidden` flag that drops a control/section from the panel while keeping its parameter in `defaults`.

**Architecture:** A new main-thread `markdown.js` renders + sanitizes descriptions (`marked` → `DOMPurify`). `controls.js` gains pure visibility predicates (consumed by `buildControls` to skip hidden/empty items) and an `attachInfo` helper that adds a focusable `ⓘ` glyph wired to a single shared popover. happy-dom (scoped per test file) makes the panel DOM unit-testable.

**Tech Stack:** Vanilla ES modules, `marked`, `dompurify`, Vitest + happy-dom, Node 24.

## Global Constraints

- **Node 24 for tests** (`nvm use` first; default shell Node is too old).
- **Descriptions are Markdown (CommonMark)**, rendered with `marked` then sanitized with `DOMPurify`. Links get `target="_blank" rel="noopener noreferrer"`; scripts/event-handlers/disallowed URL schemes are stripped.
- **`markdown.js` is main-thread only** — it imports a DOM sanitizer and MUST NOT be imported by the geometry worker (same rule as `viewer.js`/`controls.js`).
- **`hidden: true`** removes a control/section/feature from the panel but its `key` stays in `defaults` and still drives geometry. A section with no presets and no visible controls (or `hidden`) does not render.
- **happy-dom is scoped per file** via a `// @vitest-environment happy-dom` docblock — the WASM/geometry suites keep running in plain Node, unchanged.
- **Backward compatible:** absent `description`/`hidden` = today's exact behavior.
- Commit messages follow repo convention; end with the `Co-Authored-By:`/`Claude-Session:` trailers.

---

## Task 1: Markdown render module (+ deps + happy-dom)

The pure, testable seam. Installs the three dependencies and establishes the happy-dom test convention.

**Files:**
- Create: `src/framework/markdown.js`
- Test: `test/framework/markdown.test.js`
- Modify: `package.json` (via `npm install`)

**Interfaces:**
- Produces: `renderMarkdown(src: string) => string` — sanitized HTML; `""` for empty/blank input.

- [ ] **Step 1: Install dependencies**

Run:
```bash
nvm use && npm install marked dompurify && npm install -D happy-dom
```
Expected: `marked` and `dompurify` land in `dependencies`, `happy-dom` in `devDependencies`.

- [ ] **Step 2: Write the failing tests**

Create `test/framework/markdown.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { renderMarkdown } from "../../src/framework/markdown.js";

test("renders basic formatting", () => {
  const html = renderMarkdown("**bold** *italic* `code`");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
  expect(html).toContain("<code>code</code>");
});

test("renders a list", () => {
  const html = renderMarkdown("- one\n- two");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
});

test("links open in a new tab with rel=noopener", () => {
  const html = renderMarkdown("[docs](https://example.com/x)");
  expect(html).toMatch(/href="https:\/\/example\.com\/x"/);
  expect(html).toMatch(/target="_blank"/);
  expect(html).toMatch(/rel="noopener noreferrer"/);
});

test("renders an image", () => {
  const html = renderMarkdown("![a diagram](https://example.com/d.png)");
  expect(html).toMatch(/<img [^>]*src="https:\/\/example\.com\/d\.png"/);
  expect(html).toMatch(/alt="a diagram"/);
});

test("strips script, event-handler, and javascript: payloads", () => {
  expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script");
  expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("onerror");
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
});

test("blank input renders empty string", () => {
  expect(renderMarkdown("")).toBe("");
  expect(renderMarkdown("   ")).toBe("");
  expect(renderMarkdown(undefined)).toBe("");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/markdown.test.js`
Expected: FAIL — cannot find module `../../src/framework/markdown.js`.

- [ ] **Step 4: Implement the module**

Create `src/framework/markdown.js`:

```js
// Render a (trusted, author-authored) Markdown description to sanitized HTML for
// display in a control/section info popover. Main-thread only — it imports a DOM
// sanitizer, so it must NOT be imported from the geometry worker.
import { marked } from "marked";
import DOMPurify from "dompurify";

// Links open in a new tab and cannot reach window.opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const CONFIG = {
  ALLOWED_TAGS: ["a", "img", "p", "br", "strong", "em", "code", "pre", "blockquote",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "hr", "del"],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "target", "rel"],
  // links: http(s)/mailto; images: https or data:image/. (Union applied to all URI attrs.)
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/)/i,
  FORBID_ATTR: ["style"],
};

// src: a CommonMark string. Returns sanitized HTML. Empty/blank/non-string → "".
export function renderMarkdown(src) {
  if (typeof src !== "string" || !src.trim()) return "";
  const raw = marked.parse(src, { async: false });
  return DOMPurify.sanitize(raw, CONFIG);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/framework/markdown.test.js`
Expected: PASS (6 tests).

> If DOMPurify fails to initialize under happy-dom (it needs a `window`), pass the
> global window explicitly: replace the import with
> `import createDOMPurify from "dompurify"; const DOMPurify = createDOMPurify(window);`
> — `window` is global under the happy-dom environment.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `nvm use && npx vitest run`
Expected: PASS. (A pre-existing intermittent failure may appear in `test/cli-occt.test.js` under parallel run — a `render/` dir race unrelated to this work; it passes in isolation. If it appears, confirm the new test passes alone and proceed.)

- [ ] **Step 7: Commit**

```bash
git add src/framework/markdown.js test/framework/markdown.test.js package.json package-lock.json
git commit -m "feat: add markdown render+sanitize module for descriptions"
```

---

## Task 2: Hidden filtering + visibility predicates

Pure predicates plus the `buildControls` wiring that skips hidden controls/sections and empty Advanced blocks.

**Files:**
- Modify: `src/framework/controls.js` (`buildControls` ~98-106, `buildPresetSection` ~108-147, `buildFeatureSection` ~149-185)
- Test: `test/framework/controls.test.js` (extend)

**Interfaces:**
- Produces (exported from `controls.js`):
  - `visibleAdvanced(sec) => def[]` — `sec.advanced` minus `hidden`.
  - `visibleFeatures(sec) => feature[]` — `sec.features` minus `hidden`.
  - `sectionRenders(sec) => boolean` — false if `sec.hidden`; feature section → has ≥1 visible feature; preset section → has presets OR ≥1 visible advanced control.

- [ ] **Step 1: Write the failing predicate + DOM tests**

Append to `test/framework/controls.test.js`. First add the happy-dom docblock at the very top of the file if not present (the file currently starts with imports — add the docblock as line 1):

```js
// @vitest-environment happy-dom
```

Then append:

```js
import { buildControls, visibleAdvanced, visibleFeatures, sectionRenders } from "../../src/framework/controls.js";

const presetSec = (over = {}) => ({ id: "body", title: "Body",
  advanced: [
    { key: "od", label: "OD", min: 1, max: 10, step: 1 },
    { key: "secret", label: "Secret", min: 0, max: 1, step: 1, hidden: true },
  ], ...over });
const featureSec = (over = {}) => ({ id: "f", title: "Flange", features: [
    { label: "Flange", key: "flange_d", on: 16, sliders: [{ key: "flange_d", label: "D", min: 1, max: 50, step: 1 }] },
    { label: "Hidden feat", key: "hf", on: 1, hidden: true, sliders: [{ key: "hf", label: "H", min: 0, max: 1, step: 1 }] },
  ], ...over });

test("visibleAdvanced / visibleFeatures drop hidden entries", () => {
  expect(visibleAdvanced(presetSec()).map((d) => d.key)).toEqual(["od"]);
  expect(visibleFeatures(featureSec()).map((f) => f.key)).toEqual(["flange_d"]);
});

test("sectionRenders: hidden section never renders; empty section doesn't; preset/feature do", () => {
  expect(sectionRenders({ title: "X", hidden: true, presets: { A: {} } })).toBe(false);
  expect(sectionRenders({ title: "X", advanced: [{ key: "z", label: "Z", min: 0, max: 1, step: 1, hidden: true }] })).toBe(false);
  expect(sectionRenders(presetSec())).toBe(true);                // has a visible control
  expect(sectionRenders({ title: "P", presets: { A: {} }, advanced: [] })).toBe(true); // presets only
  expect(sectionRenders(featureSec())).toBe(true);
  expect(sectionRenders({ title: "F", features: [{ label: "h", key: "h", on: 1, hidden: true, sliders: [] }] })).toBe(false);
});

test("buildControls omits hidden advanced control from the DOM", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [presetSec()], { od: 5, secret: 0 }, () => {});
  const labels = [...root.querySelectorAll("label")].map((l) => l.textContent);
  expect(labels.join(" ")).toContain("OD");
  expect(labels.join(" ")).not.toContain("Secret");
});

test("buildControls skips a section whose every control is hidden", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const allHidden = { id: "h", title: "AllHidden", advanced: [{ key: "z", label: "Z", min: 0, max: 1, step: 1, hidden: true }] };
  buildControls(root, [allHidden], { z: 0 }, () => {});
  expect(root.textContent).not.toContain("AllHidden");
  expect(root.querySelectorAll(".section").length).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: FAIL — `visibleAdvanced is not a function` / hidden control still present.

- [ ] **Step 3: Add the predicates**

In `src/framework/controls.js`, add near the top (after `clampToRange`):

```js
// --- visibility (hidden controls/sections) --------------------------------
export const visibleAdvanced = (sec) => (sec.advanced ?? []).filter((d) => !d.hidden);
export const visibleFeatures = (sec) => (sec.features ?? []).filter((f) => !f.hidden);
export function sectionRenders(sec) {
  if (sec.hidden) return false;
  if (sec.features) return visibleFeatures(sec).length > 0;
  const hasPresets = sec.presets && Object.keys(sec.presets).length > 0;
  return !!hasPresets || visibleAdvanced(sec).length > 0;
}
```

- [ ] **Step 4: Skip non-rendering sections in `buildControls`**

Replace `buildControls`:

```js
export function buildControls(root, parameters, params, onDirty) {
  for (const sec of parameters) {
    if (!sectionRenders(sec)) continue;
    const section = el("div", "section");
    section.append(el("div", "sec-title", sec.title));
    if (sec.features) buildFeatureSection(section, sec, params, onDirty);
    else buildPresetSection(section, sec, params, onDirty);
    root.append(section);
  }
}
```

- [ ] **Step 5: Build only visible advanced controls in `buildPresetSection`**

Replace `buildPresetSection` with (presets block unchanged; sliders iterate `visibleAdvanced`; Advanced block omitted when there are none; preset-change refresh works with or without sliders):

```js
function buildPresetSection(section, sec, params, onDirty) {
  let preset = null;
  const presetNames = sec.presets ? Object.keys(sec.presets) : [];
  if (presetNames.length) {
    preset = document.createElement("select");
    preset.className = "preset";
    for (const name of [...presetNames, "Custom"]) {
      const o = document.createElement("option");
      o.value = name; o.textContent = name; preset.append(o);
    }
    preset.value = presetNames[0];
    section.append(preset);
  }

  const advanced = visibleAdvanced(sec);
  const syncs = {};
  if (advanced.length) {
    const { adv, toggle } = advancedBlock();
    for (const def of advanced) {
      const s = makeSlider(def, params, () => { if (preset) preset.value = "Custom"; onDirty?.(); });
      adv.append(s.wrap);
      syncs[def.key] = s.sync;
    }
    section.append(toggle, adv);
  }

  if (preset) {
    preset.addEventListener("change", () => {
      const bundle = sec.presets[preset.value];
      if (!bundle) return; // "Custom"
      Object.assign(params, bundle);
      for (const key in syncs) if (key in params) syncs[key]();
      onDirty?.();
    });
  }
}
```

- [ ] **Step 6: Build only visible features / sliders in `buildFeatureSection`**

In `buildFeatureSection`, change the feature loop to iterate visible features and skip hidden sliders. Replace `for (const feat of sec.features) {` with:

```js
  for (const feat of visibleFeatures(sec)) {
```

and replace the slider loop `for (const def of feat.sliders) {` with:

```js
    for (const def of feat.sliders.filter((d) => !d.hidden)) {
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS (existing `clampToRange` tests + the new predicate/DOM tests).

- [ ] **Step 8: Commit**

```bash
git add src/framework/controls.js test/framework/controls.test.js
git commit -m "feat: hidden controls/sections + visibility predicates in the panel"
```

---

## Task 3: Info glyph + Markdown popover

The `ⓘ` glyph and shared click-popover, used by section titles, controls, and feature labels.

**Files:**
- Modify: `src/framework/controls.js` (import `renderMarkdown`; add `attachInfo` + popover; call it from `buildControls`, `makeSlider`, `buildFeatureSection`)
- Modify: `src/framework/app.css` (append `.info` + `.popover` styles)
- Test: `test/framework/controls.test.js` (extend)

**Interfaces:**
- Consumes: `renderMarkdown` (Task 1).
- Produces: an `ⓘ` `button.info` after any titled element with a `description`; clicking it opens a single shared `.popover` (appended to `document.body`) containing the rendered Markdown.

- [ ] **Step 1: Write the failing popover tests**

Append to `test/framework/controls.test.js`:

```js
const descSec = () => ({ id: "d", title: "Body", description: "Body **section** docs",
  advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1, description: "Outer [dia](https://x.test/d)" },
             { key: "h", label: "H", min: 1, max: 10, step: 1 }] }); // h has no description

function render(sec, params) {
  document.body.innerHTML = '<div id="root"></div>';
  document.querySelectorAll(".popover").forEach((p) => p.remove()); // reset shared popover between tests
  const root = document.getElementById("root");
  buildControls(root, [sec], params, () => {});
  return root;
}

test("info glyph appears only for items with a description", () => {
  const root = render(descSec(), { od: 5, h: 5 });
  // section title + the OD control have descriptions; H does not
  expect(root.querySelectorAll(".info").length).toBe(2);
});

test("clicking the glyph opens a popover with rendered markdown; Escape closes it", () => {
  const root = render(descSec(), { od: 5, h: 5 });
  const glyph = root.querySelector(".info");
  glyph.click();
  const pop = document.querySelector(".popover");
  expect(pop).toBeTruthy();
  expect(pop.hidden).toBe(false);
  expect(pop.innerHTML).toContain("<strong>section</strong>");
  expect(glyph.getAttribute("aria-expanded")).toBe("true");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".popover").hidden).toBe(true);
  expect(glyph.getAttribute("aria-expanded")).toBe("false");
});

test("opening a second glyph swaps content and closes the first", () => {
  const root = render(descSec(), { od: 5, h: 5 });
  const [g1, g2] = root.querySelectorAll(".info"); // section, then OD control
  g1.click();
  g2.click();
  const pop = document.querySelector(".popover");
  expect(pop.hidden).toBe(false);
  expect(pop.innerHTML).toContain('href="https://x.test/d"'); // OD's link
  expect(g1.getAttribute("aria-expanded")).toBe("false");
  expect(g2.getAttribute("aria-expanded")).toBe("true");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/framework/controls.test.js -t glyph`
Expected: FAIL — no `.info` elements (`querySelectorAll(".info").length` is 0).

- [ ] **Step 3: Implement `attachInfo` + the shared popover in `controls.js`**

At the top of `src/framework/controls.js`, add the import:

```js
import { renderMarkdown } from "./markdown.js";
```

Then add the popover machinery (after `clampToRange`/predicates, before `el`):

```js
// --- info glyph + shared popover ------------------------------------------
// One popover element, reused across glyphs (only one open at a time). Global
// dismiss listeners are registered once at module load.
let popover = null;
function ensurePopover() {
  if (!popover || !popover.isConnected) {
    popover = document.createElement("div");
    popover.className = "popover";
    popover.hidden = true;
    document.body.append(popover);
  }
  return popover;
}
function closePopover() {
  if (popover && !popover.hidden) {
    popover.hidden = true;
    if (popover._owner) { popover._owner.setAttribute("aria-expanded", "false"); popover._owner = null; }
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (popover && !popover.hidden && !popover.contains(e.target) && !e.target.closest?.(".info")) closePopover();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopover(); });
}

// Append a focusable ⓘ glyph to `container` that toggles the shared popover with
// `description` (Markdown). No-op when description is empty.
function attachInfo(container, description) {
  if (typeof description !== "string" || !description.trim()) return;
  const glyph = document.createElement("button");
  glyph.type = "button";
  glyph.className = "info";
  glyph.textContent = "ⓘ";
  glyph.setAttribute("aria-label", "More info");
  glyph.setAttribute("aria-expanded", "false");
  glyph.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = ensurePopover();
    if (pop._owner === glyph) { closePopover(); return; } // toggle off
    closePopover();
    pop.innerHTML = renderMarkdown(description);
    pop.hidden = false;
    pop._owner = glyph;
    glyph.setAttribute("aria-expanded", "true");
    const r = glyph.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.max(8, r.left - 8)}px`;
  });
  container.append(glyph);
}
```

- [ ] **Step 4: Call `attachInfo` from the three label sites**

In `buildControls`, attach to the section title:

```js
    const title = el("div", "sec-title", sec.title);
    attachInfo(title, sec.description);
    section.append(title);
```

(replacing the previous `section.append(el("div", "sec-title", sec.title));`).

In `makeSlider`, attach to the control label. Replace `row.append(el("label", "", def.label));` with:

```js
  const label = el("label", "", def.label);
  attachInfo(label, def.description);
  row.append(label);
```

In `buildFeatureSection`, attach to the feature label. Replace
`checkRow.append(box, el("span", "", feat.label));` with:

```js
    const featLabel = el("span", "", feat.label);
    attachInfo(featLabel, feat.description);
    checkRow.append(box, featLabel);
```

- [ ] **Step 5: Add glyph + popover styles to `app.css`**

Append to `src/framework/app.css`:

```css
/* info glyph + description popover */
.info {
  appearance: none; border: none; background: none; cursor: pointer;
  color: var(--muted); font-size: 12px; line-height: 1; padding: 0 0 0 5px;
  vertical-align: middle;
}
.info:hover { color: var(--text-2); }
.info:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.popover {
  position: fixed; z-index: 50; max-width: 280px; max-height: 50vh; overflow: auto;
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
  font-size: 12px; line-height: 1.5;
}
.popover[hidden] { display: none; }
.popover img { max-width: 100%; height: auto; border-radius: 4px; }
.popover a { color: var(--accent); }
.popover p:first-child { margin-top: 0; }
.popover p:last-child { margin-bottom: 0; }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/framework/controls.test.js`
Expected: PASS (all controls tests: clampToRange, predicates, hidden DOM, glyph/popover).

- [ ] **Step 7: Run the full suite (no regressions)**

Run: `nvm use && npx vitest run`
Expected: PASS (modulo the known `cli-occt` parallel-run flake — confirm in isolation if it appears).

- [ ] **Step 8: Best-effort app smoke**

If Playwright + Chromium are installed, confirm the app still boots clean:

Run: `nvm use && node scripts/check-app.mjs demo.html`
Expected: booted, 0 console errors. (If Playwright isn't installed, skip and note it.)

- [ ] **Step 9: Commit**

```bash
git add src/framework/controls.js src/framework/app.css test/framework/controls.test.js
git commit -m "feat: info-glyph markdown description popover for sections and controls"
```

---

## Self-review notes

- **Spec coverage:** schema fields (Task 2 hidden + Task 3 description consumption; the fields are just read off defs, no separate declaration needed); `markdown.js` (Task 1); glyph+popover + section descriptions (Task 3); hidden + empty-section handling + predicates (Task 2); happy-dom env (Task 1 docblock, reused in Task 2/3). All spec sections covered.
- **Placeholder scan:** none — every step has full code/commands.
- **Type consistency:** `renderMarkdown(src)→string` defined in Task 1, consumed in Task 3. `visibleAdvanced`/`visibleFeatures`/`sectionRenders` defined in Task 2, used in `buildControls`. `attachInfo(container, description)` defined and called consistently in Task 3. Test fixtures use the real schema shape (`advanced[]`, `features[]`, `presets`).
- **Manifold/OCCT untouched:** no geometry/worker file changes; `markdown.js` is main-thread only.
- **DOM testability:** happy-dom scoped per file; predicates also pure-testable.
