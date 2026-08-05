// Headless smoke check: start a dev server, load a part app in real Chromium, and
// confirm the geometry worker actually boots (the status line shows a triangle count)
// with no console/worker errors. Catches WASM/worker/wiring failures that a passing
// build and unit tests miss.
//
//   node scripts/check-app.mjs [entry.html] [--keep] [--allow-no-cutaway]
//   (entry defaults to demo.html)
//
// `--allow-no-cutaway` accepts only pages without #cutaway; a present but
// unusable cutaway control still fails.
//
// Set CHECK_PORT to run on a port other than 5179. Normal runs terminate Vite's
// detached process group before exiting. `--keep` intentionally leaves it running,
// prints its process-group ID, and makes the caller responsible for stopping it.
//
// Requires Playwright + a browser: `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const entry = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "demo.html";
const PORT = Number(process.env.CHECK_PORT) || 5179;
const url = `http://localhost:${PORT}/${entry}`;
const keepServer = process.argv.includes("--keep");
const allowNoCutaway = process.argv.includes("--allow-no-cutaway");
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

let vite;
let viteFailure = null;
let viteState = null;
let viteLogDir;
let viteStderrPath;

const errors = [];
let booted = false;
let hovered = false;
let cutaway = false;
let cutawayControl = "missing";
let status = "(unavailable)";
let browser;
let page;

function errorMessage(error) {
  return error?.message || String(error);
}

function startVite() {
  viteLogDir = mkdtempSync(join(tmpdir(), "partforge-check-"));
  const stdoutFd = openSync(join(viteLogDir, "vite.stdout.log"), "w");
  viteStderrPath = join(viteLogDir, "vite.stderr.log");
  const stderrFd = openSync(viteStderrPath, "w");
  try {
    vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  vite.on("error", (error) => { viteFailure = error; });
  vite.on("exit", (code, signal) => { viteState = { event: "exit", code, signal }; });
  vite.on("close", (code, signal) => { viteState = { event: "close", code, signal }; });
  vite.unref();
}

function boundedViteStderr() {
  if (!viteStderrPath || !existsSync(viteStderrPath)) return "";
  return readFileSync(viteStderrPath, "utf8").slice(-4000).trim().replace(/\s+/g, " ");
}

function viteStoppedMessage(prefix) {
  const state = viteState
    ? `${viteState.event} code=${viteState.code ?? "null"} signal=${viteState.signal ?? "none"}`
    : "state unavailable";
  const stderr = boundedViteStderr();
  return `${prefix} (${state})${stderr ? `: ${stderr}` : ""}`;
}

async function waitForVite() {
  for (let i = 0; i < 80; i++) {
    if (viteFailure) throw viteFailure;
    if (viteState) throw new Error(viteStoppedMessage("dev server stopped before startup"));
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(250) });
    } catch {
      // Connection failures are expected while Vite is starting.
    }
    if (response?.ok) {
      // Give the process a brief chance to report strict-port failures; a
      // different server already occupying PORT can otherwise look ready.
      await sleep(250);
      if (viteState) throw new Error(viteStoppedMessage("dev server stopped before startup"));
      return;
    }
    await sleep(250);
  }
  const stderr = boundedViteStderr();
  throw new Error(`dev server did not start${stderr ? `: ${stderr}` : ""}`);
}

