# What makes LLMs succeed at generating parametric CAD

*Research survey, July 2026. Method: multi-angle web/literature sweep (20 sources,
mostly 2024–2026 arXiv papers plus practitioner writeups), claim extraction, and
adversarial 3-vote verification of the top claims. Findings marked **[verified]**
survived that verification; **[single-source]** ones were extracted but not
independently verified (the verify pass was cut short by a token budget). Three
claims from one benchmark (arXiv 2605.10865's specialist-vs-frontier IoU numbers)
were actively refuted by verifiers and are excluded.*

The headline: **the biggest wins come from the feedback loop around the LLM, not
the LLM itself.** partforge's `measure`/`verify`/`render` CLI is already the right
architecture. The survey's original first three gaps were tracked as issues
[#27](https://github.com/scottsykora/partforge/issues/27),
[#28](https://github.com/scottsykora/partforge/issues/28), and
[#29](https://github.com/scottsykora/partforge/issues/29); structured diagnostics,
the symptom-indexed pattern library, and near-miss/contact/clearance checks have since
landed. The remaining frontier is preserving requirement authority and extending the
loop from geometric validity to explicit physical assumptions and engineering evidence.

---

## 1. Closed-loop execution feedback is the single biggest lever

- Executing generated CAD code and feeding the raw error back for self-correction
  raised execution success **53% → 85%** (Gemini 2.0 Flash annotating the
  Text-to-CadQuery dataset). **[verified]**
  ([2505.06507](https://arxiv.org/pdf/2505.06507))
- A dual-loop agent — inner loop fixes execution errors, outer loop judges geometry
  with **kernel measurements plus a VLM over renders** — took median IoU
  0.81 → 0.96 and cut mean Chamfer distance ~40× vs. zero-shot. **[single-source]**
  ([2603.26512](https://arxiv.org/pdf/2603.26512))
- Test-time compute spent as an **external-feedback repair loop scales far better
  than a bigger one-shot reasoning budget**: 10 FEA-graded repair attempts raised
  requirement-pass 38.8% → 60.5%, while raising reasoning effort alone was nearly
  flat (Hephaestus-CCX). **[single-source]**
- **Error message quality is itself a lever**: structured
  `(ErrorCause, ErrorLocation, CorrectiveAction)` triples cut average retries
  2.62 → 1.86 and lifted success 81.5% → 100%. **[single-source]**
  ([2508.01031](https://arxiv.org/html/2508.01031v5)) → implemented in partforge's
  diagnostics contract
- The cad-khana project (build123d) reaches the same design from practice: the
  bottleneck is feedback, not code generation — emit a `diagnostics.json`
  (interference, clearance, wall thickness, overhangs) on every build, and turn
  in-script geometric assertions into **hard build failures** rather than trusting
  the model to self-check. **[single-source]**
  ([cad-khana](https://github.com/cyberchitta/cad-khana))
- **Refinement saturates fast**: CADCodeVerify saw no improvement past iteration 2.
  Budget 2–3 repair rounds unless hard external metrics (FEA, verify gates) drive
  each round. **[verified]** ([2410.05340](https://arxiv.org/abs/2410.05340))

## 2. Numbers beat pixels for simple parts; renders become essential for complex ones

- Models reason about CAD **far more reliably from code than from images**
  (0.836 vs 0.587 QA score) — machine-readable geometry facts should be the primary
  feedback channel. **[verified]**
- On the hardest multi-feature parts, removing rendered views from the judge
  degraded Chamfer distance **~35×**, while kernel metrics alone sufficed for simple
  parts. **[single-source]** ([2603.26512](https://arxiv.org/pdf/2603.26512))
- Dense views help: going from the usual 4–6 renders to **21 calibrated views
  including close-ups and x-ray section cuts** raised GPT-5.5's requirement-pass
  19.4% → 29.3% (Hephaestus-CCX). But its full ablation found 7 views sometimes
  matched or beat 21 on simpler/exterior-dominated parts: target close-ups and section
  views at hidden or high-risk interfaces instead of maximizing image count blindly.
  **[single-source]**
- The strongest visual-feedback pattern is not "here's a render, fix it" but
  **structured self-verification** (CADCodeVerify): the VLM derives 2–5 binary
  validation questions from the original request, answers them against 4 renders
  (0°/90°/180°/270°), and only the *failed* questions become corrective feedback.
  Beat raw image-based refinement (3D-Premise) on both geometry and compile rate.
  Few-shot examples and reference images in the loop are load-bearing (ablations).
  **[verified]** ([2410.05340](https://arxiv.org/abs/2410.05340))
- Blind spot, documented repeatedly: VLM critics **miss small gaps, disconnected
  parts, and incomplete boolean unions**. A quadcopter frame scored F1 0.963 /
  IoU 0.985, passed all checks, and was unmanufacturable — arms didn't meet the
  hub. Numeric near-contact checks must catch what renders can't.
  **[single-source]** ([2603.26512](https://arxiv.org/pdf/2603.26512)) → implemented
  as near-miss reporting plus `contacts` / `clearance` gates

## 3. Target a representation the model knows; design the DSL for statelessness and named references

- Emitting a **mainstream, pretrained-known language** (CadQuery Python) beat
  purpose-built CAD command sequences: top-1 exact match 58.8% → 69.3%, Chamfer
  distance −48.6%. **[verified]** ([2505.06507](https://arxiv.org/pdf/2505.06507))
  Zoo built KCL text-first for the same reason. **[single-source]**
- **Explicit state beats fluent chaining**: an explicit-state paradigm (each op maps
  input state + params → new state) hit 100% execution success vs CadQuery's 87.5%
  and build123d's 96%. **[single-source]**
  ([2508.01031](https://arxiv.org/html/2508.01031v5)) Practitioner echo: LLMs lose
  track of solid-vs-void after 2–3 nested CSG operations.
- **Symbolic, named references to faces/edges instead of coordinates** raised
  editing executability 58.4% → 82.5% and sidesteps the topological-naming problem.
  **[single-source]** ([2606.20607](https://arxiv.org/pdf/2606.20607))
- Practitioner (OpenSCAD): the biggest single improvement was having the LLM emit a
  **structured JSON intermediate representation** converted to geometry by
  deterministic code; pre-render validation of the IR caught ~90% of geometric
  errors. Direct-generation quality degrades sharply beyond ~20 lines of geometry
  code. **[single-source]**
- Expect a **bias toward plain sketch-and-extrude**: models systematically
  substitute simple extrusions for twists, lofts, and helical sweeps unless
  advanced ops are explicitly scaffolded in docs and examples. **[single-source]**
  ([2605.18430](https://arxiv.org/abs/2605.18430) area)
- Small type/semantic affordances pay off: encoding the return type in the function
  name (`chamfer_rsolid`) lifted Pass@1 0.32 → 0.45 in ablation. **[single-source]**

## 4. For a small custom DSL, curated docs + RAG beat fine-tuning

Fine-tuned specialists win on fixed distributions (CAD-Coder: 100% valid syntax vs
82–94% for prompted frontier models **[single-source]**), but gains are
distribution-bound and require ~10⁵ training pairs. For a frontier-agent-driven
custom framework the in-context findings matter more:

- **RAG over curated API docs is load-bearing**: one ablation saw *complete
  generation failure* when API function annotations were removed; a curated KB of
  ~155 method entries plus **25 error→solution patterns** substituted for
  fine-tuning entirely. **[single-source]**
  ([2603.26512](https://arxiv.org/pdf/2603.26512),
  [2508.01031](https://arxiv.org/html/2508.01031v5)) → implemented as
  `ERROR-PATTERNS.md` and its grep-first agent rule
- Doc-RAG also raises *ambition*: with searchable version-correct API docs, an
  agent used ~5× more complex modeling operations while making *fewer* errors
  (Blender 4.4 KB study). **[single-source]**
- **Reasoning/thinking modes measurably help**: 0.865 vs 0.740 edit accuracy
  **[verified]**; an independent 15-model OpenSCAD eval found the top 7 models were
  all reasoning models. **[single-source]**
  ([willpatrick.xyz](https://willpatrick.xyz/technology/2025/04/23/teaching-llms-how-to-solid-model.html))
- **Plan-then-fill decomposition** beats one-shot: a locked blueprint stage
  (envelopes, interfaces, machine-checkable acceptance claims) before geometry
  code; decompose vague functional goals into concrete parameter/operation edits —
  accuracy degrades monotonically with instruction abstraction (IoU 0.935 explicit
  → 0.708 functional). **[single-source]**
- Long rule-heavy prompts hit diminishing returns (~6k-token rule prompts lost to
  demonstration); **worked examples beat rules**. **[single-source]**
- Multi-turn interaction is the mechanism, not clever one-shot prompts: iterative
  conversational refinement beat automated one-shot prompting by 15–18 points
  across code tasks in a 37-participant study. **[single-source]**
  ([2310.10508](https://arxiv.org/html/2310.10508v2))

## 5. Known failure modes to design around

- Spatial reasoning degrades sharply with operation count: >80% success on
  single-operation OpenSCAD tasks fell to 3–30% at five operations. **[single-source]**
- Nested CSG state-tracking: models pattern-match operation keywords but lose
  solid-vs-void identity after 2–3 nested difference/union ops. **[single-source]**
- Coordinate-frame confusion (Z-up vs Y-up) from mixed training data. **[single-source]**
- Advanced-op substitution (see §3). **[single-source]**
- Near-miss gaps invisible to both metrics and renders (see §2). **[single-source]**
- All models — general and CAD-specific — degrade substantially on complex topology
  and advanced features relative to basic geometry. **[verified]**
  ([2605.18430](https://arxiv.org/abs/2605.18430))

## 6. Physical structures need an explicit engineering contract and an external oracle

- Hephaestus-CCX's blueprint records **datums, envelopes, interfaces, materials, load
  paths, supports/load selectors, and numbered verification targets before CAD code**.
  Its deterministic controller owns execution, measurement, validation, and FEA while
  the model owns design and repair. This is the clearest current pattern for preventing
  a plausible-looking solid from standing in for an engineering model. **[single-source]**
  ([2605.17448](https://arxiv.org/pdf/2605.17448))
- Physical parameters must be explicit rather than guessed. LLMPhy decomposes physical
  reasoning into scene/layout decisions plus identification of continuous parameters
  such as mass and friction, then uses simulator error to refine them. For CAD, unknown
  material properties, loads, constraints, tolerances, and safety factors should become
  stated unknowns or user questions, not silent model assumptions. **[single-source]**
  ([2411.08027](https://arxiv.org/abs/2411.08027))
- An agent that writes both an artifact and its tests is not an independent oracle.
  FEM-Bench evaluates generated scientific tests against a correct implementation and
  curated wrong implementations; even its best model reached only 73.8% average joint
  test success. Preserve user/specification criteria separately, and use analytical,
  simulation, or independently curated checks for physical claims. **[single-source]**
  ([2512.20732](https://arxiv.org/pdf/2512.20732))
- ActPlane generalizes the same authority problem to agent harnesses: higher-authority
  requirements must not be weakenable by the agent they constrain, and a successful
  check is valid only if it happened after the latest relevant edit. Its ablation also
  reinforces the value of structured recovery feedback over opaque denial. The useful
  partforge application is an application-level fresh-evidence gate, not an eBPF
  dependency. **[single-source]**
  ([2606.25189](https://arxiv.org/html/2606.25189v2))

---

## Implications for partforge

Already aligned with best practice: `partforge measure` with verify gates and
non-zero exit, canonical-angle `render`, `verify` blocks with min-wall, assembly
interpenetration and near-miss/contact/clearance checks, structured corrective
diagnostics, a symptom-indexed error-pattern library, declarative build-step vocabulary
with named sub-parts, request-a-pick for symbolic selection, and worked examples as the
documentation spine.

Gaps, in priority order:

1. **Separate acceptance authority from implementation** — preserve stable,
   user/specification-derived requirement IDs and thresholds outside the repairable
   geometry/check implementation; an agent may add checks but not weaken the contract.
2. **Fresh evidence for completion** — bind a passing report to the current source,
   parameters, view, backend, and framework version; any relevant edit invalidates it.
   A future `partforge check` command could emit this as one machine-readable bundle.
3. **Engineering-intent blueprint for physical parts** — state coordinate frame,
   datums, interfaces/tolerances, material/process assumptions, loads, supports, load
   paths, safety factors, and unresolved assumptions before geometry.
4. **Independent physical validation** — for load-bearing/safety-relevant parts,
   supplement geometric gates with analytical checks or an external FEA adapter and
   qualified human review; never describe `verify` alone as proof of safety.
5. Richer, targeted `render` for complex parts: section/x-ray views and close-ups at
   named interfaces or reported failure locations, with view count driven by complexity.
6. Validation-question loop for visual checks (derive binary questions from the
   request; feed only failures back) rather than raw "does this look right".
7. Cap unguided repair loops at ~2–3 rounds; continue longer only while hard external
   metrics provide new failure margins and measurable progress.
8. Keep the vocabulary explicit and named (`along().at()`, `rotateAbout`, named
   sub-parts); resist coordinate-heavy or fluent-chained API additions.

## Sources

Primary papers: [2505.06507](https://arxiv.org/pdf/2505.06507) (Text-to-CadQuery),
[2410.05340](https://arxiv.org/abs/2410.05340) (CADCodeVerify),
[2603.26512](https://arxiv.org/pdf/2603.26512) (dual-loop CadQuery agent),
[2504.01786](https://arxiv.org/abs/2504.01786) (BlenderGym),
[2508.01031](https://arxiv.org/html/2508.01031v5) (explicit-state paradigm),
[2605.18430](https://arxiv.org/abs/2605.18430) (Text2CAD-Bench),
[2507.09792](https://arxiv.org/html/2507.09792v2) (CADmium),
[2505.14646](https://arxiv.org/pdf/2505.14646) (CAD-Coder),
[2606.20607](https://arxiv.org/pdf/2606.20607) (LLM4CAD-Editor),
[2310.10508](https://arxiv.org/html/2310.10508v2) (prompting-vs-finetune study),
[2410.03981](https://arxiv.org/abs/2410.03981) (low-resource DSL survey),
Hephaestus-CCX ([2605.17448](https://arxiv.org/pdf/2605.17448)),
[2411.08027](https://arxiv.org/abs/2411.08027) (LLMPhy),
[2512.20732](https://arxiv.org/pdf/2512.20732) (FEM-Bench), and
[2606.25189](https://arxiv.org/html/2606.25189v2) (ActPlane).
Practitioner: [cad-khana](https://github.com/cyberchitta/cad-khana),
[Zoo/KCL](https://zoo.dev/research/introducing-kcl),
[Will Patrick — Teaching LLMs how to solid model](https://willpatrick.xyz/technology/2025/04/23/teaching-llms-how-to-solid-model.html),
[Why LLMs fail at OpenSCAD](https://dev.to/alanwest/why-llms-fail-at-openscad-code-generation-and-how-to-fix-it-2bel).
