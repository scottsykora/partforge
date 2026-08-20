// @vitest-environment happy-dom
// The view cube's renderer. happy-dom has no real 2d context, so the context is
// injected and the assertions are on the DRAW ORDER and the fills chosen — the
// two things that decide whether a ghost cube with arrows in front of it reads
// correctly (the ink-canvas.js / dim3-scene paintLabel precedent).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCubeCanvas, faceLabelBasis, CUBE_PALETTE, CUBE_RENDER } from "../../../src/framework/viewcube/cube-canvas.js";
import { projectCube } from "../../../src/framework/viewcube/cube-geom.js";

function fakeContext() {
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 0, height: 0 },
    setTransform: (...a) => calls.push(["setTransform", ...a]),
    clearRect: (...a) => calls.push(["clearRect", ...a]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (...a) => calls.push(["moveTo", ...a]),
    lineTo: (...a) => calls.push(["lineTo", ...a]),
    closePath: () => calls.push(["closePath"]),
    fill: () => calls.push(["fill", ctx.fillStyle]),
    // lineWidth captured at call time too, so a test can assert which stroke
    // width was in force for a given stroke — needed to prove CUBE_RENDER's
    // width knobs (not just its presence) are actually read by draw().
    stroke: () => calls.push(["stroke", ctx.strokeStyle, ctx.lineWidth]),
    fillText: (...a) => calls.push(["fillText", a[0], ctx.fillStyle, a[1], a[2]]),
    // The face-label transform composes onto the DPR scale via save()
    // /transform()/restore() rather than replacing it with setTransform(),
    // so those three need recording too (they didn't exist before the
    // on-face-label reshape).
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    transform: (...a) => calls.push(["transform", ...a]),
    // The hover pass clips to a cell and clears it so the tint composites over
    // the same (empty) backdrop on every side of a region.
    clip: () => calls.push(["clip"]),
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    set strokeStyle(v) { this._stroke = v; },
    get strokeStyle() { return this._stroke; },
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
  return ctx;
}

// One back face, one front face (the hoverable one) plus a camera-facing
// centre cell ("front", isCentre) so face-label behaviour is exercised too, a
// back and a front (subtle, untagged) edge, and all three axis arrows — one
// of them (Y) parked behind the cube (negative depth) so the depth-routing
// behaviour is exercised alongside the normal front-of-everything case. Each
// arrow is now just `{ axis, from, tip, depth }` — the head and label are
// screen-space constructs the renderer builds itself (see cube-canvas.js).
//
// The centre cells' corners are wound the way a REAL projection winds them —
// p0 -> p1 along the face's u axis, p0 -> p3 along its v axis, which for these
// two faces is model +Z and so points UP the screen (negative y) for any
// upright camera. Since the 2026-08-20 label fix the winding is load-bearing:
// the label's up comes from the declared model-space up projected along that v
// edge, so a physically impossible winding describes an upside-down camera and
// would (correctly) get an upside-down label.
function makeProjection() {
  return {
    back: [{ id: "back", points: [[0, 10], [10, 10], [10, 0], [0, 0]], depth: -1, face: "back", isCentre: true }],
    front: [
      { id: "front", points: [[2, 8], [8, 8], [8, 2], [2, 2]], depth: 1, face: "front", isCentre: true },
      { id: "top-front", points: [[2, 0], [8, 0], [8, 2], [2, 2]], depth: 1.1, face: "front", isCentre: false },
    ],
    backEdges: [{ points: [[0, 0], [0, 10]], axis: null, depth: -0.5 }],
    frontEdges: [{ points: [[2, 2], [8, 2]], axis: null, depth: 0.9 }],
    arrows: [
      { axis: "X", from: [5, 5], tip: [10, 5], depth: 0.5 },
      { axis: "Y", from: [5, 5], tip: [5, 10], depth: -0.4 },
      { axis: "Z", from: [5, 5], tip: [5, 0], depth: 0.6 },
    ],
  };
}

