// Pure unit tests for the native contour offset engine — no WASM, no kernel boot.
import { describe, expect, test } from "vitest";
import { _offsetSegment } from "../src/framework/geometry/contour-offset.js";

const close = (a, b, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(tol);

describe("line offset", () => {
  test("offsets right of travel", () => {
    // travel +x, right of travel is -y; delta +1 → shifted down
    const r = _offsetSegment([0, 0], { to: [10, 0] }, 1);
    close(r.start, [0, -1]); close(r.segments[0].to, [10, -1]);
    expect(r.dirty).toBe(false);
  });
});

describe("arc offset", () => {
  test("CCW arc grows concentrically with positive delta", () => {
    // quarter circle r=5 about origin, CCW from (5,0) to (0,5): right of travel is outward
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, 1);
    close(r.start, [6, 0]); close(r.segments[0].to, [0, 6]);
    close(r.segments[0].via, [6 / Math.SQRT2, 6 / Math.SQRT2]);
    expect(r.dirty).toBe(false);
  });
  test("CW arc shrinks with positive delta", () => {
    // same quarter circle traversed CW from (0,5) to (5,0): right of travel is inward
    const r = _offsetSegment([0, 5], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [5, 0] }, 1);
    close(r.start, [0, 4]); close(r.segments[0].to, [4, 0]);
    expect(r.dirty).toBe(false);
  });
  test("radius inversion flags dirty", () => {
    const r = _offsetSegment([5, 0], { via: [5 / Math.SQRT2, 5 / Math.SQRT2], to: [0, 5] }, -6);
    expect(r.dirty).toBe(true);
  });
  test("collinear via degrades to a line", () => {
    const r = _offsetSegment([0, 0], { via: [5, 0], to: [10, 0] }, 1);
    expect(r.segments[0].via).toBeUndefined();
    close(r.start, [0, -1]);
  });
});

describe("cubic offset", () => {
  test("offset endpoints displaced along endpoint normals; deviation within tolerance", () => {
    // quarter-circle cubic r=5 (k = 0.5523·r), CCW from (5,0) to (0,5)
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 1);
    close(r.start, [6, 0], 1e-6); close(r.segments.at(-1).to, [0, 6], 1e-6);
    expect(r.dirty).toBe(false);
    // every emitted piece is a cubic
    for (const s of r.segments) expect(s.c1).toBeDefined();
  });
  test("subdivided pieces connect exactly", () => {
    const k = 0.551915 * 5;
    const r = _offsetSegment([5, 0], { c1: [5, k], c2: [k, 5], to: [0, 5] }, 4); // large delta forces subdivision
    expect(r.segments.length).toBeGreaterThan(1);
  });
});

import { _offsetContour, validateRawOffset } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = (s) => ({ start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] });
const area = (c) => ringArea(tessellateContour(c, 256));
const kinds = (c) => c.segments.map((s) => (s.c1 ? "cubic" : s.via ? "arc" : "line"));

