# Offset Winding Resolver (Face-Labeled) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the offset engine's cleanup path with a winding resolver whose piece
classification comes from planar-arrangement face labeling (combinatorial winding
propagation) instead of per-piece geometric probes, fixing the text-offset regression
without the pinch-vertex dead-end class that sank branch `claude/offset-winding-resolver`.

**Architecture:** Port the prior branch's verified components (crossings, clustering,
splitting, coincidence, chaining, orchestrator, oracles, corpus) from commit `7d4df16`;
rewrite only `_classify`: build half-edge face orbits with the verified leftmost-turn rule,
anchor one face per connected component at its bottom-most point, propagate winding
combinatorially (BFS, conflict ⇒ loud throw), keep a piece iff its two face labels straddle
`w ≥ 1`.

**Tech Stack:** Plain ESM JavaScript, vitest, paper.js (intersection finding only),
manifold-3d WASM in oracle tests (Clipper2 embedded, used as polygon-set assembler).

**Spec:** `docs/superpowers/specs/2026-08-15-offset-winding-faces-design.md`
(and, for background, the prior branch's spec at
`git show 7d4df16:docs/superpowers/specs/2026-08-15-offset-winding-resolver-design.md`)

## Global Constraints

- **Node 24 required.** The sandbox blocks `source`; prefix every npm/npx/node command with
  `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" && `.
- All ports are pinned to commit `7d4df16` (branch `claude/offset-winding-resolver` HEAD at
  plan time). Extract with `git show 7d4df16:<path>`.
- `src/framework/geometry/contour-winding.js` must stay DOM-free, `three`-free,
  `node:`-free (`test/worker-layering.test.js` enforces the worker graph).
- Units are millimetres. Contour IR: `{ start:[x,y], segments:[{to}|{to,via}|{to,c1,c2}] }`,
  rings explicitly closed, outers CCW, holes CW.
- Pinned error messages, byte-identical:
  - `'Shape2D.offset: corners must be "round" | "chamfer" | "sharp"'`
  - `"Shape2D.offset: delta must be a finite number"`
  - `"Shape2D.offset: offset collapses the shape (reduce |delta|)"`
  - `"contour-winding: could not chain offset boundary (incomplete intersection set)"`
- **Never weaken an assertion or loosen a tolerance to make a test pass.** Every moved
  expectation must be justified against an independent oracle (Minkowski helper, closed
  form, or Clipper2) — report, don't re-baseline on faith.
- The full suite (`npm test`) must be green before every commit.
- Grep `docs/ERROR-PATTERNS.md` on any confusing failure (repo rule).
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` plus the
  session line the harness mandates.
- Branch: `worktree-offset-winding-rewrite` (worktree off `origin/main` = `f3ce357` =
  shipped 0.59.0).

## Reference: verified API facts (from the prior branch's review, rely on them)

- `toPaperPath(scope, contour, segMap)` fills `segMap[paperCurveIndex] === irSegmentIndex`.
- `path.getIntersections()` → self-intersections; each location has `.curve.index`,
  `.time`, `.point`, `.intersection` (partner location). Self-crossings: push BOTH `loc`
  and `loc.intersection` (each is one distinct (seg, t) record).
- `irTime` recovers the IR parameter from the intersection POINT: linear in position for a
  line, linear in ANGLE for an arc (`arcCenterAndSweep`), paper time for a cubic. Exact to
  ~2e-16.
- `trimSegment(from, seg, tStart, tEnd)` preserves segment kind; arc `via` recomputed at
  the kept sweep's angular midpoint.
- `segTangent(from, seg, atStart)` is exact for arcs (⊥ radius, oriented by `dA`'s sign)
  and handles the degenerate `c1 === from` cubic.
- Paper's `addCurveIntersections` bails at 40 recursion levels / 4096 calls, returning a
  PARTIAL set on pathological input — detected downstream (BFS conflict / chain throw).
- Crossing a directed edge from its left to its right changes winding by −(net
  multiplicity of coincident directed edges on that span) — Ruling 8.

## File structure

| File | Responsibility |
|---|---|
| `src/framework/geometry/contour-ops.js` | +2 exports (`trimSegment`, `segTangent`), bodies untouched |
| `src/framework/geometry/paper-bridge.js` | +`ringCrossings`/`irTime`; −`resolveSelfRegions` (Task 5) |
| `src/framework/geometry/contour-winding.js` | NEW — cluster, split (with exact endpoint tangents), coincidence, face graph, winding propagation, chain, `resolveOffsetWinding` |
| `src/framework/geometry/contour-offset.js` | branch orchestrator: gated trim, 7C validation, `rawOffset`, ladder, `offsetRegions` |
| `test/contour-winding.test.js` | ported branch tests minus probe-specific blocks, plus face-labeling tests |
| `test/contour-offset.test.js` | branch version (ported) |
| `test/helpers/minkowski-oracle.js`, `test/minkowski-oracle.test.js` | ported verbatim |
| `test/helpers/offset-corpus.js`, `test/offset-fuzz.test.js` | ported verbatim |
| `test/offset-oracle-manifold.test.js` | branch version, with parked throws converted to correctness |
| `test/offset-text.test.js` | NEW — the reported case ("Scott") + glyph topology table vs Clipper2 |
| `scripts/offset-rates.mjs`, `package.json` | ported rate instrument + `offset-rates` script + version 0.60.0 |
| `docs/ERROR-PATTERNS.md`, `docs/KERNEL-CONTRACT.md` | branch sections rewritten for the face mechanism, all rates re-measured |

---

### Task 1: Foundations — `trimSegment`/`segTangent` exports, `ringCrossings` + `irTime`

**Files:**
- Modify: `src/framework/geometry/contour-ops.js:127,284` (add `export` keyword + the
  branch's comment above `segTangent`)
- Modify: `src/framework/geometry/paper-bridge.js` (append `irTime` + `ringCrossings`)
- Create: `test/contour-winding.test.js` (first sections only)

**Interfaces:**
- Produces: `trimSegment(from, seg, tStart, tEnd) -> {from, seg}` (kind-preserving),
  `segTangent(from, seg, atStart) -> [x,y]` from `contour-ops.js`;
  `ringCrossings(rings) -> [{ring, seg, t, point}]` from `paper-bridge.js`.

- [ ] **Step 1: Write the failing tests** — extract the branch's test sections for
  trimSegment / ringCrossings / IR-parameter recovery (lines 1–151 of the branch file):
  `git show 7d4df16:test/contour-winding.test.js | sed -n '1,151p'` — take the
  `trimSegment…`, `ringCrossings`, and `ringCrossings reports the IR parameter…` describe
  blocks and only the imports they need (`ringCrossings`, `trimSegment`,
  `tessellateContour`; NOT the contour-winding module yet). Trim the import list to what
  compiles.
- [ ] **Step 2: Run to verify failure** —
  `npx vitest run test/contour-winding.test.js` → FAIL (exports missing).
- [ ] **Step 3: Apply the branch's contour-ops.js diff** (export keywords + comment):
  `git diff f3ce357..7d4df16 -- src/framework/geometry/contour-ops.js` shows the exact
  ±10 lines; apply identically.
- [ ] **Step 4: Port `irTime` + `ringCrossings`** — from
  `git show 7d4df16:src/framework/geometry/paper-bridge.js` copy the two functions and
  their comments verbatim into the base file (keep `resolveSelfRegions` for now — the base
  orchestrator still calls it until Task 5). Keep the existing
  `export { paperScope, toContour, toOpenContour, groupPaperPaths };` line.
- [ ] **Step 5: Run tests** → PASS. Run the full suite → green.
- [ ] **Step 6: Commit** `feat: export trimSegment/segTangent, add ringCrossings with exact IR parameter recovery`

### Task 2: contour-winding.js part 1 — cluster, split (with exact endpoint tangents), winding query, coincidence

**Files:**
- Create: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js` (add ported sections)

