// Headless smoke check: start a dev server, load a part app in real Chromium, and
// confirm the geometry worker actually boots (the status line shows a triangle count)
// with no console/worker errors. Catches WASM/worker/wiring failures that a passing
// build and unit tests miss.
//
//   node scripts/check-app.mjs [entry.html] [--keep]
//   (entry defaults to demo.html)
//
// Requires Playwright + a browser: `npm i -D playwright && npx playwright install chromium`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const entry = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "demo.html";
const PORT = 5179;
const url = `http://localhost:${PORT}/${entry}`;

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
vite.stdout.on("data", (d) => { if (/localhost:/.test(String(d))) ready = true; });
for (let i = 0; i < 80 && !ready; i++) await sleep(250);
const fail = (code, msg) => { console.error(msg); vite.kill("SIGTERM"); process.exit(code); };
if (!ready) fail(2, "dev server did not start");

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + (e.message || e)));
page.on("worker", (w) => w.on("console", (m) => { if (m.type() === "error") errors.push("worker: " + m.text()); }));

let booted = false;
try {
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(
    () => /triangle/i.test(document.getElementById("status")?.textContent || ""),
    { timeout: 60000 }
  );
  booted = true;
} catch { /* report below */ }
const status = await page.$eval("#status", (e) => e.textContent).catch(() => "(no #status)");

await browser.close();
if (!process.argv.includes("--keep")) vite.kill("SIGTERM");

console.log(`check ${url}`);
console.log(`  booted: ${booted}   status: ${JSON.stringify(status)}   errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log("    - " + e.split("\n")[0]);
process.exit(booted ? 0 : 1);
