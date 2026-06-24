// Builds the sectioned control panel from a part's `parameters` schema.
//
// Most sections show a preset picker (below the title) plus an expandable
// "Advanced" block of sliders. The "features" section instead puts, under
// Advanced, a checkbox per feature followed by its own controls — ticking one
// enables it and reveals those controls right below it.
// All controls mutate the shared `params` object and call onDirty() on change.

// Short numeric string without float noise (4 dp max) for the value box.
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

// --- visibility (hidden controls/sections) --------------------------------
export const visibleAdvanced = (sec) => (sec.advanced ?? []).filter((d) => !d.hidden);
export const visibleFeatures = (sec) => (sec.features ?? []).filter((f) => !f.hidden);
export function sectionRenders(sec) {
  if (sec.hidden) return false;
  if (sec.features) return visibleFeatures(sec).length > 0;
  const hasPresets = sec.presets && Object.keys(sec.presets).length > 0;
  return !!hasPresets || visibleAdvanced(sec).length > 0;
}

// Parse a typed value → clamped to [min, max], or null if not a finite number.
export function clampToRange(raw, min, max) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
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
// The box accepts exact values (finer than `step`); typed values clamp to
// [min, max] on commit (blur/Enter). Returns { wrap, sync }.
function makeSlider(def, params, onChange) {
  const numeric = def.control === "number";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  row.append(el("label", "", def.label));

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
  for (const sec of parameters) {
    if (!sectionRenders(sec)) continue;
    const section = el("div", "section");
    section.append(el("div", "sec-title", sec.title));
    if (sec.features) buildFeatureSection(section, sec, params, onDirty);
    else buildPresetSection(section, sec, params, onDirty);
    root.append(section);
  }
}

function buildPresetSection(section, sec, params, onDirty) {
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

  const advanced = visibleAdvanced(sec);
  const syncs = {};
  if (advanced.length) {
    const { adv, toggle } = advancedBlock();
    for (const def of advanced) {
      const s = makeSlider(def, params, () => { if (preset) preset.value = "Custom"; onDirty?.(); });
      adv.append(s.wrap);
      syncs[def.key] = s.sync;
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

function buildFeatureSection(section, sec, params, onDirty) {
  // Everything lives under Advanced: each feature is a checkbox followed by its
  // own controls, which appear directly below it when the box is checked.
  const { adv, toggle } = advancedBlock();
  section.append(toggle, adv);

  for (const feat of visibleFeatures(sec)) {
    const checkRow = el("label", "feat");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = params[feat.key] > 0;
    checkRow.append(box, el("span", "", feat.label));

    const group = el("div", "feat-group");
    const syncs = [];
    for (const def of feat.sliders.filter((d) => !d.hidden)) {
      const s = makeSlider(def, params, onDirty);
      group.append(s.wrap);
      syncs.push(s.sync);
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
