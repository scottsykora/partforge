import { expect, test } from "vitest";
import { distanceTransform, matchMasks, matchViews } from "../src/framework/oracle/match.js";
import { MATCH_VIEWS } from "../src/framework/oracle/silhouette.js";

// Masks are Task 1's shape: {data: Uint8Array of 0|255, width, height, mmPerPx, minX, minY},
// row 0 = TOP. Built by hand here so each fixture states exactly the shape being scored;
// `mmPerPx: null` is a mask with no scale, which is what turns the scale-aware path off.
function blank(width, height, mmPerPx = null) {
  return { data: new Uint8Array(width * height), width, height, mmPerPx, minX: 0, minY: 0 };
}
function rect(m, col, row, w, h, v = 255) {
  for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) m.data[r * m.width + c] = v;
  return m;
}
function disk(m, cc, cr, radius) {
  for (let r = 0; r < m.height; r++) for (let c = 0; c < m.width; c++) {
    if ((c - cc) ** 2 + (r - cr) ** 2 <= radius * radius) m.data[r * m.width + c] = 255;
  }
  return m;
}
// A plus sign filling the given bbox: same bbox AND same centroid as the square that
// contains it, which is what lets a delta fixture isolate "extra" from "misaligned".
function cross(m, col, row, size, arm) {
  const mid = Math.round((size - arm) / 2);
  rect(m, col, row + mid, size, arm);
  rect(m, col + mid, row, arm, size);
  return m;
}
const square = (side, at = 10, size = 256, mmPerPx = null) => rect(blank(size, size, mmPerPx), at, at, side, side);
const classes = (delta) => { const n = [0, 0, 0, 0]; for (const v of delta.data) n[v]++; return n; };

test("identical masks score a perfect overlap and no contour separation", () => {
  const a = square(80), b = square(80);
  const m = matchMasks(a, b);
  expect(m.iou).toBe(1);
  expect(m.boundaryIoU).toBe(1);
  expect(m.contourDist).toBe(0);
  expect(m.contourUnit).toBe("%bbox-diag");
  expect(m.iouScale).toBeUndefined();
  expect(m.delta.width).toBe(256);
  expect(m.delta.height).toBe(256);
  const n = classes(m.delta);
  expect(n[2]).toBe(0); // nothing missing
  expect(n[3]).toBe(0); // nothing extra
  expect(n[1]).toBeGreaterThan(0);
});

test("pose normalization is translation invariant", () => {
  const a = square(40, 5), b = square(40, 70);
  const m = matchMasks(a, b);
  expect(m.iou).toBe(1);
  expect(m.contourDist).toBe(0);
});

test("pose normalization is scale invariant, and scaleAware is where size is judged", () => {
  // 200 mm square (50 px at 4 mm/px) against a 100 mm reference (100 px at 1 mm/px).
  const big = square(50, 20, 256, 4);
  const small = square(100, 20, 256, 1);
  expect(matchMasks(big, small).iou).toBe(1);

  const m = matchMasks(big, small, { scaleAware: true });
  expect(m.iou).toBe(1);
  expect(m.iouScale).toBeCloseTo(0.25, 3); // 1x1 inside 2x2
  expect(m.contourUnit).toBe("mm");
});

// An L's centroid sits well away from its bbox centre, which is the case that stresses
// the centroid-aligned frame: scaling the long side to 0.92 of the frame and then putting
// the CENTROID at the centre pushes the far arm past the edge.
const ell = (k, at) => {
  const m = blank(256, 256);
  rect(m, at, at, 10 * k, 40 * k);
  rect(m, at, at + 30 * k, 40 * k, 10 * k);
  return m;
};

test("pose normalization never runs a shape off the frame edge", () => {
  // Clipping is silent: it would drop the far end of the arm from every score, so a
  // difference out there would read as agreement.
  const { delta } = matchMasks(ell(3, 20), ell(3, 20));
  const on = (r, c) => delta.data[r * delta.width + c] !== 0;
  for (let c = 0; c < delta.width; c++) {
    expect(on(0, c)).toBe(false);
    expect(on(delta.height - 1, c)).toBe(false);
  }
  for (let r = 0; r < delta.height; r++) {
    expect(on(r, 0)).toBe(false);
    expect(on(r, delta.width - 1)).toBe(false);
  }
});

