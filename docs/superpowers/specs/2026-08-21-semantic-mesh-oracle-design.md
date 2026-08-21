# Semantic mesh oracle (`describe`) — design

**Date:** 2026-08-21
**Status:** approved design, pre-implementation
**Scope:** partforge framework (oracle + worker job) + CLI. partforge-cloud
plumbing is a documented follow-up (see §7), and is a separate repo and PR.

## Goal

Consume a triangle mesh and emit a **semantic description of its features** —
planes, cylinders, holes, fillets, chamfers, extrusions, revolves, shells, hole
patterns, symmetry — in a form an LLM can read and use to rebuild the part
parametrically in partforge.

The driving workflow already exists in halves. A user hands the agent an STL;
`imports` / `k.import()` bring it in; a `reference`-bound sub-part gets a
`deviation` fact; `verify`'s `ref*` gates hold the rebuild to the scan; the
ghost view shows the fit by eye (see
`2026-08-16-geometry-import-design.md`). What is missing is the **front half**:
nothing tells the agent *what the mesh is*. Today it can only measure a bounding
box and a volume, then guess. `describe` closes that gap.

Primary consumer is the partforge-cloud agent loop. The CLI verb is the
agent-facing surface locally and the test harness everywhere.

## Prior art, and our stance on it

This is a well-trodden problem and **we are deliberately not innovating in the
solved parts.** The survey behind this design is summarized here so the
implementation reaches for the established answer rather than inventing one.

- **Primitive extraction from meshes/point clouds is settled.** Efficient RANSAC
  (Schnabel/Wahl/Klein 2007) and region-growing-with-refit are the standard
  answers; CGAL ships both. Variational Shape Approximation (Cohen-Steiner 2004)
  and its quadric extension are the canonical error-driven face-clustering
  formulation. Gauss-map / normal-space bucketing plus Hough is the classic way
  to separate planes from cylinders and cones. Implement these; do not invent
  alongside them.
- **Feature recognition from surfaces is settled.** The attributed adjacency
  graph — faces as nodes, edges labeled convex/concave — dates to Joshi & Chang
  (1988) and is still the backbone of both classical and neural systems (AAGNet,
  BrepMFR). Commercially this is Geomagic Design X, Fusion's prismatic mesh
  conversion, Paramesh AI, Backflip AI.
- **The LLM layer is active and mostly orthogonal.** CAD-Recode (ICCV 2025)
  emits CadQuery Python from point clouds via a fine-tuned small model.
  Point2CAD, ParSeNet, HPNet, SED-Net, ComplexGen do segmentation and fitting to
  B-rep with no language layer. CSGNet, UCSG-Net, CAPRI-Net, ExtrudeNet,
  SECAD-Net do inverse CSG and inverse sketch-extrude. CADFit (2026) is the
  closest in spirit — IoU-driven incremental fitting and validation of
  parametric ops — but it is a solver, not a describer. BrepLLM (ECCV 2026)
  feeds B-rep through a learned encoder to an LLM for captioning.
- **The gap we occupy.** Nearly all of the above emit *geometry* (B-rep, STEP, a
  feature tree) or a *learned latent*. Very little emits a symbolic, auditable
  feature report as the deliverable, and nothing found does it inside a loop
  where a general-purpose LLM reads the report, writes parametric source, and is
  measured back against the source mesh. partforge already owns that back half.

