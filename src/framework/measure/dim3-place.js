// Pure in-scene dimension placement (spec v2 §Placement + amendments).
// Everything works in the PARTS frame — the meshes' shared parent group
// (delivered geometry composed with pose matrices) — so the resulting drawing
// rides the pivot rotation and per-view recentring untouched. No DOM, no GL,
// no rendering objects: three's math classes only, so this runs under plain
// vitest.
//
// Placement does the expensive DISCOVERY only: anchor points (extreme-vertex
// scans, surface raycasts, plane snapping), side selection, dedupe and stagger
// lanes. Every display distance — standoff, surface gap, arrowheads, the
// overshoot past the dim line, leader length, text size — is screen-constant,
// so the final geometry depends on zoom and is assembled per frame by
// dim3-scene from the parametric records emitted here. That keeps zoom fully
// rebuild-free.
//
// Split in two so the orchestrator can score cheaply every frame and rebuild
// rarely: evaluateChoices() is dot-products + hysteresis over the previous
// choices; placeDims() does the discovery only when a choice flipped or the
// scene changed.
//
// Drawing contract (consumed by dim3-scene):
//   { itemId, tier, pinned,
//     dims:    [{ pA, pB, baseA, baseB, ext, dir, lane, standoffScale,
//                 label: { text, param, x, y } }],
//     diams:   [{ rimA, rimB, du, dv, label }],
//     leaders: [{ rim, dir, perp, label }] }
// All vectors are number[3] in the parts frame. A linear dim's line endpoints
// at display time are base± + ext·offset (offset chosen on-screen); pA/pB are
// the discovered surface-contact anchors its extension lines run from. A diam
// is the fixed line across a circle (rim to rim); a leader points at `rim`
// along `dir`.
import * as THREE from "three";
import { fmtMm } from "./feature-dims.js";

// --- discovery constants ------------------------------------------------------
// standoffNominal: the mm offset ASSUMED while discovering surface contacts
// (raycast origins) and extreme-vertex tie-break targets. Display standoff is
// screen-constant and lives in dim3-scene; discovery only needs a plausible
// out-of-the-part reference, and the contact points it finds barely depend on
// it.
export const standoffNominal = (modelSize) => Math.max(6, modelSize * 0.10);
export const HYSTERESIS = 1.15;  // challenger must beat the holder by 15%
export const FLIP_DEADBAND_DEG = 25; // cylinder ⌀ direction re-aim threshold

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// --- duplicate-dimension suppression ------------------------------------------
// Two items measuring the same thing draw identical dims on top of each other:
// a hovered sub-part over the overall bounds (single-part apps), a hover over
// its own pin. The signature identifies "the same measurement" independent of
// item id/tier. Within one placeDims call the LATER item wins (pins carry the
// param pill the overall lacks); across the orchestrator's base/hover split,
// the hover pass hands the base items' sigs in as `suppress`.
export function specSig(spec) {
  return JSON.stringify({ kind: spec.kind, values: spec.values, anchors: spec.anchors });
}

// --- stagger lanes ------------------------------------------------------------
// Dims extending the same outward direction stack at increasing standoff
// (drafting-style stacked dimension lines), so co-located labels stagger
// instead of overlapping. Lanes are per-placeDims-call and deterministic in
// item order (overall, pins, hover). The lane's on-screen spacing lives in
// dim3-scene.
function laneFor(lanes, ext) {
  const key = `${ext.x.toFixed(2)},${ext.y.toFixed(2)},${ext.z.toFixed(2)}`;
  const lane = lanes.get(key) ?? 0;
  lanes.set(key, lane + 1);
  return lane;
}

