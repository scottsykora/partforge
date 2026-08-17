// Mesh fillet/chamfer for the Manifold backend — the tangent-wedge CSG technique
// (independently reimplemented from the approach discussed in elalish/manifold
// #1411): for each selected sharp edge chain, build a solid whose curved wall IS
// the rolling-ball blend surface, then boolean it against the part. Convex chains
// subtract a cutter; concave chains union a filler. Because the boolean runs in
// Manifold, output is watertight by construction and the blend radius is exact to
// tessellation.
//
// Edge classes supported:
//   - straight chains with planar flanks           → lofted prism cutter
//   - circular-arc chains with revolved flanks     → revolved cutter (bore rims,
//     cylinder rims, the arcs where fillets meet a face), full circles included
//   - planar contour chains at constant dihedral   → swept cutter/filler along the
//     chain's own polyline (top/bottom rims of extruded text, offset outlines,
//     splines — see tryPlanarChain/planarTool)
// Anything else (helical edges, varying dihedral, branching curves) raises
// UnsupportedEdgeError so a caller can reroute the build to the B-rep backend.
//
// Known limits (documented, not bugs): no spherical corner patches yet — two
// chains meeting at a vertex leave a mitred junction where their blend surfaces
// intersect, and a planar chain split at a sharp corner mitres the same way;
// radius feasibility is the caller's job (clamp like filleted-box.js
// does — an oversized radius self-intersects the cutters).
//
// Selector object mirrors edge-selector.js semantics ({dir, inPlane, at, near});
// `dir` only ever matches straight chains, like replicad's inDirection.
// Pure module: no DOM, no node:, no three — safe anywhere in the worker graph.
import { sweepSeedFrame } from "./sweep.js";

const TOL = 1e-4;            // selector / coplanarity tolerance (mm)
const WELD = 1e6;            // vertex weld quantization (1/WELD mm grid)
const COLLINEAR_DEG = 0.1;   // joints straighter than this extend a line run
const SMOOTH_MAX_DEG = 30;   // joints turning more than this are corners (chain ends)
const DEFAULT_SEGS = 116;    // full-circle tessellation density (preview quality)

export class UnsupportedEdgeError extends Error {
  constructor(message) { super(message); this.name = "UnsupportedEdgeError"; }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? scl(a, 1 / l) : [0, 0, 0]; };
const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const rotVec = (p, k, th) => { // Rodrigues rotation about unit axis k
  const c = Math.cos(th), s = Math.sin(th);
  return add(add(scl(p, c), scl(cross(k, p), s)), scl(k, dot(k, p) * (1 - c)));
};

