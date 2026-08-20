// @vitest-environment happy-dom
// The view cube's renderer. happy-dom has no real 2d context, so the context is
// injected and the assertions are on the DRAW ORDER and the fills chosen — the
// two things that decide whether a ghost cube with arrows in front of it reads
// correctly (the ink-canvas.js / dim3-scene paintLabel precedent).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCubeCanvas, CUBE_PALETTE, CUBE_RENDER } from "../../../src/framework/viewcube/cube-canvas.js";
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
function makeProjection() {
  return {
    back: [{ id: "back", points: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: -1, face: "back", isCentre: true }],
    front: [
      { id: "front", points: [[2, 2], [8, 2], [8, 8], [2, 8]], depth: 1, face: "front", isCentre: true },
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
    // arrow-shaft paths. So the call right after any closePath must be a
    // fill, never a stroke — for every cell, hovered or not, back or front.
    handle.draw(projection, { hover: "top-front" });
    const closeIdx = ctx.calls.map((c, i) => (c[0] === "closePath" ? i : -1)).filter((i) => i >= 0);
    expect(closeIdx.length).toBeGreaterThan(0);
    for (const i of closeIdx) expect(ctx.calls[i + 1][0]).toBe("fill");
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
    const frontFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.frontFill);
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
    // The fixture's "front" cell is the axis-aligned square [2,2]-[8,8]: half
    // its edge vectors are (3,0) and (0,3), and its centroid is (5,5) — so the
    // transform composed onto the DPR scale (via save()/transform(), never
    // setTransform(), so the DPR scale survives) must carry exactly those.
    handle.draw(projection, {});
    const idx = ctx.calls.findIndex((c) => c[0] === "transform");
    expect(idx).toBeGreaterThan(-1);
    expect(ctx.calls[idx - 1][0]).toBe("save");
    expect(ctx.calls[idx]).toEqual(["transform", 3, 0, 0, 3, 5, 5]);
    const textIdx = ctx.calls.findIndex((c, i) => i > idx && c[0] === "fillText" && c[1] === "FRONT");
    expect(textIdx).toBeGreaterThan(idx);
    // Drawn at the LOCAL origin (0, 0) — the transform itself carries it to
    // the face's screen centroid, not a pre-computed screen point.
    expect(ctx.calls[textIdx][3]).toBe(0);
    expect(ctx.calls[textIdx][4]).toBe(0);
    expect(ctx.calls[textIdx + 1][0]).toBe("restore");
  });

  it("flips the in-plane basis when it would mirror the label, keeping the text readable", () => {
    // p0=(0,0), p1=(2,0), p3=(0,-2): u=(1,0), v=(0,-1) — a determinant of -1,
    // which would mirror the glyph. The renderer must flip one axis so the
    // transform it hands the context is orientation-preserving again.
    const mirroredCell = { id: "front", points: [[0, 0], [2, 0], [2, -2], [0, -2]], depth: 1, face: "front", isCentre: true };
    const proj = { back: [], front: [mirroredCell], backEdges: [], frontEdges: [], arrows: [] };
    handle.draw(proj, {});
    const idx = ctx.calls.findIndex((c) => c[0] === "transform");
    const [, a, b, c, d] = ctx.calls[idx];
    expect(a * d - b * c).toBeGreaterThan(0);
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