**Interfaces:**
- Produces: `CLUSTER_TOL`, `WINDING_SEGS`, `_mergeCrossings(crossings, tol) ->
  {crossings:[{…,vertex}], pool:[[x,y]]}`, `_splitRings(rings, merged) -> pieces`,
  `_windingAt(p, tessRings) -> integer`, `_coincidence(pieces, tol) -> {mult, duplicate}`.
- A piece is `{ ring, from, segs, vStart, vEnd, tanA, kA, tanB, kB }` — `tanA`/`kA` are
  the exact unit tangent and signed curvature of the SOURCE curve at the piece's start
  crossing (direction of travel), `tanB`/`kB` at its end crossing; `null` for an
  uncrossed whole ring. Consumed by Task 3 (departure ordering) and Task 4 (`_chain`).

- [ ] **Step 1: Port the module skeleton** from
  `git show 7d4df16:src/framework/geometry/contour-winding.js`: the module header
  (rewrite the first paragraph to describe face labeling — final wording in Task 3),
  imports, `CLUSTER_TOL`, `WINDING_SEGS`, `dist`, `_mergeCrossings`, `ringPoints`,
  `_splitRings`, the whole coincidence block (`COINCIDENT_SAMPLES`, `pieceSamples`,
  `maxDist`, `coincidenceSign`, `_coincidence`), and `_windingAt`. Omit everything from
  `PROBE_EPS` through `projectToRing` and the probe-based `_classify` — deleted by design.
- [ ] **Step 2: Add exact endpoint tangents/curvatures in `_splitRings`.** Add local
  helpers (arcCenterAndSweep imported from paper-bridge.js):

```js
// Exact unit tangent / signed curvature of ORIGINAL segment `seg` (from `from`) at
// parameter t. Computed on the untrimmed source curve so it stays well-conditioned for
// arbitrarily short trimmed pieces — the trimmed arc's own from/via/to become nearly
// collinear as the piece shrinks, but the source arc's center never degrades.
function srcTangentAt(from, seg, t) {
  if (seg.c1) {
    const u = 1 - t;
    const d = [0, 1].map((k) => 3*u*u*(seg.c1[k]-from[k]) + 6*u*t*(seg.c2[k]-seg.c1[k]) + 3*t*t*(seg.to[k]-seg.c2[k]));
    const L = Math.hypot(d[0], d[1]);
    if (L > 1e-12) return [d[0]/L, d[1]/L];
    return segTangent(from, seg, t < 0.5);              // cusp/degenerate handle: endpoint rule
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {
      const a = Math.atan2(from[1]-c.center[1], from[0]-c.center[0]) + c.dA * t;
      return c.dA >= 0 ? [-Math.sin(a), Math.cos(a)] : [Math.sin(a), -Math.cos(a)];
    }
  }
  const L = Math.hypot(seg.to[0]-from[0], seg.to[1]-from[1]) || 1;
  return [(seg.to[0]-from[0])/L, (seg.to[1]-from[1])/L];
}
function srcCurvatureAt(from, seg, t) {
  if (seg.c1) {
    const u = 1 - t;
    const d1 = [0, 1].map((k) => 3*u*u*(seg.c1[k]-from[k]) + 6*u*t*(seg.c2[k]-seg.c1[k]) + 3*t*t*(seg.to[k]-seg.c2[k]));
    const d2 = [0, 1].map((k) => 6*u*(seg.c2[k]-2*seg.c1[k]+from[k]) + 6*t*(seg.to[k]-2*seg.c2[k]+seg.c1[k]));
    const L = Math.hypot(d1[0], d1[1]);
    return L > 1e-12 ? (d1[0]*d2[1] - d1[1]*d2[0]) / (L*L*L) : 0;
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) return (c.dA >= 0 ? 1 : -1) / c.r;
  }
  return 0;
}
```

  In `emit(a, b)` inside `_splitRings`, after the existing snap, attach:

