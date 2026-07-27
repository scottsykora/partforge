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
    const viewRect = viewbar?.getBoundingClientRect();
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
    return { overlappingChrome, overflowingActions };
  });
  for (const target of result.overlappingChrome) {
    errors.push(`layout ${width}px: #viewbar overlaps ${target}`);
  }
  if (result.overflowingActions.length) {
    errors.push(`layout ${width}px: cutaway actions overflow (${result.overflowingActions.join(", ")})`);
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
      sections[0].classList.add("section-hidden");
      const firstVisible = sections.find((s) => !s.classList.contains("section-hidden"));
      const secondVisible = sections.find((s) => s !== firstVisible && !s.classList.contains("section-hidden"));
      if (firstVisible && getComputedStyle(firstVisible).borderTopWidth !== "0px") {
        problems.push("first visible section has a stray top divider after relevance hid the DOM-first section");
      }
      if (secondVisible && getComputedStyle(secondVisible).borderTopWidth === "0px") {
        problems.push("section after the first visible one is missing its divider");
      }
      sections[0].classList.remove("section-hidden");
    }

    return { problems };
  });
  for (const problem of result.problems) errors.push(`rail layout ${width}px: ${problem}`);
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
