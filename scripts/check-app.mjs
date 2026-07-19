// Headless smoke check: start a dev server, load a part app in real Chromium, and
// confirm the geometry worker actually boots (the status line shows a triangle count)
// with no console/worker errors. Catches WASM/worker/wiring failures that a passing
// build and unit tests miss.
//
//   node scripts/check-app.mjs [entry.html] [--keep]
//   (entry defaults to demo.html)
//
// Set CHECK_PORT to run on a port other than 5179. Sequential checks MUST use distinct
// ports: each run spawns `vite --strictPort` and the prior run's vite can still hold its
// port when the next starts (notably on Linux CI, where killing the `npx` wrapper can
// orphan the vite child), so a shared port makes the second run fail to bind.
//
// Requires Playwright + a browser: `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const entry = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "demo.html";
const PORT = Number(process.env.CHECK_PORT) || 5179;
const url = `http://localhost:${PORT}/${entry}`;
const keepServer = process.argv.includes("--keep");

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
let viteFailure = null;
vite.stdout.on("data", (d) => { if (/localhost:/.test(String(d))) ready = true; });
vite.on("error", (error) => { viteFailure = error; });

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

async function checkCompactLayout(width) {
  await page.setViewportSize({ width, height: 720 });
  await sleep(50);
  const result = await page.evaluate(() => {
    const viewbar = document.getElementById("viewbar");
    const topbar = document.getElementById("topbar");
    const viewRect = viewbar?.getBoundingClientRect();
    const topRect = topbar?.getBoundingClientRect();
    const overlaps = Boolean(viewRect && topRect
      && viewRect.left < topRect.right
      && viewRect.right > topRect.left
      && viewRect.top < topRect.bottom
      && viewRect.bottom > topRect.top);
    const overflowingActions = [...document.querySelectorAll("#viewbar .pf-cutaway-actions button")]
      .filter((button) => button.scrollWidth > button.clientWidth)
      .map((button) => button.textContent?.trim() || "(unlabelled)");
    return { overlaps, overflowingActions };
  });
  if (result.overlaps) errors.push(`layout ${width}px: #viewbar overlaps #topbar`);
  if (result.overflowingActions.length) {
    errors.push(`layout ${width}px: cutaway actions overflow (${result.overflowingActions.join(", ")})`);
  }
}

try {
  for (let i = 0; i < 80 && !ready && !viteFailure; i++) await sleep(250);
  if (!ready) throw viteFailure || new Error("dev server did not start");

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
      if (await page.locator("#pf-hover-tip.show").count()) { hovered = true; break; }
    }
  }

  const cutawayButton = page.locator("#cutaway");
  if (await cutawayButton.count()) {
    cutawayControl = await cutawayButton.isDisabled() ? "disabled" : "ready";
    if (cutawayControl === "ready") {
      await cutawayButton.click();
      cutaway = await cutawayButton.getAttribute("aria-pressed") === "true";
      cutawayControl = cutaway ? "enabled" : "not pressed";
      await sleep(200);
    }
  }

  if (cutaway) {
    const viewport = page.viewportSize();
    await checkCompactLayout(390);
    await checkCompactLayout(320);
    if (viewport) await page.setViewportSize(viewport);
  }
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
  if (!keepServer) vite.kill("SIGTERM");
}

console.log(`check ${url}`);
console.log(`  booted: ${booted}   hovered: ${hovered}   cutaway: ${cutaway}   status: ${JSON.stringify(status)}   errors: ${errors.length}`);
if (!cutaway) console.log(`  cutaway control: ${cutawayControl}`);
for (const e of errors.slice(0, 10)) console.log("    - " + e.split("\n")[0]);
process.exit(booted && hovered && cutaway && errors.length === 0 ? 0 : 1);
