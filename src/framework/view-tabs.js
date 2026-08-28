import { resolveDefaultView } from "./default-view.js";
import { loadView, saveView } from "./view-state.js";

// The view-tab segmented control. When the part declares `views`, the buttons are
// generated from it (part.views is the single source of truth — host pages leave
// the #part div empty); a part without `views` keeps whatever buttons the page
// hand-wrote. Which tab opens is resolveDefaultView's call, not key order. The
// active tab then persists per part for the rest of the browser session, so a
// Vite dev reload doesn't throw you back mid-edit.
//
// The bar has TWO representations of the same choice, and both exist from the
// start: the segmented buttons, and a dropdown that takes over when the pill no
// longer fits the stage's top-centre slot. Which one shows is `data-pf-tabs` on
// the element, kept current by the measurement below. They are built together
// and switched together rather than rebuilt on each swap, so a click and a
// dropdown change are the same commit path and neither can drift from the other.

// The slot must clear the pill by this much before the buttons come back. Purely
// an anti-flap margin: a pill whose natural width lands within a subpixel of the
// slot would otherwise swap layouts on every ResizeObserver notification.
const EXPAND_MARGIN = 2;
// chrome.css's `.pf-float-tabs { top: 12px; left: 50% }` inset — the margin the
// bar keeps from the stage edge when nothing else competes for the corner.
const STAGE_MARGIN = 12;
// Breathing room between the pill's edge and the rail toggle it must not reach.
const TOGGLE_GAP = 8;

// Which representation to show. Pure, and deliberately a function of the pill's
// NATURAL width rather than its current one — see `natural` below for why that
// distinction is what stops the swap oscillating.
//
// A non-positive measurement is the ABSENCE of a reading, not a claim that
// nothing fits: happy-dom reports zeros for every box, and so does a real
// browser before first layout. Segmented is the honest fallback — it is what
// the bar looked like before this measurement existed.
export function pickLayout({ natural, available, collapsed }) {
  if (!(natural > 0) || !(available > 0)) return "segmented";
  if (collapsed) return available >= natural + EXPAND_MARGIN ? "segmented" : "menu";
  return natural > available ? "menu" : "segmented";
}

// How much of each stage edge is spoken for. Doubled by the caller because the
// pill is centre-anchored: the tighter side governs both halves. Derived from
// the rail toggle's measured box rather than from a second copy of its offsets,
// the same way animation-controls.js derives the view cube's claim from the
// viewbar's — retune chrome.css and this follows. The toggle is `[hidden]`
// below the narrow breakpoint, where the stage margin stands alone.
function sideClearance(stage, stageRect) {
  const toggle = stage?.querySelector?.(".pf-float-rail-toggle");
  if (!toggle || toggle.hidden || !stageRect) return STAGE_MARGIN;
  const rect = toggle.getBoundingClientRect?.();
  if (!(rect?.width > 0)) return STAGE_MARGIN;
  return Math.max(STAGE_MARGIN, stageRect.right - rect.left + TOGGLE_GAP);
}

// `segWidth` is what the pill measures RIGHT NOW, which is near nothing once the
// buttons are hidden. Reporting it raw rather than smoothing it here keeps this
// a plain reading; remembering the last meaningful one is the orchestrator's job.
function domMeasure(el) {
  return () => {
    const stage = el.closest?.(".pf-stage") ?? el.offsetParent ?? el.ownerDocument?.documentElement;
    const stageRect = stage?.getBoundingClientRect?.() ?? null;
    const stageWidth = stageRect?.width || stage?.clientWidth || 0;
    return {
      segWidth: el.scrollWidth || 0,
      available: stageWidth ? stageWidth - 2 * sideClearance(stage, stageRect) : 0,
    };
  };
}

// Built from the buttons rather than from part.views so a page with hand-written
// markup gets a working dropdown too — the buttons are the one description of
// the choice that both paths share. Option text goes through textContent for the
// same reason the buttons do: view labels are untrusted data.
function buildSelect(doc, tabs) {
  const select = doc.createElement("select");
  select.className = "pf-view-select";
  select.setAttribute("aria-label", "View");
  for (const btn of tabs) {
    const option = doc.createElement("option");
    option.value = btn.dataset.part;
    option.textContent = btn.textContent;
    select.append(option);
  }
  return select;
}

