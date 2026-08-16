#!/usr/bin/env node
// The partforge CLI — also the agent-facing surface (SKILL.md points here). One
// async function per command, dispatched from the table at the bottom; flags are
// parsed strictly per command with util.parseArgs, so a typo'd flag or a missing
// option value fails loudly instead of being silently ignored.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { detectBackend } from "../src/framework/backend-select.js";
import { viewAnimations, evaluate, cueAt } from "../src/framework/animation.js";
import { bootOcctKernel } from "../src/testing/occt.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { renderViews } from "../src/testing/render.js";
import {
  createPickServer, requestPicks, formatPickResult,
  PICK_SERVER_DEFAULT_PORT, PICK_SERVER_DEFAULT_TIMEOUT_MS,
} from "../src/framework/pick-request/server.js";
import { savePickToken, loadPickToken, clearPickToken, pickTokenPath } from "../src/framework/pick-request/token-store.js";
import { matchPattern } from "../src/testing/error-patterns.js";
import { lintPart } from "../src/lint.js";

const die = (msg) => { console.error(msg); process.exit(1); };
const USAGE = "usage: partforge <lint|measure|render|pick-serve|pick> …";

// Crash contract (issue #27): with --json, a thrown error becomes structured
// stdout JSON; either way the message is matched against ERROR-PATTERNS.md and
// the pattern's fix is surfaced. Exit 1 always. NOTE on stdout purity: in --json
// mode every human-readable printer (printLint/printMeasure/printVerify) is
// gated behind `!flags.json`, so crash JSON is the only thing that ever reaches
// stdout — including when verify() throws (an unknown metric in verify.expect,
// or a per-case build crash) after measure's report has already been computed.
// Without --json there is no purity contract: human lines print as each stage
// completes, so a later crash's message lands after them, not instead of them.
function crash(cmd, e, jsonMode) {
  // The mesh backend signals an edge class it can't blend (helical edge, varying
  // dihedral, …) with NEEDS_OCCT. The two WASM kernels must never boot in one
  // process, so the fallback is a re-exec of this exact command with the backend
  // pinned to OCCT via the environment. One retry only — PARTFORGE_BACKEND set
  // means we ARE the retry.
  if (e?.code === "NEEDS_OCCT" && !process.env.PARTFORGE_BACKEND) {
    console.error(`${cmd}: ${e.message} — retrying on the OCCT backend`);
    const r = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit", env: { ...process.env, PARTFORGE_BACKEND: "occt" },
    });
    process.exit(r.status ?? 1);
  }
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