test("an off-centroid shape normalizes the same way at any scale", () => {
  const m = matchMasks(ell(1, 5), ell(3, 20));
  expect(m.iou).toBe(1);
  expect(m.contourDist).toBe(0);
});

test("a wildly oversized candidate coarsens the scale-aware grid instead of cropping it", () => {
  // 100 px at 4000 mm/px is a 400 m square against a 100 mm reference. Laying that out at
  // the reference's own pitch would be a 400 000 px frame, so the grid coarsens — the
  // score still has to say "4000x too big", not run out of memory or crop to a draw.
  const huge = square(100, 20, 256, 4000);
  const ref = square(100, 20, 256, 1);
  const m = matchMasks(huge, ref, { scaleAware: true });
  expect(m.iou).toBe(1);
  expect(m.iouScale).toBeLessThan(1e-5);
  expect(m.contourDist).toBeGreaterThan(1e5); // hundreds of metres apart, in mm
  expect(Number.isFinite(m.contourDist)).toBe(true);
});

test("a square against a disk of the same bbox scores partial overlap", () => {
  const sq = square(101);
  const d = disk(blank(256, 256), 60, 60, 50);
  const m = matchMasks(sq, d);
  expect(m.iou).toBeGreaterThan(0.7);
  expect(m.iou).toBeLessThan(0.9);
});

test("distanceTransform reports Euclidean distance to the nearest foreground pixel", () => {
  const w = 32, h = 32;
  const data = new Uint8Array(w * h);
  data[10 * w + 10] = 255;
  const dt = distanceTransform(data, w, h);
  expect(dt[10 * w + 10]).toBeCloseTo(0, 6);
  expect(dt[14 * w + 13]).toBeCloseTo(5, 6);   // offset (3, 4)
  expect(dt[6 * w + 7]).toBeCloseTo(5, 6);     // and the other way
  expect(dt[10 * w + 13]).toBeCloseTo(3, 6);
});

test("distanceTransform is correct on a non-square grid", () => {
  // A square grid cannot tell the row pass from the column pass: swap the two lengths the
  // envelope is run over and every square fixture still passes. This one is 40 wide by 16
  // tall and probed off both diagonals, so a transposed pass reads past the end of one
  // axis and comes back with the BIG seed instead of a distance.
  const w = 40, h = 16;
  const data = new Uint8Array(w * h);
  data[3 * w + 30] = 255;
  const dt = distanceTransform(data, w, h);
  expect(dt[3 * w + 30]).toBeCloseTo(0, 6);
  expect(dt[7 * w + 33]).toBeCloseTo(5, 6);              // (4 rows, 3 cols)
  expect(dt[15 * w + 39]).toBeCloseTo(15, 6);            // far corner: (12, 9)
  expect(dt[0]).toBeCloseTo(Math.hypot(3, 30), 4);       // the other far corner
});

test("contourDist is reported in mm when both masks carry a scale", () => {
  // Concentric squares, 100 px vs 80 px at 1 mm/px: every inner rim pixel sits 10 mm
  // from the outer rim, and the outer corners a little further.
  const outer = rect(blank(128, 128, 1), 14, 14, 100, 100);
  const inner = rect(blank(128, 128, 1), 24, 24, 80, 80);
  const m = matchMasks(inner, outer, { scaleAware: true });
  expect(m.contourUnit).toBe("mm");
  expect(m.contourDist).toBeGreaterThan(9);
  expect(m.contourDist).toBeLessThan(12);
});

test("contourDist is reported as a fraction of the reference bbox diagonal when unscaled", () => {
  const sq = square(100);
  const plus = cross(blank(256, 256), 10, 10, 100, 34);
  const m = matchMasks(plus, sq);
  expect(m.contourUnit).toBe("%bbox-diag");
  // Pinned, not bracketed: a plain (0, 100) range accepts any divisor at all, including
  // the raw pixel distance with no conversion. 100 px square vs the cross inside it.
  expect(m.contourDist).toBeCloseTo(7.74, 1);
});

