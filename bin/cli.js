#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { measure } from "../src/testing/measure.js";
import { renderViews } from "../src/testing/render.js";

const die = (msg) => { console.error(msg); process.exit(1); };
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, "-");

const [, , cmd, partPath, ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  } else positional.push(rest[i]);
}
const view = positional[0];

if (!["measure", "render"].includes(cmd)) die("usage: partforge <measure|render> <part-module> [view] [flags]");
if (!partPath) die(`usage: partforge ${cmd} <part-module> [view]`);

const mod = await import(pathToFileURL(resolve(process.cwd(), partPath)))
  .catch((e) => die(`cannot load part "${partPath}": ${e.message}`));
const part = mod.default;
if (!part?.parts || !part?.views) die(`"${partPath}" has no default-exported PartDefinition`);

const wasm = await Module(); wasm.setup();
const kernel = createManifoldKernel(wasm, { quality: "preview" });

try {
  if (cmd === "measure") {
    const report = measure(kernel, part, view);
    printMeasure(report);
    const file = `measure-${slug(report.part)}-${report.view}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${file}`);
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } else {
    const views = typeof flags.views === "string" ? flags.views.split(",") : undefined;
    const files = await renderViews(kernel, part, view, { views, out: flags.out || "render" });
    for (const f of files) console.log(`wrote ${f}`);
    process.exit(0);
  }
} catch (e) {
  die(`${cmd} failed: ${e.message || e}`);
}

function printMeasure(r) {
  console.log(`${r.part} / ${r.view}`);
  for (const s of r.subparts) {
    console.log(`  ${s.name}  bbox ${s.bbox.map((n) => n.toFixed(1)).join("×")}  ` +
      `vol ${(s.volume / 1000).toFixed(2)}cm³  area ${(s.surfaceArea / 100).toFixed(1)}cm²  ` +
      `tris ${s.triangleCount}  ${s.watertight ? "watertight ✓" : "NOT watertight ✗"}  holes ${s.holes}`);
  }
  const a = r.aggregate;
  console.log(`  ── view  bbox ${a.bbox.map((n) => n.toFixed(1)).join("×")}  vol ${(a.volume / 1000).toFixed(2)}cm³  tris ${a.triangleCount}`);
  console.log(`  overlaps: ${r.overlaps.length ? r.overlaps.map((o) => `${o.a}×${o.b} (${o.volume.toFixed(1)}mm³)`).join(", ") : "none"}`);
}
