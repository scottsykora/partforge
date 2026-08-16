// Regression fixtures contributed from the parallel face-labeled-resolver effort
// (branch claude/offset-winding-faces): three review findings confirmed by execution
// against this engine's shared construction code, plus two adversarial fixture families
// its independent testing surfaced. Engine-agnostic — every truth here is a closed form,
// a Minkowski-oracle value, or an exact-tangency identity, never an engine's own output.
// Pure JS + paper.js only — no WASM boot.
import { describe, expect, test } from "vitest";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { profileArea } from "../src/framework/geometry/contour-ops.js";
import { caseFor } from "./helpers/offset-corpus.js";

const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
const region = (outer, holes = []) => ({ outer, holes });

describe("review findings (execution-confirmed pre-fix)", () => {
  test("a zero-extent sliver ring collapses with the pinned message, not a TypeError", () => {
    // A ring whose every segment drops as zero-length left _offsetContour with no pieces
    // and assembleRing dereferenced an empty list. checkPointRing demands three points,
    // not nonzero extent, so a sliver ring from an upstream boolean reaches here through
    // the public surface.
    const sliver = { start: [5, 5], segments: [{ to: [5 + 1e-10, 5] }, { to: [5, 5 + 1e-10] }, { to: [5, 5] }] };
    expect(() => offsetRegions([region(sliver)], 1)).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
    // ...and a sliver ring beside a real region must not take the real region down with it
    const sq = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const out = offsetRegions([region(sliver), region(sq)], 1, { corners: "sharp" });
    expect(out).toHaveLength(1);
    expect(profileArea(out)).toBeCloseTo(144, 6);
  });

  test("a zero-width spike gets its round end caps: the stadium, not a flat-capped rectangle", () => {
    // An EXACT 180° reversal failed the strict turn*delta > 0 gap test and fell through
    // to the overlap branch (flat cap), and a NEAR-180° reversal took joinSegs'
    // degenerate-bisector fallback which put the arc `via` on the diametrically wrong
    // side, sweeping the cap through the interior where the winding rule cancelled it.
    // Either way the tip cap silently vanished. Truth: a length-10 segment dilated by 1
    // is a stadium, area 20 + π.
    const exact = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [5, 0] }, { to: [0, 0] }] };
    const near = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [0, 5e-9] }, { to: [0, 0] }] };
    for (const spike of [exact, near]) {
      const out = offsetRegions([region(spike)], 1, { corners: "round" });
      expect(profileArea(out)).toBeCloseTo(20 + Math.PI, 1);
    }
  });
});

describe("adversarial fixtures from the parallel effort's independent testing", () => {
  test("exact inter-ring tangency (fuzz seed 135 at −2): the tangent region survives whole", () => {
    // The corpus's multi-region family constructs a region eroded to EXACT tangency with
    // a growing hole at delta −2. Truth (Minkowski oracle, fan 512): 2 regions, 1 hole,
    // area 266.392 — the tangent region is a whole ~28 mm² component that a mislabeled
    // arrangement loses silently while neighbouring deltas stay correct.
    const c = caseFor(135);
    const out = offsetRegions(c.regions, -2, { corners: "round" });
    expect(out).toHaveLength(2);
    expect(out.reduce((a, rg) => a + rg.holes.length, 0)).toBe(1);
    expect(profileArea(out)).toBeCloseTo(266.39, 0);
  });

  test("comb sever thresholds: region counts flip exactly at the knife edges", () => {
    // A three-slot comb (teeth 6/4/4/4 wide, slots 7 deep, web 3 thick) eroded ACROSS its
    // own sever thresholds: the web severs at exactly |d| = 1.5 and the 4-wide teeth
    // vanish at exactly |d| = 2 — half-thousandth offsets to either side are the
    // knife-edge pinch arrangements per-piece classification historically got wrong.
    // Truths from the independent Minkowski erode oracle at fan=512.
    const comb = ring([[0, 0], [30, 0], [30, 10], [26, 10], [26, 3], [22, 3], [22, 10], [18, 10],
                       [18, 3], [14, 3], [14, 10], [10, 10], [10, 3], [6, 3], [6, 10], [0, 10]]);
    const TRUTH = [
      [-1.4975, 1, 45.16277],   // web survives as a 0.005 mm sliver: still ONE region
      [-1.5,    4, 44.89739],   // exact sever: the web is gone, four teeth remain
      [-1.5025, 4, 44.69452],
      [-1.9975, 4, 12.65567],   // 4-wide teeth one half-thousandth from vanishing
      [-2.0025, 4, 12.46230],   // teeth columns gone; a lens survives under each slot pair
      [-2.4975, 1, 5.03856],    // only the 6-wide left tooth's core survives
    ];
    for (const [d, regions, area] of TRUTH) {
      const out = offsetRegions([region(comb)], d, { corners: "round" });
      expect(out, `delta ${d}`).toHaveLength(regions);
      expect(profileArea(out)).toBeCloseTo(area, 2);
    }
  });
});