test("the %bbox-diag divisor is the REFERENCE's bbox diagonal, not the candidate's", () => {
  // The two shapes above share a bbox, so they cannot tell the two divisors apart. These
  // differ in aspect ratio, so their normalized diagonals differ: the square normalizes to
  // 235.52² (diag 333.07) and the 2:1 rectangle to 235.52 x 117.76 (diag 263.32).
  const sq = rect(blank(256, 256), 10, 10, 100, 100);
  const wide = rect(blank(256, 256), 10, 10, 100, 50);

  // contourDistance is symmetric, so the SAME pixel distance is divided both times and the
  // ratio is exactly the ratio of the two references' diagonals — analytic, no measurement.
  const withWideRef = matchMasks(sq, wide).contourDist;
  const withSquareRef = matchMasks(wide, sq).contourDist;
  const diagSquare = Math.hypot(235.52, 235.52), diagWide = Math.hypot(235.52, 117.76);
  expect(withWideRef / withSquareRef).toBeCloseTo(diagSquare / diagWide, 6); // sqrt(1.6)

  // Dividing by the candidate's diagonal inverts that ratio, so state the direction too:
  // the smaller reference diagonal must be the one that reports the larger percentage.
  expect(withWideRef).toBeGreaterThan(withSquareRef);
  expect(withWideRef).toBeCloseTo(12.61, 1);
  expect(withSquareRef).toBeCloseTo(9.97, 1);
});

test("boundaryIoU penalizes a thin tab more than plain iou", () => {
  const ref = square(100);
  const tabbed = rect(rect(blank(256, 256), 10, 10, 100, 100), 110, 45, 30, 2);
  const m = matchMasks(tabbed, ref);
  expect(m.boundaryIoU).toBeLessThan(m.iou);
});

test("boundaryIoU penalizes a rim-only difference the area score barely notices", () => {
  // Same bbox both ways, so pose normalization is a no-op and only the rim differs.
  const ref = square(100);
  const notched = rect(square(100), 10, 45, 30, 2, 0);
  const m = matchMasks(notched, ref);
  expect(m.iou).toBeGreaterThan(0.98);   // 60 px out of 10 000 — the area score shrugs
  expect(m.boundaryIoU).toBeLessThan(0.95);
  expect(m.boundaryIoU).toBeLessThan(m.iou);
  // Pinned so the band width itself is behavioral: BAND_PX = 2. A wider band dilutes the
  // notch into more agreeing rim and this number climbs; a narrower one drops it.
  expect(m.boundaryIoU).toBeCloseTo(0.681, 2);
});

test("delta names candidate-only pixels excess and reference-only pixels missing", () => {
  const sq = square(100);
  const plus = cross(blank(256, 256), 10, 10, 100, 34);

  const extra = classes(matchMasks(sq, plus).delta);   // candidate covers more than the reference
  expect(extra[3]).toBeGreaterThan(0);
  expect(extra[2]).toBe(0);

  const short = classes(matchMasks(plus, sq).delta);   // candidate covers less
  expect(short[2]).toBeGreaterThan(0);
  expect(short[3]).toBe(0);
});

test("an empty or absent mask is unscoreable rather than zero-scoring", () => {
  const sq = square(40);
  expect(matchMasks(blank(64, 64), sq)).toBe(null);
  expect(matchMasks(sq, blank(64, 64))).toBe(null);
  expect(matchMasks(null, sq)).toBe(null);
  expect(matchMasks(sq, null)).toBe(null);
  expect(matchMasks(null, null)).toBe(null);
});

test("matchViews scores every view it can and reports the best", () => {
  const ref = square(101);
  const views = {
    front: disk(blank(256, 256), 60, 60, 50),
    left: square(40, 100),
    right: null,
    top: blank(256, 256),
  };
  const { best, views: scores } = matchViews(views, ref);
  expect(Object.keys(scores).sort()).toEqual(["front", "left"]); // null and empty skipped
  expect(scores.left).toBe(1);
  expect(scores.front).toBeGreaterThan(0.7);
  expect(best.view).toBe("left");
  expect(best.iou).toBe(1);
  expect(best.delta.width).toBe(256);
});

test("matchViews breaks a tie in MATCH_VIEWS order, not in key order", () => {
  const ref = square(40);
  const { best } = matchViews({ left: square(40), front: square(40) }, ref);
  expect(MATCH_VIEWS.indexOf("front")).toBeLessThan(MATCH_VIEWS.indexOf("left"));
  expect(best.view).toBe("front");
});

test("matchViews with nothing scoreable reports no best", () => {
  const { best, views } = matchViews({ front: null, top: blank(32, 32) }, square(40));
  expect(best).toBe(null);
  expect(views).toEqual({});
  expect(matchViews(null, square(40)).best).toBe(null);
  expect(matchViews({ front: square(40) }, null).best).toBe(null);
});