// --- candidate sides for a box-extent dim ------------------------------------
// Measuring along `axis`, the dim can extend outward along ± each of the other
// two axes; the plane normal is the remaining axis. Keys are stable across
// frames so hysteresis can hold a choice.
function boxCandidates(axis) {
  const others = [0, 1, 2].filter((i) => i !== axis);
  const out = [];
  for (const extAxis of others) {
    const nAxis = others.find((i) => i !== extAxis);
    for (const sign of [1, -1]) out.push({ key: `e${extAxis}s${sign}`, extAxis, sign, nAxis });
  }
  return out;
}

function scoreCandidate(ext, n, toCam) {
  // favour extending toward the viewer; favour a plane the viewer sees face-on
  return 0.6 * Math.max(0, ext.dot(toCam)) + 0.4 * Math.abs(n.dot(toCam));
}

// Hold the previous choice unless a challenger beats it by HYSTERESIS.
function chooseWithHysteresis(scored, prevKey) {
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const prev = prevKey != null ? scored.find((s) => s.key === prevKey) : null;
  if (prev && best.key !== prev.key && best.score < prev.score * HYSTERESIS) return prev;
  return best;
}

// --- per-frame-cheap choice scoring ------------------------------------------
export function evaluateChoices(items, { camPos, center, prev = {} }) {
  const cam = v3(camPos);
  const toCam = cam.clone().sub(v3(center)).normalize();
  const choices = {};
  for (const item of items) {
    const spec = item.spec;
    if (spec.kind === "bbox") {
      for (const axis of [0, 1, 2]) {
        const ck = `${item.id}|ax${axis}`;
        const scored = boxCandidates(axis).map((c) => ({
          ...c,
          score: scoreCandidate(AXES[c.extAxis].clone().multiplyScalar(c.sign), AXES[c.nAxis], toCam),
        }));
        choices[ck] = { key: chooseWithHysteresis(scored, prev[ck]?.key).key };
      }
    } else if (spec.kind === "plane") {
      const n = v3(spec.anchors.normal).normalize();
      for (const dimKey of ["width", "height"]) {
        const { a, b } = spec.anchors[dimKey];
        const dir = v3(b).sub(v3(a)).normalize();
        const perp = new THREE.Vector3().crossVectors(n, dir).normalize();
        const ck = `${item.id}|${dimKey}`;
        const scored = [
          { key: "p+", sign: 1, score: scoreCandidate(perp, n, toCam) },
          { key: "p-", sign: -1, score: scoreCandidate(perp.clone().negate(), n, toCam) },
        ];
        choices[ck] = { key: chooseWithHysteresis(scored, prev[ck]?.key).key };
      }
    } else if (spec.kind === "cylinder") {
      // ⌀/R direction: radial component of the view direction, re-aimed only
      // past the deadband so the drawing doesn't chase every orbit degree.
      const axis = v3(spec.anchors.axis).normalize();
      const toCamHere = cam.clone().sub(v3(spec.anchors.center)).normalize();
      let du = toCamHere.clone().addScaledVector(axis, -toCamHere.dot(axis));
      if (du.lengthSq() < 1e-6) du = v3(spec.anchors.rimDir ?? [1, 0, 0]);
      du.normalize();
      const ck = `${item.id}|du`;
      const prevDu = prev[ck]?.du ? v3(prev[ck].du) : null;
      const hold = prevDu && du.angleTo(prevDu) < (FLIP_DEADBAND_DEG * Math.PI) / 180;
      choices[ck] = { du: (hold ? prevDu : du).toArray() };
      // depth dim side: ± the chosen du (in the plane containing the axis)
      const dck = `${item.id}|depth`;
      const duHeld = hold ? prevDu : du;
      const scored = [
        { key: "d+", score: scoreCandidate(duHeld, axis, toCamHere) },
        { key: "d-", score: scoreCandidate(duHeld.clone().negate(), axis, toCamHere) },
      ];
      choices[dck] = { key: chooseWithHysteresis(scored, prev[dck]?.key).key, du: duHeld.toArray() };
    }
  }
  return choices;
}

