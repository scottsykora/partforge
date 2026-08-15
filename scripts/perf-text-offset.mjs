// The offset engine's text-perf gate (the original winding-resolver spec's W9 budget):
// cleanup of the 24-glyph benchmark must stay within ~1.5x of the 0.59.0 reference
// (~85 ms end to end on the machine the reference was recorded on). Run with
// `node scripts/perf-text-offset.mjs`; prints median ms over warm iterations for the
// 24-glyph string at +0.3 and the reported "Scott" case at each handoff delta.
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { loadDefaultFont } from "../test/helpers/offset-corpus.js";
import { textGlyphs } from "../src/framework/geometry/text2d.js";

const font = await loadDefaultFont();

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function bench(label, regions, delta, iters = 20) {
  offsetRegions(regions, delta, { corners: "round" });          // warm
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    offsetRegions(regions, delta, { corners: "round" });
    times.push(performance.now() - t0);
  }
  console.log(`${label}: median ${median(times).toFixed(1)} ms over ${iters} runs`);
}

bench("24-glyph 'The quick brown fox jumps' +0.3", textGlyphs(font, "The quick brown fox jumps", { size: 10 }), 0.3);
const scott = textGlyphs(font, "Scott", { size: 10 });
for (const d of [0.2, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0]) bench(`"Scott" +${d}`, scott, d, 10);
