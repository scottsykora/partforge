// Builds the sectioned control panel from the SECTIONS schema.
//
// Most sections show a preset picker (below the title) plus an expandable
// "Advanced" block of sliders. The "features" section instead shows a checkbox
// per feature; ticking one enables it and reveals its sliders under Advanced.
// All controls mutate the shared `params` object and call onDirty() on change.

import { SECTIONS } from "./params.js";

const fmt = (v, unit) => {
  const n = Math.round(v * 100) / 100;
  return unit ? `${n} ${unit}`.trim() : `${n}`;
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// One slider bound to params[def.key]. Returns { wrap, sync } — sync() refreshes
// the input + readout from params (after a preset or checkbox changes the value).
function makeSlider(def, params, onChange) {
  const wrap = el("div", "slider");
  const row = el("div", "row");
  row.append(el("label", "", def.label));
  const out = document.createElement("output");
  out.textContent = fmt(params[def.key], def.unit);
  row.append(out);
  const input = document.createElement("input");
  input.type = "range";
  input.min = def.min;
  input.max = def.max;
  input.step = def.step;
  input.value = params[def.key];
  input.addEventListener("input", () => {
    params[def.key] = +input.value;
    out.textContent = fmt(+input.value, def.unit);
    onChange?.();
  });
  wrap.append(row, input);
  const sync = () => {
    input.value = params[def.key];
    out.textContent = fmt(params[def.key], def.unit);
  };
  return { wrap, sync };
}

// A collapsible "Advanced ▾" block. Returns { adv, toggle, open() }.
function advancedBlock() {
  const adv = el("div", "adv hidden");
  const toggle = el("button", "adv-toggle", "Advanced ▾");
  toggle.addEventListener("click", () => {
    const hidden = adv.classList.toggle("hidden");
    toggle.textContent = hidden ? "Advanced ▾" : "Advanced ▴";
  });
  const open = () => {
    adv.classList.remove("hidden");
    toggle.textContent = "Advanced ▴";
  };
  return { adv, toggle, open };
}

export function buildControls(root, params, onDirty) {
  for (const sec of SECTIONS) {
    const section = el("div", "section");
    section.append(el("div", "sec-title", sec.title));
    if (sec.features) buildFeatureSection(section, sec, params, onDirty);
    else buildPresetSection(section, sec, params, onDirty);
    root.append(section);
  }
}

function buildPresetSection(section, sec, params, onDirty) {
  // preset picker, below the title, full width
  const preset = document.createElement("select");
  preset.className = "preset";
  const presetNames = Object.keys(sec.presets);
  for (const name of [...presetNames, "Custom"]) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    preset.append(o);
  }
  preset.value = presetNames[0];
  section.append(preset);

  const { adv, toggle } = advancedBlock();
  const syncs = {};
  for (const def of sec.advanced) {
    const s = makeSlider(def, params, () => {
      preset.value = "Custom";
      onDirty?.();
    });
    adv.append(s.wrap);
    syncs[def.key] = s.sync;
  }
  section.append(toggle, adv);

  // applying a preset overwrites its keys and refreshes this section's sliders
  preset.addEventListener("change", () => {
    const bundle = sec.presets[preset.value];
    if (!bundle) return; // "Custom"
    Object.assign(params, bundle);
    for (const key in syncs) if (key in params) syncs[key]();
    onDirty?.();
  });
}

function buildFeatureSection(section, sec, params, onDirty) {
  const { adv, toggle, open } = advancedBlock();

  for (const feat of sec.features) {
    // checkbox (below the title), always visible — enables/disables the feature
    const checkRow = el("label", "feat");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = params[feat.key] > 0;
    checkRow.append(box, el("span", "", feat.label));
    section.append(checkRow);

    // this feature's sliders live under Advanced, shown only when it's on
    const group = el("div", "feat-group");
    const syncs = [];
    for (const def of feat.sliders) {
      const s = makeSlider(def, params, onDirty);
      group.append(s.wrap);
      syncs.push(s.sync);
    }
    group.classList.toggle("hidden", !box.checked);
    adv.append(group);

    box.addEventListener("change", () => {
      if (box.checked) {
        if (!(params[feat.key] > 0)) params[feat.key] = feat.on; // enable
        syncs.forEach((s) => s());
        group.classList.remove("hidden");
        open(); // reveal the freshly-enabled sliders
      } else {
        params[feat.key] = 0; // disable
        group.classList.add("hidden");
      }
      onDirty?.();
    });
  }

  section.append(toggle, adv);
}
