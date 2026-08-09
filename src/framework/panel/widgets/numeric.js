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

  // A log track maps thumb position 0..LOG_STEPS onto [min, max] geometrically —
  // the value box stays linear and exact (see AUTHORING-PARTS.md's slider scale
  // section). Only valid when min > 0; lint's log-scale-needs-positive-min
  // catches an authored part that violates that before it ever reaches here.
  const LOG_STEPS = 1000;
  const log = node.scale === "log" && node.min > 0;
  const toValue = (t) => Math.exp(Math.log(node.min) + (t / LOG_STEPS) * (Math.log(node.max) - Math.log(node.min)));
  const toPos = (v) => Math.round(LOG_STEPS * (Math.log(v) - Math.log(node.min)) / (Math.log(node.max) - Math.log(node.min)));
  // toPos(0) is -Infinity and a non-finite assignment to slider.value snaps the
  // thumb to mid-track instead of an end — guard the live-typed, unclamped box
  // value before it reaches the slider.
  const toPosSafe = (v) => {
    if (!(v > 0)) return 0;
    const t = toPos(v);
    return Math.max(0, Math.min(LOG_STEPS, Number.isFinite(t) ? t : 0));
  };

  let slider = null;
  if (!numeric) {
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = log ? 0 : node.min; slider.max = log ? LOG_STEPS : node.max; slider.step = log ? 1 : node.step;
    slider.value = log ? toPos(params[node.key]) : params[node.key];
    slider.addEventListener("input", () => {
      const v = log ? toValue(+slider.value) : +slider.value;
      params[node.key] = v;
      box.value = numStr(v);
      onChange?.();
    });
    wrap.append(slider);
  }

  // live preview while typing (unclamped); clamp + reformat on commit
  box.addEventListener("input", () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    params[node.key] = v;
    if (slider) slider.value = log ? toPosSafe(v) : v;
    onChange?.();
  });
  box.addEventListener("change", () => {
    const v = clampToRange(box.value, node.min, node.max);
    if (v == null) { box.value = numStr(params[node.key]); return; } // revert invalid input
    params[node.key] = v;
    box.value = numStr(v);
    if (slider) slider.value = log ? toPosSafe(v) : v;
    onChange?.();
  });

  const sync = () => {
    box.value = numStr(params[node.key]);
    if (slider) slider.value = log ? toPosSafe(params[node.key]) : params[node.key];
  };
  return { el: wrap, sync };
}