// ---------------------------------------------------------------------------
// Sharp-edge extraction: weld vertices, keep edges whose two incident triangles
// meet at a dihedral sharper than sharpDeg, tag convexity and flank normals.
export function detectSharpEdges({ positions, indices }, { sharpDeg = 20 } = {}) {
  const nVert = positions.length / 3;
  const weld = new Map(), wid = new Int32Array(nVert), pts = [];
  for (let i = 0; i < nVert; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
    let id = weld.get(key);
    if (id === undefined) { id = pts.length; weld.set(key, id); pts.push([x, y, z]); }
    wid[i] = id;
  }
  const edges = new Map(); // "lo:hi" -> { u, v, faces: [{ n, w }] }
  for (let t = 0; t < indices.length; t += 3) {
    const ids = [wid[indices[t]], wid[indices[t + 1]], wid[indices[t + 2]]];
    const [a, b, c] = ids.map((i) => pts[i]);
    const n = norm(cross(sub(b, a), sub(c, a)));
    if (len(n) === 0) continue; // degenerate sliver
    for (let e = 0; e < 3; e++) {
      const u = ids[e], v = ids[(e + 1) % 3], w = pts[ids[(e + 2) % 3]];
      if (u === v) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      let rec = edges.get(key);
      if (!rec) { rec = { u, v, faces: [] }; edges.set(key, rec); }
      rec.faces.push({ n, w });
    }
  }
  const cosSharp = Math.cos((sharpDeg * Math.PI) / 180);
  const out = [];
  for (const { u, v, faces } of edges.values()) {
    if (faces.length !== 2) continue;
    const [f1, f2] = faces;
    if (dot(f1.n, f2.n) > cosSharp) continue; // smooth or coplanar
    const convex = dot(sub(f2.w, pts[u]), f1.n) < -1e-9;
    out.push({ ua: u, ub: v, a: pts[u], b: pts[v], n1: f1.n, n2: f2.n, convex });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chain sharp edges into straight and circular-arc runs.
//
// Walk maximal paths through the sharp-edge graph (vertices of degree ≠ 2 and
// convexity flips end a path), classify each joint by turn angle, then split
// paths into runs: collinear-joined stretches are line chains; stretches joined
// by "circle-consistent" joints (small turn AND similar edge lengths — a long
// straight edge next to tiny arc facets fails the length test and stays its own
// line chain) are arc candidates, validated by a circumcircle fit. A loop with
// no run boundary at all is a full circle.
export function chainEdges(edges) {
  const COS_COLL = Math.cos((COLLINEAR_DEG * Math.PI) / 180);
  const COS_SMOOTH = Math.cos((SMOOTH_MAX_DEG * Math.PI) / 180);
  const adj = new Map(); // welded vid -> [edge index...]
  edges.forEach((e, i) => {
    for (const v of [e.ua, e.ub]) (adj.get(v) ?? adj.set(v, []).get(v)).push(i);
  });
  const deg = (v) => adj.get(v).length;
  const other = (e, v) => (e.ua === v ? e.ub : e.ua);
  const used = new Array(edges.length).fill(false);

  // orient edge e so it leaves vertex v: returns [from, to, dir]
  const oriented = (e, v) => {
    const from = v === e.ua ? e.a : e.b, to = v === e.ua ? e.b : e.a;
    return { from, to, dir: norm(sub(to, from)) };
  };

  const paths = []; // { members: [edgeIdx...], verts: [vid...], loop }
  const walk = (start, firstEdge) => {
    const members = [firstEdge], verts = [start];
    let v = start, e = firstEdge;
    for (;;) {
      used[e] = true;
      const nv = other(edges[e], v);
      verts.push(nv);
      if (deg(nv) !== 2) break;
      const next = adj.get(nv).find((i) => !used[i]);
      if (next === undefined) break;
      if (edges[next].convex !== edges[e].convex) break; // convexity flip ends the path
      // turn angle gate: corners end paths
      const d1 = oriented(edges[e], v).dir, d2 = oriented(edges[next], nv).dir;
      if (dot(d1, d2) < COS_SMOOTH) break;
      members.push(next);
      v = nv; e = next;
    }
    return { members, verts, loop: verts[0] === verts[verts.length - 1] };
  };
  // open paths first (seeded at non-degree-2 vertices), then leftovers: loops,
  // or open runs whose gates (turn/convexity) broke the walk mid-graph — those
  // are walked in both directions from the seed and stitched
  for (const [v, list] of adj) {
    if (deg(v) === 2) continue;
    for (const i of list) if (!used[i]) paths.push(walk(v, i));
  }
  edges.forEach((_, i) => {
    if (used[i]) return;
    const fwd = walk(edges[i].ua, i);
    if (fwd.loop) { paths.push(fwd); return; }
    // extend backward from the seed vertex if a compatible unused edge remains
    const backSeed = adj.get(edges[i].ua).find((j) => !used[j]);
    if (backSeed === undefined) { paths.push(fwd); return; }
    const back = walk(other(edges[backSeed], edges[i].ua), backSeed);
    paths.push({
      members: [...back.members.slice().reverse(), ...fwd.members],
      verts: [...back.verts.slice().reverse(), ...fwd.verts.slice(1)],
      loop: false,
    });
  });

  // split a path's member list into runs of "line" (collinear joints) and "arc"
  // (circle-consistent joints) edges
  const chains = [];
  for (const path of paths) {
    const { members, verts, loop } = path;
    const dirs = members.map((i, k) => oriented(edges[i], verts[k]).dir);
    const lens = members.map((i) => len(sub(edges[i].b, edges[i].a)));
    const nJoint = loop ? members.length : members.length - 1; // joint j is between member j and j+1 (mod)
    const jointType = []; // "coll" | "circ" | "cut"
    for (let j = 0; j < nJoint; j++) {
      const k2 = (j + 1) % members.length;
      const c = dot(dirs[j], dirs[k2]);
      const ratio = lens[j] / lens[k2];
      if (c >= COS_COLL) jointType.push("coll");
      else if (c >= COS_SMOOTH && ratio > 1 / 3 && ratio < 3) jointType.push("circ");
      else jointType.push("cut");
    }
    // rotate loops so index 0 starts right after a run boundary; a loop with no
    // boundary at all is a closed uniform curve (full circle candidate)
    let order = members.map((_, k) => k);
    let closedUniform = false;
    if (loop) {
      const boundary = jointType.findIndex((t, j) => t !== jointType[(j - 1 + nJoint) % nJoint] || t === "cut");
      const cut = jointType.indexOf("cut");
      const startAfter = cut !== -1 ? cut : boundary !== -1 ? boundary : -1;
      if (startAfter === -1 && jointType.every((t) => t === jointType[0])) closedUniform = true;
      else if (startAfter !== -1) order = order.map((k) => (startAfter + 1 + k) % members.length);
    }
    const runs = [];
    let run = null;
    for (let idx = 0; idx < order.length; idx++) {
      const k = order[idx];
      if (!run) { run = { type: null, ks: [k] }; continue; }
      const t = jointType[order[idx - 1]]; // joint j joins member j and its successor
      if (t === "cut" || (run.type !== null && run.type !== t)) { runs.push(run); run = { type: null, ks: [k] }; }
      else { if (run.type === null) run.type = t; run.ks.push(k); }
    }
    if (run) runs.push(run);
    // a run's type is the joint type joining its members; single-member runs are lines
    const runChains = [];
    for (const r of runs) {
      const type = r.ks.length === 1 || r.type === "coll" || r.type === null ? "line" : "arc";
      runChains.push(buildChain(edges, path, r.ks, type, closedUniform && runs.length === 1));
    }
    // Planar rescue is per-PATH, not per-run, and replaces the WHOLE path's chains: a rim
    // that mixes straight, curvy, and short runs must become ONE swept tool, because
    // per-run tools along the same rim continue each other nearly collinearly — their
    // overshoots then overlap surface-on-surface (not the clean perpendicular crossing of
    // a box corner) and the boolean leaves degenerate seams where identical blend
    // surfaces coincide. A path whose runs are ALL line/arc keeps its exact per-run tools
    // exactly as before — promotion only fires where the path would otherwise reroute.
    if (runChains.some((c) => c.kind === "unsupported")) {
      const rescue = buildPlanarPath(edges, path);
      if (rescue) { chains.push(rescue); continue; }
    }
    chains.push(...runChains);
  }
  return stitchPlanarChains(chains);
}

// Join open planar chains that continue each other across a path junction. The edge walk
// ends a path at any degree≠2 vertex — and a real rim grows one wherever its outline
// turns past sharpDeg, because that corner puts a sharp VERTICAL edge up the wall. The
// rim's halves then arrive as separate open planar chains whose swept tools would cross
// at the junction's own shallow angle — a near-parallel surface overlap that leaves
// degenerate seams (the same disease the whole-path promotion cures within one path).
// Stitched into one chain, the junction becomes an interior vertex: the sweep miters it
// when gentle, and planarTool's fold guard splits it (with a clean, wide-angle mitre
// crossing) when sharp. Chains stitch only when they share an endpoint, the same face
// plane, and the same convexity — the same-plane test is what keeps a top rim from ever
// stitching to a bottom rim.
function stitchPlanarChains(chains) {
  const open = [], out = [];
  for (const c of chains) (c.kind === "planar" && !c.closed ? open : out).push(c);
  if (open.length < 2) return chains;
  const key = (p) => `${Math.round(p[0] * WELD)},${Math.round(p[1] * WELD)},${Math.round(p[2] * WELD)}`;
  const compatible = (a, b) => a.convex === b.convex && dot(a.faceN, b.faceN) > FLANK_COS &&
    Math.abs(dot(a.points[0], a.faceN) - dot(b.points[0], a.faceN)) <= TOL;
  const rev = (c) => ({ ...c, points: [...c.points].reverse(), wallNs: [...c.wallNs].reverse() });
  let progress = true;
  while (progress) {
    progress = false;
    outer: for (let i = 0; i < open.length; i++) {
      const a = open[i], aEnd = key(a.points[a.points.length - 1]);
      for (let j = 0; j < open.length; j++) {
        if (i === j || !compatible(a, open[j])) continue;
        let b = open[j];
        if (key(b.points[b.points.length - 1]) === aEnd) b = rev(b);
        if (key(b.points[0]) !== aEnd) continue;
        const points = [...a.points, ...b.points.slice(1)];
        const closed = key(points[0]) === key(points[points.length - 1]);
        const joined = { ...a, points, wallNs: [...a.wallNs, ...b.wallNs], closed };
        open.splice(Math.max(i, j), 1);
        open.splice(Math.min(i, j), 1);
        (closed ? out : open).push(joined);
        progress = true;
        break outer;
      }
    }
  }
  return [...out, ...open];
}

// Whole-path planar rescue, called by chainEdges when any of a path's runs classified
// unsupported: rebuild the ENTIRE path (every member, in walk order) as one candidate
// planar chain. See the promotion comment at the call site for why the whole path — and
// tryPlanarChain below for what qualifies.
function buildPlanarPath(edges, path) {
  const members = path.members.map((i) => edges[i]);
  const points = [vertPos(members[0], path.verts[0])];
  members.forEach((m, i) => points.push(vertPos(m, otherVid(m, path.verts[i]))));
  return tryPlanarChain(members, points, members[0].convex, path.loop);
}

// Rescue an unsupported path as a PLANAR chain: every point of the path lies in one plane,
// one flank IS that plane's face (a world-constant normal — the top of an extrusion, the
// plate around a boss), and the other flank — the wall — turns with the path at a constant
// dihedral. Top and bottom rims of extruded profiles whose outlines are neither straight
// nor circular (text, offset outlines, splines) are exactly this shape, and they used to
// be this module's most common NEEDS_OCCT reroute. The blend tool for a planar chain is a
// sweep of the same 2-D cross-section the prism and revolve tools use (planarTool below):
// in the sweep's transported frame both flanks have constant coordinates along the whole
// run — the same rotating-frame argument fitArcChain makes about surfaces of revolution —
// so one fixed profile blends the entire path.
//
// Flank pairing keys on the CANDIDATE face normal itself (each of member 0's two flanks
// in turn): every member contributes whichever of its flanks lies closer to the candidate.
// Neighbor-pairing — the trick classifyChain's line branch uses — is deliberately NOT
// reused here: over a long turning run the wall normal rotates far enough that it pairs
// against the face and scrambles both columns (measured on a 37-edge run of the wavy-rim
// fixture). Keying on the candidate is stable however far the wall turns, because the
// true face flank stays within FLANK_COS of it while the wall sits a whole dihedral away.
// A run where neither candidate yields a constant column (a helix, a saddle) returns null
// and stays unsupported — the rescue never guesses.
const FLANK_COS = 0.9986;   // ~3°, the same constancy bar the line classifier uses
function tryPlanarChain(members, points, convex, closed) {
  if (points.length < 3) return null;              // a 2-point run is a line chain's job
  for (const cand of [members[0].n1, members[0].n2]) {
    const face = [], wall = [];
    for (const m of members) {
      const [f, wl] = dot(m.n1, cand) >= dot(m.n2, cand) ? [m.n1, m.n2] : [m.n2, m.n1];
      face.push(f);
      wall.push(wl);
    }
    const meanRaw = face.reduce((s, f) => add(s, f), [0, 0, 0]);
    if (len(meanRaw) < 1e-9) continue;
    const w = norm(meanRaw);
    if (!face.every((f) => dot(f, w) > FLANK_COS)) continue;          // not world-constant
    const d0 = dot(points[0], w);
    if (!points.every((p) => Math.abs(dot(p, w) - d0) <= TOL)) continue;   // run not in the face plane
    const dots = wall.map((n) => dot(n, w));
    const meanDot = dots.reduce((s, x) => s + x, 0) / dots.length;
    if (!dots.every((x) => Math.abs(x - meanDot) <= 0.05)) continue;  // dihedral drifts (~3°)
    return { kind: "planar", points, closed, convex, w, faceN: w, wallNs: wall };
  }
  return null;
}

function buildChain(edges, path, ks, type, closed) {
  // ks are positions along the path; path.members maps them to global edge indices
  const members = ks.map((k) => edges[path.members[k]]);
  const convex = members[0].convex;
  // ordered polyline: the member at path position k runs path.verts[k] -> path.verts[k+1]
  const points = [vertPos(members[0], path.verts[ks[0]])];
  ks.forEach((k, i) => points.push(vertPos(members[i], otherVid(members[i], path.verts[k]))));
  if (type !== "arc") {
    // pair flank normals consistently against the first member (world frame is
    // fine here — straight chains have near-constant flank normals)
    const ref = members[0];
    const flanks = members.map((m) => (dot(m.n1, ref.n1) >= dot(m.n2, ref.n1) ? [m.n1, m.n2] : [m.n2, m.n1]));
    const a = points[0], b = points[points.length - 1];
    const dir = norm(sub(b, a));
    const n1 = norm(flanks.reduce((s, f) => add(s, f[0]), [0, 0, 0]));
    const n2 = norm(flanks.reduce((s, f) => add(s, f[1]), [0, 0, 0]));
    // planar-flank sanity: every member within ~3° of the mean
    const planar = flanks.every((f) => dot(f[0], n1) > 0.9986 && dot(f[1], n2) > 0.9986);
    if (!planar) return { kind: "unsupported", reason: "straight edge with non-planar flanks", points, convex };
    return { kind: "line", points, a, b, dir, length: len(sub(b, a)), n1, n2, convex };
  }
  return fitArcChain(members, points, convex, closed);
}
const vertPos = (e, vid) => (vid === e.ua ? e.a : e.b);
const otherVid = (e, vid) => (vid === e.ua ? e.ub : e.ua);

// Circumcircle fit + rotating-frame flank extraction for an arc run.
function fitArcChain(members, points, convex, closed) {
  const bad = (reason) => ({ kind: "unsupported", reason, points, convex });
  const n = points.length;
  if (n < 3) return bad("arc run too short to fit");
  const p0 = points[0], pm = points[Math.floor(n / 2)], pn = closed ? points[Math.floor((2 * n) / 3)] : points[n - 1];
  // circumcircle of three points
  const e1 = sub(pm, p0), e2 = sub(pn, p0);
  const w0 = cross(e1, e2);
  if (len(w0) < 1e-12) return bad("arc points are collinear");
  const w = norm(w0);
  const l1 = dot(e1, e1), l2 = dot(e2, e2), c12 = dot(e1, e2);
  const det = 2 * (l1 * l2 - c12 * c12);
  const alpha = (l2 * (l1 - c12)) / det, beta = (l1 * (l2 - c12)) / det;
  const O = add(p0, add(scl(e1, alpha), scl(e2, beta)));
  const R = len(sub(p0, O));
  const rtol = Math.max(1e-3, 1e-3 * R);
  for (const p of points) {
    if (Math.abs(len(sub(p, O)) - R) > rtol) return bad("edge curve is not circular");
    if (Math.abs(dot(sub(p, O), w)) > rtol) return bad("edge curve is not planar");
  }
  // frame: azimuth 0 at the first point; flip w so azimuths increase along the run
  const u0 = norm(sub(points[0], O));
  let v0 = cross(w, u0);
  const az = (p) => Math.atan2(dot(sub(p, O), v0), dot(sub(p, O), u0));
  let wS = w, v0S = v0;
  if (!closed && az(points[1]) < 0) { wS = scl(w, -1); v0S = cross(wS, u0); }
  else if (closed && az(points[1]) < 0) { wS = scl(w, -1); v0S = cross(wS, u0); }
  const azS = (p) => { const a = Math.atan2(dot(sub(p, O), v0S), dot(sub(p, O), u0)); return a < -1e-9 ? a + 2 * Math.PI : a; };
  let span = 2 * Math.PI;
  if (!closed) {
    let prev = 0;
    for (let i = 1; i < n; i++) {
      const a = azS(points[i]);
      if (a < prev - 1e-9) return bad("arc azimuths not monotonic");
      prev = a;
    }
    span = azS(points[n - 1]);
  }
  // rotating-frame flanks: constant (ρ, ζ) components, negligible azimuthal part.
  // Pairing happens HERE, in the rotating frame — a revolved wall's world-space
  // normal flips sign across the circle, so world-frame pairing would swap flanks
  // on the far side.
  const rfRaw = members.map((m) => {
    const mid = scl(add(vertPos(m, m.ua), vertPos(m, m.ub)), 0.5);
    const th = azS(mid);
    const rho = add(scl(u0, Math.cos(th)), scl(v0S, Math.sin(th)));
    const azv = cross(wS, rho);
    return [m.n1, m.n2].map((f) => {
      if (Math.abs(dot(f, azv)) > 0.2) return null; // not a surface of revolution about this axis
      const v2 = [dot(f, rho), dot(f, wS)];
      const l = Math.hypot(v2[0], v2[1]);
      return [v2[0] / l, v2[1] / l];
    });
  });
  if (rfRaw.some((pair) => pair.some((f) => f === null))) return bad("flank is not a surface of revolution about the edge axis");
  const refRf = rfRaw[0];
  const rf = rfRaw.map(([f1, f2]) =>
    f1[0] * refRf[0][0] + f1[1] * refRf[0][1] >= f2[0] * refRf[0][0] + f2[1] * refRf[0][1] ? [f1, f2] : [f2, f1]);
  const mean = (idx) => {
    const s = rf.reduce((acc, pair) => [acc[0] + pair[idx][0], acc[1] + pair[idx][1]], [0, 0]);
    const l = Math.hypot(s[0], s[1]); return [s[0] / l, s[1] / l];
  };
  const n1 = mean(0), n2 = mean(1);
  const ok = rf.every((pair) => pair[0][0] * n1[0] + pair[0][1] * n1[1] > 0.9986 && pair[1][0] * n2[0] + pair[1][1] * n2[1] > 0.9986);
  if (!ok) return bad("flank angle varies along the arc");
  return { kind: "arc", points, O, w: wS, u0, v0: v0S, R, span, closed, n1, n2, convex };
}

// ---------------------------------------------------------------------------
// Selector: the edge-selector.js object form, evaluated against a chain.
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PLANE_AXIS = { XY: 2, XZ: 1, YZ: 0 };
export function matchesSelector(chain, sel) {
  if (sel == null) return true;
  if (typeof sel === "function")
    throw new UnsupportedEdgeError("function selectors are OCCT-specific — use the {dir, inPlane, at, near} object form");
  const { dir, inPlane, at, near } = sel;
  if (dir !== undefined) {
    if (chain.kind !== "line") return false; // like replicad inDirection: straight edges only
    const d = Array.isArray(dir) ? norm(dir) : AXIS[dir];
    if (!d) throw new Error(`mesh fillet: unknown dir ${JSON.stringify(dir)}`);
    if (Math.abs(dot(chain.dir, d)) < Math.cos((1 * Math.PI) / 180)) return false;
  }
  if (inPlane !== undefined) {
    const ax = PLANE_AXIS[inPlane];
    if (ax === undefined) throw new Error(`mesh fillet: unknown inPlane ${JSON.stringify(inPlane)}`);
    const c = at ?? 0;
    if (!chain.points.every((p) => Math.abs(p[ax] - c) <= TOL)) return false;
  }
  if (near !== undefined) {
    if (chain.kind === "arc") {
      // Select against the fitted circle, not its tessellated chords. An exact
      // design-space point between two mesh vertices sits one facet sagitta away
      // from the chord and must not spuriously miss (and reroute to OCCT).
      const q = sub(near, chain.O);
      const axial = dot(q, chain.w);
      const radial = sub(q, scl(chain.w, axial));
      if (Math.abs(axial) > TOL || Math.abs(len(radial) - chain.R) > TOL) return false;
      if (!chain.closed) {
        let az = Math.atan2(dot(radial, chain.v0), dot(radial, chain.u0));
        if (az < 0) az += 2 * Math.PI;
        const angularTol = TOL / Math.max(chain.R, TOL);
        if (az > chain.span + angularTol && 2 * Math.PI - az > angularTol) return false;
      }
    } else {
      let best = Infinity;
      for (let i = 0; i + 1 < chain.points.length; i++) {
        const a = chain.points[i], b = chain.points[i + 1];
        const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(near, a), ab) / (dot(ab, ab) || 1)));
        best = Math.min(best, len(sub(near, add(a, scl(ab, t)))));
      }
      if (best > TOL) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shared 2D cross-section profile. P is the edge point, n1/n2 the unit flank
// normals, all in the cross-section plane. Fillet connects the tangent points
// with the rolling-ball arc; chamfer with a straight chord. Convex profiles
// hang off the corner (oversized past it by delta so no cutter wall is exactly
// coplanar with a flank); concave profiles tuck the corner point into the
// material so the filler welds on.
const rot2 = ([x, y], th) => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)];
function profile2D({ P, n1, n2, magnitude, mode, convex, segs, ext = 0 }) {
  const c = clamp1(n1[0] * n2[0] + n1[1] * n2[1]);
  if (1 + c < 1e-6) throw new UnsupportedEdgeError("~180° knife edge");
  const bl = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]);
  const bis = [(n1[0] + n2[0]) / bl, (n1[1] + n2[1]) / bl];
  const delta = 0.02 * magnitude;
  const sgn = convex ? 1 : -1; // +bis is outside the material at a convex corner, inside at a concave one
  const corner = [P[0] + sgn * delta * bis[0], P[1] + sgn * delta * bis[1]];
  if (mode === "chamfer") {
    // setback along each flank surface, away from the edge: perpendicular to the
    // normal, on the material side of the bisector (which points out of the
    // material at a convex corner and into the air pocket at a concave one)
    const inFace = (nv) => {
      let f = [-nv[1], nv[0]];
      if (sgn * (f[0] * bis[0] + f[1] * bis[1]) > 0) f = [-f[0], -f[1]];
      return f;
    };
    const f1 = inFace(n1), f2 = inFace(n2);
    const T1 = [P[0] + magnitude * f1[0], P[1] + magnitude * f1[1]];
    const T2 = [P[0] + magnitude * f2[0], P[1] + magnitude * f2[1]];
    if (ext > 0) {
      // revolve tools: extend the chord past both flanks so the tool's closing
      // walls clear the flank tessellation instead of hugging it (same float
      // phase-noise issue the fillet's arc extension solves); the extra polygon
      // area lies outside the material for cutters and inside it for fillers
      const ux = T1[0] - T2[0], uy = T1[1] - T2[1], ul = Math.hypot(ux, uy);
      const e = 0.02 * magnitude;
      T1[0] += (e * ux) / ul; T1[1] += (e * uy) / ul;
      T2[0] -= (e * ux) / ul; T2[1] -= (e * uy) / ul;
    }
    return [corner, T1, T2];
  }
  const r = magnitude;
  const C = [P[0] + sgn * (-r / (1 + c)) * (n1[0] + n2[0]), P[1] + sgn * (-r / (1 + c)) * (n1[1] + n2[1])];
  const phi = Math.atan2(n1[0] * n2[1] - n1[1] * n2[0], c); // signed angle n1 → n2
  // `ext` (radians) continues the arc a hair past both tangent points — used by
  // revolve cutters only. At the tangent the blend surface touches the flank
  // without crossing it; for two curved tessellations (posed revolve vs flank
  // facets) float phase noise turns that contact into a wiggle of degenerate
  // sliver triangles. Overshooting makes the cutter cross the flank decisively,
  // penetrating the material by only r·(1−cos ext) ≈ r·5e-5 mm, far below
  // visibility, and the extension curves into the material for cutters and
  // fillers alike. Prism cutters keep ext = 0: their tangent contact is
  // plane-on-plane, which the kernel resolves exactly.
  const s2 = Math.sign(phi) || 1, span = Math.abs(phi);
  const nArc = Math.max(2, Math.ceil((span / (2 * Math.PI)) * segs));
  const pts = [corner];
  for (let i = 0; i <= nArc; i++) {
    const nv = rot2(n1, s2 * (-ext + ((span + 2 * ext) * i) / nArc));
    pts.push([C[0] + sgn * r * nv[0], C[1] + sgn * r * nv[1]]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Cutter/filler solids.
function prismTool(k, chain, magnitude, mode, segs) {
  const { a, dir: e, length, n1, n2, convex } = chain;
  // pose rotation Z → e; the 2D basis is the image of X,Y under the SAME rotation
  const axisRaw = cross([0, 0, 1], e);
  const s = len(axisRaw);
  let axis = null, theta = 0;
  if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, e[2]); }
  else if (e[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
  const u = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
  const v = axis ? rotVec([0, 1, 0], axis, theta) : [0, 1, 0];
  const p2 = (w) => [dot(w, u), dot(w, v)];
  const poly = profile2D({ P: [0, 0], n1: p2(n1), n2: p2(n2), magnitude, mode, convex, segs });
  // convex cutters overshoot the edge ends (sticking outside the solid is
  // harmless when subtracting); concave fillers must end flush — any overshoot
  // would bulge outside the part when unioned
  const over = convex ? Math.max(1e-3, 0.05 * magnitude) : 0;
  let tool = k.loft(
    [{ polygon: poly, z: -over }, { polygon: poly, z: length + over }],
    { shading: "smooth" },
  );
  if (axis) tool = tool.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
  return tool.translate(a);
}

function revolveTool(k, chain, magnitude, mode, segs) {
  const { O, w, u0, v0, R, span, closed, n1, n2, convex } = chain;
  // Seam-grazing guard. The edge circle passes through the flank tessellation's
  // VERTICES (circumradius) while its facets sit at the apothem, so a revolved
  // tool built exactly at R grazes every facet seam tangentially — Manifold
  // keeps the resulting epsilon-degenerate needle triangles, and simplify()
  // cannot always collapse them. `sag` is that facet sagitta plus a roundoff pad
  // bounded relative to the requested feature, so tiny blends never inherit a
  // fixed allowance larger than their own cross-section.
  const sag = (R + magnitude) * (1 - Math.cos(Math.PI / segs)) + Math.min(2e-4, 0.02 * magnitude);
  // Fillet: size the arc-tail extension to cross the facet planes, but cap it at
  // 0.4 rad. Below the mesh's own facet scale a larger tail wraps around the tiny
  // profile and creates one tunnel per facet; the cap bounds penetration to 8%
  // of the requested radius while the cutter's outside corner still opens into
  // free space.
  const ext = Math.min(0.4, Math.max(0.01, Math.acos(Math.max(-1, 1 - sag / magnitude))));
  let poly = profile2D({ P: [R, 0], n1, n2, magnitude, mode, convex, segs, ext });
  if (mode === "chamfer") {
    // Chamfer: the cone itself is the cutting surface — no tail to extend, so
    // bury the whole profile by `sag` along the material-side bisector instead.
    // The chamfer lands microns deep; dimensionally invisible.
    const bl2 = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]);
    const bis2 = [(n1[0] + n2[0]) / bl2, (n1[1] + n2[1]) / bl2];
    // A convex cutter must leave its outside closure corner unburied: moving the
    // whole profile inward can close a micro-tunnel per flank facet when sag is
    // larger than a tiny chamfer. A concave filler needs every point buried so
    // it overlaps the source solid instead of leaving disconnected components.
    poly = poly.map(([x, y], i) => i === 0 && convex ? [x, y] : [x - sag * bis2[0], y - sag * bis2[1]]);
  }
  if (poly.some(([x]) => x <= 0)) throw new UnsupportedEdgeError("fillet crosses the revolve axis (radius too large for this bore)");
  // enforce CCW winding for the revolve
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) poly = poly.slice().reverse();
  const ovAng = closed || !convex ? 0 : Math.min(0.15, Math.max(1e-3, (0.05 * magnitude) / R));
  const degrees = closed ? 360 : ((span + 2 * ovAng) * 180) / Math.PI;
  let tool = k.revolve(poly, { degrees });
  // pose: Z → w, then twist so the revolve's start azimuth (+X) lands on the
  // chain's start direction (backed off by the angular overshoot)
  const startDir = closed ? u0 : add(scl(u0, Math.cos(-ovAng)), scl(v0, Math.sin(-ovAng)));
  const axisRaw = cross([0, 0, 1], w);
  const s = len(axisRaw);
  let axis = null, theta = 0;
  if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, w[2]); }
  else if (w[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
  if (axis) tool = tool.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
  const xImage = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
  // Closed revolves get an extra half-facet twist: at 360° the tool's facet
  // pitch exactly matches the flank's, and phase-aligned seams graze vertex-on-
  // vertex at every step (the degenerate-needle generator). Half a step lands
  // every crossing mid-facet. Partial arcs have a slightly different pitch
  // (degrees don't divide evenly) and never align in the first place.
  const dephase = closed ? Math.PI / segs : 0;
  const twist = Math.atan2(dot(w, cross(xImage, startDir)), dot(xImage, startDir)) + dephase;
  if (Math.abs(twist) > 1e-9) tool = tool.rotateAbout({ axis: w, deg: (twist * 180) / Math.PI });
  return tool.translate(O);
}

// ---------------------------------------------------------------------------
// Planar-chain blend tool: sweep the shared 2-D cross-section (profile2D) along the
// chain's own polyline with k.sweep — a prism IS the one-segment case of this sweep,
// generalized to a path that turns. In the sweep's transported frame the face and wall
// flanks keep constant coordinates along a planar constant-dihedral path, so ONE profile
// polygon serves every station; sweepSeedFrame gives the exact frame the sweep will seed,
// so the profile is authored in it rather than re-deriving (and drifting from) the pick.
//
// The sweep miters gently-turning joints on its own. A vertex whose miter would fold —
// a sharp corner, a reversal cusp, a segment shorter than the profile's reach — SPLITS
// the chain there instead, and each open stretch overshoots its ends the way prism
// cutters do, so adjacent stretches mitre into each other across the split. Concave
// fillers stay flush at their ends — overshoot would bulge outside the part when unioned
// (prismTool's own rule) — which can leave a hairline notch in a bead at a split; that is
// the mitred-junction limit from the module header, not a leak (the boolean stays
// watertight). Any residual sweep refusal (float-edge fold the pre-split missed) is
// converted to UnsupportedEdgeError so the caller reroutes to OCCT instead of failing
// the build. Returns an ARRAY of tools — one per stretch.
function planarTool(k, chain, magnitude, mode, segs) {
  const { points, closed, convex, faceN, wallNs } = chain;
  const pts = closed ? points.slice(0, -1) : points;   // drop the duplicated closure point
  const m = pts.length;
  const at = (i) => pts[((i % m) + m) % m];
  const nSeg = closed ? m : m - 1;
  const segDir = [], segLen = [];
  for (let i = 0; i < nSeg; i++) {
    const d = sub(at(i + 1), at(i)), l = len(d);
    segDir.push(scl(d, 1 / (l || 1)));
    segLen.push(l);
  }

  // Fold guard, mirrored from resolveSweepStations' miter check with a stricter factor
  // (0.45 vs 0.5) so the split fires before the sweep would throw. `reach` is a cheap
  // rigid upper bound on the profile's half-width — exact reach needs the profile, the
  // profile needs the stretch, and conservatism here only costs an extra mitred split.
  const reach = magnitude * 1.5;
  const isBreak = (i) => {   // vertex i, with a segment on both sides
    const dIn = segDir[(i - 1 + nSeg) % nSeg], dOut = segDir[i];
    const c = clamp1(dot(dIn, dOut));
    if (c < -1 + 1e-6) return true;                                  // reversal cusp
    return reach * Math.tan(Math.acos(c) / 2) > 0.45 * Math.min(segLen[(i - 1 + nSeg) % nSeg], segLen[i]);
  };
  const breaks = [];
  for (let i = closed ? 0 : 1; i < (closed ? m : m - 1); i++) if (isBreak(i)) breaks.push(i);

  const over = convex ? Math.max(1e-3, 0.05 * magnitude) : 0;
  const overshoot = (path) => {
    if (!(over > 0) || path.length < 2) return path;
    const a = path[0], b = path[1], y = path[path.length - 1], x = path[path.length - 2];
    return [add(a, scl(norm(sub(a, b)), over)), ...path, add(y, scl(norm(sub(y, x)), over))];
  };

  // One tool per stretch. The profile's wall normal is the SEED member's — the segment
  // whose tangent the sweep frame is seeded ⟂ to: the closing segment for a closed loop,
  // the first segment for an open stretch (overshoot extends along that same tangent, so
  // it never changes the seed).
  // ext stays 0 for every planar sweep, cutters and fillers alike — measured both ways
  // on the fixtures. Stations sit ON the path vertices, so the profile's tangent lines
  // ride the flank facets exactly: plane-on-plane contact the kernel resolves cleanly.
  // An arc-tail extension (revolveTool's recipe for curved-vs-curved phase noise) turns
  // that exact contact into a ~2° grazing CROSSING — and a grazing crossing's float
  // wiggle carves sliver seams whether the tool is subtracted or unioned, because the
  // crossing curve is exactly where the boolean's boundary hands over, always exposed.
  const toolFor = (path3D, isClosed, wallN) => {
    const { N, B } = sweepSeedFrame(path3D, isClosed);
    const p2 = (v) => {
      const q = [dot(v, N), dot(v, B)], l = Math.hypot(q[0], q[1]) || 1;
      return [q[0] / l, q[1] / l];
    };
    const poly = profile2D({ P: [0, 0], n1: p2(faceN), n2: p2(wallN), magnitude, mode, convex, segs });
    return k.sweep(poly, path3D, { closed: isClosed });
  };

  try {
    if (closed && breaks.length === 0) {
      return [toolFor(pts.map((p) => [p[0], p[1], p[2]]), true, wallNs[nSeg - 1])];
    }
    // Open stretches between breaks. An open chain's endpoints are implicit breaks; a
    // closed chain's stretches wrap from each break to the next.
    const bounds = closed
      ? breaks.map((b, j) => [b, breaks[(j + 1) % breaks.length] + (j + 1 === breaks.length ? m : 0)])
      : (breaks.length ? [[0, breaks[0]], ...breaks.map((b, j) => [b, j + 1 < breaks.length ? breaks[j + 1] : m - 1])] : [[0, m - 1]]);
    const tools = [];
    for (const [s, e] of bounds) {
      if (e <= s) continue;
      const path = [];
      for (let i = s; i <= e; i++) path.push(at(i));
      tools.push(toolFor(overshoot(path), false, wallNs[s % nSeg]));
    }
    return tools;
  } catch (e) {
    throw new UnsupportedEdgeError(`planar sweep: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Spherical corner patches. Where exactly three selected straight convex chains
// meet at a vertex with mutually orthogonal directions (a box-like corner), the
// three edge blends are capped with a rolling-ball sphere octant instead of the
// default mitre: cutter = corner cube − sphere(C, r), the classic corner-mask
// construction, with C = V + r·(ê1+ê2+ê3) (distance r inside each face). The
// cube spans exactly [V, V + r·ê_j] — the sphere-cylinder tangent planes —
// because inside that cube the true rolling-ball surface is PURE sphere (the
// edge cylinders end at the tangent planes; extending protection cylinders in
// here would preserve their proud Steinmetz-intersection ridges instead of the
// sphere patch, and extending the cube out would gouge the edge fillets). The
// cube's outer walls land inside the material the edge cutters already remove,
// so the only new surface is the octant. Non-orthogonal corners keep the mitre
// — the safe, documented default.
function cornerPatches(k, selected, r, segs) {
  const lines = selected.filter((ch) => ch.kind === "line" && ch.convex);
  const byVertex = new Map();
  for (const ch of lines) {
    for (const [pt, dirOut] of [[ch.a, ch.dir], [ch.b, scl(ch.dir, -1)]]) {
      const key = pt.map((v) => Math.round(v * 1e4)).join(",");
      (byVertex.get(key) ?? byVertex.set(key, []).get(key)).push({ pt, dirOut });
    }
  }
  const patches = [];
  for (const ends of byVertex.values()) {
    if (ends.length !== 3) continue;
    let [e1, e2, e3] = ends.map((e) => e.dirOut);
    const ortho = Math.abs(dot(e1, e2)) < 1e-3 && Math.abs(dot(e1, e3)) < 1e-3 && Math.abs(dot(e2, e3)) < 1e-3;
    if (!ortho) continue; // non-orthogonal trihedral: leave the mitre
    if (dot(cross(e1, e2), e3) < 0) [e2, e3] = [e3, e2]; // right-handed frame
    const V = ends[0].pt;
    const C = add(V, scl(add(add(e1, e2), e3), r));
    const dOut = 0.02 * r;
    // Bury the sphere a hair into the material (past its own facet sagitta): it
    // is tangent to each flat face at a point and meets the edge-fillet
    // cylinders tangentially at the cube walls, and tessellated tangency
    // produces the same grazing-noise creases the edge tools guard against.
    const bury = r * (1 - Math.cos(Math.PI / segs)) + 1e-3;
    const inward = norm(add(add(e1, e2), e3));
    // corner block: cube spanned by the edge frame, oversized only outward
    let block = k.box({ min: [-dOut, -dOut, -dOut], max: [r, r, r] });
    // pose standard axes onto (e2, e3, e1): Z → e1, then twist X-image onto e2
    const axisRaw = cross([0, 0, 1], e1);
    const s = len(axisRaw);
    let axis = null, theta = 0;
    if (s > 1e-9) { axis = scl(axisRaw, 1 / s); theta = Math.atan2(s, e1[2]); }
    else if (e1[2] < 0) { axis = [1, 0, 0]; theta = Math.PI; }
    if (axis) block = block.rotateAbout({ axis, deg: (theta * 180) / Math.PI });
    const xImage = axis ? rotVec([1, 0, 0], axis, theta) : [1, 0, 0];
    const twist = Math.atan2(dot(e1, cross(xImage, e2)), dot(xImage, e2));
    if (Math.abs(twist) > 1e-9) block = block.rotateAbout({ axis: e1, deg: (twist * 180) / Math.PI });
    block = block.translate(V);
    patches.push(block.cut(k.sphere({ r }).at(add(C, scl(inward, bury)))));
  }
  return patches;
}

// ---------------------------------------------------------------------------
// Entry points.
//   meshFillet(k, solid, { r, edges?, segs?, sharpDeg? })  → Solid
//   meshChamfer(k, solid, { d, edges?, segs?, sharpDeg? }) → Solid
export function meshFillet(k, solid, opts) { return apply(k, solid, "fillet", opts?.r, opts); }
export function meshChamfer(k, solid, opts) { return apply(k, solid, "chamfer", opts?.d, opts); }

function apply(k, solid, mode, magnitude, { edges, segs = DEFAULT_SEGS, sharpDeg = 20 } = {}) {
  if (!(magnitude > 0)) throw new Error(`mesh ${mode}: magnitude must be > 0`);
  const chains = chainEdges(detectSharpEdges(solid.toIndexedMesh(), { sharpDeg }));
  const selected = chains.filter((ch) => matchesSelector(ch, edges));
  if (!selected.length) throw new UnsupportedEdgeError(`${mode} selector matched no sharp edges`);
  const unsupported = selected.find((ch) => ch.kind === "unsupported");
  if (unsupported) throw new UnsupportedEdgeError(`${mode}: ${unsupported.reason}`);
  const toolsFor = (ch) =>
    ch.kind === "planar"
      ? planarTool(k, ch, magnitude, mode, segs)
      : [(ch.kind === "arc" ? revolveTool : prismTool)(k, ch, magnitude, mode, segs)];
  const cutters = selected.filter((ch) => ch.convex).flatMap(toolsFor);
  const fillers = selected.filter((ch) => !ch.convex).flatMap(toolsFor);
  if (mode === "fillet") cutters.push(...cornerPatches(k, selected, magnitude, segs));
  let out = solid;
  if (cutters.length) out = out.cutAll(cutters);
  if (fillers.length) out = k.union([out, ...fillers]);
  return out;
}