```js
pieces.push({ ring: r, from: [from[0], from[1]], segs, vStart: a.vertex, vEnd: b.vertex,
  tanA: srcTangentAt(pts[a.seg], contour.segments[a.seg], a.t),
  kA:   srcCurvatureAt(pts[a.seg], contour.segments[a.seg], a.t),
  tanB: srcTangentAt(pts[b.seg], contour.segments[b.seg], b.t),
  kB:   srcCurvatureAt(pts[b.seg], contour.segments[b.seg], b.t) });
```

  The uncrossed-whole-ring branch keeps `vStart: null, vEnd: null` and gets
  `tanA: null, kA: 0, tanB: null, kB: 0`.
- [ ] **Step 3: `_coincidence` tweak** — in the `net === 0` branch, pick one
  representative like the non-zero branch does (rep keeps `mult 0`, others become
  `duplicate: true`) so the face graph never carries parallel cancelled edges:

```js
if (net === 0) {
  // The group cancels: winding is identical on both sides, so no piece here bounds a
  // face. One representative stays in the arrangement as a weight-0 edge (both adjacent
  // faces get equal labels and it is never kept); the copies would only create parallel
  // edges in the face graph.
  const rep0 = group[0].i;
  for (const g of group) { duplicate[g.i] = g.i !== rep0; mult[g.i] = 0; }
  continue;
}
```

- [ ] **Step 4: Port the tests** — from the branch file take describe blocks
  `crossing cluster merge` (drop the PROBE_EPS assertion inside "CLUSTER_TOL is derived…"
  if present there — PROBE_EPS no longer exists), `splitting rings at crossings`,
  `integer winding`. From the coincidence unit test
  (`_coincidence: same direction doubles, opposite cancels, a lens is neither`) adjust the
  cancelling pair's expectation to the new representative rule:
  `expect(opp.mult).toEqual([0, 0]); expect(opp.duplicate).toEqual([false, true]);`
  Add a new assertion: pieces produced by `_splitRings` carry unit `tanA`/`tanB`
  (`expect(Math.hypot(...p.tanA)).toBeCloseTo(1, 12)`) and an arc ring's piece carries
  `kA` ≈ ±1/r.
- [ ] **Step 5: Run** `npx vitest run test/contour-winding.test.js` → PASS; full suite
  green (nothing imports the new module yet).
- [ ] **Step 6: Commit** `feat: contour-winding foundations — cluster, split with exact endpoint tangents, coincidence`

### Task 3: The face core — departures, orbits, anchors, winding propagation, `_classify`

**Files:**
- Modify: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Produces: `_classify(pieces, tessRings, { debug=false, inside=(w)=>w!==0 }) ->
  [{piece, keep, reverse, wLeft?, wRight?}]` — identical call shape and record shape to
  the prior branch, so its behavioral tests port unchanged. `tessRings[i]` is
  `tessellateContour(rings[i], WINDING_SEGS)` indexed by piece `.ring`.
  Also exports `CHAIN_INCOMPLETE_MESSAGE` (moved up from the chain section since the BFS
  throws it too).

- [ ] **Step 1: Write failing tests.** Port from the branch: describe
  `piece classification` (tests: simple CCW square all kept unreversed; stacked-squares
  interior dropped; the invariant test rewritten as `wLeft - wRight === mult` over
  non-null records — this is now true by construction; DROP the PROBE_EPS derivation
  test). Port the two plain-circle tests from the probe-anchoring block (r=25, r=50 —
  keep the assertions, reword the describe to "face labels are radius-independent").
  Port `a piece with zero segments is dropped, not thrown`. Add NEW tests:

