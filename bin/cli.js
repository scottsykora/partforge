#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { detectBackend } from "../src/framework/geometry/probe.js";
import { bootOcctKernel } from "../src/testing/occt.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/testing/measure.js";
import { verify } from "../src/testing/verify.js";
import { renderViews } from "../src/testing/render.js";
import { createPickServer, requestPicks, formatPickResult } from "../src/framework/pick-request/server.js";

const die = (msg) => { console.error(msg); process.exit(1); };
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, "-");

const [, , cmd, ...args] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  } else positional.push(args[i]);
}

const USAGE = "usage: partforge <measure|render|pick-serve|pick> …";

// --- pick-serve / pick: no part module, no kernel boot --------------------------
if (cmd === "pick-serve") {
  const port = Number(flags.port) || 4518;
  const timeoutMs = (Number(flags.timeout) || 120) * 1000;
  const { port: bound } = await createPickServer({ port, timeoutMs }).start();
  console.log(`partforge pick-server listening on http://127.0.0.1:${bound}`);
  // keep the process alive serving requests
} else if (cmd === "pick") {
  if (positional.length === 0) die('usage: partforge pick "<prompt>" ["<prompt>" …] [--port N]');
  const port = Number(flags.port) || 4518;
  const out = await requestPicks({ port, prompts: positional }).catch((e) => die(e.message));
  console.log(formatPickResult(out));
  process.exit(out.status === "done" ? 0 : 1);
} else if (!["measure", "render"].includes(cmd)) {
  die(USAGE);
}

const partPath = positional[0];
const view = positional[1];
if (["measure", "render"].includes(cmd) && !partPath) die(`usage: partforge ${cmd} <part-module> [view]`);

if (["measure", "render"].includes(cmd)) {
  const mod = await import(pathToFileURL(resolve(process.cwd(), partPath)))
    .catch((e) => die(`cannot load part "${partPath}": ${e.message}`));
  const part = mod.default;
  if (!part?.parts || !part?.views) die(`"${partPath}" has no default-exported PartDefinition`);

  let kernel;
  if (detectBackend(part) === "occt") {
    kernel = await bootOcctKernel();
  } else {
    kernel = await bootManifoldKernel();
  }

  try {
    if (cmd === "measure") {
      const report = measure(kernel, part, view);
      printMeasure(report);
      let vok = true;
      const processFlag = typeof flags.process === "string" ? flags.process : undefined;
      if ((part.verify || processFlag) && !flags["no-verify"]) {
        const v = verify(kernel, part, { process: processFlag, view });
        printVerify(v);
        report.verify = v;
        vok = v.ok;
      }
      const file = `measure-${slug(report.part)}-${report.view}.json`;
      writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`\nwrote ${file}`);
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok && vok ? 0 : 1);
    } else {
      const views = typeof flags.views === "string" ? flags.views.split(",") : undefined;
      const files = await renderViews(kernel, part, view, { views, out: flags.out || "render" });
      for (const f of files) console.log(`wrote ${f}`);
      process.exit(0);
    }
  } catch (e) {
    die(`${cmd} failed: ${e.message || e}`);
  }
}

function printMeasure(r) {
  console.log(`${r.part} / ${r.view}`);
  for (const s of r.subparts) {
    const wt = s.watertight === null ? "watertight n/a" : (s.watertight ? "watertight ✓" : "NOT watertight ✗");
    const holes = s.holes === null ? "holes n/a" : `holes ${s.holes}`;
    console.log(`  ${s.name}  bbox ${s.bbox.map((n) => n.toFixed(1)).join("×")}  ` +
      `vol ${(s.volume / 1000).toFixed(2)}cm³  area ${(s.surfaceArea / 100).toFixed(1)}cm²  ` +
      `tris ${s.triangleCount}  ${wt}  ${holes}`);
  }
  const a = r.aggregate;
  console.log(`  ── view  bbox ${a.bbox.map((n) => n.toFixed(1)).join("×")}  vol ${(a.volume / 1000).toFixed(2)}cm³  tris ${a.triangleCount}`);
  console.log(`  overlaps: ${r.overlaps.length ? r.overlaps.map((o) => `${o.a}×${o.b} (${o.volume.toFixed(1)}mm³)`).join(", ") : "none"}`);
}

function printVerify(v) {
  console.log(`\nverify:`);
  for (const c of v.cases) {
    console.log(`  ${c.name}`);
    for (const ch of c.checks) {
      const icon = ch.status === "pass" ? "✓" : ch.status === "fail" ? "✗" : ch.status === "warn" ? "⚠" : "·";
      console.log(`    ${icon} ${ch.subpart ?? "_view"} ${ch.metric} ${ch.expr}  (${ch.message})`);
    }
  }
  const f = v.failures.length, w = v.warnings.length;
  console.log(`  result: ${f ? `${f} gate failure(s)` : "all gates passed"}${w ? `, ${w} warning(s)` : ""}`);
}