function viteGroupIsRunning() {
  if (!vite?.pid) return false;
  try {
    process.kill(-vite.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function stopVite() {
  if (!viteGroupIsRunning()) return;
  process.kill(-vite.pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (!viteGroupIsRunning()) return;
    await sleep(50);
  }
  process.kill(-vite.pid, "SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (!viteGroupIsRunning()) return;
    await sleep(50);
  }
  throw new Error(`Vite process group ${vite.pid} did not stop`);
}

async function checkCompactLayout(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(() => {
    const viewbar = document.getElementById("viewbar");
    const topbar = document.getElementById("topbar");
    const panel = document.getElementById("panel");
    const stage = document.getElementById("app");
    const viewRect = viewbar?.getBoundingClientRect();
    const stageRect = stage?.getBoundingClientRect();
    const intersects = (element) => {
      const rect = element?.getBoundingClientRect();
      return Boolean(viewRect && rect
        && viewRect.left < rect.right
        && viewRect.right > rect.left
        && viewRect.top < rect.bottom
        && viewRect.bottom > rect.top);
    };
    const overlappingChrome = [
      ["#topbar", topbar],
      ["#panel", panel],
    ].filter(([, element]) => intersects(element)).map(([name]) => name);
    const overflowingActions = [...document.querySelectorAll("#viewbar .pf-cutaway-actions button")]
      .filter((button) => button.scrollWidth > button.clientWidth)
      .map((button) => button.textContent?.trim() || "(unlabelled)");
    // #viewbar is a floating pill anchored to the stage's right edge
    // (bottom: 12px; right: 12px). At narrow widths a wide pill (extra
    // buttons, cutaway's Flip/Reset) can overflow the stage's LEFT edge and
    // get clipped by .pf-shell { overflow: hidden } — nothing previously
    // asserted horizontal containment.
    const containment = viewRect && stageRect
      ? { left: viewRect.left - stageRect.left, right: stageRect.right - viewRect.right }
      : null;
    return { overlappingChrome, overflowingActions, containment };
  });
  for (const target of result.overlappingChrome) {
    errors.push(`layout ${width}px: #viewbar overlaps ${target}`);
  }
  if (result.overflowingActions.length) {
    errors.push(`layout ${width}px: cutaway actions overflow (${result.overflowingActions.join(", ")})`);
  }
  if (result.containment && result.containment.left < -0.5) {
    errors.push(`layout ${width}px: #viewbar overflows the stage's left edge by ${Math.round(-result.containment.left)}px`);
  }
}

// Wide-layout geometry: the rail is a full-height right edge and the viewer
// column owns its floating chrome. checkCompactLayout only runs below the 720px
// breakpoint, where the rail is stacked, so it can't see any of this.
async function checkRailLayout(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(() => {
    const panel = document.getElementById("panel");
    const app = document.getElementById("app");
    const viewbar = document.getElementById("viewbar");
    if (!panel || !app) return { problems: ["missing #panel or #app"] };
    const rail = panel.getBoundingClientRect();
    const stage = app.getBoundingClientRect();
    const bar = viewbar?.getBoundingClientRect();
    const problems = [];
    if (Math.abs(rail.right - window.innerWidth) > 1) problems.push("rail is not flush to the right edge");
    if (Math.abs(rail.height - window.innerHeight) > 1) problems.push(`rail height ${Math.round(rail.height)} != viewport ${window.innerHeight}`);
    if (Math.abs(rail.left - stage.right) > 1) problems.push("rail does not sit flush against the viewer column");
    if (rail.width < 200) problems.push(`rail collapsed unexpectedly (${Math.round(rail.width)}px)`);
    if (bar && bar.right > stage.right + 1) problems.push("#viewbar escapes the viewer column");
    if (bar && bar.bottom > stage.bottom + 1) problems.push("#viewbar escapes the viewer column vertically");

    // Section divider: hiding the first section via relevance must not leave a
    // stray hairline under the rail header (see src/framework/app.css .section rule).
    const sections = [...document.querySelectorAll("#controls .section")];
    if (sections.length >= 2) {
      // Natural-state check first, with nothing mutated yet: this is what makes
      // the guard non-vacuous, since with only two sections the post-hide check
      // below always leaves exactly one visible section (no "following section"
      // to inspect). Only meaningful when the first two sections both start
      // visible; skip it otherwise rather than special-casing a hidden second.
      const firstHidden = sections[0].classList.contains("section-hidden");
      const secondHidden = sections[1].classList.contains("section-hidden");
      if (!firstHidden && !secondHidden) {
        if (getComputedStyle(sections[0]).borderTopWidth !== "0px") {
          problems.push("first section has a stray top divider in its natural state");
        }
        if (getComputedStyle(sections[1]).borderTopWidth === "0px") {
          problems.push("second section has no divider in its natural state - divider rule not in effect");
        }
      }

      if (!firstHidden) sections[0].classList.add("section-hidden");
      const secondVisible = sections.find((s) => s !== sections[0] && !s.classList.contains("section-hidden"));
      if (secondVisible && getComputedStyle(secondVisible).borderTopWidth !== "0px") {
        problems.push("first visible section after the DOM-first one keeps its divider after relevance hid it");
      }
      if (!firstHidden) sections[0].classList.remove("section-hidden");
    }

    return { problems };
  });
  for (const problem of result.problems) errors.push(`rail layout ${width}px: ${problem}`);

  // Drag the seam across the viewer and assert the rail followed. Pointer
  // capture is what makes this work; without it the pointer reaches the canvas
  // and the drag dies. happy-dom cannot model this, so it is proven here.
  const seam = await page.$(".pf-rail-seam");
  if (!seam) {
    errors.push(`rail layout ${width}px: no .pf-rail-seam to drag`);
    await resetRail();
    return;
  }
  const box = await seam.boundingBox();
  const before = await page.evaluate(() => document.getElementById("panel").getBoundingClientRect().width);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const after = await page.evaluate(() => document.getElementById("panel").getBoundingClientRect().width);
  if (after <= before + 40) {
    errors.push(`rail layout ${width}px: drag did not widen the rail (${Math.round(before)} -> ${Math.round(after)})`);
  }
  await resetRail();
}

// Reset through the rail's own API — a dblclick on the seam routes through
// rail.js's commit(), which resets to the 288px default — so the DOM and
// rail.js's in-memory `state` agree. The old approach (clear localStorage,
// poke --pf-rail-w directly) left `state` holding the dragged width, so the
// next setViewportSize fired a resize -> apply() that overwrote the inline
// value right back to the stale width; later checks then ran against a
// widened rail even though the property and storage both looked "clean".
//
// Uses a real page.mouse.dblclick() rather than a synthetic dblclick event
// dispatched in page.evaluate: onPointerDown calls e.preventDefault() on the
// seam's pointerdown, and only a genuine click sequence (pointerdown, up,
// click, pointerdown, up, click, dblclick) exercises that path — a dispatched
// MouseEvent("dblclick") skips straight to the last event and never touches it.
async function resetRail() {
  const seam = await page.$(".pf-rail-seam");
  if (!seam) return; // nothing to reset — the caller already recorded the missing-seam error
  const box = await seam.boundingBox();
  if (!box) return;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(50);
}

// Narrow-layout pane tabs: below RAIL_NARROW_BREAKPOINT (720px) the shell shows
// exactly ONE pane, full height, chosen by .pf-tabbar (mobile-tabs.js writes
// data-pf-pane onto .pf-shell) — and #rail-toggle hides itself because the tab
// bar replaces it. This is pure CSS cascade, invisible to happy-dom (the vitest
// suite never loads chrome.css/app.css), which is exactly how this branch's two
// bugs escaped: .pf-tabbar's unconditional `display: none` declared after the
// media query that reveals it (the bar was invisible at every width), and
// #viewbar button's author-origin `display: flex` beating the UA's
// `[hidden] { display: none }` (rail.js's `toggle.hidden = true` left
// #rail-toggle fully visible below the breakpoint). Both are fixed; this check
// is what would have caught them.
//
// What this does NOT cover: this whole script runs Chromium headless, and
// headless Chromium does not throttle rendering the way a headed browser
// does for hidden content. Measured directly: a `visibility: hidden`
// sandboxed iframe kept delivering requestAnimationFrame callbacks under
// headless (180 in the sample window; `display: none` delivered a full
// count too in one configuration), while headed Chromium delivered zero for
// `visibility: hidden`. So a bug where hiding an element starves its rAF
// loop — as happened to partforge-cloud's viewer iframe and its
// build-screenshot capture — would pass this check even if reintroduced
// here. Catching that class needs a headed run.
async function checkNarrowPaneTabs(narrowWidth, wideWidth) {
  const displays = async () => page.evaluate(() => {
    const display = (selector) => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el).display : "(missing)";
    };
    // Geometry, not just `display`. A tab bar can be display:flex and still be
    // invisible: if the stage refuses to shrink (it needs min-height: 0, since
    // the narrow shell is a column and the canvas carries a real pixel height),
    // the bar is pushed past the bottom of the viewport. That shipped once, and
    // a display-only assertion waved it through in both engines.
    const bar = document.querySelector(".pf-tabbar");
    const rect = bar ? bar.getBoundingClientRect() : null;
    return {
      tabbar: display(".pf-tabbar"),
      railToggle: display("#rail-toggle"),
      stage: display(".pf-stage"),
      rail: display(".pf-rail"),
      barOnScreen: rect ? rect.top < window.innerHeight && rect.bottom > 0 && rect.height > 0 : false,
      barBottom: rect ? Math.round(rect.bottom) : null,
      viewportH: window.innerHeight,
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
    };
  });

  await page.setViewportSize({ width: narrowWidth, height: 720 });
  await sleep(50);
  let result = await displays();
  if (result.tabbar !== "flex") {
    errors.push(`pane tabs ${narrowWidth}px: .pf-tabbar display is ${result.tabbar}, expected flex`);
  }
  if (!result.barOnScreen) {
    errors.push(`pane tabs ${narrowWidth}px: .pf-tabbar is laid out off-screen (bottom ${result.barBottom} vs viewport ${result.viewportH}) — it is display:${result.tabbar} but not visible`);
  }
  if (result.overflowY > 0) {
    errors.push(`pane tabs ${narrowWidth}px: the shell overflows the viewport by ${result.overflowY}px — a pane is refusing to shrink`);
  }
  if (result.railToggle !== "none") {
    errors.push(`pane tabs ${narrowWidth}px: #rail-toggle display is ${result.railToggle}, expected none`);
  }
  if (result.stage === "none") {
    errors.push(`pane tabs ${narrowWidth}px: .pf-stage is hidden with data-pf-pane at its default`);
  }
  if (result.rail !== "none") {
    errors.push(`pane tabs ${narrowWidth}px: .pf-rail display is ${result.rail}, expected none with data-pf-pane at its default`);
  }

  // Switch panes the way a phone user would: tap the tab bar's Controls button.
  const railTab = page.locator('[data-pf-pane-tab="rail"]');
  if (await railTab.count()) {
    await railTab.click();
    await sleep(50);
    result = await displays();
    if (result.rail === "none") {
      errors.push(`pane tabs ${narrowWidth}px: .pf-rail is still hidden after switching to the Controls tab`);
    }
    if (result.stage !== "none") {
      errors.push(`pane tabs ${narrowWidth}px: .pf-stage display is ${result.stage} after switching to the Controls tab, expected none`);
    }
    // Switch back to the stage tab so no state leaks into a later check that
    // reuses this narrow width (checkCompactLayout runs at widths below the
    // same breakpoint).
    const stageTab = page.locator('[data-pf-pane-tab="stage"]');
    if (await stageTab.count()) {
      await stageTab.click();
      await sleep(50);
    }
  } else {
    errors.push(`pane tabs ${narrowWidth}px: no [data-pf-pane-tab="rail"] button to click`);
  }

  await page.setViewportSize({ width: wideWidth, height: 720 });
  await sleep(50);
  result = await displays();
  if (result.tabbar !== "none") {
    errors.push(`pane tabs ${wideWidth}px: .pf-tabbar display is ${result.tabbar}, expected none above the breakpoint`);
  }
  if (result.railToggle === "none") {
    errors.push(`pane tabs ${wideWidth}px: #rail-toggle is hidden above the breakpoint`);
  }
  if (result.stage === "none" || result.rail === "none") {
    errors.push(`pane tabs ${wideWidth}px: stage and rail are not both visible above the breakpoint (stage=${result.stage}, rail=${result.rail})`);
  }
}

// Showcase capture (runtime.captureCurrent): a page that stashes its mount handle
// on window.__pfRuntime (demo.html does) gets the capture exercised the way an
// embedder would. Asserts the real-GL properties the faked-renderer unit tests
// cannot: the JPEG comes back at the requested long-edge size with the live
// viewport's aspect, and the visible canvas is pixel-identical afterwards (render
// target, lights, and grid all restored). Pages without the handle are skipped.
async function checkCaptureCurrent() {
  if (!await page.evaluate(() => Boolean(window.__pfRuntime?.captureCurrent))) return;
  // An autoplay animation (e.g. hinged-box's looping "cycle") can be running,
  // and a looping canvas never satisfies the identical-screenshots baseline
  // below — pause it the same way a person would, same trick the removed
  // turntable #pause button used to need.
  const animPlayButton = page.locator(".pf-anim-play");
  if (await animPlayButton.count() && await animPlayButton.textContent() === "⏸") {
    await animPlayButton.click();
  }
  // The idle canvas is static now (no turntable), but any residual
  // OrbitControls damping from the setup above (e.g. the cutaway check) still
  // needs to settle — so on a slow software-GL runner (CI) a wall-clock sleep
  // under-waits and the residual sub-pixel drift keeps accumulating between
  // the baseline and after-capture screenshots. Wait the decay out in frames
  // (machine-speed independent), then still demand consecutive identical
  // screenshots before trusting the baseline.
  await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const tick = () => (++n >= 120 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  let before = await page.locator("#app canvas").screenshot();
  let stable = false;
  for (let i = 0; i < 15 && !stable; i++) {
    await sleep(200);
    const next = await page.locator("#app canvas").screenshot();
    stable = before.equals(next);
    before = next;
  }
  if (!stable) { errors.push("captureCurrent: canvas never stabilized for a baseline"); return; }
  const result = await page.evaluate(async () => {
    const dataUrl = window.__pfRuntime.captureCurrent({ size: 512 });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg")) {
      return { ok: false, why: `unexpected return value: ${String(dataUrl).slice(0, 40)}` };
    }
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    const canvas = document.querySelector("#app canvas");
    return {
      ok: true,
      width: img.naturalWidth,
      height: img.naturalHeight,
      canvasW: canvas.clientWidth,
      canvasH: canvas.clientHeight,
    };
  });
  if (!result.ok) { errors.push(`captureCurrent: ${result.why}`); return; }
  if (Math.max(result.width, result.height) !== 512) {
    errors.push(`captureCurrent: long edge ${Math.max(result.width, result.height)} != requested 512`);
  }
  const wantAspect = result.canvasW / result.canvasH;
  const gotAspect = result.width / result.height;
  if (Math.abs(gotAspect - wantAspect) > 0.02) {
    errors.push(`captureCurrent: aspect ${gotAspect.toFixed(3)} != viewport ${wantAspect.toFixed(3)}`);
  }
  await sleep(100);
  if (!before.equals(await page.locator("#app canvas").screenshot())) {
    errors.push("captureCurrent: live canvas changed after an offscreen capture");
  }
}

// Cutaway section caps are stencil-masked, and a WebGLRenderTarget does not get
// a stencil buffer unless it asks for one — so an offscreen capture taken with
// cutaway enabled used to come back with each cap flooding its ENTIRE plane with
// hatch, burying the part, while the live canvas stayed perfect. Nothing threw;
// only the captured pixels were wrong, which is exactly what the faked-renderer
// unit tests cannot see (they have no GL state, let alone a stencil buffer).
//
// Measure how much of the frame the hatch covers. Hatch is a fine stripe pattern,
// so sampling pairs of pixels a few px apart and counting big luminance jumps
// gives its area; a masked cap marks only the cross-section, an unmasked one
// marks a whole quad. Measured on demo.html at the default framing: 0.8% with
// cutaway off, 7.9% masked (correct), 32.0% unmasked (the bug). The threshold
// sits between the latter two — retune it here if a page with a much larger
// cross-section ever stashes a runtime handle.
async function checkCutawayCapture() {
  if (!cutaway) return; // no cutaway on this page — nothing to assert
  if (!await page.evaluate(() => Boolean(window.__pfRuntime?.captureCurrent))) return;
  const result = await page.evaluate(async () => {
    const dataUrl = window.__pfRuntime.captureCurrent({ size: 512 });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg")) {
      return { ok: false, why: `unexpected return value: ${String(dataUrl).slice(0, 40)}` };
    }
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luma = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    };
    const STRIDE = 3, EDGE = 18;
    let hatched = 0, sampled = 0;
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x + STRIDE < canvas.width; x += 2) {
        sampled++;
        if (Math.abs(luma(x, y) - luma(x + STRIDE, y)) > EDGE) hatched++;
      }
    }
    return { ok: true, coverage: hatched / sampled };
  });
  if (!result.ok) { errors.push(`cutaway capture: ${result.why}`); return; }
  const MAX_HATCH_COVERAGE = 0.18;
  if (result.coverage > MAX_HATCH_COVERAGE) {
    errors.push(
      `cutaway capture: section hatch covers ${(result.coverage * 100).toFixed(1)}% of the frame `
      + `(limit ${(MAX_HATCH_COVERAGE * 100).toFixed(0)}%) — caps are rendering unmasked, `
      + "which means the offscreen render target has no stencil buffer",
    );
  }
}