```js
describe("face labeling", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
  const tess = (rings) => rings.map((r) => tessellateContour(r, 64));
  const classify = (rings, inside) => {
    const merged = _mergeCrossings(ringCrossings(rings));
    const pieces = _splitRings(rings, merged);
    return _classify(pieces, tess(rings), { debug: true, ...(inside ? { inside } : {}) });
  };

  test("bowtie: the two lobes get w=+1/-1 labels and only the positive lobe's boundary survives w>=1", () => {
    const cls = classify([ring([[0, 0], [10, 10], [10, 0], [0, 10]])], (w) => w >= 1);
    // 4 pieces after the single self-crossing; the two tracing the CCW lobe are kept
    expect(cls.filter((c) => c.keep).length).toBe(2);
    for (const c of cls) if (c.wLeft !== null) expect(c.wLeft - c.wRight).toBe(1);
  });

  test("nested but disjoint rings: ambient winding crosses components", () => {
    // small CCW square strictly inside a big CCW square — no crossings, two components.
    const big = ring([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const small = ring([[8, 8], [12, 8], [12, 12], [8, 12]]);
    const cls = classify([big, small], (w) => w >= 1);
    // big: wLeft 1 / wRight 0 → kept. small: ambient 1 → wLeft 2 / wRight 1 → both
    // filled → dropped (a doubly-covered island contributes no boundary).
    const bigRec = cls.find((c) => c.piece.ring === 0), smallRec = cls.find((c) => c.piece.ring === 1);
    expect(bigRec.keep).toBe(true);  expect([bigRec.wLeft, bigRec.wRight]).toEqual([1, 0]);
    expect(smallRec.keep).toBe(false); expect([smallRec.wLeft, smallRec.wRight]).toEqual([2, 1]);
  });

  test("a CW hole nested in a disjoint CCW outer is kept (ambient 1, inside 0)", () => {
    const outer = ring([[0, 0], [20, 0], [20, 20], [0, 20]]);
    const hole = ring([[8, 8], [8, 12], [12, 12], [12, 8]]);      // CW
    const cls = classify([outer, hole], (w) => w >= 1);
    const h = cls.find((c) => c.piece.ring === 1);
    expect(h.keep).toBe(true);
    expect([h.wLeft, h.wRight]).toEqual([1, 0]);
    expect(h.reverse).toBe(false);
  });

  test("pinch vertex: two squares meeting at exactly one corner classify consistently (no dead-end)", () => {
    // The four-edge pinch that killed the probe design: every kept edge's head has a
    // kept departure, so _chain can always close. Checked here at the classification
    // level: kept pieces form even degree at every vertex.
    const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const b = ring([[10, 10], [20, 10], [20, 20], [10, 20]]);
    const cls = classify([a, b], (w) => w >= 1);
    const deg = new Map();
    for (const c of cls) {
      if (!c.keep) continue;
      for (const [v, d] of [[c.piece.vStart, 1], [c.piece.vEnd, 1]]) {
        if (v === null) continue;
        deg.set(v, (deg.get(v) ?? 0) + d);
      }
    }
    for (const [, d] of deg) expect(d % 2).toBe(0);
  });

  test("an inconsistent arrangement throws the pinned chain message, not a silent wrong label", () => {
    // Hand-build pieces whose crossings were dropped (one square "crossing" another with
    // no shared vertices) by splitting only ONE of the two rings at fake vertices.
    // BFS sees two faces connected by edges demanding conflicting labels.
    // (Construct via _splitRings on rings but a doctored merged set — see implementation
    // note in _classify's test hooks; if unreachable by hand, assert instead that the
    // message constant is exported and byte-exact.)
    expect(CHAIN_INCOMPLETE_MESSAGE).toBe("contour-winding: could not chain offset boundary (incomplete intersection set)");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `_classify` not exported yet.
- [ ] **Step 3: Implement.** Add to `contour-winding.js` (replacing the deleted probe
  block):

```js
export const CHAIN_INCOMPLETE_MESSAGE =
  "contour-winding: could not chain offset boundary (incomplete intersection set)";

// Fallback tangents for hand-built pieces (ported tests build pieces without tanA/tanB);
// _splitRings output always carries the exact source-curve values.
const pieceTanA = (p) => p.tanA ?? segTangent(p.from, p.segs[0], true);
const pieceTanB = (p) => {
  if (p.tanB) return p.tanB;
  const pts = [p.from, ...p.segs.map((s) => s.to)];
  return segTangent(pts[pts.length - 2], p.segs[p.segs.length - 1], false);
};

// Bottom-most tessellation sample over a set of piece polylines → { e, k, poly } with
// globally minimal (y, then x). Used to anchor a component's local exterior face.
function bottomSample(polys) {
  let best = null;
  polys.forEach((poly, e) => {
    for (let k = 0; k < poly.length; k++) {
      const [x, y] = poly[k];
      if (!best || y < best.y - 1e-15 || (Math.abs(y - best.y) <= 1e-15 && x < best.x))
        best = { e, k, x, y };
    }
  });
  return best;
}

