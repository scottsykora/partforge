// The `type: "vector"` control. Its VALUE is vector artwork — either a URL
// string (the same grammar `PartDefinition.vectors` already accepts) or the
// PARSED partforge-vector document object a drop/paste conversion produces
// (see file-drop.js's vector-kind handling and vectors.js's `asParsedFile`,
// "the in-tree form" — a source that IS the parsed contents of its file
// rather than a way to reach its bytes). `vectorsFor` (vectors.js) is what
// lets a `type: "vector"` control drive the artwork: a part declares
// `vectors: (p) => ({ name: p.art })` and this control writes `p.art`.
//
// Unlike font.js/image.js there is NO catalog provider for artwork — no
// `vectorCatalog` exists (see the design doc's "no vector catalog provider"
// note) — so this control has exactly ONE rendering: a URL field plus a
// drop target. There is no picker button and nothing here degrades from a
// richer form; this IS the whole control.
//
// Main-thread only: the real SVG -> partforge-vector conversion (paper.js)
// runs inside `makeFileDrop` -> the registry's "vector" convert thunk,
// never here.
import { attachInfo } from "../info.js";
import { mountDrop } from "./file-drop.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);
// A dropped/pasted SVG with no `onAssetUpload` host hook lands as the PARSED
// document object (task-9 addendum, Ruling D) — an opaque value with nothing
// a text field can show, the same rule image.js/font.js apply to a
// byte-valued param.
const isOpaque = (v) => isBytes(v) || (v != null && typeof v === "object");

export function makeVector(node, params, { onChange, onCommit, info, onAssetUpload } = {}) {
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label ?? node.key);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  // The URL field. Unlike `text`, it does NOT write on every keystroke — a
  // half-typed URL is a guaranteed failed fetch, and the rebuild loop would
  // chase every one of them. Mirrors widgets/image.js's/font.js's own field.
  const field = document.createElement("input");
  field.type = "text";
  field.className = "text-input";
  const paintField = () => {
    const v = params[node.key];
    // A parsed document (or bytes) cannot round-trip through a text field —
    // show an honest placeholder instead, and leave the field free to type a
    // replacement URL over it.
    field.value = isOpaque(v) ? "" : String(v ?? "");
    field.placeholder = isOpaque(v) ? "Uploaded artwork" : "";
  };
  field.addEventListener("change", () => {
    params[node.key] = field.value;
    onChange?.();
    onCommit?.();
  });
  paintField();
  wrap.append(field);

  const drop = mountDrop("vector", {
    params, node, onAssetUpload, onChange, onCommit, onRender: paintField,
  });
  wrap.append(drop.el, drop.errorEl);

  return { el: wrap, sync: paintField, dispose: () => drop.dispose() };
}