const bootKernel = (part) => {
  const backend = process.env.PARTFORGE_BACKEND || detectBackend(part); // env: crash()'s NEEDS_OCCT retry
  return backend === "occt" ? bootOcctKernel() : bootManifoldKernel();
};

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
      if (!flags.json) printMeasure(report);
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
        if (!flags.json) printVerify(v);
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
      // `--params '[1,2]'` or '42' parses fine and then merges into nothing, so the
      // flag silently does nothing. Only an object can carry param overrides.
      if (baseParams === null || typeof baseParams !== "object" || Array.isArray(baseParams)) {
        die(`--params takes a JSON object of param overrides\n${usage}`);
      }
      const outDir = flags.out || "render";
      const views = flags.views ? flags.views.split(",") : undefined;
      // Usage checks BEFORE the kernel: a flag typo shouldn't pay a WASM boot.
      // Test `=== undefined`, not falsiness: `--animation ""` is a flag the user
      // passed and got wrong (an unset shell variable, typically), not one they
      // omitted, and silently rendering a non-animation still hides the mistake.
      if (flags.animation !== undefined && flags.animation.trim() === "") {
        die(`--animation needs an animation name\n${usage}`);
      }
      if (flags.animation === undefined && (flags.at || flags.step)) {
        die(`--at/--step require --animation\n${usage}`);
      }
      if (flags.at != null && flags.step != null) {
        die(`--at and --step are alternatives — pass one, not both\n${usage}`);
      }
      // Own-key test: `part.views?.["constructor"]` resolves through
      // Object.prototype and would sail past a plain lookup, straight back into
      // the background-only render this guard exists to stop.
      if (view !== undefined && !Object.hasOwn(part.views ?? {}, view)) {
        die(`unknown view "${view}" (have: ${Object.keys(part.views ?? {}).join(", ") || "none"})\n${usage}`);
      }
      // Resolve --animation across views, still BEFORE the kernel boots (the
      // header's rule: a flag typo shouldn't pay a WASM boot, and this depends
      // only on `part`). A unique name implies its owning view, overriding the
      // default-view rule; an ambiguous one needs the positional view argument.
      // NOT a --view flag: --views already means camera angles.
      let anim = null, animView;
      if (flags.animation !== undefined) {
        const byView = viewAnimations(part);
        // Deduped: two views declaring the same name would otherwise report
        // "(declared: shared, shared)".
        const declared = () =>
          [...new Set([...byView.values()].flat().map((x) => x.name))].join(", ") || "none";
        const owners = [...byView.entries()]
          .filter(([, anims]) => anims.some((x) => x.name === flags.animation))
          .map(([v]) => v);
        if (view !== undefined) {
          if (!owners.includes(view)) {
            throw new Error(owners.length
              ? `animation "${flags.animation}" is not in view "${view}" — it lives in view ${owners.map((v) => `"${v}"`).join(", ")}`
              : `unknown animation "${flags.animation}" (declared: ${declared()})`);
          }
          animView = view;
        } else if (owners.length === 1) {
          animView = owners[0];
        } else if (owners.length > 1) {
          die(`--animation "${flags.animation}" is ambiguous (views ${owners.map((v) => `"${v}"`).join(", ")}) — pass the positional view argument\n${usage}`);
        } else {
          throw new Error(`unknown animation "${flags.animation}" (declared: ${declared()})`);
        }
        // Already normalized by viewAnimations — no normalizeAnimation call here.
        anim = byView.get(animView).find((x) => x.name === flags.animation);
      }

      const kernel = await bootKernel(part);

      if (anim === null) {
        const files = await renderViews(kernel, part, view, { views, out: outDir, params: baseParams });
        for (const f of files) console.log(`wrote ${f}`);
        process.exit(0);
      }
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
        // Split first and reject blanks: Number("") is 0, so "0.2,,0.8" would
        // otherwise slip a silent extra frame at t=0 past the range check.
        const raw = (flags.at ?? "1").split(",");
        const ts = raw.map((s) => (s.trim() === "" ? Number.NaN : Number(s)));
        if (!ts.length || ts.some((t) => !Number.isFinite(t) || t < 0 || t > 1)) {
          die(`--at takes comma-separated positions in 0..1\n${usage}`);
        }
        // The tag is the only thing distinguishing one frame's file from another.
        // Two decimals suits the usual `--at 0,0.5,1`, but a dense request like
        // 0.001,0.004 collides and the later render would silently overwrite the
        // earlier — one file for two frames asked for. Widen the tag just enough
        // for THIS request instead of refusing it: ordinary runs keep their
        // familiar t000/t050/t100 names, dense ones get one file each.
        const tagsAt = (decimals) =>
          ts.map((t) => String(Math.round(t * 10 ** decimals)).padStart(decimals + 1, "0"));
        let decimals = 2;
        while (decimals < 6 && new Set(tagsAt(decimals)).size !== ts.length) decimals++;
        const tags = tagsAt(decimals);
        if (new Set(tags).size !== ts.length) {
          // No precision separates them: the same position was listed twice.
          die(`--at lists the same position more than once\n${usage}`);
        }
        frames = ts.map((t, i) => ({ t, tag: `${flags.animation}-t${tags[i]}` }));
      }
      for (const frame of frames) {
        const { values, opacity } = evaluate(anim, frame.t);
        const cue = cueAt(anim, frame.cueT ?? frame.t);
        const frameViews = views ?? (cue ? [cue.view] : undefined);
        const files = await renderViews(kernel, part, animView, {
          views: frameViews, out: outDir, params: { ...baseParams, ...values }, tag: frame.tag, opacity,
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
    const port = Number(flags.port) || PICK_SERVER_DEFAULT_PORT;
    const timeoutMs = (Number(flags.timeout) || PICK_SERVER_DEFAULT_TIMEOUT_MS / 1000) * 1000;
    const srv = createPickServer({ port, timeoutMs });
    const { port: bound } = await srv.start();
    // The token is what keeps every other page on the machine out of this server.
    // `partforge pick` runs in a different process, so drop it in a 0600 file for
    // that process to find; the browser gets it through the app URL below.
    savePickToken(bound, srv.token);
    const stop = () => { clearPickToken(bound); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log(`partforge pick-server listening on http://127.0.0.1:${bound}`);
    console.log(`token: ${srv.token}  (also at ${pickTokenPath(bound)})`);
    console.log(`open the app with: ?pickserver=http://127.0.0.1:${bound}&picktoken=${srv.token}`);
    // no exit — the process stays alive serving requests
  },

  async pick(args) {
    const usage = 'usage: partforge pick "<prompt>" ["<prompt>" …] [--port N] [--token T]';
    const { values: flags, positionals: prompts } = parse(args, { port: { type: "string" }, token: { type: "string" } }, usage);
    if (prompts.length === 0) die(usage);
    const port = Number(flags.port) || PICK_SERVER_DEFAULT_PORT;
    const token = flags.token || process.env.PARTFORGE_PICK_TOKEN || loadPickToken(port);
    if (!token) die(`no pick-server token for port ${port} — start one with \`partforge pick-serve\`, or pass --token`);
    const out = await requestPicks({ port, prompts, token }).catch((e) => die(e.message));
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
