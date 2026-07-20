// Builds the sectioned control panel from a part's `parameters` schema.
//
// Most sections show a preset picker (below the title) plus an expandable
// "Advanced" block of sliders. The "features" section instead puts, under
// Advanced, a checkbox per feature followed by its own controls — ticking one
// enables it and reveals those controls right below it.
// All controls mutate the shared `params` object and call onDirty() on change.

import { renderMarkdown } from "./markdown.js";

// Short numeric string without float noise (4 dp max) for the value box.
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

// --- relevance (dim controls / hide sections that don't affect on-screen parts) ---
// `relevant` is a Set of param keys, or any non-Set value (e.g. RELEVANT_ALL) → show all.
function applyRelevance(relevant, controls, sections) {
  const showAll = !(relevant instanceof Set);
  for (const { key, el: node } of controls) {
    const irrelevant = !showAll && !relevant.has(key);
    node.classList.toggle("irrelevant", irrelevant);
    if (irrelevant) node.title = "Doesn't affect the parts in the current view";
    else node.removeAttribute("title");
  }
  for (const { el: node, keys } of sections) {
    const anyRelevant = showAll || [...keys].some((k) => relevant.has(k));
    node.classList.toggle("section-hidden", !anyRelevant);
  }
}

// --- visibility (hidden controls/sections) --------------------------------
export const visibleAdvanced = (sec) => (sec.advanced ?? []).filter((d) => !d.hidden);
export const visibleFeatures = (sec) => (sec.features ?? []).filter((f) => !f.hidden);
// Standalone toggle checkboxes a preset section can show (outside the Advanced fold),
// e.g. preview switches. Each: { key, label, on?, description?, hidden? }.
export const visibleToggles = (sec) => (sec.toggles ?? []).filter((t) => !t.hidden);
export function sectionRenders(sec) {
  if (sec.hidden) return false;
  if (sec.features) return visibleFeatures(sec).length > 0;
  const hasPresets = sec.presets && Object.keys(sec.presets).length > 0;
  return !!hasPresets || visibleAdvanced(sec).length > 0 || visibleToggles(sec).length > 0;
}

// Parse a typed value → clamped to [min, max], or null if not a finite number.
export function clampToRange(raw, min, max) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

// --- info glyph + per-panel popover -----------------------------------------
// One popover element per panel, shared by all its glyphs (only one open at a
// time). Document-level dismiss listeners are registered per panel and removed
// by panel.dispose().
function createInfoPopover() {
  const pop = el("div", "popover");
  pop.hidden = true;
  document.body.append(pop);
  let owner = null; // the glyph whose description is showing

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    if (owner) { owner.setAttribute("aria-expanded", "false"); owner = null; }
  }
  const onDocClick = (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.(".info")) close();
  };
  const onDocKeydown = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);

  return {
    toggle(glyph, description) {
      if (owner === glyph) { close(); return; } // toggle off
      close();
      pop.innerHTML = renderMarkdown(description);
      pop.hidden = false;
      owner = glyph;
      glyph.setAttribute("aria-expanded", "true");
      const r = glyph.getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.left = `${Math.max(8, r.left - 8)}px`;
    },
    dispose() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKeydown);
      pop.remove();
    },
  };
}

// Append a focusable ⓘ glyph to `container` that toggles the panel's shared
// popover with `description` (Markdown). No-op when description is empty.
function attachInfo(container, description, info) {
  if (typeof description !== "string" || !description.trim()) return;
  const glyph = document.createElement("button");
  glyph.type = "button";
  glyph.className = "info";
  glyph.textContent = "ⓘ";
  glyph.setAttribute("aria-label", "More info");
  glyph.setAttribute("aria-expanded", "false");
  glyph.addEventListener("click", (e) => { e.stopPropagation(); info.toggle(glyph, description); });
  container.append(glyph);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// One parameter control bound to params[def.key]. `def.control`:
//   "slider" (default) — range slider + an editable number box (drag OR type)
//   "number"           — number box only (no slider)
//   "text"             — single-line text field
//   "textarea"         — multiline text field
// The box accepts exact values (finer than `step`); typed values clamp to
// [min, max] on commit (blur/Enter). Returns { wrap, sync }.
function makeSlider(def, params, onChange, info) {
  const numeric = def.control === "number";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", def.label);
  attachInfo(label, def.description, info);
  row.append(label);

  // editable value box (+ optional unit suffix)
  const val = el("div", "val");
  const box = document.createElement("input");
  box.type = "number";
  box.className = "num";
  box.min = def.min; box.max = def.max; box.step = def.step;
  box.value = numStr(params[def.key]);
  val.append(box);
  if (def.unit) val.append(el("span", "unit", def.unit));
  row.append(val);
  wrap.append(row);

  let slider = null;
  if (!numeric) {
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = def.min; slider.max = def.max; slider.step = def.step;
    slider.value = params[def.key];
    slider.addEventListener("input", () => {
      params[def.key] = +slider.value;
      box.value = numStr(+slider.value);
      onChange?.();
    });
    wrap.append(slider);
  }

  // live preview while typing (unclamped); clamp + reformat on commit (blur/Enter)
  box.addEventListener("input", () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    params[def.key] = v;
    if (slider) slider.value = v;
    onChange?.();
  });
  box.addEventListener("change", () => {
    const v = clampToRange(box.value, def.min, def.max);
    if (v == null) { box.value = numStr(params[def.key]); return; } // revert invalid input
    params[def.key] = v;
    box.value = numStr(v);
    if (slider) slider.value = v;
    onChange?.();
  });

  const sync = () => {
    box.value = numStr(params[def.key]);
    if (slider) slider.value = params[def.key];
  };
  return { wrap, sync };
}

