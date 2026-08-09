// Builds the sectioned control panel from a part's `parameters` schema.
//
// Most sections show a preset picker (below the title) plus an expandable
// "Advanced" block of sliders. The "features" section instead puts, under
// Advanced, a checkbox per feature followed by its own controls — ticking one
// enables it and reveals those controls right below it.
// All controls mutate the shared `params` object and call onDirty() on change.

import { createInfoPopover, attachInfo } from "./panel/info.js";

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

export { popoverTop, createInfoPopover, attachInfo } from "./panel/info.js";

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
  const syncFns = []; // { key, sync } for every widget that can re-read params
  for (const sec of parameters) {
    if (!sectionRenders(sec)) continue;
    const section = el("div", "section");
    const title = el("div", "sec-title", sec.title);
    attachInfo(title, sec.description, info);
    section.append(title);
    const keys = new Set();
    const register = (key, node, sync) => {
      controls.push({ key, el: node });
      keys.add(key);
      if (sync) syncFns.push({ key, sync });
    };
    if (sec.features) buildFeatureSection(section, sec, params, onDirty, register, info);
    else buildPresetSection(section, sec, params, onDirty, register, info);
    root.append(section);
    sections.push({ el: section, keys });
  }
  return {
    applyRelevance: (relevant) => applyRelevance(relevant, controls, sections),
    // Re-read params into the widgets — all of them, or just `keys`. The
    // programmatic twin of a user edit (setParams); never fires onDirty.
    syncValues: (keys) => {
      const only = keys && new Set(keys);
      for (const { key, sync } of syncFns) if (!only || only.has(key)) sync();
    },
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
    register(t.key, row, () => { box.checked = params[t.key] > 0; });
    section.append(row);
  }

  const advanced = visibleAdvanced(sec);
  const syncs = {};
  if (advanced.length) {
    const { adv, toggle } = advancedBlock();
    for (const def of advanced) {
      const s = makeParameterControl(def, params, () => { if (preset) preset.value = "Custom"; onDirty?.(); }, info);
      adv.append(s.wrap);
      syncs[def.key] = s.sync; // raw: preset APPLICATION must not mark itself Custom
      // A programmatic edit diverges from the preset exactly as a user edit does,
      // so the picker falls back to Custom — leaving a stale preset name selected
      // would also make it unre-appliable (no change event for the current option).
      register(def.key, s.wrap, () => { s.sync(); if (preset) preset.value = "Custom"; });
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
    // `group` is created just below — the sync only ever runs after this
    // function returns, so the closure is safely bound by then.
    register(feat.key, checkRow, () => {
      box.checked = params[feat.key] > 0;
      group.classList.toggle("hidden", !box.checked);
    });

    const group = el("div", "feat-group");
    const syncs = [];
    for (const def of feat.sliders.filter((d) => !d.hidden)) {
      const s = makeParameterControl(def, params, onDirty, info);
      group.append(s.wrap);
      syncs.push(s.sync);
      register(def.key, s.wrap, s.sync);
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
