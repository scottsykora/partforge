// Oracle: the deleted OCCT/BRepOffsetAPI offset route, reconstructed test-locally
// (Drawing per region via replicad's draw API, offset, SVG-path readback) against
// the raw replicad/OCCT WASM kernel. This is the safety net for the native
// contour-offset engine: it exists to FIND divergence from BRepOffsetAPI, not to
// be green.
//
// Manifold must NOT boot in the same process as OCCT — this file boots only
// replicad/OCCT, and the Manifold oracle lives in its own file (vitest isolates
// per file) so that invariant holds automatically.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { beforeAll, expect, test } from "vitest";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea, svgPathToRings } from "../src/framework/geometry/shape2d-regions.js";

const SEGS = 64;
const rings = (regions) => regions.flatMap((rg) =>
  [tessellateContour(rg.outer, SEGS), ...rg.holes.map((h) => tessellateContour(h, SEGS))]);
const totalArea = (rs) => rs.reduce((a, r) => a + ringArea(r), 0);
// one-directional sampled boundary distance: max over a's points of min distance to b's segments
function boundaryDist(a, b) {
  const segDist = (p, q1, q2) => {
    const dx = q2[0] - q1[0], dy = q2[1] - q1[1];
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
    return Math.hypot(p[0] - (q1[0] + t * dx), p[1] - (q1[1] + t * dy));
  };
  let worst = 0;
  for (const ring of a) for (const p of ring) {
    let best = Infinity;
    for (const r2 of b) for (let i = 0; i < r2.length; i++)
      best = Math.min(best, segDist(p, r2[i], r2[(i + 1) % r2.length]));
    worst = Math.max(worst, best);
  }
  return worst;
}
const hausdorff = (a, b) => Math.max(boundaryDist(a, b), boundaryDist(b, a));

// Corpus: name, regions (contour IR), deltas to test. Polygonal + curved cases.
// (Identical to offset-oracle-manifold.test.js's corpus — duplicated per Task 8's
// brief, since the two oracle files must not share a module that boots anything.)
const sq = (s) => ({ outer: { start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] }, holes: [] });
const circ = (r) => ({ outer: { start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] }, holes: [] });
const Lsh = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] }, holes: [] };
const CORPUS = [
  { name: "square", regions: [sq(10)], deltas: [1, -1, 2.5], curved: false },
  { name: "circle", regions: [circ(5)], deltas: [1, -2], curved: true },
  { name: "L-shape", regions: [Lsh], deltas: [1, -1.5], curved: false },
  { name: "square+hole", regions: [{ ...sq(10), holes: [{ start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }] }], deltas: [0.5, -0.5], curved: false },
];
const AREA_RTOL = 0.005;                       // 0.5 %
const HAUS_TOL = (curved) => (curved ? 2e-2 : 5e-3);  // curved: absorb the oracle's own faceting

let replicad;
beforeAll(async () => {
  // Boot preamble copied from src/testing/occt.js (createRequire / wasmBinary / setOC).
  const require = createRequire(import.meta.url);
  globalThis.require = globalThis.require ?? require;
  globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
  replicad = await import("replicad");
  replicad.setOC(OC);
}, 60_000);

// contour IR ring -> replicad Drawing (lines + threePointsArcTo for via arcs — the same
// mapping occt-backend's (now-deleted) contourDrawing used: `s.c1 ? cubicBezierCurveTo(...)
// : s.via ? threePointsArcTo(...) : lineTo(...)`; cubics via cubicBezierCurveTo).
function contourToDrawing(c) {
  let d = replicad.draw(c.start);
  for (const s of c.segments)
    d = s.c1 ? d.cubicBezierCurveTo(s.to, s.c1, s.c2)
        : s.via ? d.threePointsArcTo(s.to, s.via)
        : d.lineTo(s.to);
  return d.close();
}

