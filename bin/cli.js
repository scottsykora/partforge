#!/usr/bin/env node
// The partforge CLI — also the agent-facing surface (SKILL.md points here). One
// async function per command, dispatched from the table at the bottom; flags are
// parsed strictly per command with util.parseArgs, so a typo'd flag or a missing
// option value fails loudly instead of being silently ignored.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { detectBackend } from "../src/framework/geometry/probe.js";
import { bootOcctKernel } from "../src/testing/occt.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/testing/measure.js";
import { verify } from "../src/testing/verify.js";
import { renderViews } from "../src/testing/render.js";
import { createPickServer, requestPicks, formatPickResult } from "../src/framework/pick-request/server.js";
import { matchPattern } from "../src/testing/error-patterns.js";

const die = (msg) => { console.error(msg); process.exit(1); };
const USAGE = "usage: partforge <measure|render|pick-serve|pick> …";

// Crash contract (issue #27): with --json, a thrown error becomes structured
// stdout JSON; either way the message is matched against ERROR-PATTERNS.md and
// the pattern's fix is surfaced. Exit 1 always. NOTE on stdout purity: crash
// JSON is the only thing on stdout for errors thrown before any report printing
// (load/boot/measure). But verify() runs after printMeasure and can throw (an
// unknown metric in verify.expect, or a per-case build crash), so a throw after
// printing appends the JSON after the human lines — it is not pure. Consumers
// should prefer --out for robust machine parsing.
function crash(cmd, e, jsonMode) {
  const message = e?.message || String(e);
  const m = matchPattern(message);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: { message, ...(m && { pattern: m.id, hint: m.fix }) } }, null, 2));
  } else {
    console.error(`${cmd} failed: ${message}`);
    if (m) console.error(`pattern: ERROR-PATTERNS.md#${m.id} — ${m.fix}`);
  }
  process.exit(1);
}

const parse = (args, options, usage) => {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (e) {
    return die(`${e.message}\n${usage}`);
  }
};

async function loadPart(partPath, usage) {
  if (!partPath) die(usage);
  const mod = await import(pathToFileURL(resolve(process.cwd(), partPath)))
    .catch((e) => { throw new Error(`cannot load part "${partPath}": ${e.message}`); });
  const part = mod.default;
  if (!part?.parts || !part?.views) throw new Error(`"${partPath}" has no default-exported PartDefinition`);
  return part;
}

const bootKernel = (part) => (detectBackend(part) === "occt" ? bootOcctKernel() : bootManifoldKernel());

const commands = {
  async measure(args) {
    const usage = "usage: partforge measure <part-module> [view] [--process <profile>] [--no-verify] [--json] [--out <file>]";
    const { values: flags, positionals: [partPath, view] } = parse(args, {
      process: { type: "string" },
      "no-verify": { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      const kernel = await bootKernel(part);
      const report = measure(kernel, part, view);
      printMeasure(report);
      let vok = true;
      if ((part.verify || flags.process) && !flags["no-verify"]) {
        const v = verify(kernel, part, { process: flags.process, view });
        printVerify(v);
        report.verify = v;
        vok = v.ok;
      }
      if (flags.out) {
        mkdirSync(dirname(resolve(flags.out)), { recursive: true });
        writeFileSync(flags.out, JSON.stringify(report, null, 2));
        console.log(`\nwrote ${flags.out}`);
      }
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok && vok ? 0 : 1);
    } catch (e) {
      crash("measure", e, !!flags.json);
    }
  },

  async render(args) {
    const usage = "usage: partforge render <part-module> [view] [--views iso,front] [--out <dir>]";
    const { values: flags, positionals: [partPath, view] } = parse(args, {
      views: { type: "string" },
      out: { type: "string" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      const kernel = await bootKernel(part);
      const views = flags.views ? flags.views.split(",") : undefined;
      const files = await renderViews(kernel, part, view, { views, out: flags.out || "render" });
      for (const f of files) console.log(`wrote ${f}`);
      process.exit(0);
    } catch (e) {
      crash("render", e, false);
    }
  },

  async "pick-serve"(args) {
    const usage = "usage: partforge pick-serve [--port N] [--timeout <seconds>]";
    const { values: flags } = parse(args, { port: { type: "string" }, timeout: { type: "string" } }, usage);
    const port = Number(flags.port) || 4518;
    const timeoutMs = (Number(flags.timeout) || 120) * 1000;
    const { port: bound } = await createPickServer({ port, timeoutMs }).start();
    console.log(`partforge pick-server listening on http://127.0.0.1:${bound}`);
    // no exit — the process stays alive serving requests
  },

  async pick(args) {
    const usage = 'usage: partforge pick "<prompt>" ["<prompt>" …] [--port N]';
    const { values: flags, positionals: prompts } = parse(args, { port: { type: "string" } }, usage);
    if (prompts.length === 0) die(usage);
    const port = Number(flags.port) || 4518;
    const out = await requestPicks({ port, prompts }).catch((e) => die(e.message));
    console.log(formatPickResult(out));
    process.exit(out.status === "done" ? 0 : 1);
  },
};

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
  console.log(`  overlaps: ${r.overlaps.length
    ? r.overlaps.map((o) => `${o.a}×${o.b} (${o.volume.toFixed(1)}mm³ at [${o.location.map((n) => n.toFixed(1)).join(", ")}])`).join(", ")
    : "none"}`);
}

function printVerify(v) {
  console.log(`\nverify:`);
  for (const c of v.cases) {
    console.log(`  ${c.name}`);
    for (const ch of c.checks) {
      const icon = ch.status === "pass" ? "✓" : ch.status === "fail" ? "✗" : ch.status === "warn" ? "⚠" : "·";
      console.log(`    ${icon} ${ch.subpart ?? "_view"} ${ch.metric} ${ch.expr}  (${ch.message})`);
      if (ch.status === "fail" || ch.status === "warn") {
        if (ch.location) console.log(`        at [${ch.location.map((n) => n.toFixed(1)).join(", ")}]`);
        if (ch.hint) console.log(`        hint: ${ch.hint}${ch.pattern ? ` (ERROR-PATTERNS.md#${ch.pattern})` : ""}`);
      }
    }
  }
  const f = v.failures.length, w = v.warnings.length;
  console.log(`  result: ${f ? `${f} gate failure(s)` : "all gates passed"}${w ? `, ${w} warning(s)` : ""}`);
}

const [, , cmd, ...args] = process.argv;
if (!commands[cmd]) die(USAGE);
await commands[cmd](args);