export function choicesEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    if (x.key !== y.key) return false;
    if (!!x.du !== !!y.du) return false;
    if (x.du && (x.du[0] !== y.du[0] || x.du[1] !== y.du[1] || x.du[2] !== y.du[2])) return false;
  }
  return true;
}

// --- extreme vertex scan ------------------------------------------------------
// The vertex realizing the extreme along `axis` over the posed meshes; ties
// within tolerance (a flat base is all "the minimum") break toward `near`, so
// the anchor lands on the side of the part the dimension is drawn on.
const _sv = new THREE.Vector3();
export function extremeVertex(meshData, axis, sign, near) {
  let bestVal = sign > 0 ? -Infinity : Infinity;
  for (const { positions, matrix } of meshData) {
    for (let i = 0; i < positions.length; i += 3) {
      _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      const val = _sv.getComponent(axis);
      if (sign > 0 ? val > bestVal : val < bestVal) bestVal = val;
    }
  }
  if (!Number.isFinite(bestVal)) return null;
  let best = null, bestD = Infinity;
  for (const { positions, matrix } of meshData) {
    for (let i = 0; i < positions.length; i += 3) {
      _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      if (Math.abs(_sv.getComponent(axis) - bestVal) > 1e-3) continue;
      const d = _sv.distanceToSquared(near);
      if (d < bestD) { bestD = d; best = _sv.clone(); }
    }
  }
  return best;
}

// --- one parametric linear dimension -----------------------------------------
// pA/pB: surface anchor points. nomA/nomB: NOMINAL dim-line endpoints used for
// discovery only. baseA/baseB: dim-line endpoints at ZERO standoff — the scene
// slides them out along `ext` by the screen-derived offset. When `surfaceHit`
// is given, each extension line starts at the first in-plane surface hit
// walking from the nominal endpoint back toward the part (ray nudged 0.05 mm
// inside the extreme plane so a grazing ray on the extreme face registers);
// otherwise (feature dims — anchors already ON the surface) it starts at the
// anchor.
function linearDim(out, {
  pA, pB, baseA, baseB, nomA, nomB, ext, lane, standoffScale = 1,
  text, param, surfaceHit, planeAxis, planeC,
}) {
  const dir = baseB.clone().sub(baseA).normalize();
  const anchors = [pA, pB];
  [[pA, nomA, 1], [pB, nomB, -1]].forEach(([p, nom, inwardSign], i) => {
    if (!surfaceHit) return;
    const nudged = nom.clone().addScaledVector(dir, 0.05 * inwardSign);
    const toward = p.clone().sub(nom).normalize();
    const hit = surfaceHit(nudged, toward);
    if (hit) {
      const start = hit.clone();
      if (planeAxis != null) start.setComponent(planeAxis, planeC); // stay exactly coplanar
      anchors[i] = start;
    }
  });
  out.dims.push({
    pA: anchors[0].toArray(), pB: anchors[1].toArray(),
    baseA: baseA.toArray(), baseB: baseB.toArray(),
    ext: ext.toArray(), dir: dir.toArray(),
    lane, standoffScale,
    label: { text, param: param ?? null, x: dir.toArray(), y: ext.clone().negate().toArray() },
  });
}