This aligns with `docs/research/llm-cad-generation-strategies.md`: §2 ("numbers
beat pixels", 0.836 vs 0.587) makes a symbolic report the right primary channel,
and §3 ("symbolic named references beat coordinates", 58.4% → 82.5% edit
executability) dictates the report's id scheme.

## Decisions (settled during brainstorming)

| Question | Decision |
| --- | --- |
| Primary job | Reverse-engineer imported meshes into partforge parts. Not a semantic regression oracle for our own output (though the test suite uses it that way — see §8). |
| Input class | CAD-exported STL/3MF first (exact facets, chord-tolerance-only "noise"). Fitting stays robust enough to degrade gracefully on real 3D scans later; scans are not a v1 target. |
| Output language | **Two layers.** A neutral, measured feature graph is authoritative; a separate, explicitly-labeled `suggestion` layer speaks partforge ops. The agent may ignore the hints; the facts stand alone and are independently testable. |
| Vocabulary | Prismatic core (planes, cylinders, cones, spheres, tori; through/blind holes, fillets, chamfers, planar extrusions, pockets, bosses) **plus revolves and uniform-wall shells**. Everything else is explicit residual. |
| Self-grading | **In v1.** The oracle reconstructs from its own description and diffs against the source; per-feature confidence is the acceptance score. |
| Pipeline shape | **Segment to propose, fit-and-test to confirm.** Segmentation is a candidate generator; scored acceptance decides membership and order. |
| Backend | **Manifold only.** Partly chosen (booleans are 75–1486× faster and this is a search loop), partly forced (mesh imports on OCCT are never attempted). |
| Cache key | The import's content digest. `describe` is pure in the mesh — no part source, no params — so an edit can never invalidate it. |

## 1. Architecture

**The recognition stack is kernel-free; only acceptance touches geometry.** This
is the load-bearing structural decision:

- Every detector is testable against hand-built triangle fixtures with no WASM
  boot. That matters here specifically because OCCT and Manifold must not boot
  in the same process, so kernel-bearing tests are expensive and file-isolated.
- It keeps the whole module inside the oracle's existing DOM-free / `three`-free
  / `node:`-free envelope that `test/worker-layering.test.js` enforces.

New directory `src/framework/oracle/describe/`. Pure leaves except where noted:

| Module | Job |
| --- | --- |
| `topology.js` | Weld vertices, build face adjacency, per-face normal and area, **signed** dihedral per edge. Normalizes Manifold's non-indexed soup and OCCT's indexed mesh into one shape. |
| `fit.js` | Least-squares fits: plane, cylinder, cone, sphere, torus. Each returns params + RMS + max deviation. The numerical core. |
| `segment.js` | Gauss-map seeding → region growing under a primitive predicate → refit → repeat. Produces candidate patches. |
| `ransac.js` | Efficient RANSAC over whatever region growing fragments or leaves behind. |
| `surface-graph.js` | Merge patches into surfaces, extract boundary loops, build the attributed adjacency graph with convex/concave edge labels. |
| `features/` | Graph rules → holes, fillets, chamfers, pockets, bosses, extrusions, revolves, shells. One file per family. |
| `patterns.js` | Linear / circular / grid repetition; mirror and rotational symmetry over the feature list. |
| `snap.js` | Number snapping, unit and grid inference, fastener-table lookup. |
| `accept.js` | **Kernel-touching.** Incrementally rebuilds candidates, scores by symmetric-difference volume, greedily accepts, tracks residual. |
| `report.js` / `hints.js` | Emit the facts layer and the labeled suggestion layer, both in full and compact shapes. |
| `../describe.js` | Orchestrator — `describe(kernel, mesh, opts)`, sitting beside `measure.js`. |

Two reuses, no new geometry machinery: `accept.js` scores with the same
symmetric-difference math `measure.js` already runs for the `reference`
deviation fact, and neighborhood queries go through the existing
`oracle/bvh.js`.

## 2. The pipeline

### 2.1 Topology (`topology.js`)

Weld vertices at a tolerance derived from the bbox diagonal. Build face
adjacency and per-edge signed dihedral angle. The sign is the whole point: it is
what later separates a boss from a pocket and a fillet from a chamfer. Normalize
the two mesh conventions here so nothing downstream branches on backend.

### 2.2 Fitting (`fit.js`)

Least-squares fits for plane, cylinder, cone, sphere, torus. Every fit returns
`{ type, params, rms, maxDev }` — **no fit is ever returned without its error**,
because the report's honesty depends on carrying that number all the way out.

### 2.3 Segmentation (`segment.js`, `ransac.js`)

Seed in normal space: bucket face normals on the Gauss sphere, where planes
collapse to point clusters and cylinders/cones sweep circles. Within a normal
cluster, bucket on signed offset `n·p` so distinct parallel planes separate.

Then region-grow on the dual graph with the fitted primitive as the acceptance
predicate, refitting as the region grows, iterating to stability. Pure bucketing
is brittle at feature boundaries; growing is what makes it robust. Efficient
RANSAC mops up whatever fragments or is left over.

### 2.4 Surface graph (`surface-graph.js`)

Merge patches into surfaces, extract boundary loops, and build the attributed
adjacency graph: surfaces as nodes, shared edges as arcs labeled convex or
concave from the dihedral sign, with the edge's own geometry (line, circle,
radius) attached.