export function createViewTabs(el, part, { onChange, measure } = {}) {
  const generated = !!(el && part.views);
  const partKey = part?.meta?.title ?? "";
  const resolved = resolveDefaultView(part);
  const doc = el.ownerDocument ?? document;
  if (generated) {
    // Built node-by-node with textContent/dataset rather than an innerHTML
    // template — view keys and labels come from the part, which is untrusted
    // data (hosts run LLM-generated and user-supplied parts), so a label of
    // `<img src=x onerror=...>` must land as text, not as markup.
    el.replaceChildren(...Object.entries(part.views).map(([key, v]) => {
      const btn = document.createElement("button");
      btn.dataset.part = key;
      btn.textContent = v?.label ?? key;
      // Inline, not a stylesheet rule, because this one is load-bearing rather
      // than decorative and a host can drop a stylesheet rule by accident.
      // partforge-cloud restyles the pill from scratch (`#viewer #part button`,
      // no `.seg` class), which is exactly how app.css's `white-space: nowrap`
      // stopped applying there and let long labels wrap onto a second line. A
      // wrapping label makes the pill NARROWER, not wider, so the collapse
      // below would never trip — the overflow it is meant to catch would show
      // up as a two-row pill instead. On the element, it is out of reach.
      btn.style.whiteSpace = "nowrap";
      if (key === resolved) btn.classList.add("on");
      return btn;
    }));
  }

  const buttons = () => [...el.querySelectorAll("button[data-part]")];
  const tabs = buttons();
  // Below two tabs there is nothing to choose, and an empty pill must stay
  // empty: partforge-cloud hides the bar with `#viewer #part:empty`, so a part
  // with no views would otherwise gain a one-option dropdown and a visible pill.
  const select = tabs.length >= 2 ? buildSelect(doc, tabs) : null;
  if (select) el.append(select);

  const setActive = (btn) => {
    for (const b of buttons()) b.classList.toggle("on", b === btn);
    if (select) select.value = btn.dataset.part;
  };

  // Initial view: the session-saved one if it still matches a tab, else the active
  // button — the resolved default for a generated bar, or whatever the page's own
  // markup marked `on` for a hand-written one.
  const defaultView = el.querySelector("button.on")?.dataset.part ?? el.querySelector("button")?.dataset.part;
  const saved = loadView(partKey);
  const savedBtn = saved ? tabs.find((b) => b.dataset.part === saved) : null;
  let view = savedBtn ? saved : defaultView;
  // Unconditional now (it used to run only for a restored view): the dropdown
  // has to open showing the same tab the buttons do, and for a generated bar
  // the button half of this is the no-op it always was.
  const activeBtn = savedBtn ?? tabs.find((b) => b.dataset.part === view);
  if (activeBtn) setActive(activeBtn);

  const commit = (btn) => {
    view = btn.dataset.part;
    saveView(partKey, view);
    setActive(btn);
    onChange(view);
  };

  const onClick = (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    commit(btn);
  };
  el.addEventListener("click", onClick);

  const onSelectChange = () => {
    const btn = buttons().find((b) => b.dataset.part === select.value);
    if (btn) commit(btn);
  };
  select?.addEventListener("change", onSelectChange);

  // ---- layout: which representation is on screen --------------------------
  let detached = false;
  let mode = null;
  // The pill's width AS IF THE BUTTONS WERE SHOWING — the fixed point the swap
  // turns on, and the same trick animation-controls.js's nominalClusterRect
  // plays for the view cube. Re-reading the live pill while collapsed would
  // measure the dropdown instead, decide the buttons fit, expand, overflow, and
  // collapse again: two frames per cycle, on screen as a flickering bar. This
  // value cannot change while collapsed, so the collapsed state is stable.
  // Caching is exact rather than approximate here because the buttons are
  // content-sized (`min-width` + padding + nowrap, no percentages), so their
  // natural width does not depend on the viewport at all.
  let natural = 0;
  const read = measure ?? domMeasure(el);

  const setMode = (next) => {
    if (next === mode) return;
    mode = next;
    el.dataset.pfTabs = next;
    const menu = next === "menu";
    for (const b of buttons()) b.hidden = menu;
    if (select) select.hidden = !menu;
  };

  const relayout = () => {
    if (detached) return;
    if (!select) { setMode("segmented"); return; }
    const { segWidth, available } = read();
    if (mode !== "menu" && segWidth > 0) natural = segWidth;
    setMode(pickLayout({ natural, available, collapsed: mode === "menu" }));
  };
  setMode("segmented"); // measure from the state the cache is only valid in
  relayout();

  // ResizeObserver is the precise trigger; the resize listener is the belt that
  // also fires where it is absent, mirroring animation-controls.js's placement
  // pair. Both land on the same idempotent relayout, so a doubled notification
  // costs one measurement and no DOM write.
  const win = doc.defaultView ?? globalThis;
  win.addEventListener?.("resize", relayout);
  const stage = el.closest?.(".pf-stage") ?? el.parentElement;
  const observer = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(relayout) : null;
  if (observer && stage) observer.observe(stage);
  // A webfont swap changes every label's width, and so the pill's natural width,
  // after the first layout the measurement above ran against.
  doc.fonts?.ready?.then(relayout).catch(() => {});

  return {
    current: () => view,
    // Programmatic switch — the click path without the click. Used by an
    // embedder (mount's handle.setView) to change tabs from outside the DOM.
    // Returns false for a name that isn't a tab so callers can validate.
    select: (name) => {
      if (name === view) return true; // already active — nothing to do
      const btn = buttons().find((b) => b.dataset.part === name);
      if (!btn) return false;
      commit(btn);
      return true;
    },
    detach: () => {
      detached = true;
      el.removeEventListener("click", onClick);
      select?.removeEventListener("change", onSelectChange);
      win.removeEventListener?.("resize", relayout);
      observer?.disconnect();
      select?.remove(); // ours in both paths — hand-written markup never has one
      delete el.dataset.pfTabs;
      if (generated) el.innerHTML = ""; // we generated these buttons; hand-written markup stays
      else for (const b of buttons()) b.hidden = false; // leave the page's own buttons as we found them
    },
  };
}
