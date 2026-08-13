// Pure in-scene dimension placement (spec v2 §Placement). Everything works in
// the PARTS frame — the meshes' shared parent group (delivered geometry
// composed with pose matrices) — so the resulting drawing rides the pivot
// rotation and per-view recentring untouched. No DOM, no GL, no rendering
// objects: three's math classes only, so this runs under plain vitest.
//
// Split in two so the orchestrator can score cheaply every frame and rebuild
// rarely: evaluateChoices() is dot-products + hysteresis over the previous
// choices; placeDims() does the real work (vertex scans, raycasts, geometry)
// only when a choice flipped or the scene changed.
import * as THREE from "three";
import { fmtMm } from "./feature-dims.js";

// --- locked visual constants (spec v2 §Visual language) ----------------------
export const GAP = 1.0;          // mm, surface-contact point -> extension line
export const OVERSHOOT = 1.5;    // mm, extension line past the dim line
export const HYSTERESIS = 1.15;  // challenger must beat the holder by 15%
export const FLIP_DEADBAND_DEG = 25; // cylinder ⌀ direction re-aim threshold
export const standoff = (modelSize) => Math.max(6, modelSize * 0.10);
export const arrowLen = (span) => 0.7 * Math.min(3, Math.max(1.2, span * 0.04));
export const ARROW_HALF_W = 0.25; // × arrow length
export const textHeight = (modelSize) => Math.max(3.2, modelSize * 0.05);

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

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

// --- one flat linear dimension ------------------------------------------------
// pA/pB: surface anchor points. da/db: dim-line endpoints. ext: unit in-plane
// outward direction. All coplanar by the time this runs. When `surfaceHit` is
// given, each extension line starts at the first in-plane surface hit walking
// from the dim-line endpoint back toward the part (ray nudged `nudge` inside
// the extreme plane so a grazing ray on the extreme face still registers);
// otherwise (feature dims — anchors already ON the surface) it starts at the
// anchor.
function linearDim(out, { pA, pB, da, db, ext, text, param, modelSize, surfaceHit, planeAxis, planeC }) {
  const dir = db.clone().sub(da).normalize();
  const span = db.distanceTo(da);
  const aLen = arrowLen(span);

  for (const [p, d, inwardSign] of [[pA, da, 1], [pB, db, -1]]) {
    let start = p;
    if (surfaceHit) {
      const nudged = d.clone().addScaledVector(dir, 0.05 * inwardSign);
      const toward = p.clone().sub(d).normalize();
      const hit = surfaceHit(nudged, toward);
      if (hit) {
        start = hit.clone();
        if (planeAxis != null) start.setComponent(planeAxis, planeC); // stay exactly coplanar
      }
    }
    const u = d.clone().sub(start);
    const un = u.lengthSq() > 1e-12 ? u.normalize() : ext.clone();
    const s = start.clone().addScaledVector(un, GAP);
    const e = d.clone().addScaledVector(un, OVERSHOOT);
    out.segments.push(s.x, s.y, s.z, e.x, e.y, e.z);
  }

  // dim line, inset so it never pokes through the arrowheads
  const dA = da.clone().addScaledVector(dir, aLen);
  const dB = db.clone().addScaledVector(dir, -aLen);
  out.segments.push(dA.x, dA.y, dA.z, dB.x, dB.y, dB.z);
  arrow(out, da, dir, ext, aLen);
  arrow(out, db, dir.clone().negate(), ext, aLen);

  const h = textHeight(modelSize);
  const mid = da.clone().add(db).multiplyScalar(0.5);
  const center = mid.clone().addScaledVector(ext, h * 0.85); // OUTSIDE the line
  out.labels.push({
    text, param: param ?? null,
    center: center.toArray(), x: dir.toArray(), y: ext.clone().negate().toArray(), h,
  });
}

