// select: a dropdown over `options`. radio: the same data as a segmented
// control (reuses the app's existing `.seg` styling), for 2–4 options where
// seeing all of them matters. Option values may be strings or numbers; the DOM
// only speaks strings, so both widgets map String(value) back to the real
// value on the way out.
import { attachInfo } from "../info.js";
import { normalizeOptions } from "../widget-specs.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function labeledRow(node, info) {
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);
  return wrap;
}

export function makeSelect(node, params, { onChange, onCommit, info }) {
  const wrap = labeledRow(node, info);
  const opts = normalizeOptions(node.options);
  const byString = new Map(opts.map((o) => [String(o.value), o.value]));
  const select = document.createElement("select");
  select.className = "select-input";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = o.label;
    if (o.description) opt.title = o.description; // long-form option descriptions surface as tooltips
    select.append(opt);
  }
  select.value = String(params[node.key]);
  select.addEventListener("change", () => {
    params[node.key] = byString.get(select.value);
    onChange?.();
    onCommit?.();
  });
  wrap.append(select);
  const sync = () => { select.value = String(params[node.key]); };
  return { el: wrap, sync };
}

export function makeRadio(node, params, { onChange, onCommit, info }) {
  const wrap = labeledRow(node, info);
  const opts = normalizeOptions(node.options);
  const seg = el("div", "seg");
  const buttons = opts.map((o) => {
    const b = el("button", "", o.label);
    b.type = "button";
    if (o.description) b.title = o.description;
    b.addEventListener("click", () => {
      params[node.key] = o.value;
      paint();
      onChange?.();
      onCommit?.();
    });
    seg.append(b);
    return { b, value: o.value };
  });
  const paint = () => {
    for (const { b, value } of buttons) b.classList.toggle("on", params[node.key] === value);
  };
  paint();
  wrap.append(seg);
  return { el: wrap, sync: paint };
}