### 2.5 Feature recognition (`features/`)

Graph rules over the AAG:

- **Through hole** — cylinder with concave edges to two parallel planes.
- **Blind hole** — cylinder with a concave edge to one plane and a planar or
  conical cap.
- **Fillet** — small-radius cylinder or torus strip tangent between two larger
  faces, concave side.
- **Chamfer** — narrow planar strip meeting two faces at a consistent angle.
- **Pocket / boss** — a closed loop of concave (resp. convex) edges bounding a
  face set offset from a base plane.
- **Extrusion** — a face ring sharing a common sweep direction, with a readable
  cross-section profile.
- **Revolve** — a surface set whose fitted axes are collinear and whose profile
  is readable in the axial half-plane.
- **Shell** — a surface with a matching counter-surface at constant offset. This
  is the hardest detector and the one to cut first if v1 runs long.

### 2.6 Patterns and symmetry (`patterns.js`)

This is where a feature *dump* becomes design *intent*, and it is worth more
than marginal recognition accuracy. Four identical holes on a grid must compress
to one parameterized pattern, not four holes. Detected mirror and rotational
symmetry planes tell the agent how the part wants to be parameterized.

### 2.7 Snapping (`snap.js`)

Convert measurement into intent: 11.9976 → 12; a Ø5.3 hole → "M5 clearance". Infer
a working grid and unit. Snapping is an **interpretation**, so the raw value is
always retained alongside it (§3.1).

### 2.8 Scored acceptance (`accept.js`)

Candidate generation proposes a base body first (a prismatic solid from the
dominant plane set, an extrusion of a detected profile, or a revolve about a
detected axis), then feature candidates.

The loop is greedy on marginal gain: repeatedly accept whichever remaining
candidate most reduces symmetric-difference volume against the source; stop when
no candidate improves it past a threshold, when residual falls below target, or
when the budget is spent. A feature's `confidence` is literally the marginal
gain that admitted it, not a separate estimate.

**Cache-bracket constraint (load-bearing).** `geometry/solid-cache.js` bounds
retention to the current build's graph: each `begin()`/`end()` bracket rebuilds
a sub-part's retained set and disposes anything not reused that round. An
acceptance loop spanning many brackets would thrash the cache and churn WASM
memory. `accept.js` therefore runs inside **one** bracket, with a hard candidate
budget that degrades into residual rather than running unbounded.

## 3. The report

### 3.1 Facts layer

Five principles:

1. **Every fact carries its own residual.** Surfaces report RMS and max
   deviation; features report the acceptance score that admitted them. Nothing
   is asserted without an error bar.
2. **Stable symbolic ids** — `s0`, `f3`, `p0`. The agent refers to "pattern
   `p0`", never to a coordinate triple.
3. **Raw and snapped are both retained**, never one or the other.
4. **The coordinate frame is stated explicitly**, with a note that no
   realignment was applied. Z-up/Y-up confusion is a documented LLM failure mode
   and costs one line to defuse.
5. **Residual is localized, not summarized** — count, centroid, and bounds, not
   just a percentage.

```json
{
  "source":   { "name": "scan", "digest": "…", "triangles": 24310, "watertight": true, "units": "mm" },
  "frame":    { "up": "+Z", "note": "as-imported; no realignment applied" },
  "bounds":   { "size": [60, 40, 12], "min": […], "max": […] },
  "surfaces": [ { "id": "s7", "type": "cylinder", "axis": {…}, "radius": 2.65,
                  "extent": [0, 12], "area": 199.8, "triangles": 96, "rms": 0.0004 } ],
  "edges":    [ { "between": ["s0","s7"], "convexity": "concave", "kind": "circle", "radius": 2.65 } ],
  "features": [ { "id": "f3", "type": "throughHole", "diameter": 5.3, "depth": 12,
                  "entryFace": "s0", "exitFace": "s2", "surfaces": ["s7"], "confidence": 0.99,
                  "snapped": { "diameter": { "raw": 5.2996, "to": 5.3, "note": "M5 clearance" } } } ],
  "patterns": [ { "id": "p0", "type": "grid", "members": ["f3","f4","f5","f6"],
                  "counts": [2,2], "pitch": [50,30], "plane": "s0", "confidence": 0.97 } ],
  "symmetry": [ { "type": "mirror", "plane": { "normal": [1,0,0], "offset": 30 }, "coverage": 0.998 } ],
  "residual": { "areaFraction": 0.012, "regions": [ { "triangles": 290, "centroid": […], "bounds": {…} } ] },
  "score":    { "explainedArea": 0.988, "xorFraction": 0.0019, "bboxDelta": [0.01, 0.01, 0.02] }
}
```