// --- per-kind placement -------------------------------------------------------
function placeBox(out, item, spec, choices, { meshData, surfaceHit, modelSize, lanes }, refSide) {
  const min = spec.anchors.min, max = spec.anchors.max;
  const nomOff = standoffNominal(modelSize);
  const scan = meshData; // caller pre-filtered by item.meshes
  const valueByAxis = [spec.values.w, spec.values.d, spec.values.h];
  const seenValues = new Set();
  for (const axis of [0, 1, 2]) {
    const span = max[axis] - min[axis];
    if (span < 1e-6) continue;
    // duplicate-value suppression within the item: a round or square part has
    // equal extents — one dim carries the shared value
    const text = `${fmtMm(valueByAxis[axis])} mm`;
    if (seenValues.has(text)) continue;
    seenValues.add(text);
    const cand = boxCandidates(axis).find((c) => c.key === choices[`${item.id}|ax${axis}`]?.key)
      ?? boxCandidates(axis)[0];
    const { extAxis, sign, nAxis } = cand;
    const ext = AXES[extAxis].clone().multiplyScalar(sign);
    // dim-line base points: measured coordinate at min/max, ext coordinate on
    // the near face (zero standoff); the plane coordinate (nAxis) is snapped
    // below. Nominal points add the discovery standoff for raycast origins and
    // tie-break targets.
    const extBase = sign > 0 ? max[extAxis] : min[extAxis];
    const mk = (m, off) => {
      const p = new THREE.Vector3();
      p.setComponent(axis, m);
      p.setComponent(extAxis, extBase + sign * off);
      p.setComponent(nAxis, refSide(nAxis, min, max));
      return p;
    };
    const nomA = mk(min[axis], nomOff), nomB = mk(max[axis], nomOff);
    // true extreme anchors (tie-break toward the nominal dim line), then plane
    // snap: slide the plane along nAxis to whichever anchor sits nearer the
    // mid-plane reference; the other anchor projects into the plane.
    const ref = refSide(nAxis, min, max);
    let pA = extremeVertex(scan, axis, -1, nomA) ?? new THREE.Vector3().setComponent(axis, min[axis]);
    let pB = extremeVertex(scan, axis, +1, nomB) ?? new THREE.Vector3().setComponent(axis, max[axis]);
    const cA = pA.getComponent(nAxis), cB = pB.getComponent(nAxis);
    const c = Math.abs(cA - ref) <= Math.abs(cB - ref) ? cA : cB;
    const baseA = mk(min[axis], 0), baseB = mk(max[axis], 0);
    for (const p of [pA, pB, nomA, nomB, baseA, baseB]) p.setComponent(nAxis, c);
    linearDim(out, {
      pA, pB, baseA, baseB, nomA, nomB, ext,
      lane: laneFor(lanes, ext),
      text, param: item.paramName,
      surfaceHit, planeAxis: nAxis, planeC: c,
    });
  }
}

function placePlane(out, item, spec, choices, { lanes }) {
  const n = v3(spec.anchors.normal).normalize();
  const dims = [
    ["width", spec.values.width],
    ["height", spec.values.height],
  ];
  for (const [dimKey, value] of dims) {
    if (value < 1e-6) continue;
    const a = v3(spec.anchors[dimKey].a), b = v3(spec.anchors[dimKey].b);
    const dir = b.clone().sub(a).normalize();
    const perp = new THREE.Vector3().crossVectors(n, dir).normalize();
    const sign = choices[`${item.id}|${dimKey}`]?.key === "p-" ? -1 : 1;
    const ext = perp.multiplyScalar(sign);
    linearDim(out, {
      pA: a, pB: b, baseA: a.clone(), baseB: b.clone(), nomA: a, nomB: b, ext,
      lane: laneFor(lanes, ext), standoffScale: 0.55, // feature dims hug their feature
      text: `${fmtMm(value)} mm`, param: item.paramName, surfaceHit: null,
    });
  }
}

