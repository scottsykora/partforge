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

// Showcase capture (runtime.captureCurrent): a page that stashes its mount handle
// on window.__pfRuntime (demo.html does) gets the capture exercised the way an
// embedder would. Asserts the real-GL properties the faked-renderer unit tests
// cannot: the JPEG comes back at the requested long-edge size with the live
// viewport's aspect, and the visible canvas is pixel-identical afterwards (render
// target, lights, and grid all restored). Pages without the handle are skipped.
async function checkCaptureCurrent() {
  if (!await page.evaluate(() => Boolean(window.__pfRuntime?.captureCurrent))) return;
  // Stop auto-rotation so the before/after frames are comparable (same trick as
  // the cutaway check; a no-op if an earlier check already paused it).
  const pauseButton = page.locator("#pause");
  if (await pauseButton.count() && await pauseButton.textContent() === "⏸") {
    await pauseButton.click();
  }
  // Baseline only once the canvas is actually static: the viewport restore above
  // leaves OrbitControls damping settling for a few hundred ms, and a baseline
  // taken mid-settle makes the after-capture comparison below fail spuriously.
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
      const pauseButton = page.locator("#pause");
      if (await pauseButton.count() && await pauseButton.textContent() === "⏸") {
        await pauseButton.click();
      }
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
    if (viewport) await page.setViewportSize(viewport);
  }
  await checkCaptureCurrent(); // before checkDebugOverlay — that one navigates away
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
