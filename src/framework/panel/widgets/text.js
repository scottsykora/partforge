// text / textarea: a live-updating string field. Every edit writes params
// immediately so the existing rebuild loop previews the new string.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function makeText(node, params, { onChange, info }) {
  const multiline = node.type === "textarea";
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  const field = document.createElement(multiline ? "textarea" : "input");
  if (!multiline) field.type = "text";
  field.className = "text-input";
  field.value = String(params[node.key] ?? "");
  field.addEventListener("input", () => {
    params[node.key] = field.value;
    onChange?.();
  });
  wrap.append(field);

  const sync = () => { field.value = String(params[node.key] ?? ""); };
  return { el: wrap, sync };
}