// Filled flat triangle lying in the dim plane: tip on the endpoint, base
// toward the line's centre, spread along the in-plane perpendicular.
function arrow(out, tip, inward, perp, len) {
  const base = tip.clone().addScaledVector(inward, len);
  const halfW = len * ARROW_HALF_W;
  const p1 = base.clone().addScaledVector(perp, halfW);
  const p2 = base.clone().addScaledVector(perp, -halfW);
  out.triangles.push(tip.x, tip.y, tip.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
}

// --- per-kind placement -------------------------------------------------------
function placeBox(out, item, spec, choices, { meshData, surfaceHit, modelSize }, camAidedRefSide) {
  const min = spec.anchors.min, max = spec.anchors.max;
  const off = standoff(modelSize);
  const scan = meshData; // caller pre-filtered by item.meshes
  const valueByAxis = [spec.values.w, spec.values.d, spec.values.h];
  for (const axis of [0, 1, 2]) {
    const span = max[axis] - min[axis];
    if (span < 1e-6) continue;
    const cand = boxCandidates(axis).find((c) => c.key === choices[`${item.id}|ax${axis}`]?.key)
      ?? boxCandidates(axis)[0];
    const { extAxis, sign, nAxis } = cand;
    const ext = AXES[extAxis].clone().multiplyScalar(sign);
    // dim-line endpoints: measured coordinate at min/max, ext coordinate at the
    // near face + standoff; the plane coordinate (nAxis) is snapped below.
    const extBase = sign > 0 ? max[extAxis] : min[extAxis];
    const mk = (m) => {
      const p = new THREE.Vector3();
      p.setComponent(axis, m);
      p.setComponent(extAxis, extBase + sign * off);
      p.setComponent(nAxis, camAidedRefSide(nAxis, min, max));
      return p;
    };
    const da = mk(min[axis]), db = mk(max[axis]);
    // true extreme anchors (tie-break toward the dim line), then plane snap:
    // slide the plane along nAxis to whichever anchor sits nearer the
    // mid-plane reference; the other anchor projects into the plane.
    const ref = camAidedRefSide(nAxis, min, max);
    let pA = extremeVertex(scan, axis, -1, da) ?? new THREE.Vector3().setComponent(axis, min[axis]);
    let pB = extremeVertex(scan, axis, +1, db) ?? new THREE.Vector3().setComponent(axis, max[axis]);
    const cA = pA.getComponent(nAxis), cB = pB.getComponent(nAxis);
    const c = Math.abs(cA - ref) <= Math.abs(cB - ref) ? cA : cB;
    for (const p of [pA, pB, da, db]) p.setComponent(nAxis, c);
    linearDim(out, {
      pA, pB, da, db, ext,
      text: `${fmtMm(valueByAxis[axis])} mm`, param: item.paramName,
      modelSize, surfaceHit, planeAxis: nAxis, planeC: c,
    });
  }
}

function placePlane(out, item, spec, choices, { modelSize }) {
  const n = v3(spec.anchors.normal).normalize();
  const off = standoff(modelSize) * 0.5; // feature dims hug their feature
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
    const da = a.clone().addScaledVector(ext, off);
    const db = b.clone().addScaledVector(ext, off);
    linearDim(out, {
      pA: a, pB: b, da, db, ext,
      text: `${fmtMm(value)} mm`, param: item.paramName, modelSize, surfaceHit: null,
    });
  }
}