// IMPORTANT deviation from the brief's suggested helper (confirmed empirically, see
// task-8-report.md): a single `drawingOf(regions).offset(delta, {...})` call does NOT
// implement Shape2D.offset's documented material-wise semantics for a region WITH
// holes ("outer +delta, holes -delta" — docs/AUTHORING-PARTS.md's offsetPolygon entry,
// and the same convention contour-offset.js's native engine implements via the
// outer-CCW/holes-CW storage invariant). replicad's own `offset()` (dist.js's
// `offsetBlueprint`) auto-corrects each individual closed contour's sign so a bare
// `.offset(+delta)` ALWAYS GROWS that contour outward regardless of the winding it
// was drawn with — verified directly: drawCircle(2).offset(1) and a hand-drawn CW
// square both grow, never shrink, under a bare positive delta. A CompoundBlueprint's
// offset (`cut2D(offset(outer,...), fuseAll(holes.map(offset...)))`) offsets EVERY
// sub-blueprint — including holes — through that same always-grows rule with the SAME
// signed delta, so a fused region-with-hole Drawing's holes GROW under +delta instead
// of shrinking (confirmed: a 2x2 hole in a 10x10 square grew to 3x3 under delta=+0.5
// via the naive single-call reconstruction — backwards from the documented and native
// behavior). That is a real quirk of replicad's Drawing API, not a native-engine bug:
// asserting the naive reconstruction against native would report a false divergence on
// every holed case. The correct oracle offsets the outer and each hole as INDEPENDENT
// standalone contours (each with its own always-grows-with-positive-delta offset, so
// the hole gets -delta to shrink it) and then cuts — mirroring exactly how this
// codebase's own offsetPolygon (polygon.js) already handles holes on plain point lists
// (`holes.map((h) => offsetPolygon(h, -delta, opts))`).
function offsetRegionOracle(rg, delta, lineJoinType) {
  const outerOff = contourToDrawing(rg.outer).offset(delta, { lineJoinType });
  if (!outerOff || !outerOff.innerShape)
    throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  let result = outerOff;
  for (const h of rg.holes) {
    const holeOff = contourToDrawing(h).offset(-delta, { lineJoinType });
    if (holeOff && holeOff.innerShape) result = result.cut(holeOff);
    // else: the hole itself collapsed under erosion (shrunk to nothing) — no hole
    // survives to cut, matching what an eroded-to-nothing hole should do. Not
    // exercised by this file's corpus (deltas are small relative to hole size).
  }
  return result;
}
const oracleRings = (regions, delta, lineJoinType) => {
  const fused = regions.reduce((acc, rg) => {
    const r = offsetRegionOracle(rg, delta, lineJoinType);
    return acc ? acc.fuse(r) : r;
  }, null);
  return fused.toSVGPaths().flat(Infinity).flatMap((d) => svgPathToRings(d, SEGS))
    .map((ring) => ring.map(([x, y]) => [x, -y]));   // toSVGPathD is y-down
};

// chamfer -> "bevel": unlike Clipper2 (Manifold oracle), replicad's "bevel" join is
// EXACTLY the semantic native chamfer implements — a true straight-chord bevel at
// every corner, not a 2-chord approximation. The deleted production route
// (occt-backend.js's offsetDrawing, see git history) mapped corners->lineJoinType
// the same way: `{ round: "round", chamfer: "bevel", sharp: "miter" }`. So unlike
// the Manifold file, there's no semantic gap to exclude here — chamfer is included.
const JOIN = { round: "round", sharp: "miter", chamfer: "bevel" };
for (const { name, regions, deltas, curved } of CORPUS) {
  for (const delta of deltas) for (const corners of ["round", "sharp", "chamfer"]) {
    test(`${name} delta=${delta} ${corners} matches BRepOffsetAPI within tolerance`, () => {
      const native = rings(offsetRegions(regions, delta, { corners }));
      const oracle = oracleRings(regions, delta, JOIN[corners]);
      // Only the oracle side needs abs() around totalArea: the y-flip in oracleRings
      // (toSVGPathD is y-down) inverts its global winding sign, but native's sign is
      // already correct (outer CCW positive, holes CW negative) — leaving it un-abs'd
      // means a hypothetical native winding inversion would still be caught here.
      expect(Math.abs(totalArea(native) - Math.abs(totalArea(oracle))) / Math.abs(totalArea(oracle))).toBeLessThan(AREA_RTOL);
      expect(hausdorff(native, oracle)).toBeLessThan(HAUS_TOL(curved));
    });
  }
}
