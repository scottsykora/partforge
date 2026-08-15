#!/usr/bin/env node
// Measures the 2-D offset engine's chain-incomplete throw rate, per corner style, before and
// after the fallback ladder — plus what the ladder costs when it fires.
//
// THIS SCRIPT IS THE SOURCE OF EVERY OFFSET RATE QUOTED IN docs/ERROR-PATTERNS.md AND
// docs/KERNEL-CONTRACT.md. Those numbers used to come from scratch scripts that were never
// committed; a reviewer who re-derived them independently got different answers and
// falsified several shipped claims, including "sharp has never produced this throw". If you
// change a rate in either doc, change it because this script printed it.
//
//   nvm use && node scripts/offset-rates.mjs                 # the default 600-case corpus
//   node scripts/offset-rates.mjs --cases 2000               # a bigger sweep
//   node scripts/offset-rates.mjs --seed 137                 # one case, every delta/style
//   node scripts/offset-rates.mjs --no-oracle                # rates only; skips the WASM boot
//
// Corpus: test/helpers/offset-corpus.js (seeded, deterministic, four shape families) swept at
// CORPUS_DELTAS x three corner styles, plus the six glyph cases at five deltas. Truth for the
// accuracy columns is the independent Minkowski-union oracle (test/helpers/minkowski-oracle.js),
// never Clipper2's own offsetter.

import { offsetRegions, _offsetNoFallback, _rawOffset, _ladderRungs }
  from "../src/framework/geometry/contour-offset.js";
import { CHAIN_INCOMPLETE_MESSAGE } from "../src/framework/geometry/contour-winding.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";
import { textGlyphs } from "../src/framework/geometry/text2d.js";
import { minkowskiOracle } from "../test/helpers/minkowski-oracle.js";
import { corpus, caseFor, glyphCases, loadDefaultFont, CORPUS_DELTAS, CORNER_STYLES }
  from "../test/helpers/offset-corpus.js";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const CASES = flag("cases", 600);
const ONE = argv.includes("--seed") ? flag("seed", 0) : null;
const USE_ORACLE = !argv.includes("--no-oracle");
const SEGS = 64;

const pointRings = (regions) => regions.map((rg) => ({
  outer: tessellateContour(rg.outer, SEGS), holes: rg.holes.map((h) => tessellateContour(h, SEGS)) }));
