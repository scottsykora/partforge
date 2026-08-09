// A bare on/off checkbox, writing `on` when ticked and 0 when cleared.
//
// `preserveOn` is the one behavioral difference between the two legacy shapes it
// replaces. A `features` checkbox only wrote `on` when the value wasn't already
// positive (controls.js:352), so re-ticking a feature restored the magnitude the
// user had dialled in. A `toggles` checkbox always wrote it (controls.js:286),
// because its `on` is a flag, not a magnitude.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function makeCheckbox(node, params, { onChange, info }) {
  const row = el("label", "feat");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = params[node.key] > 0;
  const lbl = el("span", "", node.label);
  attachInfo(lbl, node.description, info);
  row.append(box, lbl);

  box.addEventListener("change", () => {
    if (box.checked) {
      if (!node.preserveOn || !(params[node.key] > 0)) params[node.key] = node.on ?? 1;
    } else {
      params[node.key] = 0;
    }
    onChange?.();
  });

  const sync = () => { box.checked = params[node.key] > 0; };
  return { el: row, sync };
}
