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

  function syncUi() {
    const { status, t, stepIndex } = playback.state();
    const active = status === "playing" || status === "intro";
    playBtn.textContent = active ? "⏸" : "▶";
    playBtn.setAttribute("aria-label", active ? "Pause animation" : "Play animation");
    playBtn.title = playBtn.getAttribute("aria-label");
    scrub.value = String(Math.round(t * 1000));
    if (current.steps.length > 1) {
      const step = current.steps[stepIndex];
      stepLabel.textContent = `${stepIndex + 1}/${current.steps.length} · ${step.label}`;
    }
    viewer.suppressAutoRotate(active);
  }

  // --- driver -----------------------------------------------------------------
  // A frame that throws — a malformed cue or track that slipped past lint, a
  // viewer that rejects a view name — must cost that frame, not the render
  // loop: this callback runs from the viewer's frame listeners, and letting it
  // propagate would take the other listeners down with it. Warn once, then
  // stay quiet so a bad frame can't flood the console 60x a second.
  let frameFailureWarned = false;
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
          onComplete: r.status === "intro" ? () => apply(playback.introDone()) : undefined,
        });
      }
      syncUi();
    } catch (err) {
      if (!frameFailureWarned) {
        frameFailureWarned = true;
        console.warn("partforge: animation frame failed", err);
      }
    }
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
    syncUi();
  }

  const offFrame = viewer.onFrame((dt) => apply(playback.tick(dt)));
  // User orbit: the viewer has already cancelled any cue tween (its own
  // "start" handler); disarm the remaining cues, and if an intro tween was
  // gating playback, settle the gate — cancel() never fires onComplete, so
  // without this the machine would sit in "intro" forever.
  const offOrbit = viewer.onCameraStart(() => {
    playback.disarmCues();
    if (playback.state().status === "intro") apply(playback.introDone());
  });

  const onPlayClick = () => {
    const active = playback.state().status;
    if (active === "playing" || active === "intro") {
      viewer.cancelCameraTween();
      apply(playback.pause());
    } else {
      apply(playback.play());
    }
  };
  const onScrub = () => apply(playback.seek(Number(scrub.value) / 1000));
  const onPrev = () => apply(playback.stepPrev());
  const onNext = () => apply(playback.stepNext());
  const onPick = () => selectAnimation(pick.value);
  playBtn.addEventListener("click", onPlayClick);
  scrub.addEventListener("input", onScrub);
  prevBtn.addEventListener("click", onPrev);
  nextBtn.addEventListener("click", onNext);
  pick.addEventListener("change", onPick);
  resetBtn.addEventListener("click", doReset);

  syncStructure();
  syncUi();

  const runtime = {
    // An unknown name is a host bug, not a request to play whatever happens to
    // be selected — say so and do nothing rather than silently animating
    // something else.
    play(name) {
      if (name != null && !animations.some((a) => a.name === name)) {
        console.warn(`partforge: unknown animation "${name}"`);
        return;
      }
      if (name) selectAnimation(name);
      apply(playback.play());
    },
    pause() { viewer.cancelCameraTween(); apply(playback.pause()); },
    seek(t) { apply(playback.seek(t)); },
    stop() { doReset(); },
    state: () => ({ animation: current.name, ...playback.state() }),
  };

  const handle = {
    runtime,
    // A user edit to any control (or a host setParams) takes over the params:
    // pause playback rather than fight over them.
    notifyUserEdit() {
      viewer.cancelCameraTween();
      playback.userEdited();
      syncUi();
    },
    detach() {
      offFrame();
      offOrbit();
      playBtn.removeEventListener("click", onPlayClick);
      scrub.removeEventListener("input", onScrub);
      prevBtn.removeEventListener("click", onPrev);
      nextBtn.removeEventListener("click", onNext);
      pick.removeEventListener("change", onPick);
      resetBtn.removeEventListener("click", doReset);
      info.dispose();
      bar.remove();
      viewer.suppressAutoRotate(false);
    },
    __viewer: viewer, // test hook only
  };
  return handle;
}
