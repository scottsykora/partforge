// Transport bar + playback driver for part-declared animations. The bar is
// framework-generated DOM appended to the stage (no host markup needed, like
// the debug overlay); the driver ticks the pure playback state machine
// (animation.js) from the viewer's frame loop and routes every param write
// through the mount-supplied applyValues hook — the same path as a slider
// edit, minus the regen debounce. Returns null when the part declares no
// (valid) animations, so mount can wire it unconditionally.
import { normalizeAnimations, createPlayback } from "./animation.js";
import { createInfoPopover, attachInfo } from "./controls.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function btn(className, text, label) {
  const b = el("button", className, text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}

// Where the transport bar may sit, given the stage width, the bar's natural
// width, and the viewbar's left edge (all px, viewbarLeft stage-relative).
// null → the CSS default (centered) already clears the viewbar. Otherwise
// inline overrides: `left` slides the bar toward the stage's `margin`, and
// when even that isn't enough, `maxWidth` caps the bar so the `gap` holds.
export function planAnimBarPlacement({ stageWidth, barWidth, viewbarLeft }, { gap = 10, margin = 12 } = {}) {
  const centeredLeft = (stageWidth - barWidth) / 2;
  const limit = viewbarLeft - gap - barWidth;
  if (centeredLeft <= limit) return null;
  const left = Math.max(margin, limit);
  const available = Math.max(0, viewbarLeft - gap - margin);
  return barWidth > available ? { left, maxWidth: available } : { left };
}

// A setter for an element's text that MUTATES its existing text node instead of
// replacing it. `el.textContent = x` always replaces the node, and WebKit will
// not dispatch a `click` on an element whose text node was replaced between
// mousedown and mouseup — so a label that can change while the user is pressing
// it must be written this way or the press is silently swallowed. Isolated in
// WebKit on a 120ms press: `textContent = <identical string>` loses the click,
// `node.data = <same>` never does, and neither does an attribute write.
//
// This is what makes the transport's glyph safe even when it legitimately flips
// mid-press (playback ending under the user's finger), which no amount of
// skipping redundant writes can cover.
function textSetter(element) {
  const node = element.firstChild?.nodeType === 3
    ? element.firstChild
    : element.appendChild(document.createTextNode(""));
  return (value) => { if (node.data !== value) node.data = value; };
}

