// Builds the sectioned control panel from the SECTIONS schema. Each section
// shows a preset picker (the easy choice) and an expandable "Advanced" block
// with the full per-part controls. Mutates the shared `params` object and
// calls onDirty() whenever something changes.

import { SECTIONS } from "./params.js";

const fmt = (v, unit) => {
  const n = Math.round(v * 100) / 100;
  return unit ? `${n} ${unit}`.trim() : `${n}`;
};

export function buildControls(root, params, onDirty) {
  for (const sec of SECTIONS) {
    const section = el("div", "section");

    // header: title + preset picker
    const head = el("div", "sec-head");
    head.append(el("span", "sec-title", sec.title));
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
    head.append(preset);
    section.append(head);

    // advanced block (collapsed by default)
    const adv = el("div", "adv hidden");
    const sliders = {};
    for (const def of sec.advanced) {
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
        preset.value = "Custom";
        onDirty?.();
      });
      wrap.append(row, input);
      adv.append(wrap);
      sliders[def.key] = { input, out, def };
    }

    const toggle = el("button", "adv-toggle", "Advanced ▾");
    toggle.addEventListener("click", () => {
      const hidden = adv.classList.toggle("hidden");
      toggle.textContent = hidden ? "Advanced ▾" : "Advanced ▴";
    });
    section.append(toggle, adv);
    root.append(section);

    // applying a preset overwrites its keys and refreshes this section's sliders
    preset.addEventListener("change", () => {
      const bundle = sec.presets[preset.value];
      if (!bundle) return; // "Custom"
      Object.assign(params, bundle);
      for (const key in sliders) {
        if (key in params) {
          sliders[key].input.value = params[key];
          sliders[key].out.textContent = fmt(params[key], sliders[key].def.unit);
        }
      }
      onDirty?.();
    });
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