### 3.2 Hints layer

Physically separate and explicitly labeled as unverified. Its steps come out in
**acceptance order**, which is already a build order — a direct payoff of the
propose-then-confirm pipeline. No heuristic decides sequencing.

```json
"suggestion": {
  "disclaimer": "Proposed reconstruction, not measurement. The facts above are authoritative.",
  "params": [ { "name": "plateW", "value": 60, "from": "bounds.size[0]" },
              { "name": "holeDia", "value": 5.3, "from": "p0" } ],
  "steps":  [ { "op": "box",    "explains": ["s0","s1","s2","s3","s4","s5"], "score": 0.94, "args": {…} },
              { "op": "cut",    "explains": ["f3","f4","f5","f6"], "pattern": "p0", "score": 0.99, "with": {…} },
              { "op": "fillet", "explains": ["f7"], "radius": 2, "score": 0.91, "edges": "vertical" } ]
}
```

### 3.3 Bounded shape — a hard requirement, not a nicety

Everything crossing partforge-cloud's sandbox boundary is treated as
attacker-controlled: `protocol.js`'s `sanitizeResult` whitelists fields, types,
**and sizes**, with hard caps (`MAX_SUBPARTS` 40, `MAX_ISSUES` 40, `MAX_NAME`
120). An unbounded `surfaces[]` cannot cross it.

So every array in the report carries a documented cap — `MAX_SURFACES`,
`MAX_EDGES`, `MAX_FEATURES`, `MAX_PATTERNS`, `MAX_RESIDUAL_REGIONS` — and the
report sets `truncated: true` naming which caps it hit. Caps are declared in one
plain-data module with no imports (the idiom `src/chat/profileLimits.js` uses in
cloud) so both ends can share them without dragging in a dependency graph.

### 3.4 Compact vs full — designed here, not downstream

Two shapes, **both defined in partforge**, next to each other in `report.js`:

- **Full** — everything above. Written to disk by the CLI, returned by `--json`.
- **Compact** — features, patterns, symmetry, score, residual, and the
  suggestion. Surfaces and edges elided to counts. This is what a model reads.

The compact shape must live here rather than being invented by each consumer,
or cloud's trim and the CLI's summary drift apart. This mirrors what
`mountManager.js`'s `compactReport` does for `measure`/`verify` today — and that
function is precedent for the fact that a *full* oracle report is not a
model-facing artifact.

A 24k-triangle part can produce several hundred surfaces; dumping them buries
the agent in exactly the noise the oracle exists to remove.

## 4. Caching

Three caches stack. Together they are what make `describe` affordable across a
long multi-turn session.

### 4.1 `describe` is pure in the mesh

The key property. `measure`/`verify` depend on part source *and* params, so they
re-run on every apply. **`describe` depends on nothing but the imported bytes.**

Therefore the report memoizes on the import's content digest — the same
`h("import", name, digest)` key the geometry cache already folds in — and the
memo lives in the worker beside the parsed mesh master, which is already
resident for the worker's lifetime (import bytes and parsed masters are
memoized process-wide by source identity; see `AUTHORING-PARTS.md` § "Caching &
content-stability").

Because partforge-cloud's `workerPool` keeps the real worker alive across
`setPart` rebinds, **an edit can never invalidate the report.** Compute once per
mesh per worker; reuse for the whole session. A genuinely changed file has a new
digest and misses the memo correctly.

### 4.2 Reconstruction rides the existing solid cache

Every candidate `accept.js` builds is an ordinary boundary op with a content
hash, so it lands in `solid-cache.js` and is shared through the cross-partition
`index`. A warm re-run is nearly free, and repeated candidate subtractions reuse
shared subtrees. Subject to the one-bracket constraint in §2.8.

