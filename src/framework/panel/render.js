// The DOM binder. Builds elements from the render tree, then applies whatever
// panel-state.js decided. Everything about WHAT to show lives in the model and
// state modules; this file only knows how to put it on screen.
import { desugar } from "./legacy.js";
import { buildTree, controlNodes } from "./model.js";
import { computeState } from "./panel-state.js";
import { WIDGET_FACTORIES } from "./widgets/index.js";
import { makeReadout } from "./widgets/readout.js";
import { createInfoPopover, attachInfo } from "./info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Map every node id (groups and leaves alike) to its node, for the reveal
// re-sync in applyState below.
function indexNodes(nodes, map) {
  for (const node of nodes ?? []) {
    map.set(node.id, node);
    if (node.kind === "group") indexNodes(node.children, map);
  }
}

export function buildControls(root, parameters, params, onDirty) {
  const info = createInfoPopover();
  const tree = buildTree(desugar(parameters));

  const nodeEls = new Map();      // id -> the element whose visibility we toggle
  const displayUpdates = new Map(); // id -> a display widget's update(derived)
  const groupIds = new Set();     // ids that are group/section wrappers, never controls
  const syncFns = [];             // { key, sync } for every widget
  const rawSyncs = new Map();     // sectionId -> [{ key, sync }] for preset application
  const widgetSyncs = new Map();  // id -> the RAW widget sync (no markCustom)
  const nodeById = new Map();     // id -> node, for the reveal re-sync
  const lastVisible = new Map();  // id -> previous `visible`, to detect a reveal
  const lastDisabled = new Map(); // id -> previous `disabled`, to skip a no-op input pass
  // Containers that own a disclosure: sections, and titled inner groups (the
  // legacy "Advanced" fold). `label` is set only for the inner groups, whose
  // button text carries the ▾/▴ instead of a chevron span.
  const disclosures = new Map(); // id -> { body, button, label }
  indexNodes(tree, nodeById);
  let relevant = null;

  // Re-apply state after any change that could flip a condition. This is what
  // reproduces the legacy feature behavior generically: ticking a feature's
  // checkbox now simply makes its group's condition true. It also re-syncs any
  // subtree that just went from hidden to visible, so a just-revealed slider
  // shows the freshly-written value instead of a stale one (legacy
  // controls.js ran `syncs.forEach((s) => s())` on a feature tick).
  // The FIRST computed state decides which sections/folds start open, per the
  // auto-open rule and any explicit `collapsed`. After that, the user's own
  // clicks own it — re-running this on every param change would otherwise
  // snap a section the user opened shut on the next slider drag.
  let openApplied = false;
  const applyOpenState = (state) => {
    if (openApplied) return;
    openApplied = true;
    for (const [id, d] of disclosures) {
      const open = state.get(id)?.open ?? true;
      d.body.classList.toggle("hidden", !open);
      d.button.setAttribute("aria-expanded", String(open));
      if (d.label) d.button.textContent = open ? `${d.label} ▴` : `${d.label} ▾`;
    }
  };

  const applyState = () => {
    const state = computeState(tree, { params, relevant });
    applyOpenState(state);
    for (const [id, node] of nodeEls) {
      const s = state.get(id);
      if (!s) continue;
      const isGroup = groupIds.has(id);
      node.classList.toggle("hidden", !s.visible);
      node.classList.toggle("section-hidden", !!s.dimmedSection);
      node.classList.toggle("irrelevant", !isGroup && s.dimmed && !s.dimmedSection);
      node.classList.toggle("disabled", s.disabled);
      // Only a control leaf's own inputs get `.disabled` written. `disabled`
      // already propagates through the whole subtree in computeState, so a
      // group never needs to (and must not) walk its descendants here — doing
      // so made the outcome depend on `nodeEls` insertion order, which differs
      // between a bare group/section (registers before its children) and a
      // titled group (registers after, via its wrapper). Skipping the query
      // entirely when `disabled` hasn't changed also keeps this off the hot
      // path (applyState runs on every slider drag and relevance update).
      if (!isGroup && lastDisabled.get(id) !== s.disabled) {
        if (node.matches?.("input, select, textarea")) node.disabled = s.disabled;
        for (const input of node.querySelectorAll("input, select, textarea")) {
          input.disabled = s.disabled;
        }
        lastDisabled.set(id, s.disabled);
      }
      if (!isGroup && s.dimmed && !s.dimmedSection) node.title = "Doesn't affect the parts in the current view";
      else node.removeAttribute("title");

      const wasVisible = lastVisible.get(id);
      if (wasVisible === false && s.visible) {
        for (const c of controlNodes([nodeById.get(id)])) widgetSyncs.get(c.id)?.();
      }
      lastVisible.set(id, s.visible);
    }
  };

  const onEdit = () => { applyState(); onDirty?.(); };

  // --- build ---------------------------------------------------------------
  //
  // TWO DIFFERENT THINGS USE `.hidden`, and conflating them is a real bug:
  // conditions hide a node, and a disclosure closes a fold. `applyState` runs on
  // every param change (mount.js:510), so if it toggled `.hidden` on the fold
  // body, every slider drag would re-open a fold the user had closed.
  //
  // So: a titled group gets a WRAPPER. Conditions toggle the wrapper; the
  // disclosure toggles the body inside it. A bare group has no fold, so it keeps
  // the legacy `.feat-group.hidden` markup exactly and conditions own it.
  function renderGroup(node, container, sectionCtx) {
    groupIds.add(node.id);

    if (node.bare) {
      const box = el("div", "feat-group");
      nodeEls.set(node.id, box);
      for (const child of node.children) renderNode(child, box, sectionCtx);
      container.append(box);
      return;
    }

    const wrap = el("div", "adv-wrap");
    const body = el("div", "adv hidden");   // starts closed — legacy parity
    body.id = `pf-fold-${node.id.replaceAll("/", "-")}`;
    const toggle = el("button", "adv-toggle", `${node.title} ▾`);
    toggle.setAttribute("aria-controls", body.id);
    toggle.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      toggle.textContent = nowHidden ? `${node.title} ▾` : `${node.title} ▴`;
      toggle.setAttribute("aria-expanded", String(!nowHidden));
    });
    for (const child of node.children) renderNode(child, body, sectionCtx);
    wrap.append(toggle, body);
    nodeEls.set(node.id, wrap);             // conditions act on the wrapper
    disclosures.set(node.id, { body, button: toggle, label: node.title });
    container.append(wrap);
  }

  // The preset picker. Applying a preset overwrites its keys and refreshes the
  // section's controls through their RAW syncs — a preset application must not
  // mark itself Custom (controls.test.js:366).
  function renderPreset(node, container, sectionCtx) {
    if (node.label) {
      const row = el("div", "row");
      row.append(el("label", "", node.label));
      container.append(row);
    }
    const names = Object.keys(node.presets);
    const select = document.createElement("select");
    select.className = "preset";
    for (const name of [...names, "Custom"]) {
      const o = document.createElement("option");
      o.value = name; o.textContent = name; select.append(o);
    }
    select.value = names[0];
    select.addEventListener("change", () => {
      const bundle = node.presets[select.value];
      if (!bundle) return; // "Custom"
      Object.assign(params, bundle);
      for (const { key, sync } of rawSyncs.get(sectionCtx.id)) if (key in params) sync();
      onEdit();
    });
    // The section's controls need a handle on the picker to drop it to Custom
    // when one of them is edited. First picker in the section wins.
    if (sectionCtx && !sectionCtx.preset) sectionCtx.preset = select;
    nodeEls.set(node.id, select);
    container.append(select);
  }

  function renderNode(node, container, sectionCtx) {
    if (node.kind === "group") { renderGroup(node, container, sectionCtx); return; }
    if (node.kind === "preset") { renderPreset(node, container, sectionCtx); return; }
    if (node.kind === "display") {
      const widget = makeReadout(node, { info });
      nodeEls.set(node.id, widget.el);
      displayUpdates.set(node.id, widget.update);
      container.append(widget.el);
      return;
    }

    const factory = WIDGET_FACTORIES[node.type];
    if (!factory) return; // unknown type: lint reports it; the panel skips it

    // Editing a control in a preset section diverges from the preset, so the
    // picker falls back to Custom (controls.js:296). A feature's own slider and a
    // toggle do NOT — `marksCustom` is false for them.
    const markCustom = () => {
      if (node.marksCustom && sectionCtx?.preset) sectionCtx.preset.value = "Custom";
    };
    const widget = factory(node, params, {
      onChange: () => { markCustom(); onEdit(); },
      info,
    });
    nodeEls.set(node.id, widget.el);
    widgetSyncs.set(node.id, widget.sync);
    container.append(widget.el);

    // The raw sync is what a PRESET application uses — it must not mark itself
    // Custom (controls.test.js:366). The registered sync is what an external
    // syncValues() uses, and for a preset-section control it does drop the
    // picker to Custom (controls.test.js:350), because a programmatic edit
    // diverges from the preset exactly as a user edit does.
    if (sectionCtx) rawSyncs.get(sectionCtx.id).push({ key: node.key, sync: widget.sync });
    syncFns.push({
      key: node.key,
      sync: () => { widget.sync(); markCustom(); },
    });
  }

  for (const section of tree) {
    groupIds.add(section.id);
    const secEl = el("div", "section");
    nodeEls.set(section.id, secEl);

    const header = el("div", "sec-header");
    const title = el("button", "sec-title");
    title.type = "button";
    // The chev span carries NO text — its glyph comes from CSS (::before) —
    // because sectionByTitle-style lookups match `.sec-title` by exact
    // textContent === title (controls.test.js:210), and a text chevron here
    // would break that match.
    title.append(el("span", "sec-name", section.title ?? ""), el("span", "chev"));
    header.append(title);
    // The ⓘ is a SIBLING of the button, never a child: attachInfo appends a
    // <button>, and a button nested in a button is invalid HTML that never
    // receives clicks.
    attachInfo(header, section.description, info);
    secEl.append(header);

    const body = el("div", "sec-body");
    body.id = `pf-sec-${section.id.replaceAll("/", "-")}`;
    title.setAttribute("aria-controls", body.id);
    secEl.append(body);

    title.addEventListener("click", () => {
      const nowHidden = body.classList.toggle("hidden");
      title.setAttribute("aria-expanded", String(!nowHidden));
    });
    disclosures.set(section.id, { body, button: title, label: null });

    // `preset` is filled in when a preset node renders. Controls read it late, so
    // one appearing after them in the children array still works.
    const ctx = { id: section.id, preset: null };
    rawSyncs.set(section.id, []);

    for (const child of section.children) renderNode(child, body, ctx);
    root.append(secEl);
  }

  applyState();

  // The single entry point for a param change: relevance dims/undims controls,
  // derived pushes fresh values into every readout. Either argument may be
  // omitted (mount.js's initial call, or a syncValues-only path) — only what's
  // passed updates. `applyRelevance` is the old name, kept as a thin delegate
  // so existing callers (and mount.test.js) don't have to change.
  let lastDerived = null;
  const refresh = ({ relevant: nextRelevant, derived } = {}) => {
    if (nextRelevant !== undefined) relevant = nextRelevant;
    if (derived !== undefined) {
      lastDerived = derived;
      for (const update of displayUpdates.values()) update(derived);
    }
    applyState();
  };

  return {
    refresh,
    applyRelevance: (next) => refresh({ relevant: next }),
    syncValues: (keys) => {
      const only = keys && new Set(keys);
      for (const { key, sync } of syncFns) if (!only || only.has(key)) sync();
      applyState();
    },
    dispose: () => { info.dispose(); root.replaceChildren(); },
  };
}