function placeCylinder(out, item, spec, choices, { modelSize }) {
  const axis = v3(spec.anchors.axis).normalize();
  const top = v3(spec.anchors.top);
  const bottom = v3(spec.anchors.bottom);
  const r = spec.values.diameter / 2;
  const du = v3(choices[`${item.id}|du`]?.du ?? spec.anchors.rimDir ?? [1, 0, 0]).normalize();
  const dv = new THREE.Vector3().crossVectors(axis, du).normalize();
  const h = textHeight(modelSize);

  if (spec.values.partial) {
    // R leader from the covered-arc midpoint, radial, in the top plane
    const rd = v3(spec.anchors.rimDir ?? du.toArray()).normalize();
    const rim = top.clone().addScaledVector(rd, r);
    const leaderLen = h * 2;
    const s = rim.clone().addScaledVector(rd, GAP);
    const e = rim.clone().addScaledVector(rd, GAP + leaderLen);
    out.segments.push(s.x, s.y, s.z, e.x, e.y, e.z);
    arrow(out, rim, rd, new THREE.Vector3().crossVectors(axis, rd).normalize(), arrowLen(r * 2));
    out.labels.push({
      text: `R${fmtMm(r)}`, param: item.paramName,
      center: e.clone().addScaledVector(rd, h * 0.85).toArray(),
      x: new THREE.Vector3().crossVectors(axis, rd).normalize().toArray(),
      y: rd.clone().negate().toArray(), h,
    });
  } else {
    // full circle: diameter line across the top circle, arrows outward at both
    // rim points, ⌀ text just outside the rim
    const rimA = top.clone().addScaledVector(du, r);
    const rimB = top.clone().addScaledVector(du, -r);
    const aLen = arrowLen(2 * r);
    const iA = rimA.clone().addScaledVector(du, -aLen);
    const iB = rimB.clone().addScaledVector(du, aLen);
    out.segments.push(iA.x, iA.y, iA.z, iB.x, iB.y, iB.z);
    arrow(out, rimA, du.clone().negate(), dv, aLen);
    arrow(out, rimB, du, dv, aLen);
    out.labels.push({
      text: `⌀${fmtMm(spec.values.diameter)}`, param: item.paramName,
      center: rimA.clone().addScaledVector(du, h * 0.85).toArray(),
      x: dv.toArray(), y: du.clone().negate().toArray(), h,
    });
  }

  // depth: linear dim along the axis, hung off the silhouette at the chosen side
  if (spec.values.depth > 1e-6) {
    const sgn = choices[`${item.id}|depth`]?.key === "d-" ? -1 : 1;
    const ext = du.clone().multiplyScalar(sgn);
    const off = standoff(modelSize) * 0.5;
    const pA = bottom.clone().addScaledVector(ext, r);
    const pB = top.clone().addScaledVector(ext, r);
    const da = pA.clone().addScaledVector(ext, off);
    const db = pB.clone().addScaledVector(ext, off);
    linearDim(out, {
      pA, pB, da, db, ext,
      text: `${fmtMm(spec.values.depth)} mm`, param: item.paramName,
      modelSize, surfaceHit: null,
    });
  }
}

// --- entry point --------------------------------------------------------------
export function placeDims(items, { meshData = [], surfaceHit = null, bounds }, choices) {
  const size = bounds
    ? Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
    : 10;
  // plane-snap reference: for bbox dims the plane snaps to whichever true
  // extreme anchor sits nearer the model's mid-plane along nAxis (see refSide
  // below) rather than to a camera side — deterministic and adequate: the
  // spec only requires "the side of the model the dim is drawn toward".
  const drawings = [];
  for (const item of items) {
    const spec = item.spec;
    if (!spec) continue;
    const out = { itemId: item.id, tier: item.tier, pinned: !!item.pinned, segments: [], triangles: [], labels: [] };
    const scan = item.meshes ? item.meshes.map((i) => meshData[i]).filter(Boolean) : meshData;
    if (spec.kind === "bbox") {
      const refSide = (nAxis, min, max) => {
        // draw-side reference along the plane normal: mid-plane — the snap then
        // picks whichever anchor is nearer the model's middle along n, keeping
        // the drawing close to where the extent actually occurs.
        return (min[nAxis] + max[nAxis]) / 2;
      };
      placeBox(out, item, spec, choices, { meshData: scan, surfaceHit, modelSize: size }, refSide);
    } else if (spec.kind === "plane") {
      placePlane(out, item, spec, choices, { modelSize: size });
    } else if (spec.kind === "cylinder") {
      placeCylinder(out, item, spec, choices, { modelSize: size });
    }
    if (out.segments.length || out.labels.length) drawings.push(out);
  }
  return drawings;
}
