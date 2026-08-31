// relief.js's DEMO_RELIEF_RANGE is hardcoded to the bundled asset's measured
// luminance extent (see the constant's own header comment) — nothing else ties
// the two together, so a regenerated relief-demo.png at different contrast
// would silently mis-map (flat or clipped relief) with no test complaining.
// Decode the committed asset and assert its actual extent still matches.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodePng } from "../src/framework/geometry/png-decode.js";
import relief, { DEMO_RELIEF_RANGE } from "../src/parts/relief.js";

describe("relief.js DEMO_RELIEF_RANGE", () => {
  it("matches the bundled asset's actual measured luminance extent", () => {
    const url = relief.images({ relief: "" }).relief; // the bundled default asset's URL
    const { data } = decodePng(new Uint8Array(readFileSync(url)));
    let min = Infinity, max = -Infinity;
    for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
    expect([min / 65535, max / 65535]).toEqual(DEMO_RELIEF_RANGE);
  });
});