// The ?debug cache overlay (#pf-debug) is fixed-position dev chrome, wholly
// separate from the app's own layout. It has been chased around the window's
// corners more than once, silently colliding with #topbar's floating tabs or
// #viewbar each time (see docs/superpowers/sdd/debug-overlay-fix.md) with
// nothing catching it. This is a small dedicated check rather than folding
// ?debug into the main page load above: the overlay only matters at a couple
// of widths, and reusing the already-booted page would mean re-navigating
// (query strings can't be toggled in place) partway through the other checks.
async function checkDebugOverlay(widths) {
  await page.goto(`${url}?debug`, { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector("#pf-debug", { timeout: 10000 });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 720 });
    await sleep(50);
    const result = await page.evaluate(() => {
      const rectOf = (id) => document.getElementById(id)?.getBoundingClientRect();
      const intersects = (a, b) =>
        Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      const overlay = rectOf("pf-debug");
      return {
        hasOverlay: Boolean(overlay),
        overlapsTopbar: intersects(overlay, rectOf("topbar")),
        overlapsViewbar: intersects(overlay, rectOf("viewbar")),
      };
    });
    if (!result.hasOverlay) errors.push(`debug overlay ${width}px: #pf-debug missing`);
    if (result.overlapsTopbar) errors.push(`debug overlay ${width}px: #pf-debug overlaps #topbar`);
    if (result.overlapsViewbar) errors.push(`debug overlay ${width}px: #pf-debug overlaps #viewbar`);
  }
}