export function attachAnimationControls(viewer, part, { container, applyValues, getParamValues }) {
  // A malformed animations block must degrade to "no transport bar", never a
  // crashed mount — lint reports the specifics; the viewer just goes without.
  let animations;
  try { animations = normalizeAnimations(part); } catch { animations = []; }
  if (!animations.length) return null;

  const reducedMotion = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tweenDuration = reducedMotion ? 0 : 0.6; // reduced motion: jump cut, no sweep

  let current = animations[0];
  let playback = createPlayback(current);
  let snapshot = null; // tracked-param values before this animation first drove them

  // Autoplay: at most one animation declares it (lint-enforced). Armed until
  // the user manually touches the transport — and never armed at all under
  // prefers-reduced-motion: self-starting motion is exactly what that setting
  // opts out of. The transport still plays everything on request.
  const autoplayAnim = animations.find((a) => a.autoplay) ?? null;
  let autoplayArmed = !!autoplayAnim && !reducedMotion;
  const disarmAutoplay = () => { autoplayArmed = false; };

  // --- DOM --------------------------------------------------------------------
  const bar = el("div", "pf-anim-bar");
  const info = createInfoPopover();

  const pick = document.createElement("select");
  pick.className = "pf-anim-pick";
  pick.setAttribute("aria-label", "Choose animation");
  for (const a of animations) {
    const o = document.createElement("option");
    o.value = a.name; o.textContent = a.label;
    pick.append(o);
  }
  const title = el("span", "pf-anim-title", "");
  bar.append(animations.length > 1 ? pick : title);
  const infoSlot = el("span", "pf-anim-info");
  const playBtn = btn("pf-anim-play", "▶", "Play animation");
  const prevBtn = btn("pf-anim-step-btn", "‹", "Previous step");
  const stepLabel = el("span", "pf-anim-step", "");
  const nextBtn = btn("pf-anim-step-btn", "›", "Next step");
  const scrubWrap = el("span", "pf-anim-scrub-wrap");
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = "0"; scrub.max = "1000"; scrub.step = "1"; scrub.value = "0";
  scrub.className = "pf-anim-scrub";
  scrub.setAttribute("aria-label", "Animation position");
  scrubWrap.append(scrub);
  const resetBtn = btn("pf-anim-reset", "↺", "Reset animation");
  bar.append(infoSlot, playBtn, prevBtn, stepLabel, nextBtn, scrubWrap, resetBtn);
  container.append(bar);

  // Per-animation chrome: title, ⓘ description, step buttons, scrubber ticks.
  function syncStructure() {
    title.textContent = current.label;
    infoSlot.replaceChildren();
    attachInfo(infoSlot, current.description ?? "", info);
    const stepped = current.steps.length > 1;
    prevBtn.hidden = nextBtn.hidden = stepLabel.hidden = !stepped;
    for (const n of scrubWrap.querySelectorAll(".pf-anim-tick")) n.remove();
    if (stepped) {
      for (const t of current.stepStarts.slice(1)) {
        const tick = el("span", "pf-anim-tick");
        tick.style.left = `${t * 100}%`;
        scrubWrap.append(tick);
      }
    }
  }

  // syncUi() runs on every playback frame. Two rules keep that from eating the
  // user's clicks, and they are independent:
  //
  // 1. Text goes through textSetter (see above), so the button's text node is
  //    mutated and never replaced. This is the one that matters, because it
  //    holds even when the glyph legitimately changes under a held finger —
  //    playback ending, or a step boundary crossing, mid-press.
  // 2. Each element has its own renderer that leaves early when its own value
  //    is unchanged, so a playing transport does no DOM work per frame at all.
  //    Per ELEMENT, not per write: driving several elements off one shared
  //    state key means a step change also redraws the button, which was still
  //    enough to lose the click before rule 1 was in place.
  //
  // Without rule 1 this cost the pause click outright: press, release, no click
  // event at all, and only ever while playing — the one moment the button is
  // for. Measured in WebKit, any press held >= 40ms lost it (a real click is
  // ~100ms; a synthetic 0ms one survives, which is why automated clicking never
  // saw it). Reset was never affected: nothing rewrites that button per frame.
  const setPlayGlyph = textSetter(playBtn);
  const setStepText = textSetter(stepLabel);
  let shownActive = null;
  let shownStep = null;

  function renderPlayButton(active) {
    if (active === shownActive) return;
    shownActive = active;
    setPlayGlyph(active ? "⏸" : "▶");
    const label = active ? "Pause animation" : "Play animation";
    playBtn.setAttribute("aria-label", label);
    playBtn.title = label;
  }

  function renderStepLabel(stepIndex) {
    if (current.steps.length <= 1 || stepIndex === shownStep) return;
    shownStep = stepIndex;
    const step = current.steps[stepIndex];
    setStepText(`${stepIndex + 1}/${current.steps.length} · ${step.label}`);
  }

  function syncUi() {
    const { status, t, stepIndex } = playback.state();
    // The scrubber is the one thing that genuinely moves every frame. Assigning
    // `.value` updates a property rather than replacing a child node, so it
    // costs no clicks — and it is not what anyone reaches for mid-playback.
    scrub.value = String(Math.round(t * 1000));
    renderPlayButton(status === "playing" || status === "intro");
    renderStepLabel(stepIndex);
  }

  // selectAnimation swaps in a fresh playback whose state can coincide with the
  // outgoing one; the chrome still has to re-render for the new animation.
  function invalidateUi() { shownActive = null; shownStep = null; }

  // --- driver -----------------------------------------------------------------
  // A frame that throws — a malformed cue or track that slipped past lint, a
  // viewer that rejects a view name — must cost that frame, not the render
  // loop: this callback runs from the viewer's frame listeners, and letting it
  // propagate would take the other listeners down with it. Warn once, then
  // stay quiet so a bad frame can't flood the console 60x a second.
  let frameFailureWarned = false;
  function warnFrameFailure(err) {
    if (frameFailureWarned) return;
    frameFailureWarned = true;
    console.warn("partforge: animation frame failed", err);
  }
  function apply(r) {
    if (!r) return;
    try {
      // First write for this run: remember what the user's params were, so Reset
      // can put them back.
      if (snapshot == null && Object.keys(r.values).length) snapshot = getParamValues(current.trackedKeys);
      applyValues(r.values);
      if (r.cue) {
        viewer.tweenCameraTo(r.cue.view, {
          duration: tweenDuration,
          // An intro cue gates playback until the tween settles; mid-timeline
          // cues overlap playback and need no completion signal.
          onComplete: r.status === "intro" ? () => guarded(() => playback.introDone()) : undefined,
        });
      }
      syncUi();
    } catch (err) {
      warnFrameFailure(err);
    }
  }

  // Every transport entry point goes through here so the STATE-MACHINE call is
  // inside the guard too, not just apply(). playback.tick() is evaluated in the
  // render loop, and three re-arms requestAnimationFrame only after the frame
  // callback returns — a throw escaping from there stops the rAF chain and
  // freezes the viewer permanently instead of costing one frame.
  function guarded(produce) {
    try { apply(produce()); } catch (err) { warnFrameFailure(err); }
  }

  function doReset() {
    playback.reset();
    viewer.cancelCameraTween();
    if (snapshot) { applyValues(snapshot); snapshot = null; }
    syncUi();
  }

  function selectAnimation(name) {
    const next = animations.find((a) => a.name === name);
    if (!next || next === current) return;
    doReset();
    current = next;
    playback = createPlayback(current);
    if (animations.length > 1) pick.value = name;
    syncStructure();
    invalidateUi(); // a fresh playback starts idle at step 0 — the same key the
                    // outgoing one may have been showing, but for another animation
    syncUi();
  }

  const offFrame = viewer.onFrame((dt) => guarded(() => playback.tick(dt)));
  // User orbit: the viewer has already cancelled any cue tween (its own
  // "start" handler); disarm the remaining cues, and if an intro tween was
  // gating playback, settle the gate — cancel() never fires onComplete, so
  // without this the machine would sit in "intro" forever.
  const offOrbit = viewer.onCameraStart(() => {
    playback.disarmCues();
    if (playback.state().status === "intro") guarded(() => playback.introDone());
  });

  const onPlayClick = () => {
    disarmAutoplay();
    const active = playback.state().status;
    if (active === "playing" || active === "intro") {
      viewer.cancelCameraTween();
      guarded(() => playback.pause());
    } else {
      guarded(() => playback.play());
    }
  };
  const onScrub = () => { disarmAutoplay(); guarded(() => playback.seek(Number(scrub.value) / 1000)); };
  const onPrev = () => { disarmAutoplay(); guarded(() => playback.stepPrev()); };
  const onNext = () => { disarmAutoplay(); guarded(() => playback.stepNext()); };
  const onPick = () => { disarmAutoplay(); selectAnimation(pick.value); };
  const onResetClick = () => { disarmAutoplay(); doReset(); };
  playBtn.addEventListener("click", onPlayClick);
  scrub.addEventListener("input", onScrub);
  prevBtn.addEventListener("click", onPrev);
  nextBtn.addEventListener("click", onNext);
  pick.addEventListener("change", onPick);
  resetBtn.addEventListener("click", onResetClick);

  syncStructure();
  syncUi();

  // --- placement: keep clear of the viewbar ---------------------------------
  // chrome.css centers the bar (left: 50% / translateX(-50%)), and nothing in
  // CSS can stop that centered position sliding under #viewbar when the stage
  // narrows — the viewbar's width is dynamic (cutaway's Flip/Reset appear and
  // disappear), so a static reservation would either overlap or waste centre
  // space. Measure instead: when the two bars' vertical bands intersect, clamp
  // the bar's left so a 10px gap to the viewbar holds, capping its width if
  // even the stage's 12px margin isn't enough. Overrides are inline and
  // cleared at the top of every pass, so chrome.css (or a host that
  // re-anchors either bar out of the shared band) stays authoritative the
  // moment the constraint stops binding. The clear-measure-apply sequence is
  // loop-safe: it settles within one frame, so ResizeObserver — which reports
  // rendered sizes at frame boundaries — never sees the intermediate state.
  const viewbarEl = container.querySelector("#viewbar");
  let placementRaf = 0;
  function applyPlacement() {
    placementRaf = 0;
    bar.style.left = "";
    bar.style.transform = "";
    bar.style.maxWidth = "";
    bar.style.overflow = "";
    const vb = viewbarEl?.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    if (!vb || barRect.top >= vb.bottom || barRect.bottom <= vb.top) return;
    const stageRect = container.getBoundingClientRect();
    const plan = planAnimBarPlacement({
      stageWidth: stageRect.width,
      barWidth: barRect.width,
      viewbarLeft: vb.left - stageRect.left,
    });
    if (!plan) return;
    bar.style.left = `${plan.left}px`;
    bar.style.transform = "none";
    // maxWidth is the last resort, only reached when even the margin can't
    // hold the gap — and the bar's flex children have hard minimums (~320px)
    // that don't shrink to fit a tighter cap. overflow:hidden only applies
    // here, inline, because a static rule in app.css would also clip the ⓘ
    // info popover in the (far more common) uncapped state.
    if (plan.maxWidth != null) {
      bar.style.maxWidth = `${plan.maxWidth}px`;
      bar.style.overflow = "hidden";
    }
  }
  function schedulePlacement() {
    if (typeof requestAnimationFrame !== "function") return applyPlacement();
    if (!placementRaf) placementRaf = requestAnimationFrame(applyPlacement);
  }
  // Observing the bar itself catches content-driven width changes (step label
  // text, animation switch); the viewbar, cutaway's actions; the stage, rail
  // drags and window resizes.
  const placementObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(schedulePlacement) : null;
  if (placementObserver) {
    placementObserver.observe(container);
    placementObserver.observe(bar);
    if (viewbarEl) placementObserver.observe(viewbarEl);
  }
  schedulePlacement();

  const runtime = {
    // An unknown name is a host bug, not a request to play whatever happens to
    // be selected — say so and do nothing rather than silently animating
    // something else.
    play(name) {
      disarmAutoplay();
      if (name != null && !animations.some((a) => a.name === name)) {
        console.warn(`partforge: unknown animation "${name}"`);
        return;
      }
      if (name) selectAnimation(name);
      guarded(() => playback.play());
    },
    pause() { disarmAutoplay(); viewer.cancelCameraTween(); guarded(() => playback.pause()); },
    seek(t) { disarmAutoplay(); guarded(() => playback.seek(t)); },
    stop() { disarmAutoplay(); doReset(); },
    state: () => ({ animation: current.name, ...playback.state() }),
  };

  const handle = {
    runtime,
    // A user edit to any control (or a host setParams) takes over the params:
    // pause playback rather than fight over them.
    notifyUserEdit() {
      disarmAutoplay();
      viewer.cancelCameraTween();
      playback.userEdited();
      syncUi();
    },
    // Mount calls this on first ready and on every view/tab switch.
    autoplayKick() {
      if (!autoplayArmed || !autoplayAnim) return;
      if (current !== autoplayAnim) selectAnimation(autoplayAnim.name);
      const { status } = playback.state();
      if (status !== "playing" && status !== "intro") guarded(() => playback.play());
    },
    detach() {
      offFrame();
      offOrbit();
      playBtn.removeEventListener("click", onPlayClick);
      scrub.removeEventListener("input", onScrub);
      prevBtn.removeEventListener("click", onPrev);
      nextBtn.removeEventListener("click", onNext);
      pick.removeEventListener("change", onPick);
      resetBtn.removeEventListener("click", onResetClick);
      info.dispose();
      placementObserver?.disconnect();
      if (placementRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(placementRaf);
      bar.remove();
    },
    __viewer: viewer, // test hook only
  };
  return handle;
}