let host, handle, ctx, projection;
beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  ctx = fakeContext();
  handle = createCubeCanvas(host, { getContext2d: () => ctx });
  projection = makeProjection();
});
afterEach(() => handle?.dispose());

const order = () => ctx.calls.map((c) => c[0]);
const fills = () => ctx.calls.filter((c) => c[0] === "fill").map((c) => c[1]);
const strokes = () => ctx.calls.filter((c) => c[0] === "stroke");
const texts = () => ctx.calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
// Every fill paired with the polygon it painted, identified by the moveTo that
// opened its path — the only way to tell WHICH cell a fill covered once a
// single cell can take more than one fill (the hover base coat + tint).
const filledPolygons = () => ctx.calls.flatMap((c, i) => {
  if (c[0] !== "fill") return [];
  for (let j = i - 1; j >= 0; j--) {
    if (ctx.calls[j][0] === "moveTo") return [{ index: i, colour: c[1], p0: [ctx.calls[j][1], ctx.calls[j][2]] }];
  }
  return [];
});

describe("createCubeCanvas", () => {
  it("appends a canvas to the host", () => {
    expect(host.querySelector("canvas")).toBe(handle.element);
    expect(handle.element.className).toContain("pf-viewcube-canvas");
  });

  it("clears before drawing anything", () => {
    handle.draw(projection, {});
    expect(order()[0]).toBe("setTransform");
    expect(order()[1]).toBe("clearRect");
  });

  it("sizes the backing store by DPR while the CSS box stays in CSS px", () => {
    // Sizing the backing store in CSS px while scaling the context by DPR
    // renders everything at 2x on a retina display and clips the cube to its
    // top-left quarter — silent on a 1x test machine, obvious on a laptop.
    const original = globalThis.devicePixelRatio;
    globalThis.devicePixelRatio = 2;
    try {
      handle.draw(projection, {});
      expect(handle.element.width).toBe(handle.size * 2);
      expect(handle.element.height).toBe(handle.size * 2);
      expect(handle.element.style.width).toBe(`${handle.size}px`);
      // The context is scaled by the same factor, so draw code stays in CSS px.
      expect(ctx.calls[0]).toEqual(["setTransform", 2, 0, 0, 2, 0, 0]);
    } finally {
      globalThis.devicePixelRatio = original;
    }
  });

  it("never strokes a face polygon — cells are filled only, the grid is gone", () => {
    // Every face fill closes its path via polygon()'s closePath(); a stroke
    // is only ever legitimate on the separate (2-point, unclosed) edge and
    // arrow-shaft paths. So the call right after any closePath is a fill —
    // or, for a hovered cell, the clip that scopes its clear (see the hover
    // pass) — but never a stroke, for any cell, hovered or not, back or front.
    handle.draw(projection, { hover: "top-front" });
    const closeIdx = ctx.calls.map((c, i) => (c[0] === "closePath" ? i : -1)).filter((i) => i >= 0);
    expect(closeIdx.length).toBeGreaterThan(0);
    for (const i of closeIdx) expect(["fill", "clip"]).toContain(ctx.calls[i + 1][0]);
  });

  it("strokes the subtle cube edges (untagged only) with a colour clearly quieter than the old cell outline", () => {
    handle.draw(projection, {});
    const edgeStrokes = strokes().filter((c) => c[1] === CUBE_PALETTE.dark.edge);
    expect(edgeStrokes.length).toBe(2); // the one back edge + the one front edge in the fixture
    // The old cell-outline alpha was 0.45; the reshape's cube-edge colour
    // must be visibly lower so the ungridded cube still reads as quiet.
    const alpha = Number(CUBE_PALETTE.dark.edge.match(/[\d.]+\)$/)[0].slice(0, -1));
    expect(alpha).toBeLessThan(0.45);
  });

  it("never strokes an edge cube-geom.js marked hidden", () => {
    const hiddenProjection = {
      ...projection,
      frontEdges: [...projection.frontEdges, { points: [[9, 9], [9, 1]], axis: null, depth: 0.9, hidden: true }],
    };
    handle.draw(hiddenProjection, {});
    // Only the one non-hidden front edge (from the base fixture) and the one
    // back edge should have been stroked in the quiet edge colour — the
    // hidden edge added above must not add a third.
    const edgeStrokes = strokes().filter((c) => c[1] === CUBE_PALETTE.dark.edge);
    expect(edgeStrokes.length).toBe(2);
  });

  it("draws all three axis arrows at their real depth even when a real projection marks their edges hidden", () => {
    // A quaternion where the axis-origin corner has rotated to the cube's far
    // side: cube-geom.js then marks all 3 axis-tagged edges hidden (their
    // faces have rotated away from the camera), but the arrows themselves are
    // a separate structure the renderer always draws, reading dimly through
    // the translucent faces per the host's explicit choice.
    const q = [0.79, -0.4, 0.14, -0.44];
    const real = projectCube(q, { size: 100 });
    const allEdges = [...real.frontEdges, ...real.backEdges];
    expect(allEdges.filter((e) => e.axis && e.hidden)).toHaveLength(3);
    handle.draw(real, {});
    const p = CUBE_PALETTE.dark;
    expect(fills().some((c) => c === p.axisX) || strokes().some((c) => c[1] === p.axisX)).toBe(true);
    expect(fills().some((c) => c === p.axisY) || strokes().some((c) => c[1] === p.axisY)).toBe(true);
    expect(fills().some((c) => c === p.axisZ) || strokes().some((c) => c[1] === p.axisZ)).toBe(true);
    expect(texts()).toEqual(expect.arrayContaining(["X", "Y", "Z"]));
  });

  it("draws in the reshaped order: back faces, back edges, hovered cell, front faces, front edges, arrows, face labels, axis labels", () => {
    handle.draw(projection, { hover: "top-front" });
    const backFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.backFill);
    const backEdge = ctx.calls.findIndex((c) => c[0] === "stroke" && c[1] === CUBE_PALETTE.dark.edge);
    const hoverFill = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.hoverFill);
    // The FIRST frontFill now belongs to the hovered cell's own base coat (see
    // the hover pass), so the ordinary front-face pass is the first one AFTER
    // the highlight.
    const frontFace = ctx.calls.findIndex((c, i) => i > hoverFill && c[0] === "fill" && c[1] === CUBE_PALETTE.dark.frontFill);
    // The last (front-edge) stroke of the subtle colour, distinct from the first (back-edge) one.
    const lastEdge = ctx.calls.map((c, i) => (c[0] === "stroke" && c[1] === CUBE_PALETTE.dark.edge ? i : -1)).filter((i) => i >= 0).pop();
    const arrowHead = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.axisZ);
    const axisLabel = ctx.calls.findIndex((c) => c[0] === "fillText" && c[1] === "X");
    expect(backFace).toBeGreaterThan(-1);
    expect(backFace).toBeLessThan(backEdge);
    expect(backEdge).toBeLessThan(hoverFill);
    expect(hoverFill).toBeLessThan(frontFace);
    expect(frontFace).toBeLessThan(lastEdge);
    expect(lastEdge).toBeLessThan(arrowHead);
    expect(arrowHead).toBeLessThan(axisLabel);
    // Hovering suppresses face labels entirely — none should appear at all.
    expect(texts()).not.toContain("FRONT");
    expect(texts()).not.toContain("BACK");
  });

  it("draws an arrow parked behind the cube before the front faces, so it reads dimly through them", () => {
    handle.draw(projection, {});
    const yShaft = ctx.calls.findIndex((c) => c[0] === "stroke" && c[1] === CUBE_PALETTE.dark.axisY);
    const frontFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.frontFill);
    const xShaft = ctx.calls.findIndex((c) => c[0] === "stroke" && c[1] === CUBE_PALETTE.dark.axisX);
    expect(yShaft).toBeGreaterThan(-1);
    expect(yShaft).toBeLessThan(frontFace); // Y (depth -0.4) is behind: drawn early
    expect(xShaft).toBeGreaterThan(frontFace); // X (depth 0.5) is ahead: drawn late
  });

  it("honours CUBE_RENDER.arrowWidth at the arrow-shaft stroke, not a hardcoded width", () => {
    // A test that only checked CUBE_RENDER.arrowWidth === 2 would assert nothing
    // about draw() actually reading it — mutate the tunable and confirm the
    // stroke recorded for the shaft carries the mutated value.
    const original = CUBE_RENDER.arrowWidth;
    CUBE_RENDER.arrowWidth = 7;
    try {
      handle.draw(projection, {});
      const shaft = strokes().find((c) => c[1] === CUBE_PALETTE.dark.axisX);
      expect(shaft[2]).toBe(7);
    } finally {
      CUBE_RENDER.arrowWidth = original;
    }
  });

  it("builds the arrowhead at a fixed screen size regardless of the shaft's (foreshortened) projected length", () => {
    // A head built from the raw tail->tip vector would grow and shrink as the
    // shaft foreshortens with rotation — exactly the glitch this guards
    // against. Two arrows with very different shaft lengths must still
    // produce head TRIANGLES (fill polygons) of the same size: the distance
    // from the shaft's tip to the head's far vertex is always headLengthPx.
    const short = { back: [], front: [], backEdges: [], frontEdges: [], arrows: [{ axis: "X", from: [5, 5], tip: [7, 5], depth: 0.5 }] };
    const long = { back: [], front: [], backEdges: [], frontEdges: [], arrows: [{ axis: "X", from: [5, 5], tip: [50, 5], depth: 0.5 }] };
    const headApex = (calls, tip) => {
      const fillIdx = calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.axisX);
      // polygon() emits beginPath, moveTo(apex), lineTo, lineTo, closePath — 4
      // calls before the fill that follows it.
      const moveTo = calls[fillIdx - 4];
      return Math.hypot(moveTo[1] - tip[0], moveTo[2] - tip[1]);
    };
    handle.draw(short, {});
    const shortReach = headApex(ctx.calls, [7, 5]);
    ctx.calls.length = 0;
    handle.draw(long, {});
    const longReach = headApex(ctx.calls, [50, 5]);
    expect(shortReach).toBeCloseTo(CUBE_RENDER.headLengthPx, 6);
    expect(longReach).toBeCloseTo(CUBE_RENDER.headLengthPx, 6);
  });

  it("skips a degenerate (near-zero-length) arrow's head and label without ever passing NaN to the context", () => {
    // An axis pointing almost exactly at or away from the camera projects to
    // a shaft of ~zero screen length, whose normalised direction is
    // meaningless (and, unguarded, NaN). The other two arrows must still draw
    // normally.
    const proj = {
      back: [], front: [], backEdges: [], frontEdges: [],
      arrows: [
        { axis: "X", from: [5, 5], tip: [10, 5], depth: 0.5 },
        { axis: "Y", from: [5, 5], tip: [5, 5], depth: 0.5 }, // degenerate: zero length
        { axis: "Z", from: [5, 5], tip: [5, 0], depth: 0.5 },
      ],
    };
    handle.draw(proj, {});
    const numbers = ctx.calls.flatMap((c) => c.slice(1)).filter((v) => typeof v === "number");
    expect(numbers.some((n) => Number.isNaN(n))).toBe(false);
    expect(fills()).toContain(CUBE_PALETTE.dark.axisX);
    expect(fills()).toContain(CUBE_PALETTE.dark.axisZ);
    expect(texts()).toContain("X");
    expect(texts()).toContain("Z");
    expect(texts()).not.toContain("Y");
  });

  it("labels the three model axes", () => {
    handle.draw(projection, {});
    expect(texts()).toEqual(expect.arrayContaining(["X", "Y", "Z"]));
  });

  it("labels every camera-facing centre cell with its face name, uppercased", () => {
    handle.draw(projection, {});
    expect(texts()).toContain("FRONT");
    // "back" is in the BACK half (away-facing) in this fixture, so it must
    // not be labelled even though it is a centre cell.
    expect(texts()).not.toContain("BACK");
  });

  it("omits face labels entirely while a region is hovered", () => {
    handle.draw(projection, { hover: "front" });
    expect(texts()).not.toContain("FRONT");
    // Axis labels stay — they sit outside the cube and cover nothing.
    expect(texts()).toEqual(expect.arrayContaining(["X", "Y", "Z"]));
  });

  it("paints the face label through an affine transform built from the face's own in-plane edges", () => {
    // The fixture's "front" cell is the axis-aligned square [2,2]-[8,8] wound
    // p0=(2,8) -> p1=(8,8) -> p3=(2,2): half its edge vectors are (3,0) along
    // u and (0,-3) along v (v runs up the screen, as model +Z does), and its
    // centroid is (5,5). The label's own v is that edge turned to run DOWN the
    // face, so the transform composed onto the DPR scale (via save()
    // /transform(), never setTransform(), so the DPR scale survives) must carry
    // exactly (3, 0, 0, 3, 5, 5).
    handle.draw(projection, {});
    const idx = ctx.calls.findIndex((c) => c[0] === "transform");
    expect(idx).toBeGreaterThan(-1);
    expect(ctx.calls[idx - 1][0]).toBe("save");
    const [, a, b, c, d, e, f] = ctx.calls[idx];
    expect([a, d, e, f]).toEqual([3, 3, 5, 5]);
    expect(b).toBeCloseTo(0, 12); // toBeCloseTo, not toEqual: a signed zero is still zero
    expect(c).toBeCloseTo(0, 12);
    const textIdx = ctx.calls.findIndex((c, i) => i > idx && c[0] === "fillText" && c[1] === "FRONT");
    expect(textIdx).toBeGreaterThan(idx);
    // Drawn at the LOCAL origin (0, 0) — the transform itself carries it to
    // the face's screen centroid, not a pre-computed screen point.
    expect(ctx.calls[textIdx][3]).toBe(0);
    expect(ctx.calls[textIdx][4]).toBe(0);
    expect(ctx.calls[textIdx + 1][0]).toBe("restore");
  });

  it("flips u when the pairing would mirror the label, keeping the text readable", () => {
    // p0=(0,0), p1=(2,0), p3=(0,2): the u edge is (1,0) and the v edge (0,1),
    // i.e. this face's declared up projects DOWN the screen, so the label's own
    // v is (0,-1). Paired with u=(1,0) that is a determinant of -1, which would
    // mirror the glyph. The backstop must un-mirror it, and must do so by
    // flipping U — flipping v would put the label back upside down.
    const mirroredCell = { id: "front", points: [[0, 0], [2, 0], [2, 2], [0, 2]], depth: 1, face: "front", isCentre: true };
    const proj = { back: [], front: [mirroredCell], backEdges: [], frontEdges: [], arrows: [] };
    handle.draw(proj, {});
    const idx = ctx.calls.findIndex((c) => c[0] === "transform");
    const [, a, b, c, d] = ctx.calls[idx];
    expect(a * d - b * c).toBeGreaterThan(0);
    expect(a).toBe(-1);         // u flipped
    expect(b).toBeCloseTo(0, 12);
    expect(c).toBeCloseTo(0, 12);
    expect(d).toBe(-1);         // v left exactly as the declared up put it
  });

  it("paints the hovered region in the highlight fill and leaves the others alone", () => {
    handle.draw(projection, { hover: "top-front" });
    expect(fills()).toContain(CUBE_PALETTE.dark.hoverFill);
    expect(fills()).toContain(CUBE_PALETTE.dark.frontFill);
  });

  it("uses no highlight fill when nothing is hovered", () => {
    handle.draw(projection, {});
    expect(fills()).not.toContain(CUBE_PALETTE.dark.hoverFill);
  });

  // The 26 regions map onto 54 cells: a face id owns 1, an edge id 2 (one per
  // adjoining face), a corner id 3. A hover pass that resolved ONE cell —
  // `projected.front.find(...)` — filled one of them and, because step 4 skips
  // every cell whose id matches the hover, left the other two with no front
  // fill at all. On screen that read as "one side of the corner is much
  // lighter"; it was in fact an unpainted hole. These three cover it on a REAL
  // projection, since the hand-built fixture has only one cell per id and so
  // cannot express the bug at all.
  describe("a hovered region with several camera-facing cells", () => {
    // A camera showing three faces at once (bottom / front / right), so the
    // nearest corner has all 3 of its cells camera-facing and the three edges
    // between those faces have 2 each.
    const THREE_FACES = (() => {
      const q = [0.35, 0.35, 0.15, 0.85];
      const n = Math.hypot(...q);
      return q.map((v) => v / n);
    })();
    const SIZE = 100;
    let real;
    beforeEach(() => { real = projectCube(THREE_FACES, { size: SIZE, outerPad: 23 }); });

    const cellsWithId = (id) => real.front.filter((c) => c.id === id).length;

    it("has a corner with 3 camera-facing cells, an edge with 2 and a face with 1 (the fixture's premise)", () => {
      expect(cellsWithId("bottom-front-right")).toBe(3);
      expect(cellsWithId("bottom-front")).toBe(2);
      expect(cellsWithId("front")).toBe(1);
    });

    for (const [id, count] of [["bottom-front-right", 3], ["bottom-front", 2], ["front", 1]]) {
      it(`fills all ${count} camera-facing cell(s) of "${id}" in one identical shade`, () => {
        handle.draw(real, { hover: id });
        const hoverFills = fills().filter((c) => c === CUBE_PALETTE.dark.hoverFill);
        expect(hoverFills.length).toBe(count);
        expect(new Set(hoverFills).size).toBe(1);
      });
    }

    it("leaves no camera-facing cell unpainted while a corner is hovered", () => {
      // The invariant that was actually violated: EVERY camera-facing cell
      // gets painted, hovered or not. Asserted by polygon identity (a fill's
      // path opens with moveTo(p0)) rather than by counting colours, because a
      // hovered cell now takes two fills — its uniform base coat and the tint.
      handle.draw(real, { hover: "bottom-front-right" });
      const painted = new Set(filledPolygons().map(({ p0 }) => p0.join()));
      for (const cell of real.front) expect(painted).toContain(cell.points[0].join());
    });

    it("clears each hovered cell and gives it one uniform base coat before the tint", () => {
      // This is what keeps a TRANSLUCENT highlight uniform. At alpha 0.30 the
      // tint takes the colour of whatever is under each cell, and a corner's
      // three cells do not share a backdrop: one may have a back-face cell
      // (backFill) behind it, another empty canvas, another a back-phase axis
      // arrow. Clip + clear + one coat of frontFill makes the stack under the
      // tint identical for all of them — which is what the (rejected) opaque
      // fill used to achieve by brute force.
      handle.draw(real, { hover: "bottom-front-right" });
      // draw() opens with one full-canvas clearRect; the hover pass adds one
      // clipped clear per hovered cell.
      expect(ctx.calls.filter((c) => c[0] === "clearRect").length).toBe(1 + 3);
      expect(ctx.calls.filter((c) => c[0] === "clip").length).toBe(3);
      const clipIdx = ctx.calls.map((c, i) => (c[0] === "clip" ? i : -1)).filter((i) => i >= 0);
      const clearIdx = ctx.calls.map((c, i) => (c[0] === "clearRect" ? i : -1)).filter((i) => i >= 0).slice(1);
      const hoverIdx = ctx.calls
        .map((c, i) => (c[0] === "fill" && c[1] === CUBE_PALETTE.dark.hoverFill ? i : -1))
        .filter((i) => i >= 0);
      const baseIdx = ctx.calls
        .map((c, i) => (c[0] === "fill" && c[1] === CUBE_PALETTE.dark.frontFill ? i : -1))
        .filter((i) => i >= 0);
      expect(clearIdx.length).toBe(3);
      expect(hoverIdx.length).toBe(3);
      // clip -> clear -> base coat -> tint, per cell, and on the SAME polygon.
      for (let i = 0; i < 3; i++) {
        expect(clipIdx[i]).toBeLessThan(clearIdx[i]);
        expect(clearIdx[i]).toBeLessThan(baseIdx[i]);
        expect(baseIdx[i]).toBeLessThan(hoverIdx[i]);
      }
      const polys = filledPolygons();
      for (const idx of hoverIdx) {
        const tint = polys.find((f) => f.index === idx);
        const base = polys.filter((f) => f.index < idx && f.colour === CUBE_PALETTE.dark.frontFill).pop();
        expect(base.p0).toEqual(tint.p0);
      }
      // And the whole pass still happens BEFORE the ordinary front-face pass —
      // step 4 skips hovered cells, so a highlight drawn later would be
      // painting over nothing and a clear drawn later would erase the cube.
      // The hovered cells' own base coats are the first 3 frontFill fills.
      expect(Math.max(...hoverIdx)).toBeLessThan(baseIdx[3]);
    });
  });

  it("uses a TRANSLUCENT highlight — alpha 0.30 in both themes — over a cleared cell", () => {
    // The uniformity guarantee does not come from opacity (the highlight was
    // briefly opaque and read as far too strong a blue); it comes from the
    // clip-and-clear above, which gives every hovered cell the same backdrop.
    // So the tint can stay in keeping with the ghost cube.
    const alphaOf = (colour) => {
      const m = /^rgba?\(([^)]+)\)$/.exec(colour.trim());
      if (!m) return 1; // a hex colour is opaque
      const parts = m[1].split(",").map((s) => s.trim());
      return parts.length < 4 ? 1 : Number(parts[3]);
    };
    for (const mode of ["dark", "light"]) {
      expect(alphaOf(CUBE_PALETTE[mode].hoverFill)).toBe(0.3);
      // The ghost cube's own fills stay quieter still, so the highlight reads
      // as a highlight.
      expect(alphaOf(CUBE_PALETTE[mode].frontFill)).toBeLessThan(0.3);
      expect(alphaOf(CUBE_PALETTE[mode].backFill)).toBeLessThan(0.3);
    }
  });

  it("repaints in the light palette after a theme change", () => {
    handle.draw(projection, {});
    ctx.calls.length = 0;
    handle.setTheme("light");
    expect(fills()).toContain(CUBE_PALETTE.light.frontFill);
  });

  it("removes its canvas on dispose", () => {
    handle.dispose();
    expect(host.querySelector("canvas")).toBeNull();
  });
});