// Classify pieces by FACE LABELS of the planar arrangement, not per-piece probes.
//
// Half-edges: every non-duplicate crossed piece is one arrangement edge (forward = the
// piece's own direction, backward = its twin). At each pool vertex, departures are sorted
// CCW by exact source-curve tangent angle, ties broken by signed curvature (an edge
// curving harder left is infinitesimally more CCW). next(h) = the rotational predecessor
// of twin(h) in that CCW order — the standard DCEL rule, identical in effect to _chain's
// verified "smallest positive rotation from the reversed inbound direction", with the
// literal U-turn last. Orbits of next() are face boundary cycles, interior on the left.
//
// Winding: one face per graph-connected component is anchored — the face just below the
// component's bottom-most tessellated point is its LOCAL EXTERIOR, whose own-component
// winding is 0 by topology (nothing of the component lies below). Other components never
// cross this one (they'd share a component), so their winding contribution is a single
// constant over this component's entire curve network (continuity along a connected set
// that crosses nothing) — measured ONCE by ray cast at the bottom point against the other
// rings only, and added to every label. BFS then propagates across edges: crossing a
// directed edge left→right subtracts its net multiplicity (Ruling 8, by construction).
// A BFS label conflict means paper returned an incomplete/inconsistent intersection set —
// throw the pinned chain message rather than emit a wrong ring.
export function _classify(pieces, tessRings, { debug = false, inside = (w) => w !== 0 } = {}) {
  const { mult, duplicate } = _coincidence(pieces);
  const recs = pieces.map((piece) => ({ piece, keep: false, reverse: false, wLeft: null, wRight: null }));

  // ── graph over crossed, non-duplicate, non-empty pieces ─────────────────────────────
  const eIdx = [];
  pieces.forEach((p, i) => { if (!duplicate[i] && p.vStart !== null && p.segs.length > 0) eIdx.push(i); });
  const E = eIdx.length;

  if (E > 0) {
    const P = (h) => pieces[eIdx[h >> 1]];
    const tailOf = (h) => ((h & 1) ? P(h).vEnd : P(h).vStart);
    const headOf = (h) => ((h & 1) ? P(h).vStart : P(h).vEnd);
    const outVec = (h) => { const p = P(h); if (h & 1) { const t = pieceTanB(p); return [-t[0], -t[1]]; } return pieceTanA(p); };
    const outK = (h) => { const p = P(h); return (h & 1) ? -(p.kB ?? 0) : (p.kA ?? 0); };

    // departures per vertex, sorted CCW by (angle, then curvature)
    const dep = new Map();
    for (let h = 0; h < 2 * E; h++) {
      const v = tailOf(h);
      if (!dep.has(v)) dep.set(v, []);
      dep.get(v).push(h);
    }
    const pos = new Map();          // half-edge → index within its sorted departure list
    for (const list of dep.values()) {
      list.sort((a, b) => {
        const [ax, ay] = outVec(a), [bx, by] = outVec(b);
        const ta = Math.atan2(ay, ax), tb = Math.atan2(by, bx);
        if (ta !== tb) return ta - tb;
        return outK(a) - outK(b);
      });
      list.forEach((h, i) => pos.set(h, i));
    }
    const next = (h) => {
      const list = dep.get(headOf(h));
      const m = list.length;
      return list[(pos.get(h ^ 1) - 1 + m) % m];
    };

    // face orbits
    const faceOf = new Int32Array(2 * E).fill(-1);
    let F = 0;
    for (let h0 = 0; h0 < 2 * E; h0++) {
      if (faceOf[h0] !== -1) continue;
      let h = h0;
      while (faceOf[h] === -1) { faceOf[h] = F; h = next(h); }
      if (faceOf[h] !== F) throw new Error(CHAIN_INCOMPLETE_MESSAGE);   // walked into a foreign orbit
      F++;
    }

    // connected components over vertices
    const parent = new Map();
    const find = (v) => { let r = v; while (parent.get(r) !== r) r = parent.get(r); let c = v;
      while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
    for (let e = 0; e < E; e++) for (const v of [pieces[eIdx[e]].vStart, pieces[eIdx[e]].vEnd])
      if (!parent.has(v)) parent.set(v, v);
    for (let e = 0; e < E; e++) {
      const a = find(pieces[eIdx[e]].vStart), b = find(pieces[eIdx[e]].vEnd);
      if (a !== b) parent.set(a, b);
    }
    const compOf = (e) => find(pieces[eIdx[e]].vStart);

    // per-component: piece polylines, bottom anchor, ambient winding, BFS labels
    const polys = eIdx.map((i) => tessellateContour({ start: pieces[i].from, segments: pieces[i].segs }, WINDING_SEGS));
    const comps = new Map();        // root → edge indices
    for (let e = 0; e < E; e++) {
      const c = compOf(e);
      if (!comps.has(c)) comps.set(c, []);
      comps.get(c).push(e);
    }
    const wFace = new Map();        // face id → winding
    for (const edges of comps.values()) {
      const compRings = new Set(edges.map((e) => pieces[eIdx[e]].ring));
      const compPolys = edges.map((e) => polys[e]);
      const bs = bottomSample(compPolys);
      const e0 = edges[bs.e], poly = polys[e0];
      let anchor;
      if (bs.k > 0 && bs.k < poly.length - 1) {
        // interior sample: travel direction at the bottom (central difference). Travel in
        // −x ⇒ left side faces down ⇒ the forward half-edge's left face is the exterior.
        const dx = poly[bs.k + 1][0] - poly[bs.k - 1][0];
        anchor = dx < 0 ? 2 * edges.indexOf(e0) : 0;                     // placeholder, fixed below
        anchor = dx < 0 ? 2 * e0 : 2 * e0 + 1;
      } else {
        // bottom is a pool vertex: exterior = left face of the departure with the
        // LARGEST angle in [0, π] (all departures at a global minimum point upward).
        const v = bs.k === 0 ? pieces[eIdx[e0]].vStart : pieces[eIdx[e0]].vEnd;
        const list = dep.get(v);
        let bestH = list[0], bestA = -Infinity;
        for (const h of list) {
          const [x, y] = outVec(h);
          let a = Math.atan2(y, x);
          if (a < -1e-9) a += 2 * Math.PI;                               // noise below horizontal
          if (a > bestA) { bestA = a; bestH = h; }
        }
        anchor = bestH;
      }
      const others = tessRings.filter((_, r) => !compRings.has(r));
      const ambient = _windingAt([bs.x, bs.y], others);
      // BFS from the anchored exterior face
      const q = [faceOf[anchor]];
      wFace.set(faceOf[anchor], ambient);
      const edgeSeen = new Set();
      while (q.length) {
        const f = q.shift();
        for (const e of edges) {
          const fL = faceOf[2 * e], fR = faceOf[2 * e + 1];
          if (fL !== f && fR !== f) continue;
          if (edgeSeen.has(e)) continue;
          const m = mult[eIdx[e]];
          const wL = wFace.has(fL) ? wFace.get(fL) : wFace.get(fR) + m;
          const wR = wL - m;
          for (const [g, w] of [[fL, wL], [fR, wR]]) {
            if (wFace.has(g)) {
              if (wFace.get(g) !== w) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
            } else { wFace.set(g, w); q.push(g); }
          }
          edgeSeen.add(e);
        }
      }
      // every face of a connected component is reachable through its edges
      for (const e of edges) for (const f of [faceOf[2 * e], faceOf[2 * e + 1]])
        if (!wFace.has(f)) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
      // classify this component's pieces
      for (const e of edges) {
        const i = eIdx[e];
        const wL = wFace.get(faceOf[2 * e]), wR = wFace.get(faceOf[2 * e + 1]);
        const keep = inside(wL) !== inside(wR);
        recs[i] = { piece: pieces[i], keep, reverse: keep && !inside(wL), wLeft: wL, wRight: wR };
      }
    }
  }

  // ── uncrossed whole rings: interior = ambient ± 1 directly ───────────────────────────
  pieces.forEach((p, i) => {
    if (p.vStart !== null || duplicate[i] || p.segs.length === 0) return;
    const own = tessRings[p.ring];
    const ccw = ringArea(own) >= 0;
    const bs = bottomSample([own]);
    const ambient = _windingAt([bs.x, bs.y], tessRings.filter((_, r) => r !== p.ring));
    const wL = ambient + (ccw ? 1 : 0);
    const wR = wL - 1;
    const keep = inside(wL) !== inside(wR);
    recs[i] = { piece: p, keep, reverse: keep && !inside(wL), wLeft: wL, wRight: wR };
  });

  return debug ? recs : recs.map(({ piece, keep, reverse }) => ({ piece, keep, reverse }));
}
```

  Implementation notes to honor while making the tests pass:
  - Delete the duplicated placeholder line in the anchor branch (artifact above — keep
    only `anchor = dx < 0 ? 2 * e0 : 2 * e0 + 1;`); the plan shows the intent, the code
    review gate is the tests.
  - `bottomSample` on an uncrossed ring uses the ring polyline itself.
  - The BFS above is written face-first for clarity; an edge-queue formulation is equally
    fine as long as the conflict check stays.
  - The exterior-anchor half-edge for `bs.k === poly.length - 1` maps to the piece's
    `vEnd`; make sure the vertex chosen matches which end of the polyline won.
- [ ] **Step 4: Run the new tests** → PASS; then the ported classification tests → PASS;
  full suite green.
- [ ] **Step 5: Commit** `feat: face-labeled winding classification — combinatorial propagation, no probes`

### Task 4: `_chain` port + `resolveOffsetWinding`

**Files:**
- Modify: `src/framework/geometry/contour-winding.js`
- Modify: `test/contour-winding.test.js`

**Interfaces:**
- Produces: `_chain(classified, pool) -> contours`,
  `resolveOffsetWinding(rawRegions, {clusterTol}) -> regions` — identical signatures to
  the branch.

- [ ] **Step 1: Port tests**: describe blocks `chaining`, both `junction ordering…`
  blocks, `resolveOffsetWinding`, `resolveOffsetWinding — positive-winding regressions…`,
  `coincident (collinear-overlap) pieces` (whole block; the `wLeft - wRight === mult`
  test ports as-is), and the trailing `duplicate crossing records at a multi-ring meeting
  point` block (needs `_offsetContour` — it imports from contour-offset.js, which still
  works at 0.59.0 since `_offsetContour` exists there; the `grid` helper calls
  `resolveOffsetWinding` directly, fine).
- [ ] **Step 2: Run to verify failure** (`_chain`, `resolveOffsetWinding` missing).
- [ ] **Step 3: Port `reversePieceSegs`, `dirOut`/`dirIn`, `_chain`, and
  `resolveOffsetWinding`** verbatim from the branch file, with two adjustments:
  1. `dirOut`/`dirIn` prefer the exact stored tangents:

```js
const dirOut = (p) => { const t = pieceTanA(p); return Math.atan2(t[1], t[0]); };
const dirIn = (p) => { const t = pieceTanB(p); return Math.atan2(t[1], t[0]); };
```

  2. `reversePieceSegs` carries the tangents through:
     `{ ..., tanA: piece.tanB ? [-piece.tanB[0], -piece.tanB[1]] : null, kA: -(piece.kB ?? 0), tanB: piece.tanA ? [-piece.tanA[0], -piece.tanA[1]] : null, kB: -(piece.kA ?? 0) }`.
  `CHAIN_INCOMPLETE_MESSAGE` already exists from Task 3 — do not redeclare.
- [ ] **Step 4: Add the structural regression tests** the probe design failed (these are
  the point of the rewrite — all four are polygon fixtures, no font needed):

```js
describe("pinch classes the probe design could not close (the rewrite's reason to exist)", () => {
  const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });
  const inset = (pts, d, corners) =>
    offsetRegions([{ outer: ring(pts), holes: [] }], d, { corners });   // import from contour-offset AFTER Task 5 wiring; until then call rawOffset pieces directly — see note

  // four-notch comb at the knife-edge delta (-2.4975 round): the probe design dead-ends
  // at one pinch vertex; truth 91.745 (Clipper2 91.74496 / Minkowski 91.744 / SDF 91.743)
  const comb = [[0, 0], [30, 0], [30, 10], [26, 10], [26, 3], [22, 3], [22, 10], [18, 10],
                [18, 3], [14, 3], [14, 10], [10, 10], [10, 3], [6, 3], [6, 10], [0, 10]];
  test("comb -2.4975 round resolves (was: chain throw)", () => {
    const out = inset(comb, -2.4975, "round");
    expect(profileArea(out)).toBeCloseTo(91.745, 1);
  });

  // 12-vertex two-notch plate at -3.25: BOTH sharp and chamfer threw on the probe design
  // and the ladder did not rescue them (Ruling 18). Oracle: sharp 40.20778, chamfer 45.20274.
  const plate = [[0, 0], [32, 0], [32, 9], [9.429, 9], [9.429, 6.507], [8.404, 6.507],
                 [8.404, 9], [5.132, 9], [5.132, 1.541], [1.869, 1.541], [1.869, 9], [0, 9]];
  test("two-notch plate -3.25 sharp is exact (was: chain throw)", () => {
    expect(profileArea(inset(plate, -3.25, "sharp"))).toBeCloseTo(40.20778, 3);
  });
  test("two-notch plate -3.25 chamfer is exact (was: chain throw)", () => {
    expect(profileArea(inset(plate, -3.25, "chamfer"))).toBeCloseTo(45.20274, 3);
  });
});
```

  NOTE: these three tests exercise `offsetRegions`, which is wired in Task 5. Write them
  now with `test.todo(...)` wrappers or a `describe.skip`, flip them on in Task 5 Step 4,
  and record the flip in the Task 5 commit message. (Do NOT let them sit skipped past
  Task 5.) The plate coordinates are the ledger's description of the falsifying fixture
  (Ruling 18: 32×9, notches x 1.869–5.132 depth 7.459 → floor y = 9 − 7.459 = 1.541, and
  x 8.404–9.429 depth 2.493 → floor y = 6.507). If the branch's committed corpus
  reproduces the case with different truth values, re-derive the two truths from the
  Minkowski oracle in Task 6 and correct the constants with that justification written
  into the test comment.
- [ ] **Step 5: Run** contour-winding tests → PASS (structural block still todo/skip);
  full suite green.
- [ ] **Step 6: Commit** `feat: chain + resolveOffsetWinding over face-labeled classification`

### Task 5: Wire into `contour-offset.js` — gated trim, 7C validation, ladder

**Files:**
- Modify: `src/framework/geometry/contour-offset.js` (replace with branch version)
- Modify: `src/framework/geometry/paper-bridge.js` (delete `resolveSelfRegions`)
- Modify: `test/contour-offset.test.js` (branch version)
- Delete: `test/paper-bridge-resolve.test.js`
- Modify: `docs/ERROR-PATTERNS.md` (branch sections, rates marked for Task 8 re-measure)
- Modify: `test/error-patterns.test.js` (branch's +1 line)
- Modify: `test/contour-winding.test.js` (un-skip Task 4's structural block)

- [ ] **Step 1: Replace the orchestrator**:
  `git show 7d4df16:src/framework/geometry/contour-offset.js > src/framework/geometry/contour-offset.js`
  (this brings the gated trim, `segsIntersect`+`dedupeRing`, `rawOffset`, the ladder, and
  the `_rawOffset`/`_offsetNoFallback`/`_ladderRungs` hooks in one verified unit).
- [ ] **Step 2: Port the branch's test file**:
  `git show 7d4df16:test/contour-offset.test.js > test/contour-offset.test.js`.
- [ ] **Step 3: Delete `resolveSelfRegions`** from paper-bridge.js (it just lost its only
  caller — verify with `grep -rn resolveSelfRegions src/ test/`) and delete
  `test/paper-bridge-resolve.test.js` (`git rm`). Port the branch's
  `docs/ERROR-PATTERNS.md` diff (`git diff f3ce357..7d4df16 -- docs/ERROR-PATTERNS.md`)
  and `test/error-patterns.test.js` diff.
- [ ] **Step 4: Un-skip Task 4's structural regression tests.**
- [ ] **Step 5: Run the full suite.** Expected honest outcome: most tests pass; any
  contour-offset expectation that moves gets the independent-oracle treatment (the branch
  already documented its moved expectations — comb/chamfer/−2 = 3 regions/20.5, two
  squares round delta 5 → 1 region, round-sweep areas at deltas 8/10). A NEW divergence
  from the branch's own results is a stop-and-investigate, not a re-baseline.
- [ ] **Step 6: Commit** `feat: wire face-labeled resolver into offsetRegions — gated trim, endpoint-incident validation, fallback ladder`

### Task 6: Oracle infrastructure — Minkowski helper, corpus, rates, fuzz

**Files:**
- Create: `test/helpers/minkowski-oracle.js`, `test/minkowski-oracle.test.js`,
  `test/helpers/offset-corpus.js`, `test/offset-fuzz.test.js`, `scripts/offset-rates.mjs`
  (all `git show 7d4df16:<path> > <path>`)
- Modify: `test/offset-oracle-manifold.test.js` (branch version)
- Modify: `package.json` (the branch's script addition ONLY — check
  `git diff f3ce357..7d4df16 -- package.json`; do NOT take a version change here, that is
  Task 8's)

- [ ] **Step 1: Port the five files verbatim** and the package.json script line.
- [ ] **Step 2: Port `test/offset-oracle-manifold.test.js`** from the branch, then address
  the two ledger-flagged defects in it:
  (a) line ~436 asserts `toHaveLength(3)` on a comb the oracle counts at 4 — with the
  face resolver, measure what the engine now returns; if 4, fix the assertion to 4 WITH
  the oracle-derived justification in the comment; if 3, investigate before touching it
  (the 3 was a fallback-ladder artifact — the face design should not take the ladder
  there).
  (b) any `test.todo`/parked characterization for the comb/two-notch chain throws
  converts to a correctness assertion (they now resolve — Task 4's fixtures).
- [ ] **Step 3: Run the fuzz + oracle files individually** (they boot manifold WASM —
  keep them out of OCCT files):
  `npx vitest run test/minkowski-oracle.test.js test/offset-fuzz.test.js test/offset-oracle-manifold.test.js`.
  Every failure is a real finding: divergence from the Minkowski oracle at >0.5 % or a
  topology mismatch is a bug in the face core — debug with
  `node scripts/offset-rates.mjs --seed <n>`.
- [ ] **Step 4: Full suite green. Commit** `test: port committed offset corpus, Minkowski oracle, fuzz suite, rate instrument`

### Task 7: The reported case — text topology suite

**Files:**
- Create: `test/offset-text.test.js`

- [ ] **Step 1: Write the test** (this is §5 of the handoff turned into assertions; the
  truth column is Clipper2's, already recorded there):

```js
// The user-reported case that motivated the whole winding-resolver effort, pinned as
// TOPOLOGY, not just area: "Scott" size 10, round corners, across the delta sweep. The
// truth column is Clipper2 (the pre-0.59.0 route), recorded in the 2026-08-15 handoff and
// re-derivable via test/helpers/minkowski-oracle.js. 0.59.0 got the areas right and the
// topology wrong (12 phantom holes at delta 3); the probe-based resolver branch THREW at
// 0.8/1.5/2.0/3.0. Every row here must build and match.
import { beforeAll, expect, test } from "vitest";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";
import { textGlyphs, loadDefaultFont } from "./helpers/offset-corpus.js";   // adjust to the corpus's real export names