function placeCylinder(out, item, spec, choices, { lanes }) {
  const axis = v3(spec.anchors.axis).normalize();
  const top = v3(spec.anchors.top);
  const bottom = v3(spec.anchors.bottom);
  const r = spec.values.diameter / 2;
  const du = v3(choices[`${item.id}|du`]?.du ?? spec.anchors.rimDir ?? [1, 0, 0]).normalize();
  const dv = new THREE.Vector3().crossVectors(axis, du).normalize();

  if (spec.values.partial) {
    // R leader from the covered-arc midpoint, radial, in the top plane
    const rd = v3(spec.anchors.rimDir ?? du.toArray()).normalize();
    const rim = top.clone().addScaledVector(rd, r);
    out.leaders.push({
      rim: rim.toArray(), dir: rd.toArray(),
      perp: new THREE.Vector3().crossVectors(axis, rd).normalize().toArray(),
      label: {
        text: `R${fmtMm(r)}`, param: item.paramName ?? null,
        x: new THREE.Vector3().crossVectors(axis, rd).normalize().toArray(),
        y: rd.clone().negate().toArray(),
      },
    });
  } else {
    // full circle: diameter line across the top circle, arrows outward at both
    // rim points, ⌀ text just outside the rim
    const rimA = top.clone().addScaledVector(du, r);
    const rimB = top.clone().addScaledVector(du, -r);
    out.diams.push({
      rimA: rimA.toArray(), rimB: rimB.toArray(), du: du.toArray(), dv: dv.toArray(),
      label: {
        text: `⌀${fmtMm(spec.values.diameter)}`, param: item.paramName ?? null,
        x: dv.toArray(), y: du.clone().negate().toArray(),
      },
    });
  }

  // depth: linear dim along the axis, hung off the silhouette at the chosen side
  if (spec.values.depth > 1e-6) {
    const sgn = choices[`${item.id}|depth`]?.key === "d-" ? -1 : 1;
    const ext = du.clone().multiplyScalar(sgn);
    const pA = bottom.clone().addScaledVector(ext, r);
    const pB = top.clone().addScaledVector(ext, r);
    linearDim(out, {
      pA, pB, baseA: pA.clone(), baseB: pB.clone(), nomA: pA, nomB: pB, ext,
      lane: laneFor(lanes, ext), standoffScale: 0.55,
      text: `${fmtMm(spec.values.depth)} mm`, param: item.paramName, surfaceHit: null,
    });
  }
}

// --- entry point --------------------------------------------------------------
export function placeDims(items, { meshData = [], surfaceHit = null, bounds, suppress = null }, choices) {
  const size = bounds
    ? Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
    : 10;
  // duplicate-measurement suppression: see specSig. Later item wins in-call;
  // `suppress` carries sigs already drawn by another call (the base pass).
  const sigs = items.map((i) => (i.spec ? specSig(i.spec) : null));
  const skip = new Set();
  for (let i = 0; i < items.length; i++) {
    if (!sigs[i]) { skip.add(i); continue; }
    if (suppress?.has(sigs[i])) { skip.add(i); continue; }
    for (let j = i + 1; j < items.length; j++) {
      if (sigs[i] === sigs[j]) { skip.add(i); break; }
    }
  }
  // plane-snap reference: for bbox dims the plane snaps to whichever true
  // extreme anchor sits nearer the model's mid-plane along nAxis (see refSide
  // below) rather than to a camera side — deterministic and adequate: the
  // spec only requires "the side of the model the dim is drawn toward".
  const lanes = new Map();
  const drawings = [];
  items.forEach((item, idx) => {
    const spec = item.spec;
    if (!spec || skip.has(idx)) return;
    const out = { itemId: item.id, tier: item.tier, pinned: !!item.pinned, dims: [], diams: [], leaders: [] };
    const scan = item.meshes ? item.meshes.map((i) => meshData[i]).filter(Boolean) : meshData;
    if (spec.kind === "bbox") {
      const refSide = (nAxis, min, max) => {
        // draw-side reference along the plane normal: mid-plane — the snap then
        // picks whichever anchor is nearer the model's middle along n, keeping
        // the drawing close to where the extent actually occurs.
        return (min[nAxis] + max[nAxis]) / 2;
      };
      placeBox(out, item, spec, choices, { meshData: scan, surfaceHit, modelSize: size, lanes }, refSide);
    } else if (spec.kind === "plane") {
      placePlane(out, item, spec, choices, { lanes });
    } else if (spec.kind === "cylinder") {
      placeCylinder(out, item, spec, choices, { lanes });
    }
    if (out.dims.length || out.diams.length || out.leaders.length) drawings.push(out);
  });
  return drawings;
}