try {
  startVite();
  await waitForVite();

  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + errorMessage(e)));
  page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));

  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    () => /triangle/i.test(document.getElementById("status")?.textContent || ""),
    { timeout: 60000 }
  );
  booted = true;

  // Hover inspection: move the mouse across the canvas and expect the feature
  // tooltip to appear (any hit — labeled features or the sub-part fallback).
  const box = await page.locator("#app canvas").boundingBox();
  if (box) {
    for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.45], [0.6, 0.55], [0.5, 0.35]]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await sleep(120);
      if (await page.locator(".pf-hover-tip.show:not(.pf-tooltip-anchored)").count()) { hovered = true; break; }
    }
  }

  const cutawayButton = page.locator("#cutaway");
  let frameBeforeCutaway;
  if (await cutawayButton.count()) {
    cutawayControl = await cutawayButton.isDisabled() ? "disabled" : "ready";
    if (cutawayControl === "ready") {
      // The idle canvas is static now (no turntable) — this sleep is just
      // cheap insurance against any in-flight damping settling.
      await sleep(250);
      frameBeforeCutaway = await page.locator("#app canvas").screenshot();
      await cutawayButton.click();
      cutaway = await cutawayButton.getAttribute("aria-pressed") === "true";
      cutawayControl = cutaway ? "enabled" : "not pressed";
      await sleep(200);
      if (cutaway && frameBeforeCutaway.equals(await page.locator("#app canvas").screenshot())) {
        errors.push("render: canvas did not change after cutaway was enabled");
      }
    }
  }

  {
    const viewport = page.viewportSize();
    await checkRailLayout(1280);
    await checkRailLayout(1024);
    if (cutaway) {
      await checkCompactLayout(601);
      await checkCompactLayout(390);
      await checkCompactLayout(320);
    }
    await checkNarrowPaneTabs(400, 1024);
    if (viewport) await page.setViewportSize(viewport);
  }
  await checkCaptureCurrent(); // before checkDebugOverlay — that one navigates away
  await checkCutawayCapture(); // cutaway is still enabled from the toggle above
  // 390px is below the 720px stacked-layout breakpoint; 850px sits in the
  // narrower-but-still-side-by-side range where the tabs and a corner overlay
  // are most likely to collide (see the debug-overlay-fix report).
  await checkDebugOverlay([390, 850]);
  if (viteState) throw new Error(viteStoppedMessage("dev server stopped during smoke check"));
} catch (error) {
  errors.push("check: " + errorMessage(error));
} finally {
  if (page) {
    try {
      status = await page.$eval("#status", (element) => element.textContent);
    } catch (error) {
      errors.push("status: " + errorMessage(error));
      status = "(no #status)";
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      errors.push("cleanup: " + errorMessage(error));
    }
  }
  if (!keepServer && vite) {
    try {
      await stopVite();
    } catch (error) {
      errors.push("cleanup: " + errorMessage(error));
    }
  }
  if (viteLogDir) {
    try {
      rmSync(viteLogDir, { recursive: true, force: true });
    } catch (error) {
      errors.push("cleanup: " + errorMessage(error));
    }
  }
}

console.log(`check ${url}`);
console.log(`  booted: ${booted}   hovered: ${hovered}   cutaway: ${cutaway}   status: ${JSON.stringify(status)}   errors: ${errors.length}`);
if (!cutaway) console.log(`  cutaway control: ${cutawayControl}`);
if (keepServer && vite?.pid) console.log(`  vite: kept running (pid ${vite.pid})`);
for (const e of errors.slice(0, 10)) console.log("    - " + e.split("\n")[0]);
const cutawaySatisfied = cutaway || (allowNoCutaway && cutawayControl === "missing");
process.exit(booted && hovered && cutawaySatisfied && errors.length === 0 ? 0 : 1);
