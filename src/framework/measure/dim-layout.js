// PURE screen-space layout for measurement mode: specs + a projector ->
// engineering-drawing primitives (extension lines with true gap/overshoot,
// dimension lines with arrowheads, bent leaders, label boxes). Deterministic
// greedy collision pass; hysteresis via the previous frame's choices so dims
// stay planted during orbit. All coordinates in CSS pixels.
import { fmtMm } from "./feature-dims.js";

export const EXT_GAP = 4;        // drafting gap between geometry and extension line
export const EXT_OVERSHOOT = 3;  // extension line runs past the dimension line
export const ARROW = 7;          // arrowhead length
export const DIM_OFFSET = 18;    // dimension line offset from the geometry
export const CHAR_W = 7;         // label width estimate per character (mono)
export const LABEL_H = 16;
export const LABEL_PAD = 5;
const HYSTERESIS = 0.85;         // keep the previous choice unless beaten by >15%
const EDGE_MARGIN = 8;           // offscreen chips hug the viewport inside this
const MAX_NUDGE = 8;

const labelBox = (text, paramName) => {
  const chars = text.length + (paramName ? paramName.length + 3 : 0);
  return { w: chars * CHAR_W + LABEL_PAD * 2, h: LABEL_H };
};

// One linear dimension between projected points a and b, offset along unit o.
// `itemId` is the owning item's stable id, carried on the label alongside the
// primitive's own (possibly colon-bearing) `id` — chip resolution keys off
// itemId, never off parsing `id` (Solid.label() text may itself contain
// colons, so string-splitting `id` back into an item id collides).
function linearDim(out, { id, itemId, a, b, o, text, tier, paramName, pinned }) {
  const off = (p, k) => ({ x: p.x + o.x * k, y: p.y + o.y * k });
  const dimA = off(a, DIM_OFFSET), dimB = off(b, DIM_OFFSET);
  for (const [p, dp] of [[a, dimA], [b, dimB]]) {
    out.lines.push({
      x1: p.x + o.x * EXT_GAP, y1: p.y + o.y * EXT_GAP,
      x2: dp.x + o.x * EXT_OVERSHOOT, y2: dp.y + o.y * EXT_OVERSHOOT,
      kind: "ext", tier,
    });
  }
  out.lines.push({ x1: dimA.x, y1: dimA.y, x2: dimB.x, y2: dimB.y, kind: "dim", tier });
  const ang = Math.atan2(dimB.y - dimA.y, dimB.x - dimA.x);
  out.arrows.push({ x: dimA.x, y: dimA.y, angle: ang + Math.PI, tier });
  out.arrows.push({ x: dimB.x, y: dimB.y, angle: ang, tier });
  const box = labelBox(text, paramName);
  const mid = { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 };
  out.labels.push({
    id, itemId, text, tier, kind: "chip", paramName: paramName ?? null, pinned: !!pinned,
    x: mid.x - box.w / 2 + o.x * (box.h / 2 + 2),
    y: mid.y - box.h / 2 + o.y * (box.h / 2 + 2),
    ...box,
    // slide dir for the collision pass: along the dimension line
    _slide: { x: Math.cos(ang), y: Math.sin(ang) },
  });
}

const onScreen = (p, vp) => !p.behind
  && p.x >= 0 && p.x <= vp.width && p.y >= 0 && p.y <= vp.height;