function makeTextControl(def, params, onChange, info) {
  const multiline = def.control === "textarea";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", def.label);
  attachInfo(label, def.description, info);
  row.append(label);
  wrap.append(row);

  const field = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) field.type = "text";
  field.className = "text-input";
  field.value = String(params[def.key] ?? "");
  field.addEventListener("input", () => {
    params[def.key] = field.value;
    onChange?.();
  });
  wrap.append(field);

  const sync = () => { field.value = String(params[def.key] ?? ""); };
  return { wrap, sync };
}

const makeParameterControl = (def, params, onChange, info) =>
  def.control === "text" || def.control === "textarea"
    ? makeTextControl(def, params, onChange, info)
    : makeSlider(def, params, onChange, info);

// A collapsible "Advanced ▾" block. Returns { adv, toggle }.
function advancedBlock() {
  const adv = el("div", "adv hidden");
  const toggle = el("button", "adv-toggle", "Advanced ▾");
  toggle.addEventListener("click", () => {
    const hidden = adv.classList.toggle("hidden");
    toggle.textContent = hidden ? "Advanced ▾" : "Advanced ▴";
  });
  return { adv, toggle };
}

export function buildControls(root, parameters, params, onDirty) {
  const info = createInfoPopover();
  const controls = []; // { key, el } per control element
  const sections = []; // { el, keys:Set } per rendered section
  for (const sec of parameters) {
    if (!sectionRenders(sec)) continue;
    const section = el("div", "section");
    const title = el("div", "sec-title", sec.title);
    attachInfo(title, sec.description, info);
    section.append(title);
    const keys = new Set();
    const register = (key, node) => { controls.push({ key, el: node }); keys.add(key); };
    if (sec.features) buildFeatureSection(section, sec, params, onDirty, register, info);
    else buildPresetSection(section, sec, params, onDirty, register, info);
    root.append(section);
    sections.push({ el: section, keys });
  }
  return {
    applyRelevance: (relevant) => applyRelevance(relevant, controls, sections),
    dispose: () => { info.dispose(); root.replaceChildren(); },
  };
}

function buildPresetSection(section, sec, params, onDirty, register, info) {
  // preset picker, below the title, full width (omitted when the section has no presets)
  let preset = null;
  const presetNames = sec.presets ? Object.keys(sec.presets) : [];
  if (presetNames.length) {
    preset = document.createElement("select");
    preset.className = "preset";
    for (const name of [...presetNames, "Custom"]) {
      const o = document.createElement("option");
      o.value = name; o.textContent = name; preset.append(o);
    }
    preset.value = presetNames[0];
    section.append(preset);
  }

  // standalone toggle checkboxes (e.g. preview switches), shown below the preset and
  // outside the Advanced fold so they stay visible. Independent of the preset selector.
  for (const t of visibleToggles(sec)) {
    const row = el("label", "feat");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = params[t.key] > 0;
    const lbl = el("span", "", t.label);
    attachInfo(lbl, t.description, info);
    row.append(box, lbl);
    box.addEventListener("change", () => { params[t.key] = box.checked ? (t.on ?? 1) : 0; onDirty?.(); });
    register(t.key, row);
    section.append(row);
  }

  const advanced = visibleAdvanced(sec);
  const syncs = {};
  if (advanced.length) {
    const { adv, toggle } = advancedBlock();
    for (const def of advanced) {
      const s = makeParameterControl(def, params, () => { if (preset) preset.value = "Custom"; onDirty?.(); }, info);
      adv.append(s.wrap);
      syncs[def.key] = s.sync;
      register(def.key, s.wrap);
    }
    section.append(toggle, adv);
  }

  // applying a preset overwrites its keys and refreshes this section's sliders
  if (preset) {
    preset.addEventListener("change", () => {
      const bundle = sec.presets[preset.value];
      if (!bundle) return; // "Custom"
      Object.assign(params, bundle);
      for (const key in syncs) if (key in params) syncs[key]();
      onDirty?.();
    });
  }
}

function buildFeatureSection(section, sec, params, onDirty, register, info) {
  // Everything lives under Advanced: each feature is a checkbox followed by its
  // own controls, which appear directly below it when the box is checked.
  const { adv, toggle } = advancedBlock();
  section.append(toggle, adv);

  for (const feat of visibleFeatures(sec)) {
    const checkRow = el("label", "feat");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = params[feat.key] > 0;
    const featLabel = el("span", "", feat.label);
    attachInfo(featLabel, feat.description, info);
    checkRow.append(box, featLabel);
    register(feat.key, checkRow);

    const group = el("div", "feat-group");
    const syncs = [];
    for (const def of feat.sliders.filter((d) => !d.hidden)) {
      const s = makeParameterControl(def, params, onDirty, info);
      group.append(s.wrap);
      syncs.push(s.sync);
      register(def.key, s.wrap);
    }
    group.classList.toggle("hidden", !box.checked);

    box.addEventListener("change", () => {
      if (box.checked) {
        if (!(params[feat.key] > 0)) params[feat.key] = feat.on; // enable
        syncs.forEach((s) => s());
        group.classList.remove("hidden");
      } else {
        params[feat.key] = 0; // disable
        group.classList.add("hidden");
      }
      onDirty?.();
    });

    adv.append(checkRow, group); // checkbox, then its controls right below
  }
}
