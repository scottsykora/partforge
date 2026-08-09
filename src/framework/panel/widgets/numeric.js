// slider + number: a range input (omitted for `number`) beside an editable value
// box. The box accepts exact values finer than `step`; typed values clamp to
// [min, max] on commit (blur/Enter).
import { attachInfo } from "../info.js";

// Short numeric string without float noise (4 dp max) for the value box.
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

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

export function makeNumeric(node, params, { onChange, info }) {
  const numeric = node.type === "number";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);

  const val = el("div", "val");
  const box = document.createElement("input");
  box.type = "number";
  box.className = "num";
  box.min = node.min; box.max = node.max; box.step = node.step;
  box.value = numStr(params[node.key]);
  val.append(box);
  if (node.unit) val.append(el("span", "unit", node.unit));
  row.append(val);
  wrap.append(row);

  let slider = null;
  if (!numeric) {
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = node.min; slider.max = node.max; slider.step = node.step;
    slider.value = params[node.key];
    slider.addEventListener("input", () => {
      params[node.key] = +slider.value;
      box.value = numStr(+slider.value);
      onChange?.();
    });
    wrap.append(slider);
  }

  // live preview while typing (unclamped); clamp + reformat on commit
  box.addEventListener("input", () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    params[node.key] = v;
    if (slider) slider.value = v;
    onChange?.();
  });
  box.addEventListener("change", () => {
    const v = clampToRange(box.value, node.min, node.max);
    if (v == null) { box.value = numStr(params[node.key]); return; } // revert invalid input
    params[node.key] = v;
    box.value = numStr(v);
    if (slider) slider.value = v;
    onChange?.();
  });

  const sync = () => {
    box.value = numStr(params[node.key]);
    if (slider) slider.value = params[node.key];
  };
  return { el: wrap, sync };
}