describe("offsetContour", () => {
  test("sharp outset of a square is the exact bigger square", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "sharp");
    expect(dirty).toBe(false);
    expect(area(contour)).toBeCloseTo(144, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("round outset adds exact quarter-circle arcs", () => {
    const { contour, dirty } = _offsetContour(sq(10), 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour).filter((k) => k === "arc").length).toBe(4);
    expect(area(contour)).toBeCloseTo(140 + Math.PI, 2);  // exact πd² corners (tessellation-limited)
  });
  test("chamfer outset cuts 2d² off the sharp area", () => {
    const { contour } = _offsetContour(sq(10), 1, "chamfer");
    expect(area(contour)).toBeCloseTo(142, 9);
  });
  test("inset square trims line-line corners exactly on the fast path", () => {
    const { contour, dirty } = _offsetContour(sq(10), -1, "round");
    expect(dirty).toBe(false);                             // trimmed, not chord+dirty
    expect(area(contour)).toBeCloseTo(64, 9);
    expect(kinds(contour).every((k) => k === "line")).toBe(true);
  });
  test("circle offset is exact concentric arcs, no joins", () => {
    // a circle is two half-arcs (the storage convention — one full-circle arc is ambiguous)
    const circ = { start: [5, 0], segments: [{ via: [0, 5], to: [-5, 0] }, { via: [0, -5], to: [5, 0] }] };
    const { contour, dirty } = _offsetContour(circ, 1, "round");
    expect(dirty).toBe(false);
    expect(kinds(contour)).toEqual(["arc", "arc"]);
    for (const p of tessellateContour(contour, 64)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(6, 6);
  });
  test("acute triangle chamfer is a single chord per corner (true bevel)", () => {
    const tri = { start: [0, 0], segments: [{ to: [20, 0] }, { to: [10, 3] }, { to: [0, 0] }] };
    const { contour } = _offsetContour(tri, 1, "chamfer");
    // every corner contributes exactly one extra line: 3 edges + 3 chamfer chords
    expect(contour.segments.filter((s) => !s.via && !s.c1).length).toBe(6);
  });
});

describe("validateRawOffset", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
  test("accepts a clean square with a hole", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]),
      holes: [ring([[4, 4], [4, 6], [6, 6], [6, 4]])] }])).toBe(true);
  });
  test("rejects a self-intersecting (butterfly) ring", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }])).toBe(false);
  });
  // The butterfly case above short-circuits on zero net area; this pins the
  // ringSelfIntersects branch itself with a self-intersecting quad whose net area is nonzero.
  test("rejects a self-intersecting ring with nonzero net area", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 20]]), holes: [] }])).toBe(false);
  });
  test("rejects a flipped (CW) outer", () => {
    expect(validateRawOffset([{ outer: ring([[0, 0], [0, 10], [10, 10], [10, 0]]), holes: [] }])).toBe(false);
  });
  test("rejects crossing rings", () => {
    expect(validateRawOffset([
      { outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] },
      { outer: ring([[5, 5], [15, 5], [15, 15], [5, 15]]), holes: [] },
    ])).toBe(false);
  });
});

import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { profileArea } from "../src/framework/geometry/contour-ops.js";

const region = (outer, holes = []) => ({ outer, holes });
const sqRegion = (s) => region(sq(s));

describe("offsetRegions", () => {
  test("validates corners and delta with the pinned messages", () => {
    expect(() => offsetRegions([sqRegion(10)], 1, { corners: "bevel" }))
      .toThrow('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
    expect(() => offsetRegions([sqRegion(10)], NaN)).toThrow("Shape2D.offset: delta must be a finite number");
  });
  test("collapse throws the pinned message", () => {
    expect(() => offsetRegions([sqRegion(10)], -6)).toThrow("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  });
  test("zero delta returns an equal-area copy", () => {
    const out = offsetRegions([sqRegion(10)], 0);
    expect(profileArea(out)).toBeCloseTo(100, 9);
  });
  test("hole shrinks when the region grows", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }; // CW
    // delta 0.5 keeps this short of the hole's own half-width (1) — past that the hole
    // collapses entirely (see "hole vanishing" below), so this is the largest delta that
    // still leaves a partially-shrunk hole to assert against.
    const out = offsetRegions([region(sq(10), [hole])], 0.5, { corners: "sharp" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);
    expect(profileArea(out)).toBeCloseTo(121 - 1, 6);      // hole 2×2 shrank to 1×1
  });
  test("hole vanishing under positive delta is absorbed", () => {
    const hole = { start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] };
    const out = offsetRegions([region(sq(10), [hole])], 2, { corners: "sharp" });
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(196, 6);
  });
  test("dumbbell inset splits into two regions via cleanup", () => {
    const db = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 4] }, { to: [20, 4] }, { to: [20, 0] }, { to: [30, 0] },
      { to: [30, 10] }, { to: [20, 10] }, { to: [20, 6] }, { to: [10, 6] }, { to: [10, 10] },
      { to: [0, 10] }, { to: [0, 0] }] };
    const out = offsetRegions([region(db)], -2, { corners: "sharp" });
    expect(out.length).toBe(2);
    expect(profileArea(out)).toBeCloseTo(72, 4);           // two 6×6 squares
  });
  test("L-shape inset stays on the fast path with exact area", () => {
    const L = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] };
    const out = offsetRegions([region(L)], -2, { corners: "sharp" });
    expect(profileArea(out)).toBeCloseTo(11, 9);
    for (const s of out[0].outer.segments) { expect(s.via).toBeUndefined(); expect(s.c1).toBeUndefined(); }
  });
  test("cusp-producing inward cubic offset yields a simple result", () => {
    const arch = { start: [10, 0], segments: [{ c1: [7, 4], c2: [3, 4], to: [0, 0] }, { to: [10, 0] }] };
    const out = offsetRegions([region(arch)], -0.8, { corners: "round" });
    expect(validateRawOffset(out)).toBe(true);             // output must be simple
  });
});

