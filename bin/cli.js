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
import { normalizeAnimation, evaluate, cueAt } from "../src/framework/animation.js";
import { bootOcctKernel } from "../src/testing/occt.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/testing/measure.js";
import { verify } from "../src/testing/verify.js";
import { renderViews } from "../src/testing/render.js";
import { createPickServer, requestPicks, formatPickResult } from "../src/framework/pick-request/server.js";
import { matchPattern } from "../src/testing/error-patterns.js";
import { lintPart } from "../src/lint.js";

const die = (msg) => { console.error(msg); process.exit(1); };
const USAGE = "usage: partforge <lint|measure|render|pick-serve|pick> …";

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
  async lint(args) {
    const usage = "usage: partforge lint <part-module> [--params <json>] [--json] [--out <file>] [--strict]";
    const { values: flags, positionals: [partPath] } = parse(args, {
      params: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      strict: { type: "boolean" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      const params = flags.params ? JSON.parse(flags.params) : undefined;
      const report = lintPart(part, { params });
      if (!flags.json) printLint(report);
      if (flags.out) {
        mkdirSync(dirname(resolve(flags.out)), { recursive: true });
        writeFileSync(flags.out, JSON.stringify(report, null, 2));
        console.log(`\nwrote ${flags.out}`);
      }
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok && (!flags.strict || report.warnings.length === 0) ? 0 : 1);
    } catch (e) {
      crash("lint", e, !!flags.json);
    }
  },

  async measure(args) {
    const usage = "usage: partforge measure <part-module> [view] [--process <profile>] [--no-verify] [--no-lint] [--json] [--out <file>]";
    const { values: flags, positionals: [partPath, view] } = parse(args, {
      process: { type: "string" },
      "no-verify": { type: "boolean" },
      "no-lint": { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      // Error-tier lint before the kernel boots: a statically broken part fails in
      // milliseconds with a precise message rather than after a WASM boot and a
      // downstream error that doesn't name the cause. Warnings never gate measure.
      if (!flags["no-lint"]) {
        const lint = lintPart(part);
        if (!lint.ok) {
          if (flags.json) console.log(JSON.stringify({ ok: false, lint }, null, 2));
          else printLint(lint);
          if (flags.out) {
            mkdirSync(dirname(resolve(flags.out)), { recursive: true });
            writeFileSync(flags.out, JSON.stringify({ ok: false, lint }, null, 2));
          }
          process.exit(1);
        }
      }
      const kernel = await bootKernel(part);
      const report = measure(kernel, part, view);
      printMeasure(report);
      // Write --out right after measure succeeds, then re-write once verify has
      // attached report.verify. If verify throws (unknown metric, per-case build
      // crash) the file already holds the measure half (no `verify` key) — matching
      // the doc's advice to prefer --out for exactly that non-pure-stdout case.
      const writeOut = () => {
        mkdirSync(dirname(resolve(flags.out)), { recursive: true });
        writeFileSync(flags.out, JSON.stringify(report, null, 2));
      };
      if (flags.out) writeOut();
      let vok = true;
      if ((part.verify || flags.process) && !flags["no-verify"]) {
        const v = verify(kernel, part, { process: flags.process, view });
        printVerify(v);
        report.verify = v;
        vok = v.ok;
        if (flags.out) writeOut();
      }
      if (flags.out) console.log(`\nwrote ${flags.out}`);
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok && vok ? 0 : 1);
    } catch (e) {
      crash("measure", e, !!flags.json);
    }
  },

  async render(args) {
    const usage = "usage: partforge render <part-module> [view] [--views iso,front] [--out <dir>] " +
      "[--params <json>] [--animation <name>] [--at <t[,t…]>] [--step <index|label>]";
    const { values: flags, positionals: [partPath, view] } = parse(args, {
      views: { type: "string" },
      out: { type: "string" },
      params: { type: "string" },
      animation: { type: "string" },
      at: { type: "string" },
      step: { type: "string" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      const baseParams = flags.params ? JSON.parse(flags.params) : {};
      const outDir = flags.out || "render";
      const views = flags.views ? flags.views.split(",") : undefined;
      const kernel = await bootKernel(part);

      if (!flags.animation) {
        if (flags.at || flags.step) die(`--at/--step require --animation\n${usage}`);
        const files = await renderViews(kernel, part, view, { views, out: outDir, params: baseParams });
        for (const f of files) console.log(`wrote ${f}`);
        process.exit(0);
      }

      const spec = part.animations?.[flags.animation];
      if (!spec) {
        throw new Error(`unknown animation "${flags.animation}" (have: ${Object.keys(part.animations ?? {}).join(", ") || "none"})`);
      }
      const anim = normalizeAnimation(flags.animation, spec);
      // Frames: --step renders one still at the END of that step (its fully
      // applied state); --at takes positions normalized over the animation's
      // TOTAL duration (same t as the viewer scrubber / runtime seek).
      let frames;
      if (flags.step != null) {
        const byLabel = anim.steps.findIndex((s) => s.label === flags.step);
        const idx = byLabel >= 0 ? byLabel : Number(flags.step) - 1;
        if (!(idx >= 0 && idx < anim.steps.length)) {
          throw new Error(`unknown step "${flags.step}" (use 1..${anim.steps.length} or a label: ${anim.steps.map((s) => JSON.stringify(s.label)).join(", ")})`);
        }
        const end = idx + 1 < anim.steps.length ? anim.stepStarts[idx + 1] : 1;
        // Values come from the END of the step (fully applied), but the cue
        // lookup uses the step's own START: cue boundaries belong to the LATER
        // step (see animation.js stepIndexAt/cueAt), and `end` here IS the next
        // step's start, so querying the cue at `end` would resolve to the next
        // step's camera instead of this step's own.
        frames = [{ t: end, cueT: anim.stepStarts[idx], tag: `${flags.animation}-step${idx + 1}` }];
      } else {
        const ts = (flags.at ?? "1").split(",").map(Number);
        if (!ts.length || ts.some((t) => !Number.isFinite(t) || t < 0 || t > 1)) {
          die(`--at takes comma-separated positions in 0..1\n${usage}`);
        }
        frames = ts.map((t) => ({ t, tag: `${flags.animation}-t${String(Math.round(t * 100)).padStart(3, "0")}` }));
      }
      for (const frame of frames) {
        const { values } = evaluate(anim, frame.t);
        const cue = cueAt(anim, frame.cueT ?? frame.t);
        const frameViews = views ?? (cue ? [cue.view] : undefined);
        const files = await renderViews(kernel, part, view, {
          views: frameViews, out: outDir, params: { ...baseParams, ...values }, tag: frame.tag,
        });
        for (const f of files) console.log(`wrote ${f}`);
      }
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
  console.log(`  near-misses: ${r.nearMisses.length
    ? r.nearMisses.map((g) => `${g.a}×${g.b} (${g.distance.toFixed(2)}mm at [${g.at.map((n) => n.toFixed(1)).join(", ")}])`).join(", ")
    : "none"}`);
}

function printVerify(v) {
  console.log(`\nverify:`);
  for (const c of v.cases) {
    console.log(`  ${c.name}`);
    for (const ch of c.checks) {
      const icon = ch.status === "pass" ? "✓" : ch.status === "fail" ? "✗" : ch.status === "warn" ? "⚠" : "·";
      console.log(`    ${icon} ${ch.subpart ?? "_view"} ${ch.metric} ${ch.expr}  (${ch.message})`);
      // A measurement caveat prints whatever the verdict — "passed, but sampled"
      // is precisely the line a reader must not miss.
      if (ch.note) console.log(`        note: ${ch.note}`);
      if (ch.status === "fail" || ch.status === "warn") {
        if (ch.location) console.log(`        at [${ch.location.map((n) => n.toFixed(1)).join(", ")}]`);
        if (ch.hint) console.log(`        hint: ${ch.hint}${ch.pattern ? ` (ERROR-PATTERNS.md#${ch.pattern})` : ""}`);
      }
    }
  }
  const f = v.failures.length, w = v.warnings.length;
  console.log(`  result: ${f ? `${f} gate failure(s)` : "all gates passed"}${w ? `, ${w} warning(s)` : ""}`);
}

function printLint(r) {
  const all = [...r.errors, ...r.warnings, ...(r.notes ?? [])];
  if (all.length === 0) { console.log("lint: clean"); return; }
  console.log("lint:");
  for (const f of all) {
    const icon = f.severity === "error" ? "✗" : f.severity === "warning" ? "⚠" : "·";
    console.log(`  ${icon} ${f.rule}${f.path ? `  ${f.path}` : ""}`);
    console.log(`      ${f.message}`);
    console.log(`      hint: ${f.hint}${f.pattern ? ` (ERROR-PATTERNS.md#${f.pattern})` : ""}`);
  }
  const e = r.errors.length, w = r.warnings.length, n = (r.notes ?? []).length;
  console.log(`  result: ${e ? `${e} error(s)` : "no errors"}${w ? `, ${w} warning(s)` : ""}${n ? `, ${n} note(s)` : ""}`);
}

const [, , cmd, ...args] = process.argv;
if (!commands[cmd]) die(USAGE);
await commands[cmd](args);
