// Transport bar + playback driver for part-declared animations. The bar is
// framework-generated DOM appended to the stage (no host markup needed, like
// the debug overlay); the driver ticks the pure playback state machine
// (animation.js) from the viewer's frame loop and routes every param write
// through the mount-supplied applyValues hook — the same path as a slider
// edit, minus the regen debounce. Returns null when the part declares no
// (valid) animations, so mount can wire it unconditionally.
import { normalizeAnimations, createPlayback, stepIndexAt } from "./animation.js";
import { createInfoPopover, attachInfo } from "./controls.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function setBtnLabel(b, label) {
  b.setAttribute("aria-label", label);
  b.title = label;
}
function btn(className, text, label) {
  const b = el("button", className, text);
  b.type = "button";
  setBtnLabel(b, label);
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

// The scrubber's resolution: `t` is reported to the user as one of this many
// steps, and read back the same way.
export const SCRUB_STEPS = 1000;

// Snap a seek target UP onto the scrubber's grid.
//
// syncUi rounds `t` onto that grid to position the thumb, but a chapter
// boundary rarely lands on it: with three equal chapters, 1/3 rounds DOWN to
// 0.333 — which is in the chapter BEFORE the one the playhead is really in. The
// bar then reports a chapter it is not at, and the next arrow-key nudge reads
// the rounded value back and "moves" the user a chapter without the position
// changing. Rounding up keeps the grid value on the same side of the boundary
// as `t`, so the playhead and what the scrubber shows always agree.
//
// A chapter shorter than one step can't be represented at all; nothing here can
// fix that, and lint's minimum step duration keeps it out of reach.
export function snapUpToScrubGrid(t) {
  const stepped = Math.ceil(t * SCRUB_STEPS - 1e-9) / SCRUB_STEPS;
  return Math.min(1, Math.max(0, stepped));
}

// "Close enough to a chapter's start to count as being ON it." One scrubber
// step, for the same reason: finer than the grid is finer than anything the
// user can see or land on.
const AT_BOUNDARY = 1 / SCRUB_STEPS;

// Center-x for the chapter bubble, in px within the scrub wrap: the bubble
// tracks `fraction` along the timeline but never hangs past either end. A
// wrap narrower than the bubble has no legal band — park it in the middle.
export function clampBubbleX(fraction, wrapWidth, bubbleWidth) {
  if (wrapWidth <= bubbleWidth) return wrapWidth / 2;
  const half = bubbleWidth / 2;
  return Math.min(Math.max(fraction * wrapWidth, half), wrapWidth - half);
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
  // Multi-animation parts page with ‹ › at the card's outer edges — whole
  // animations only, never chapters (chapters are the bubble + PageUp/Down).
  const paged = animations.length > 1;
  // pf-anim-page carries the shared styling; the direction classes let the
  // touch layout in app.css pull › in beside the chooser without reordering
  // the DOM, so the wide-pointer outer-edge placement stays the source order.
  const prevAnimBtn = paged ? btn("pf-anim-page pf-anim-page-prev", "‹", "Previous animation") : null;
  const nextAnimBtn = paged ? btn("pf-anim-page pf-anim-page-next", "›", "Next animation") : null;
  if (prevAnimBtn) bar.append(prevAnimBtn);
  bar.append(paged ? pick : title);
  const infoSlot = el("span", "pf-anim-info");
  const playBtn = btn("pf-anim-play", "▶", "Play animation");
  const scrubWrap = el("span", "pf-anim-scrub-wrap");
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = "0"; scrub.max = String(SCRUB_STEPS); scrub.step = "1"; scrub.value = "0";
  scrub.className = "pf-anim-scrub";
  scrub.setAttribute("aria-label", "Animation position");
  scrubWrap.append(scrub);
  const resetBtn = btn("pf-anim-reset", "↺", "Reset animation");
  bar.append(infoSlot, playBtn, scrubWrap, resetBtn);
  if (nextAnimBtn) bar.append(nextAnimBtn);
  container.append(bar);
  // Chapter bubble: floats above the scrubber naming the chapter under the
  // pointer (hover) or playhead (scrub).
  //
  // It is a child of the STAGE, not of the bar, for the same reason the ⓘ
  // popover is a child of document.body: when the bar runs out of room it caps
  // its width and sets overflow:hidden (see applyPlacement), and anything
  // inside it is clipped — the bubble sits above the bar's content box, so it
  // was clipped away entirely in exactly the narrow layouts where a shrunken
  // timeline needs its labels most. Living on the stage puts it out of that
  // clip, and out of the placement ResizeObserver's subtree as well.
  //
  // Non-interactive and aria-hidden: the accessible chapter channel is the
  // scrubber's aria-valuetext, not this flag.
  const chapterBubble = el("span", "pf-anim-chapter");
  chapterBubble.setAttribute("aria-hidden", "true");
  container.append(chapterBubble);

  // A reveal is either HOVER-owned or TRANSIENT. A hover reveal lives until the
  // pointer leaves; a transient one (keyboard jump, scrub, touch) fades itself.
  //
  // `hoverInside` marks the pointer as the current owner, and while it is set a
  // transient reveal deliberately arms no fade — a drag fires pointermove then
  // an `input` on every step, so the transient timer would otherwise be the last
  // one set and would blank the label under a finger that never left.
  //
  // Every path that hides the bubble clears the latch too, so it can never
  // outlive the reveal it guards: an animation switch hides the bubble while the
  // pointer sits still, and a gesture the browser steals for scrolling delivers
  // pointercancel instead of pointerleave.
  const BUBBLE_FADE_MS = 1000;
  let bubbleFadeTimer = 0;
  let hoverInside = false;
  // The label's rendered width is re-measured only when the label itself
  // changes: showChapterBubble runs on every pointermove, and offsetWidth
  // forces a synchronous layout. Writing through textSetter keeps the text node
  // stable per the WebKit rule above, rather than replacing it per move.
  const setBubbleText = textSetter(chapterBubble);
  let bubbleLabel = null;
  let bubbleWidth = 0;
  function showChapterBubble(fraction, { transient = false } = {}) {
    if (current.steps.length <= 1) return;
    const f = Math.min(1, Math.max(0, fraction));
    const label = current.steps[stepIndexAt(current, f)].label;
    if (label !== bubbleLabel) {
      bubbleLabel = label;
      setBubbleText(label);
      bubbleWidth = chapterBubble.offsetWidth;
    }
    // Stage-relative, because the bubble lives on the stage rather than in the
    // wrap: track the point along the timeline, then lift clear of the bar.
    const wrapRect = scrubWrap.getBoundingClientRect();
    const stageRect = container.getBoundingClientRect();
    chapterBubble.style.left =
      `${wrapRect.left - stageRect.left + clampBubbleX(f, wrapRect.width, bubbleWidth)}px`;
    chapterBubble.style.bottom = `${stageRect.bottom - wrapRect.top + 8}px`;
    chapterBubble.classList.add("pf-show");
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = 0;
    if (transient && !hoverInside) bubbleFadeTimer = setTimeout(hideChapterBubble, BUBBLE_FADE_MS);
  }
  function fadeChapterBubble() {
    if (!chapterBubble.classList.contains("pf-show")) return;
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = setTimeout(hideChapterBubble, BUBBLE_FADE_MS);
  }
  function hideChapterBubble() {
    clearTimeout(bubbleFadeTimer);
    bubbleFadeTimer = 0;
    hoverInside = false;
    chapterBubble.classList.remove("pf-show");
  }
  const onWrapPointerMove = (e) => {
    if (current.steps.length <= 1) return; // no chapters: no bubble, and no layout read
    const rect = scrubWrap.getBoundingClientRect();
    if (!rect.width) return;
    hoverInside = true;
    showChapterBubble((e.clientX - rect.left) / rect.width);
  };
  // A touch pointer's leave arrives with the finger lift, so hiding outright
  // would blank the label the tap just asked for — and touch has no hover to
  // read it with afterwards. Let it fade like a keyboard reveal instead. A
  // mouse leaving still hides at once: the pointer moving away IS the dismissal.
  const onWrapPointerLeave = (e) => {
    hoverInside = false;
    if (e?.pointerType === "touch") fadeChapterBubble();
    else hideChapterBubble();
  };
  scrubWrap.addEventListener("pointermove", onWrapPointerMove);
  scrubWrap.addEventListener("pointerleave", onWrapPointerLeave);
  scrubWrap.addEventListener("pointercancel", onWrapPointerLeave);

  // Per-animation chrome: title, ⓘ description, pager labels, scrubber ticks.
  function syncStructure() {
    title.textContent = current.label;
    hideChapterBubble();
    if (paged) {
      // Name the destination. Activating a pager keeps focus on it and leaves
      // its glyph unchanged, so without this a screen reader re-announces the
      // same generic "Next animation" and never says what is now selected.
      const i = animations.indexOf(current);
      const at = (d) => animations[(i + d + animations.length) % animations.length].label;
      setBtnLabel(prevAnimBtn, `Previous animation: ${at(-1)}`);
      setBtnLabel(nextAnimBtn, `Next animation: ${at(1)}`);
    }
    infoSlot.replaceChildren();
    attachInfo(infoSlot, current.description ?? "", info);
    const stepped = current.steps.length > 1;
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
  //    playback ending mid-press.
  // 2. Each element has its own renderer that leaves early when its own value
  //    is unchanged, so a playing transport touches only what actually moved:
  //    the scrubber's value, and aria-valuetext when it crosses a reporting
  //    step. Per ELEMENT, not per write: driving several elements off one
  //    shared state key means a step change also redraws the button, which was
  //    still enough to lose the click before rule 1 was in place.
  //
  // Without rule 1 this cost the pause click outright: press, release, no click
  // event at all, and only ever while playing — the one moment the button is
  // for. Measured in WebKit, any press held >= 40ms lost it (a real click is
  // ~100ms; a synthetic 0ms one survives, which is why automated clicking never
  // saw it). Reset was never affected: nothing rewrites that button per frame.
  const setPlayGlyph = textSetter(playBtn);
  let shownActive = null;

  function renderPlayButton(active) {
    if (active === shownActive) return;
    shownActive = active;
    setPlayGlyph(active ? "⏸" : "▶");
    const label = active ? "Pause animation" : "Play animation";
    playBtn.setAttribute("aria-label", label);
    playBtn.title = label;
  }

  // aria-valuetext is the accessible chapter channel — the bubble is aria-hidden,
  // so this is the only place the chapter name reaches assistive tech. An
  // attribute write never eats clicks (see the WebKit note above), but a screen
  // reader announces every CHANGE, and during playback the position moves on its
  // own: an exact percentage would chatter ~100 times a run with the scrubber
  // focused. So while playing the percentage is reported in 10% steps. A
  // user-driven seek reports the exact position, which is when precision is the
  // feedback the user asked for.
  let shownValuetext = null;
  function renderValuetext(t, stepIndex, playing) {
    const pct = Math.round(t * 100);
    const shown = playing ? Math.round(pct / 10) * 10 : pct;
    const text = current.steps.length > 1
      ? `${current.steps[stepIndex].label} — ${shown}%`
      : `${shown}%`;
    if (text === shownValuetext) return;
    shownValuetext = text;
    scrub.setAttribute("aria-valuetext", text);
  }

  function syncUi() {
    const { status, t, stepIndex } = playback.state();
    const playing = status === "playing" || status === "intro";
    scrub.value = String(Math.round(t * SCRUB_STEPS));
    renderPlayButton(playing);
    renderValuetext(t, stepIndex, playing);
  }

  // Belt-and-braces for the animation swap. Both caches above key on the exact
  // value written to the DOM, so today a stale one can only ever agree with what
  // is already on screen — this reset is currently redundant, and no test can
  // pin it. It is kept because the cache it replaced (the old step readout) keyed
  // on a step INDEX, which genuinely collided across animations at index 0: any
  // future renderer keyed on a proxy rather than on its rendered value needs
  // this hook to already exist.
  function invalidateUi() { shownActive = null; shownValuetext = null; }

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
    invalidateUi();
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
  const onScrub = () => {
    disarmAutoplay();
    const f = Number(scrub.value) / SCRUB_STEPS;
    showChapterBubble(f, { transient: true });
    guarded(() => playback.seek(f));
  };
  // PageUp/PageDown jump whole chapters — the keyboard replacement for the
  // removed step buttons. PageUp goes FORWARD, matching the key's native
  // slider direction (it increases the value). Single-step animations keep
  // the browser's native coarse seek instead.
  //
  // Targets are derived from the chapter the playhead is IN rather than by
  // scanning stepStarts for the nearest boundary — same answers (verified
  // equivalent across the whole 0..1 range), but it reads as the rule it
  // implements and allocates nothing per keypress.
  //
  // AT_BOUNDARY decides "am I at this chapter's start or inside it", which is
  // what makes PageDown step back rather than restart. It is one scrubber step
  // because that is the finest position the user can see or reach: a tolerance
  // finer than the grid would call a playhead that just landed on a boundary
  // "inside" the chapter, and PageDown would restart it forever instead of
  // walking back.
  const onScrubKeydown = (e) => {
    if (current.steps.length <= 1) return;
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    disarmAutoplay();
    const { t } = playback.state();
    const starts = current.stepStarts;
    const i = stepIndexAt(current, t);
    const target = snapUpToScrubGrid(e.key === "PageUp"
      ? (starts[i + 1] ?? 1)
      // Inside a chapter, back up to its own start (restart it); already at the
      // start, step to the chapter before — the video-player convention.
      : (t > starts[i] + AT_BOUNDARY ? starts[i] : (starts[i - 1] ?? 0)));
    // seek() abandons a pending cue but cannot touch the viewer's camera, so an
    // in-flight tween would keep travelling to the position we just left.
    viewer.cancelCameraTween();
    showChapterBubble(target, { transient: true });
    guarded(() => playback.seek(target));
  };
  const cycleAnimation = (dir) => {
    disarmAutoplay();
    const i = animations.indexOf(current);
    selectAnimation(animations[(i + dir + animations.length) % animations.length].name);
  };
  const onPrevAnim = () => cycleAnimation(-1);
  const onNextAnim = () => cycleAnimation(1);
  const onPick = () => { disarmAutoplay(); selectAnimation(pick.value); };
  const onResetClick = () => { disarmAutoplay(); doReset(); };
  prevAnimBtn?.addEventListener("click", onPrevAnim);
  nextAnimBtn?.addEventListener("click", onNextAnim);
  playBtn.addEventListener("click", onPlayClick);
  scrub.addEventListener("input", onScrub);
  scrub.addEventListener("keydown", onScrubKeydown);
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
    bar.classList.remove("pf-squeezed");
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
    // hold the gap — and the bar's flex children have hard minimums that don't
    // shrink to fit a tighter cap. overflow:hidden is applied here, inline,
    // rather than as a static rule so it is scoped to the capped state and the
    // (far more common) uncapped bar never clips anything.
    //
    // Nothing that floats above the bar may live inside it, or this clips it:
    // the ⓘ popover is on document.body and the chapter bubble is on the stage,
    // both for that reason.
    if (plan.maxWidth != null) {
      bar.style.maxWidth = `${plan.maxWidth}px`;
      bar.style.overflow = "hidden";
      // Under the cap the bar sheds the pagers (~40px with their gaps). They are
      // pure convenience — the picker beside them reaches every animation — and
      // spending that width on the timeline is what keeps the scrubber
      // targetable instead of letting it collapse toward nothing.
      bar.classList.add("pf-squeezed");
    }
  }
  function schedulePlacement() {
    if (typeof requestAnimationFrame !== "function") return applyPlacement();
    if (!placementRaf) placementRaf = requestAnimationFrame(applyPlacement);
  }
  // Observing the bar itself catches content-driven width changes — the ⓘ glyph
  // appearing or disappearing when only some animations declare a description;
  // the viewbar, cutaway's actions; the stage, rail drags and window resizes.
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
      prevAnimBtn?.removeEventListener("click", onPrevAnim);
      nextAnimBtn?.removeEventListener("click", onNextAnim);
      playBtn.removeEventListener("click", onPlayClick);
      scrub.removeEventListener("input", onScrub);
      scrub.removeEventListener("keydown", onScrubKeydown);
      pick.removeEventListener("change", onPick);
      resetBtn.removeEventListener("click", onResetClick);
      info.dispose();
      placementObserver?.disconnect();
      if (placementRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(placementRaf);
      scrubWrap.removeEventListener("pointermove", onWrapPointerMove);
      scrubWrap.removeEventListener("pointerleave", onWrapPointerLeave);
      scrubWrap.removeEventListener("pointercancel", onWrapPointerLeave);
      hideChapterBubble(); // also clears hoverInside
      chapterBubble.remove(); // a stage child, so the bar taking itself out misses it
      bar.remove();
    },
    __viewer: viewer, // test hook only
  };
  return handle;
}