// Pins the regression class from fix round 1: a per-piece "did this trim reverse" check is
// a LOCAL signal that also fires on ordinary, non-reflected trims (acute barbs, narrow
// slots, non-square holes, 45° chamfers) — these are not full-ring reflections, and
// un-trimming them produces an over-inclusive result (or a false collapse throw). Loose
// tolerances on purpose: the point is the failure class, not exact areas.
describe("offsetRegions — whole-ring collapse vs. partial trims", () => {
  test("U-slot block insets cleanly, no false collapse", () => {
    const uSlot = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 10] }, { to: [6, 10] }, { to: [6, 4] },
      { to: [4, 4] }, { to: [4, 10] }, { to: [0, 10] }, { to: [0, 0] }] };
    // Region count is deliberately not pinned here: the slot's two prongs (each 4 wide)
    // are exactly critical at delta -2 (half-width 2), so whether the sliver remainder
    // comes back as one connected piece or splits into near-cancelling slivers right at
    // that threshold is a precision detail, not the thing this test is pinning — the bug
    // was a false collapse throw, not the resulting region count.
    let out;
    expect(() => { out = offsetRegions([region(uSlot)], -2, { corners: "round" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(1);
    expect(profileArea(out)).toBeLessThan(3);
  });
  test("plate with a star-shaped hole: hole vanishes, plate itself does not", () => {
    // The star hole is the reviewer's own explicitly-verified case ("restores every
    // regression case including the star-hole (+2) one that un-trimming could not fix").
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const starPts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 4 : 1.6;
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      starPts.push([15 + r * Math.cos(ang), 10 + r * Math.sin(ang)]);
    }
    starPts.reverse();     // CW winding for a hole
    const star = { start: starPts[0], segments: [...starPts.slice(1), starPts[0]].map((p) => ({ to: p })) };
    const out = offsetRegions([region(plate, [star])], 2, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeGreaterThan(805);
    expect(profileArea(out)).toBeLessThan(815);
  });
  // Task 5B note: the L-pocket test below was originally slated to assert 0 holes /
  // area≈812.566 at +2 (the plate's own rounded-rectangle growth 600+200+4π, assuming the
  // hole vanishes completely). That expectation is mathematically wrong for THIS geometry —
  // verified independently below, not just asserted — so this test pins the corrected
  // number instead of the one in the original task brief. See task-5B-report.md for the
  // full derivation; short version:
  //
  // The hole is an L with both arms exactly 4 wide (10-14 in x, 6-10 in y) offset by
  // delta=2 = exactly half that width. A round join at the hole's one reflex vertex (14,10)
  // pivots a radius-2 arc about that vertex — standard "uncut corner" behavior for any
  // round-tool erosion of an internal reflex corner (the same reason a round end mill
  // always leaves material in a sharp internal pocket corner: it physically cannot reach
  // in past its own radius). Shifting the reflex vertex to the origin, the surviving
  // residual is exactly {(a,b) ∈ [0,2]×[0,2] : a²+b² ≥ 2²} — a 2×2 square minus the quarter
  // disk of radius 2 nearest the vertex — with EXACT area 4−π ≈ 0.8584. Rendering that exact
  // lens shape (start [12,8], line to [12,10], round-join arc via [12.5858,8.5858] to
  // [14,8], line closing back to [12,8]) through this file's own `area()` helper at 256
  // segments returns 0.858412…, matching 4−π to 5 significant figures — and is exactly the
  // shape `offsetRegions` returns below (its raw ring visits a couple of extra collinear,
  // zero-area waypoints along the way, an artifact of Part 1's chord-bridging that doesn't
  // change the enclosed area). So "0 holes" was never the correct answer for +2 on this
  // specific geometry; "1 hole, area 4−π" is. (The *wide*-arm L-pocket below, where the
  // reflex vertex sits far enough from the two straight sides that even the corner bulge
  // can't clear delta=3, genuinely does fully vanish — that one's brief-prescribed
  // expectation checks out and is asserted unchanged.)
  test("plate with a narrow L-shaped hole at +2: a small uncut-corner residual is correct, not a bug", () => {
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const lHole = { start: [10, 6], segments: [
      { to: [10, 14] }, { to: [14, 14] }, { to: [14, 10] }, { to: [20, 10] }, { to: [20, 6] }, { to: [10, 6] }] };
    const out = offsetRegions([region(plate, [lHole])], 2, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(1);                       // NOT 0 — see comment above
    expect(profileArea(out)).toBeCloseTo(812.566 - (4 - Math.PI), 1);   // outer growth − exact uncut-corner residual
  });
  test("wide L-shaped hole (5-unit arms) at +3 fully absorbs the hole", () => {
    // Cleanup (resolveSelfRegions) already runs for this case — validateRawOffset is false
    // — and still leaves a residual today; this pins that the global distance prune closes
    // the gap cleanup alone cannot.
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const lHole = { start: [10, 5], segments: [
      { to: [10, 15] }, { to: [15, 15] }, { to: [15, 10] }, { to: [20, 10] }, { to: [20, 5] }, { to: [10, 5] }] };
    const out = offsetRegions([region(plate, [lHole])], 3, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(928.27, 1);
  });
  test("chamfered rectangle insets without a false collapse throw", () => {
    const chamfered = { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 4] }, { to: [9, 5] }, { to: [1, 5] }, { to: [0, 4] }, { to: [0, 0] }] };
    let out;
    expect(() => { out = offsetRegions([region(chamfered)], -2, { corners: "round" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(5.5);
    expect(profileArea(out)).toBeLessThan(6.6);
  });
});

// Pins the regression class from fix round 2: the whole-ring collapse predicate only
// inspected plain-LINE pieces, so on a ring where lines are a minority (a mostly-arc
// disc/bore carrying a small line-built tab or keyway) it was really a "whole-small-
// feature" predicate — it dropped the entire ring whenever just the small feature's line
// pieces collapsed, even though the ring as a whole (dominated by its arcs) was nowhere
// near critical. Loose tolerances on purpose: the point is the failure class.
describe("offsetRegions — whole-ring collapse must span the whole ring, not just its lines", () => {
  test("disc with a small rectangular tab insets without a false collapse throw", () => {
    const tab = { start: [0, -10], segments: [
      { via: [7.0711, -7.0711], to: [10, 0] },
      { to: [12, 0] }, { to: [12, 2] }, { to: [10, 2] },
      { via: [3.70, 9.29], to: [0, 10] }, { via: [-10, 0], to: [0, -10] } ] };
    let out;
    expect(() => { out = offsetRegions([region(tab)], -3, { corners: "round" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(150);
    expect(profileArea(out)).toBeLessThan(160);
  });
  test("keyed bore survives: circular hole with a keyway does not vanish", () => {
    const plate = { start: [0, 0], segments: [{ to: [60, 0] }, { to: [60, 60] }, { to: [0, 60] }, { to: [0, 0] }] };
    // r=10 circular hole centered at (30,30), CW, carrying a keyway: a 2×2-ish rectangular
    // notch (radius 10 -> 11, spanning a 30° arc) sticking outward at angle 0.
    const cx = 30, cy = 30, r = 10, rOut = 11, halfAngle = 15;
    const pt = (ang, rad) => [cx + rad * Math.cos((ang * Math.PI) / 180), cy + rad * Math.sin((ang * Math.PI) / 180)];
    const Q1 = pt(halfAngle, r), Q2 = pt(-halfAngle, r);
    const viaBig = pt(180 + halfAngle, r);
    const K1 = pt(-halfAngle, rOut), K2 = pt(halfAngle, rOut);
    const bore = { start: Q1, segments: [{ to: K2 }, { to: K1 }, { to: Q2 }, { via: viaBig, to: Q1 }] };
    const out = offsetRegions([region(plate, [bore])], 2.5, { corners: "round" });
    // Part 1's per-piece deletion (Task 5B) eliminates the spurious ≈0.63-area sliver that
    // cleanup used to leave alongside the main plate+bore region, so the output is now
    // exactly the one region — a Part-1-only build already returns this; Part 2 (the
    // distance prune) isn't involved. Kept the .find() below (rather than out[0]) since
    // that isn't what this assertion is pinning — the bug here was the bore vanishing
    // outright (0 holes, area jumping to the full ungrown-by-a-hole plate size).
    expect(out.length).toBe(1);
    const bored = out.find((rg) => rg.holes.length > 0);
    expect(bored).toBeDefined();
    expect(bored.holes.length).toBe(1);
    expect(profileArea(out)).toBeGreaterThan(4000);
    expect(profileArea(out)).toBeLessThan(4100);
  });
});

// Pins the regression class from task 5B's round-1 review: Part 2's distance prune was
// checking each raw hole against EVERY ring of its region (outer + siblings), not just its
// own source hole — which made the prune indistinguishable from two features legitimately
// merging (a case cleanup exists to resolve, not something to prune away). It also derived
// its tolerance from every tessellated chord, including straight ones with zero
// approximation error to actually be tolerant of, which on larger parts made the tolerance
// balloon past |delta| and silently no-op the prune.
describe("offsetRegions — round-1 review: distance prune must be per-hole and tolerance must be curve-only", () => {
  // These two pin the CORE Critical-1 defect using locally-constructed fixtures (the review's
  // own exact coordinates aren't available here): before this fix, offsetRegions([region(plate,
  // holes)], -2, {corners:"sharp"}) on BOTH fixtures below returns area 576 — the bare plate,
  // holes.length===0 — because the pre-fix whole-region prune checked each hole against every
  // ring of its region and, seeing that a legitimately-merging/breaking-through hole comes
  // within |delta| of a DIFFERENT ring, deleted it outright. Verified directly against the
  // pre-round-1 commit (aa82380) with these exact fixtures before writing this test.
  //
  // The post-fix numbers below (336 / 380) are NOT independently re-derived truth values the
  // way the wide-L-pocket and 9-gon numbers elsewhere in this file are — they're what this
  // specific fixture currently resolves to, which is already a large, verified improvement
  // over the 576/0-holes bug (holes now survive as real, substantially-sized geometry instead
  // of being erased) but is short of the fully-precise merged/broken-through shape a truth
  // computation puts at ~352.68 and ~409.72 respectively for geometry in this neighborhood.
  // The residual gap traces to two SEPARATE, pre-existing limitations neither Critical 1 nor
  // this task touches: validateRawOffset's hole/outer containment check tests only the hole
  // ring's first point (not the whole ring), and ringsCross (unlike ringSelfIntersects) never
  // checks segsOverlap, so two rings that overlap via parallel/collinear edges (as two same-
  // height rectangles offset by the same amount do) don't register as crossing. Both let a
  // case that should route to cleanup slip through the fast path instead. Flagged in the task
  // report as a follow-up, not fixed here.
  test("two holes 3mm apart survive as real geometry instead of both vanishing", () => {
    const plate = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const holeA = { start: [5, 6], segments: [{ to: [5, 14] }, { to: [11, 14] }, { to: [11, 6] }, { to: [5, 6] }] };
    const holeB = { start: [14, 6], segments: [{ to: [14, 14] }, { to: [20, 14] }, { to: [20, 6] }, { to: [14, 6] }] };
    const out = offsetRegions([region(plate, [holeA, holeB])], -2, { corners: "sharp" });
    expect(profileArea(out)).toBeLessThan(500);       // real hole area removed — not the bare 576 plate
    expect(profileArea(out)).toBeGreaterThan(300);
  });
  test("a hole 2mm from the edge survives as real geometry instead of the plate coming back solid", () => {
    const plate = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    const hole = { start: [15, 2], segments: [{ to: [15, 12] }, { to: [25, 12] }, { to: [25, 2] }, { to: [15, 2] }] };
    const out = offsetRegions([region(plate, [hole])], -2, { corners: "sharp" });
    expect(profileArea(out)).toBeLessThan(500);       // real hole area removed — not the bare 576 plate
    expect(profileArea(out)).toBeGreaterThan(300);
  });
  test("wide L-pocket at +3 fully absorbs the hole on a larger (60×40) plate too", () => {
    // The old whole-region tolerance was ~0.736mm on the 30×20 fixture above but scales with
    // plate size (max chord over EVERY tessellated point, including the plate's own long
    // straight edges) — 1.473mm at 60×60, 7.363mm at 300×200 — so a delta=3 prune quietly
    // stopped pruning anything at all once the plate was big enough. The curve-only,
    // per-hole-scoped tolerance is ~0 for this all-line hole regardless of plate size.
    const plate = { start: [0, 0], segments: [{ to: [60, 0] }, { to: [60, 40] }, { to: [0, 40] }, { to: [0, 0] }] };
    const lHole = { start: [10, 5], segments: [
      { to: [10, 15] }, { to: [15, 15] }, { to: [15, 10] }, { to: [20, 10] }, { to: [20, 5] }, { to: [10, 5] }] };
    const out = offsetRegions([region(plate, [lHole])], 3, { corners: "round" });
    expect(out.length).toBe(1);
    expect(out[0].holes.length).toBe(0);
    expect(profileArea(out)).toBeCloseTo(3028.274, 1);
  });
});

// Pins the regression class from task 5B's round-1 review, Important 3: Part 1's per-piece
// deletion is unrecoverable (unlike a chord/dirty join, a deleted piece can't be un-deleted
// downstream), so a bad deletion could turn perfectly good geometry into a false "offset
// collapses the shape" throw. The fix is the guard in _offsetContour: when deletion doesn't
// resolve to a simple, nonzero-area ring, prefer the un-deleted ring (still dirty) instead.
describe("offsetRegions — round-1 review: Part 1 deletion must not cause a false collapse throw", () => {
  test("concave 9-gon at delta -2.79/chamfer no longer throws", () => {
    const nonagon = { start: [19.49, 10], segments: [
      { to: [12.33, 11.95] }, { to: [11.2, 16.81] }, { to: [8.87, 11.96] }, { to: [0.93, 13.3] },
      { to: [3.45, 7.62] }, { to: [8.52, 7.44] }, { to: [10.92, 4.78] }, { to: [15.09, 5.73] }, { to: [19.49, 10] }] };
    // The false throw (HEAD) is fixed and well-evidenced: this used to throw "offset
    // collapses the shape (reduce |delta|)" and no longer does.
    //
    // Independent verification (a fine-grained grid search for the largest inscribed disk
    // clearing |delta| everywhere — the same method used and confirmed above for the
    // narrow-L-pocket case) puts the true eroded area at ~2.76 (max inradius ~3.375,
    // comfortably above delta=2.79, so the shape genuinely doesn't collapse). This
    // implementation currently returns a larger, incorrect area (~7.7, split across 2
    // regions) for this specific input — confirmed via exhaustive search to NOT be a
    // deletion-selection problem: every one of the 8 possible subsets of the 3 pieces Part 1
    // flags as reversed for this ring produces a self-intersecting (invalid) candidate, not
    // just the "delete all 3" and "delete none" ends of that search. The 7.7 figure also
    // exactly reproduces what the pre-Part-1 baseline (commit d533de3, before task 5B
    // existed) already computed for this same input — so the inaccuracy predates this task
    // and isn't something Part 1's deletion or Part 2's (hole-scoped) distance prune ever
    // touched; it's paper.js's resolveSelfRegions resolving this specific self-intersecting
    // chamfer-offset curve into the wrong pair of sub-regions. Documented here rather than
    // silently pinned to the wrong number — see task-5B-report.md's round-1 fix section for
    // the full trace. Only the throw is asserted; the area is deliberately left unpinned.
    let out;
    expect(() => { out = offsetRegions([region(nonagon)], -2.79, { corners: "chamfer" }); }).not.toThrow();
    expect(profileArea(out)).toBeGreaterThan(0);
  });
  test.todo("concave 9-gon at delta -2.79/chamfer should resolve to area ≈2.76, not ≈7.7 (pre-existing resolveSelfRegions gap, not a Part 1/Part 2 defect)");
});