// The label-orientation contract, asserted on faceLabelBasis directly rather
// than through draw(): the renderer only labels camera-facing centre cells, so
// going through draw() could never cover all six faces at one camera, and a
// loop that quietly covers three faces is exactly how LEFT and BACK got shipped
// upside down.
describe("faceLabelBasis", () => {
  const IDENTITY = [0, 0, 0, 1];
  const SIZE = 100;
  // Two cameras with ROLL, so no face's in-plane axes land on a screen axis.
  const ROLLED_A = [0.307377, 0.264412, 0.142983, 0.902863]; // bottom/right/front facing
  const ROLLED_B = [-0.044922, -0.460121, -0.343351, 0.817545]; // top/front/left facing
  // LEFT and BACK camera-facing at the same time — the two reported failures.
  const LEFT_AND_BACK = [0.071989, -0.91346, 0.185168, 0.355135];

  const centres = (q) => {
    const p = projectCube(q, { size: SIZE });
    return [...p.front, ...p.back].filter((c) => c.isCentre);
  };
  const facing = (q, face) => {
    const p = projectCube(q, { size: SIZE });
    return p.front.find((c) => c.isCentre && c.face === face);
  };

  it("never points any of the six faces' labels up the screen at identity", () => {
    // Written as a loop over whatever the projection calls a centre cell so a
    // future face-ordering or naming change cannot exempt one of them.
    const cells = centres(IDENTITY);
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      const { vx, vy } = faceLabelBasis(cell);
      // v is the direction a glyph DESCENDS, so it must run down the screen
      // (canvas +y) — or be zero, for a face seen exactly edge-on, where there
      // is no in-plane direction left to point anywhere.
      const edgeOn = Math.hypot(vx, vy) < 1e-9;
      expect(edgeOn || vy > 0, `${cell.face}: v = (${vx}, ${vy})`).toBe(true);
    }
  });

  it("lays LEFT and BACK the right way up — the two the old corner-order basis inverted", () => {
    // A corner-order basis is right-handed for these two as well, so the old
    // determinant guard passed them through rotated 180 degrees. Both are
    // genuinely camera-facing at this quaternion, so both really are drawn.
    for (const face of ["left", "back"]) {
      const cell = facing(LEFT_AND_BACK, face);
      expect(cell, `${face} should be camera-facing here`).toBeDefined();
      const { vy } = faceLabelBasis(cell);
      expect(vy, `${face} label reads upside down`).toBeGreaterThan(0);
    }
  });

  it("never mirrors a label, and never inverts a SIDE face's, at any orientation", () => {
    // The four side faces are up-to-date at every azimuth, because their
    // declared up is the model's own up. TOP and BOTTOM are deliberately
    // excluded: their up is a convention (see FACE_LABEL_UP), so they read
    // rotated — including past 90 degrees — from some azimuths, and the
    // alternative was a label that snaps mid-drag.
    const SIDES = ["front", "back", "left", "right"];
    for (const q of [IDENTITY, ROLLED_A, ROLLED_B, LEFT_AND_BACK, [0.5, 0.5, 0.5, 0.5]]) {
      for (const cell of centres(q)) {
        const { ux, uy, vx, vy } = faceLabelBasis(cell);
        expect(ux * vy - uy * vx).toBeGreaterThanOrEqual(-1e-9); // never mirrored
        if (!SIDES.includes(cell.face)) continue;
        // >= 0, not > 0: a camera rolled a full 90 degrees lays a side label
        // exactly on its side, which is the face rotating as it should.
        expect(vy, `${cell.face}: v = (${vx}, ${vy})`).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it("still lets the label ROTATE with the face — it is not snapped upright on screen", () => {
    // The behaviour the fix must not regress: the name lies ON the face, so at
    // a rolled camera its basis has to be off-axis. A "always draw upright"
    // implementation would pass the identity-camera tests above and fail here.
    for (const q of [ROLLED_A, ROLLED_B]) {
      const cells = projectCube(q, { size: SIZE }).front.filter((c) => c.isCentre);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        const { ux, uy, vx, vy } = faceLabelBasis(cell);
        const offAxis = Math.abs(ux) > 0.5 && Math.abs(uy) > 0.5
          && Math.abs(vx) > 0.5 && Math.abs(vy) > 0.5;
        expect(offAxis, `${cell.face}: u = (${ux}, ${uy}), v = (${vx}, ${vy})`).toBe(true);
      }
    }
  });
});

describe("setSize", () => {
  it("resizes the CSS box and the DPR backing store, and redraws", () => {
    handle.draw(projection, {});
    ctx.calls.length = 0;
    handle.setSize(60);
    expect(handle.size).toBe(60);
    expect(handle.element.style.width).toBe("60px");
    expect(handle.element.style.height).toBe("60px");
    expect(handle.element.width).toBe(60);
    expect(handle.element.height).toBe(60);
    expect(ctx.calls.length).toBeGreaterThan(0); // a redraw happened
  });

  it("resizes the backing store even when the DPR did not change", () => {
    // syncBackingStore's dpr-equality guard would otherwise swallow a pure
    // size change (same DPR, different CSS size) and leave a stale bitmap.
    handle.draw(projection, {});
    handle.setSize(60);
    expect(handle.element.width).toBe(60);
  });

  it("is a no-op on drawing if called before any draw (no stale projection to redraw)", () => {
    expect(() => handle.setSize(60)).not.toThrow();
    expect(handle.size).toBe(60);
  });
});
