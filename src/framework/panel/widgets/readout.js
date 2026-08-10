// readout: a read-only display of one derive() output, named by `derivedKey`.
// A display node, not a control — it has no key, never writes params, and gets
// its value pushed via panel.refresh({ derived }), not pulled from params.
import { attachInfo } from "../info.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Same float-noise trim the numeric widgets use (4 dp max).
const numStr = (v) => String(Math.round(v * 1e4) / 1e4);

export function makeReadout(node, { info }) {
  const wrap = el("div", "slider readout");
  const row = el("div", "row");
  const label = el("label", "", node.label);
  attachInfo(label, node.description, info);
  const val = el("div", "val", "—");
  row.append(label, val);
  wrap.append(row);
  const update = (derived) => {
    const v = derived?.[node.derivedKey];
    val.textContent = v == null ? "—"
      : typeof v === "number" ? numStr(v) + (node.unit ? ` ${node.unit}` : "")
      : String(v);
  };
  return { el: wrap, update };
}