const engineArea = (out) => pointRings(out).reduce((a, rg) =>
  a + Math.abs(ringArea(rg.outer)) - rg.holes.reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
const arcCount = (out) => out.reduce((a, rg) =>
  a + [rg.outer, ...rg.holes].reduce((n, c) => n + c.segments.filter((s) => s.via).length, 0), 0);
const segCount = (out) => out.reduce((a, rg) =>
  a + [rg.outer, ...rg.holes].reduce((n, c) => n + c.segments.length, 0), 0);

// Oracle topology: Clipper2 hands back outers CCW (positive area) and holes CW under the
// Positive fill rule, so signed area is the classifier. Rings under SLIVER are dropped on
// BOTH sides before counting — a 1e-3 mm² crumb is not a region anybody means.
const SLIVER = 1e-3;
function oracleTopology(O, regions, delta, corners, fan) {
  const cs = O.offset(pointRings(regions), delta, { corners, fan });
  const polys = cs.toPolygons();
  cs.delete?.();
  let outers = 0, holes = 0, area = 0;
  for (const p of polys) {
    const a = ringArea(p);
    if (Math.abs(a) < SLIVER) continue;
    if (a > 0) { outers++; area += a; } else { holes++; area += a; }
  }
  return { regions: outers, holes, area };
}

const isChain = (e) => e?.message === CHAIN_INCOMPLETE_MESSAGE;
const isCollapse = (e) => /offset collapses the shape/.test(e?.message ?? "");

async function main() {
  const font = await loadDefaultFont();
  const cases = ONE !== null ? [caseFor(ONE)] : [
    ...corpus(CASES),
    ...glyphCases(textGlyphs, font),
  ];
  const deltas = (c) => (c.family === "glyph" ? [0.2, 0.5, 1, 2, 3] : CORPUS_DELTAS);

  let O = null;
  if (USE_ORACLE) {
    const Module = (await import("manifold-3d")).default;
    const wasm = await Module();
    wasm.setup();
    O = minkowskiOracle(wasm.CrossSection);
  }

  const stat = Object.fromEntries(CORNER_STYLES.map((c) =>
    [c, { attempts: 0, collapse: 0, chainBefore: 0, chainAfter: 0, other: 0 }]));
  const survivors = [];         // rescued by the ladder: {seed, family, delta, corners}
  const residual = [];          // still throwing after the ladder
  const t0 = Date.now();

  for (const c of cases) {
    for (const delta of deltas(c)) for (const corners of CORNER_STYLES) {
      const s = stat[corners];
      s.attempts++;
      let before = null;
      try { _offsetNoFallback(c.regions, delta, corners); }
      catch (e) { before = isChain(e) ? "chain" : isCollapse(e) ? "collapse" : "other"; }
      if (before === "chain") s.chainBefore++;
      try {
        offsetRegions(c.regions, delta, corners === "round" ? undefined : { corners });
        if (before === "chain") survivors.push({ ...c, delta, corners });
      } catch (e) {
        if (isChain(e)) { s.chainAfter++; residual.push({ seed: c.seed, family: c.family, delta, corners }); }
        else if (isCollapse(e)) s.collapse++;
        else { s.other++; console.error(`UNEXPECTED ${c.seed} d=${delta} ${corners}: ${e.message}`); }
      }
    }
  }

  const pct = (n, d) => `${((100 * n) / d).toFixed(3)} %`;
  console.log(`\ncorpus: ${cases.length} cases x deltas x 3 styles — ${Date.now() - t0} ms\n`);
  console.log("corner   attempts  collapse   chain-incomplete BEFORE ladder   AFTER ladder");
  for (const c of CORNER_STYLES) {
    const s = stat[c];
    console.log(`${c.padEnd(8)} ${String(s.attempts).padStart(8)}  ${String(s.collapse).padStart(8)}` +
      `   ${String(s.chainBefore).padStart(5)} (${pct(s.chainBefore, s.attempts).padStart(8)})` +
      `        ${String(s.chainAfter).padStart(5)} (${pct(s.chainAfter, s.attempts).padStart(8)})`);
  }
  const tot = (k) => CORNER_STYLES.reduce((a, c) => a + stat[c][k], 0);
  console.log(`ALL      ${String(tot("attempts")).padStart(8)}  ${String(tot("collapse")).padStart(8)}` +
    `   ${String(tot("chainBefore")).padStart(5)} (${pct(tot("chainBefore"), tot("attempts")).padStart(8)})` +
    `        ${String(tot("chainAfter")).padStart(5)} (${pct(tot("chainAfter"), tot("attempts")).padStart(8)})`);

  if (residual.length) {
    // Does switching corner style get the caller out? This is the evidence behind the
    // workaround ERROR-PATTERNS.md offers, and the reason it no longer names a specific style:
    // the old advice ("retry with sharp") was asserted, never measured, and is false.
    const byCase = new Map();
    for (const r of residual) {
      const k = `${r.seed}@${r.delta}`;
      byCase.set(k, (byCase.get(k) ?? new Set()).add(r.corners));
    }
    let escapable = 0;
    for (const styles of byCase.values()) if (styles.size < CORNER_STYLES.length) escapable++;
    console.log(`\nresidual failures: ${residual.length} across ${byCase.size} (case, delta) pairs;` +
      ` another corner style builds in ${escapable}/${byCase.size} of them` +
      ` (${byCase.size - escapable} fail under all three).`);
    for (const c of CORNER_STYLES) {
      const only = [...byCase.values()].filter((s) => s.size === 1 && s.has(c)).length;
      console.log(`  fails ONLY under ${c.padEnd(8)}: ${only}`);
    }
    console.log("reproduce any of these with --seed <seed>:");
    for (const r of residual.slice(0, 40))
      console.log(`  seed ${String(r.seed).padEnd(8)} ${r.family.padEnd(15)} delta=${r.delta} ${r.corners}`);
  }

  if (!O) return;

  // ── what the ladder costs when it fires ────────────────────────────────────────────────
  // For every rescued case: the winning rung's answer against the oracle (area AND REGION
  // COUNT), whether a later rung would have had the region count right, and whether the
  // winning rung still carries the arcs the raw offset had. The region-count column is the
  // point — a clusterTol rung that merges two crossings across a severing web hands back one
  // region FEWER than truth, which no area tolerance would catch — and the arc column is the
  // other one, since arc preservation to STEP is this engine's headline property.
  let worstAbs = 0, worstRel = 0;
  const errs = [];
  const short = [], arcLoss = [];
  const rungWins = new Map();
  for (const s of survivors) {
    const fan = s.corners === "round" ? 4096 : 64;
    let truth;
    try { truth = oracleTopology(O, s.regions, s.delta, s.corners, fan); }
    catch { continue; }
    if (Math.abs(truth.area) < 1e-6) continue;
    const { raw } = _rawOffset(s.regions, s.delta, s.corners);
    const rungs = _ladderRungs(s.regions, raw, s.delta, s.corners);
    // Run every rung independently: which one wins today, and what the ones after it would
    // have said. first-non-empty-wins means a later, better rung never gets asked.
    const results = rungs.map((r) => {
      try { const out = r.run(); return out.length > 0 ? { name: r.name, out } : null; }
      catch { return null; }
    });
    const winIdx = results.findIndex(Boolean);
    if (winIdx === -1) continue;
    const win = results[winIdx];
    rungWins.set(win.name, (rungWins.get(win.name) ?? 0) + 1);
    const got = engineArea(win.out);
    const abs = Math.abs(got - Math.abs(truth.area));
    const rel = abs / Math.abs(truth.area);
    errs.push(rel);
    worstAbs = Math.max(worstAbs, abs); worstRel = Math.max(worstRel, rel);
    if (win.out.length < truth.regions) {
      const later = results.slice(winIdx + 1).find((r) => r && r.out.length >= truth.regions);
      short.push({ seed: s.seed, delta: s.delta, corners: s.corners, rung: win.name,
        got: win.out.length, want: truth.regions, later: later?.name ?? null });
    }
    const rawArcs = raw.reduce((a, rg) =>
      a + [rg.outer, ...rg.holes].reduce((n, c) => n + c.segments.filter((x) => x.via).length, 0), 0);
    if (rawArcs > 0 && arcCount(win.out) === 0)
      arcLoss.push({ seed: s.seed, delta: s.delta, corners: s.corners, rung: win.name,
        rawArcs, segs: segCount(win.out) });
  }
  errs.sort((a, b) => a - b);
  const median = errs.length ? errs[Math.floor(errs.length / 2)] : 0;
  console.log(`\nladder rescues: ${survivors.length}; oracle-checked: ${errs.length}`);
  console.log(`  area error vs oracle: median ${(100 * median).toFixed(4)} %, ` +
    `worst ${(100 * worstRel).toFixed(3)} % (${worstAbs.toFixed(4)} mm²)`);
  console.log(`  winning rung: ${[...rungWins].map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`  rescued answers with FEWER regions than truth: ${short.length}` +
    ` (a later rung had it right in ${short.filter((r) => r.later).length})`);
  for (const r of short.slice(0, 20))
    console.log(`    seed ${String(r.seed).padEnd(8)} delta=${r.delta} ${r.corners}: ${r.rung} gave` +
      ` ${r.got} vs truth ${r.want}${r.later ? `; ${r.later} gave >= truth` : ""}`);
  console.log(`  rescued answers that lost every arc the raw offset carried: ${arcLoss.length}`);
  for (const r of arcLoss.slice(0, 10))
    console.log(`    seed ${String(r.seed).padEnd(8)} delta=${r.delta} ${r.corners}: ${r.rung} —` +
      ` raw carried ${r.rawArcs} arcs, result has 0 arcs / ${r.segs} line segments`);
}

await main();