// The 8 corners of a min/max box.
const boxCorners = (min, max) => [
  [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
  [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
];
// Corner-index pairs of the 4 box edges parallel to each axis.
const AXIS_EDGES = [
  [[0, 1], [2, 3], [4, 5], [6, 7]], // X
  [[0, 2], [1, 3], [4, 6], [5, 7]], // Y
  [[0, 4], [1, 5], [2, 6], [3, 7]], // Z
];

// `corners` are the 8 box corners, already projected exactly once by the
// caller (layout()) — this never re-projects. A corner behind the camera
// only drops the axes/edges that actually touch it, not the whole item: the
// screen center is the mean of whichever corners ARE in front, and an axis
// whose 4 candidate edges are all behind is the only thing skipped.
function bboxItem(out, item, corners, vp, prevChoice, choices) {
  const { spec } = item;
  const visible = corners.filter((c) => !c.behind);
  const cx = visible.reduce((s, c) => s + c.x, 0) / visible.length;
  const cy = visible.reduce((s, c) => s + c.y, 0) / visible.length;
  const texts = [fmtMm(spec.values.w), fmtMm(spec.values.d), fmtMm(spec.values.h)];
  const chosen = [];
  for (let axis = 0; axis < 3; axis++) {
    if (spec.values[["w", "d", "h"][axis]] === 0) { chosen.push(-1); continue; }
    // Silhouette rule: the edge whose midpoint sits furthest from the projected
    // center never crosses the model. Hysteresis: keep the previous edge unless
    // the best beats it by >15%. An edge with either endpoint behind the camera
    // is unusable (sentinel score -1); if all 4 are behind, skip this axis.
    let bestIdx = -1, bestScore = -1;
    const scores = AXIS_EDGES[axis].map(([i, j]) => {
      if (corners[i].behind || corners[j].behind) return -1;
      const mx = (corners[i].x + corners[j].x) / 2, my = (corners[i].y + corners[j].y) / 2;
      return Math.hypot(mx - cx, my - cy);
    });
    scores.forEach((s, i) => { if (s > bestScore) { bestScore = s; bestIdx = i; } });
    if (bestIdx === -1) { chosen.push(-1); continue; }
    const prevIdx = prevChoice?.[axis];
    const idx = prevIdx != null && prevIdx >= 0 && scores[prevIdx] >= HYSTERESIS * bestScore
      ? prevIdx : bestIdx;
    chosen.push(idx);
    const [i, j] = AXIS_EDGES[axis][idx];
    const a = corners[i], b = corners[j];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const oLen = Math.hypot(mx - cx, my - cy) || 1;
    const o = { x: (mx - cx) / oLen, y: (my - cy) / oLen };
    linearDim(out, { id: `${item.id}:${axis}`, itemId: item.id, a, b, o, text: texts[axis],
      tier: item.tier, paramName: item.paramName, pinned: item.pinned });
  }
  choices[item.id] = chosen;
}

// `proj` is { widthA, widthB, heightA, heightB }, already projected exactly
// once by the caller. Each of the two dims is emitted independently — a dim
// is dropped only when its OWN pair has an endpoint behind the camera (the
// two dims share a corner: width.b is height.a), not when any of the four
// combined anchors is behind.
function planeItem(out, item, proj) {
  const { spec } = item;
  const dims = [
    { key: "width", a: proj.widthA, b: proj.widthB },
    { key: "height", a: proj.heightA, b: proj.heightB },
  ];
  const visible = [proj.widthA, proj.widthB, proj.heightA, proj.heightB].filter((p) => !p.behind);
  if (visible.length === 0) return;
  const cx = visible.reduce((s, p) => s + p.x, 0) / visible.length;
  const cy = visible.reduce((s, p) => s + p.y, 0) / visible.length;
  for (const { key, a, b } of dims) {
    if (a.behind || b.behind) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // outward = perpendicular to the dim direction, pointing away from center
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    let o = { x: -Math.sin(ang), y: Math.cos(ang) };
    if (o.x * (mx - cx) + o.y * (my - cy) < 0) o = { x: -o.x, y: -o.y };
    linearDim(out, { id: `${item.id}:${key}`, itemId: item.id, a, b, o, text: fmtMm(spec.values[key]),
      tier: item.tier, paramName: item.paramName, pinned: item.pinned });
  }
}

// `proj` is { center, bottom, top }, already projected exactly once by the
// caller. The center.behind gate covers the leader + diameter label (there's
// no meaningful leader anchor without it); the depth dim guards its own
// bottom/top endpoints independently.
function cylinderItem(out, item, proj, vp, prevChoice, choices) {
  const { spec } = item;
  const { center } = proj;
  if (center.behind) return;
  const text = spec.values.partial
    ? `R${fmtMm(spec.values.diameter / 2)}` : `⌀${fmtMm(spec.values.diameter)}`;
  // leader quadrant: away from the viewport center; hysteresis keeps it planted
  const quads = [{ x: 1, y: -1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  const away = { x: center.x - vp.width / 2, y: center.y - vp.height / 2 };
  const scores = quads.map((q) => q.x * away.x + q.y * away.y);
  let bestIdx = 0;
  scores.forEach((s, i) => { if (s > scores[bestIdx]) bestIdx = i; });
  const prevIdx = prevChoice?.[0];
  const idx = prevIdx != null && scores[prevIdx] >= HYSTERESIS * scores[bestIdx] ? prevIdx : bestIdx;
  choices[item.id] = [idx];
  const q = quads[idx];
  const L = 34; // leader run
  const elbow = { x: center.x + q.x * L, y: center.y + q.y * L * 0.6 };
  const box = labelBox(text, item.paramName);
  const labelX = q.x > 0 ? elbow.x + 8 : elbow.x - 8 - box.w;
  out.lines.push({ x1: elbow.x, y1: elbow.y, x2: center.x, y2: center.y, kind: "leader", tier: item.tier });
  out.lines.push({ x1: elbow.x, y1: elbow.y, x2: q.x > 0 ? labelX : labelX + box.w, y2: elbow.y, kind: "leader", tier: item.tier });
  out.arrows.push({ x: center.x, y: center.y, angle: Math.atan2(center.y - elbow.y, center.x - elbow.x), tier: item.tier });
  out.labels.push({
    id: `${item.id}:dia`, itemId: item.id, text, tier: item.tier, kind: "chip",
    paramName: item.paramName ?? null, pinned: !!item.pinned,
    x: labelX, y: elbow.y - box.h / 2, ...box,
    _slide: { x: 0, y: q.y },
  });
  // depth as a linear dim along the axis (skip degenerate depths)
  if (spec.values.depth > 0.01) {
    const { bottom: a, top: b } = proj;
    if (!a.behind && !b.behind) {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let o = { x: -Math.sin(ang), y: Math.cos(ang) };
      if (o.x * q.x + o.y * q.y < 0) o = { x: -o.x, y: -o.y }; // same side as the leader
      linearDim(out, { id: `${item.id}:depth`, itemId: item.id, a, b, o, text: fmtMm(spec.values.depth),
        tier: item.tier, pinned: item.pinned });
    }
  }
}

// Every anchor of a spec, projected exactly once per layout() pass — shared
// by the offscreen/onscreen test AND the per-kind builders above (no second
// projection pass, no getBoundingClientRect-per-point re-derivation).
function projectSpec(item) {
  const { spec, project } = item;
  if (spec.kind === "bbox") {
    return { kind: "bbox", corners: boxCorners(spec.anchors.min, spec.anchors.max).map(project) };
  }
  if (spec.kind === "plane") {
    return {
      kind: "plane",
      widthA: project(spec.anchors.width.a), widthB: project(spec.anchors.width.b),
      heightA: project(spec.anchors.height.a), heightB: project(spec.anchors.height.b),
    };
  }
  return {
    kind: "cylinder",
    center: project(spec.anchors.center),
    bottom: project(spec.anchors.bottom),
    top: project(spec.anchors.top),
  };
}

// Flat list of a projected spec's points, for the offscreen/onscreen test.
function pointsOf(proj) {
  if (proj.kind === "bbox") return proj.corners;
  if (proj.kind === "plane") return [proj.widthA, proj.widthB, proj.heightA, proj.heightB];
  return [proj.center, proj.bottom, proj.top];
}

export function layout(items, viewport, prev) {
  const out = { lines: [], arrows: [], labels: [], choices: {} };
  // hover first so it claims its natural spot; pinned, then static yield to it
  const order = { hover: 0, pinned: 1, static: 2 };
  const sorted = [...items].sort((a, b) => (order[a.tier] ?? 3) - (order[b.tier] ?? 3));
  for (const item of sorted) {
    const proj = projectSpec(item);
    const pts = pointsOf(proj);
    if (pts.every((p) => !onScreen(p, viewport))) {
      if (!item.pinned) continue;
      // Pinned-but-offscreen: one edge chip pointing at the anchor, clamped in.
      // Any anchor in front of the camera works as the chip's target point —
      // pts[0] specifically may be behind even when a later anchor isn't.
      const p = pts.find((pt) => !pt.behind);
      if (!p) continue;
      const text = item.spec.kind === "cylinder"
        ? `⌀${fmtMm(item.spec.values.diameter)}`
        : fmtMm(Object.values(item.spec.values).find((v) => typeof v === "number") ?? 0);
      const box = labelBox(text, item.paramName);
      out.labels.push({
        id: item.id, itemId: item.id, text, tier: item.tier, kind: "offscreen",
        paramName: item.paramName ?? null, pinned: true,
        x: Math.min(Math.max(p.x, EDGE_MARGIN), viewport.width - box.w - EDGE_MARGIN),
        y: Math.min(Math.max(p.y, EDGE_MARGIN), viewport.height - box.h - EDGE_MARGIN),
        ...box, _slide: { x: 0, y: 1 },
      });
      continue;
    }
    const prevChoice = prev?.choices?.[item.id];
    if (item.spec.kind === "bbox") bboxItem(out, item, proj.corners, viewport, prevChoice, out.choices);
    else if (item.spec.kind === "plane") planeItem(out, item, proj);
    else if (item.spec.kind === "cylinder") cylinderItem(out, item, proj, viewport, prevChoice, out.choices);
  }
  // Deterministic greedy collision pass: nudge along the label's slide dir.
  const placed = [];
  for (const l of out.labels) {
    const slide = l._slide ?? { x: 0, y: 1 };
    let tries = 0;
    while (tries < MAX_NUDGE) {
      const p = placed.find((q) =>
        l.x < q.x + q.w && q.x < l.x + l.w && l.y < q.y + q.h && q.y < l.y + l.h);
      if (!p) break;
      // Step far enough along the slide to clear THIS blocker, not a fixed
      // increment — identical stacked chips would otherwise exhaust the nudge
      // budget (a 38px-wide chip needs three 18px nudges per blocker).
      const step = Math.max(
        LABEL_H + 2,
        Math.abs(slide.x) * (p.w + 2) + Math.abs(slide.y) * (p.h + 2),
      );
      l.x += slide.x * step;
      l.y += slide.y * step;
      tries++;
    }
    placed.push(l);
    delete l._slide;
  }
  return out;
}
