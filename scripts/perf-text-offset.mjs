// The offset engine's text-performance gate. The original winding-resolver reference for
// this 24-glyph string was about 85 ms end to end; cleanup should stay within roughly 1.5x.
// Run with `node scripts/perf-text-offset.mjs`. This reports warm medians rather than making
// wall-clock timing a flaky test assertion.
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { loadDefaultFont } from "../test/helpers/offset-corpus.js";
import { textGlyphs } from "../src/framework/geometry/text2d.js";

const font = await loadDefaultFont();

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(label, regions, delta, iterations = 20) {
  offsetRegions(regions, delta, { corners: "round" });
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    offsetRegions(regions, delta, { corners: "round" });
    times.push(performance.now() - start);
  }
  console.log(`${label}: median ${median(times).toFixed(1)} ms over ${iterations} runs`);
}

bench("24-glyph 'The quick brown fox jumps' +0.3",
  textGlyphs(font, "The quick brown fox jumps", { size: 10 }), 0.3);
const scott = textGlyphs(font, "Scott", { size: 10 });
for (const delta of [0.2, 0.5, 0.8, 1, 1.5, 2, 3])
  bench(`"Scott" +${delta}`, scott, delta, 10);