### 4.3 Prompt caching — and what it forbids

The agent loop already tracks `cacheCreationInputTokens` /
`cacheReadInputTokens` (`summarizeAgentUsage`). Because the mesh is immutable,
the report is stable text in the conversation prefix and rides Anthropic's
prompt cache at read rates on every later turn.

This yields a firm rule: **describe once, inline once, never re-emit.** A tool
that re-fetches the whole report each turn would bust the stable prefix and pay
full rate every turn — the opposite of the intent. Detail is pulled per-question
via a narrow drill-down tool (§7.2), never re-broadcast.

## 5. Failure behavior

**"I could not recognize this" is never an exception — it is residual.** The
only throws are ones that already exist: unreadable file, mesh still
non-manifold after repair. Everything else degrades.

**Low coverage is a banner, not a field.** A report with low `explainedArea`
must say so loudly at the top of the compact shape. A confident-looking feature
list covering 61% of a part is worse than no report at all, because the agent
will build against it.

Recoverable problems emit the repo's structured `(cause, location,
correctiveAction)` diagnostics. Errors come from a **closed set** —
`not-manifold` | `too-large` | `empty` | `budget-exceeded` | `unreadable` —
following the reject-never-rewrite stance `svgProfile.js` takes in cloud, so
every consumer can map codes to copy exhaustively. Each gets an
`ERROR-PATTERNS.md` entry per the repo's grep-first rule.

## 6. CLI surface

```
npx partforge describe <mesh-path | part.js#importName> [--json] [--surfaces] [--budget N]
```

Prints the compact markdown summary by default; `--json` emits the full report;
`--surfaces` includes the surface and edge graph in the text output. Exits
non-zero only on a closed-set error, never on low coverage — coverage is a
finding, not a failure.

Sits alongside `lint` / `measure` / `render` in `bin/cli.js`, and gains a
`describe` worker job type in the framework's job protocol so the browser can
post it the way it posts `inspect`.

## 7. partforge-cloud integration (follow-up, separate repo and PR)

### 7.1 Intake: copy the SVG-profile pattern

An SVG dropped on the composer is not attached as a picture — it is converted at
intake into a hidden `data-profile` part plus a preview raster, and
`inlineProfileSummaries` rewrites it at the model boundary into one bracketed
sentence. **The contour data never rides model tokens in either direction.**

A dropped mesh follows the same shape: a hidden `data-mesh` part carrying the
handle, a preview raster beside it, and an `inlineMeshSummaries` that rewrites
it at the model boundary into **the compact describe report**. The report plays
the "bracketed sentence" role, just richer. The triangles never ride tokens; the
semantics do. That is the entire point of the feature.

### 7.2 Tool surface

The main report is **auto-inlined at attach time**, not fetched by a tool (§4.3).
What the model gets is one narrow client-side tool — no `execute`, like the
other six part tools, because the mesh and kernel live in the browser:

```
describe_region({ meshId, featureId? , bounds? })
```

It returns the elided detail for one feature or region. No `expectedTreeHash`:
describe reads, it does not mutate the tree.

### 7.3 Job path and timeout

`describe` cannot ride the `inspect` path. `requestReport` caps at 8000 ms and
resolves `undefined` on timeout so a good build is never sunk by inspection;
describe is far heavier. It needs its own job type with its own budget, running
asynchronously so it never blocks or fails an apply. Best-effort semantics carry
over unchanged.

### 7.4 Two traps to handle up front

- **The `data-mesh` part type must be added to the user-message union in
  `src/server/chatRequest.js`**, or every send carrying it 400s — permanently,
  since ChatPane's debounced save persists the part before the request fails, so
  every later send and warm replays it. `AGENTS.md` records `data-profile`
  shipping in exactly that state once.
- **The report needs its own link in the cap chain**, checked at *attach* time
  (where the user can start a fresh chat) rather than at send time (where the
  message is already written). Beneath it sits the server's
  `MAX_CHAT_JSON_CHARS` (1M). These are ceilings, not mirrors — do not align the
  numbers.

## 8. Testing

1. **Unit fixtures, zero kernel.** Hand-built triangle soups — a cube, a
   cylinder, one filleted edge — exercising `fit.js`, `topology.js`'s dihedral
   signs, and `segment.js` directly. Fast, no WASM boot. This is the payoff of
   the kernel-free split in §1.
2. **Round-trip the repo's own reference parts.** Build `demo.js`,
   `filleted-box.js`, `bracket.js`, `planter.js` with Manifold, take the mesh,
   run `describe`, assert the recovered features match what the part
   *declares*. Free, perfectly-labeled ground truth for the exact input class we
   target, already sitting in the repo. The strongest test asset in the project.
3. **Third-party STL corpus.** The honest limit on (2) is that it tests against
   *ideal* input — our own tessellation. Real downloaded STLs are decimated,
   re-meshed, and occasionally slightly non-manifold. Without a small corpus of
   genuine third-party files as fixtures, the suite goes green against a
   describer that falls over on the first real file.
4. **Noise injection** on the (2) meshes: perturb vertices, assert score drops,
   features survive, nothing throws. Cheap forward-compat check for the
   scans-later path.
5. **Score monotonicity** as a property test — every accepted candidate must
   strictly reduce xor volume. Catches acceptance-loop bugs for almost nothing.
6. **Cap enforcement** — a synthetic high-surface-count mesh must produce a
   capped, `truncated`-flagged report, not an unbounded one.
7. **Layering** — the existing `test/worker-layering.test.js` covers the new
   modules unchanged.
8. **CLI smoke** on `import-demo.js`'s scan asset.

## 9. Out of scope for v1

- **Real 3D scan input.** Fitting stays robust, but noise, drift, hole-filling
  and manufacturing deviation are not targeted or tested beyond (4) above.
- **Reading STEP B-rep directly.** For a STEP import there is a strictly better
  path — read the B-rep and skip segmentation entirely. v1 stays mesh-only for
  uniformity; this is the obvious v2.
- **Iterative self-refinement.** The oracle scores and reports; it does not
  refit-and-retry from its own residual the way CADFit does.
- **Threads, lofts, hulls, curve profiles, text.** Recognized as residual, not
  as features. Several are research-grade on their own.
- **Emitting a runnable part file.** The hints layer proposes; the agent writes.

## 10. Implementation phases

Two plans, not one. They land in different repos and must not be merged into a
single sequence.

- **Phase A — partforge (this repo).** §§1-6 and §8: the pipeline, both report
  shapes, the caps module, the `describe` worker job, the CLI verb, and the test
  suite. Complete and useful on its own — the CLI closes the loop locally
  without any cloud work.
- **Phase B — partforge-cloud (separate repo, separate PR).** §7: intake,
  `inlineMeshSummaries`, the `describe_region` tool, the job path, the
  `chatRequest.js` union, and the cap chain. Depends on a published Phase A.

**Release note for Phase A: bump `package.json` on the feature branch, in the
PR.** Forgetting is the documented quiet failure mode — the merge lands, the
version already exists on npm, the publish workflow correctly does nothing, and
the work never ships. Phase B pins `^<version>` and regenerates its prompt
corpus against the installed package, so let the publish finish before bumping
the dependency there.

## Sources

Primitive extraction: Schnabel/Wahl/Klein, *Efficient RANSAC for Point-Cloud
Shape Detection* (CGF 2007); Cohen-Steiner et al., *Variational Shape
Approximation* (TOG 2004); CGAL Shape Detection package docs.
Feature recognition: Joshi & Chang, AAG (1988); AAGNet (RCIM 2023); BrepMFR
(CAD 2024).
Learned reconstruction: CAD-Recode (arXiv 2412.14042, ICCV 2025); Point2CAD
(arXiv 2312.04962); ParSeNet; HPNet; SED-Net; ComplexGen; CSGNet; UCSG-Net;
CAPRI-Net; ExtrudeNet (ECCV 2022); SECAD-Net (CVPR 2023); Point2Primitive (arXiv
2505.02043); CADFit (arXiv 2605.01171); BrepLLM (arXiv 2512.16413, ECCV 2026).
Commercial: Geomagic Design X; Autodesk Fusion mesh→BRep (prismatic);
Paramesh AI; Backflip AI.
In-repo: `docs/research/llm-cad-generation-strategies.md`;
`docs/superpowers/specs/2026-08-16-geometry-import-design.md`.