let regions;
beforeAll(async () => {
  const font = await loadDefaultFont();
  regions = textGlyphs(font, "Scott", { size: 10 });
});

const SLIVER = 1e-3;
const topo = (out) => {
  let r = 0, h = 0, area = 0;
  for (const rg of out) {
    const a = Math.abs(ringArea(tessellateContour(rg.outer, 64)));
    if (a < SLIVER) continue;
    r++; area += a;
    for (const hole of rg.holes) {
      const ha = Math.abs(ringArea(tessellateContour(hole, 64)));
      if (ha >= SLIVER) { h++; area -= ha; }
    }
  }
  return { r, h, area };
};

// delta → [regions, holes, area (Clipper2 truth, 0.5% tolerance)]
const TRUTH = [
  [0.2, 5, 1, 140.068], [0.5, 4, 1, 196.816], [0.8, 1, 2, 252.996], [1.0, 1, 3, 288.531],
  [1.5, 1, 5, 362.105], [2.0, 1, 2, 419.571], [3.0, 1, 0, 522.349],
];
for (const [d, R, H, A] of TRUTH) {
  test(`"Scott" size 10 round, delta ${d}: ${R}r ${H}h`, () => {
    const out = offsetRegions(regions, d, { corners: "round" });   // must not throw
    const t = topo(out);
    expect([t.r, t.h]).toEqual([R, H]);
    expect(Math.abs(t.area - A) / A).toBeLessThan(0.005);
  });
}
```

  Check the corpus helper's actual export names first (`grep -n "export" test/helpers/offset-corpus.js`)
  — the handoff's repro used `textGlyphs` from `text2d.js` and `loadDefaultFont` from the
  corpus; import from wherever they actually live.
- [ ] **Step 2: Run it.** Any failing row is the core deliverable failing — debug the face
  core, do not touch the truth column (it is Clipper2's, independently recorded). If a row
  disagrees ONLY in hole count by slivers, check the SLIVER filter against the fuzz
  suite's convention before concluding.
- [ ] **Step 3: Also sweep the glyph corpus** — the corpus's 6 glyph cases × 5 deltas ×
  round should now agree 30/30 on the fuzz suite's topology comparison (the fuzz file
  already covers this if its glyph family is enabled; if it samples, add the explicit 30
  as tests here).
- [ ] **Step 4: Full suite green. Commit** `test: pin the reported text-offset case as topology assertions`

### Task 8: Rates, perf gate, docs, version bump

**Files:**
- Modify: `docs/ERROR-PATTERNS.md`, `docs/KERNEL-CONTRACT.md` (branch sections rewritten
  for the face mechanism; EVERY rate re-measured via `npm run offset-rates` — Ruling 18:
  re-measure, don't re-word)
- Modify: `package.json` (version `0.60.0`)
- Modify: `test/kernel-contract.test.js` if the contract version header moves

- [ ] **Step 1: Run `npm run offset-rates`** and record: chain-throw rates per corner
  style before/after the ladder under the face design (expected: dramatically lower than
  the probe design's 0.291/0.241/0.224 % pre-ladder; report actuals), plus rung win
  distribution. If the ladder rescues ~nothing, keep it (insurance) but say so in the doc.
- [ ] **Step 2: Perf gate (W9).** Measure the 24-glyph benchmark and the reported case:

```js
// scripts/perf-text-offset.mjs (temporary or committed — committed preferred, ~20 lines)
// times offsetRegions on "The quick brown fox jumps" size 10 at +0.3 and "Scott" at each
// handoff delta, 20 warm iterations, reports median. Budget: ≤1.5× the 0.59.0 timing
// (~85 ms reference for the 24-glyph case). Compare by checking out f3ce357 in a temp
// worktree if a live baseline is needed.
```

  Report both numbers in the PR body. A budget miss is a finding to report, not to hide.
- [ ] **Step 3: Docs.** Port the branch's `docs/KERNEL-CONTRACT.md` diff, then rewrite:
  the "chain-incomplete" mechanism paragraphs now describe face labeling and the BFS
  conflict detector; the polyline-rung arc-fidelity loss goes IN the normative doc
  (ledger 7D(c)); the clusterTol-rung region-undercount caveat stays; every numeric rate
  is replaced by Step 1's measurements. Same treatment for ERROR-PATTERNS (the section
  ported in Task 5 gets its numbers finalized). Bump the contract version header per that
  doc's own versioning rules and sync `test/kernel-contract.test.js`.
- [ ] **Step 4: Version bump** to `0.60.0` in `package.json` (0.59.0 is published and
  cannot be reused; the publish workflow tags on merge).
- [ ] **Step 5: Full suite + `npm run check`** (Playwright smoke; install Chromium if
  missing: `npm i -D playwright && npx playwright install chromium`).
- [ ] **Step 6: Commit** `docs+release: face-resolver contract docs with re-measured rates; 0.60.0`

---

## Self-review notes

- Spec coverage: fill rule (T3/T4), crossings+irTime (T1), cluster/split/coincidence (T2),
  face core+anchors+BFS (T3), chain+resolve (T4), orchestrator+trim gate+7C+ladder (T5),
  oracle+corpus+rates (T6), reported case (T7), perf+docs+version (T8). The spec's
  correctness-target table maps to: T4 fixtures (comb, plate), T5 ported tests
  (T-slot/concaveV/thinNeck live in the branch's contour-offset/oracle tests), T6 (sweep),
  T7 (Scott + glyphs).
- Types: piece record `{ring, from, segs, vStart, vEnd, tanA, kA, tanB, kB}` defined in
  T2, consumed in T3 (`pieceTanA/B`, `outVec`, `outK`) and T4 (`dirOut/dirIn`,
  `reversePieceSegs`). `_classify(pieces, tessRings, {debug, inside})` defined T3,
  consumed by `resolveOffsetWinding` T4 with `inside: (w) => w >= 1`.
- Known judgment calls deferred to measurement: the `toHaveLength(3|4)` comb assertion
  (T6 Step 2 states the decision procedure); ladder retention (T8 Step 1); SLIVER
  threshold consistency (T7 Step 2).
