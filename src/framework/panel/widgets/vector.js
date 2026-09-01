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
import { VECTOR_ALLOW_DEFAULT, vectorSourceAllowed } from "../../vector-source.js";
import { mountDrop } from "./file-drop.js";
import { vectorThumb } from "./vector-thumb.js";
import { declaredVectorDoc } from "../declared-source.js";

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

export function makeVector(node, params, { onChange, onCommit, info, onAssetUpload, declaredSource } = {}) {
  const allow = Array.isArray(node.allow) && node.allow.length ? node.allow : VECTOR_ALLOW_DEFAULT;
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
    field.classList.remove("warn");
  };
  field.addEventListener("change", () => {
    if (!vectorSourceAllowed(field.value, allow)) { field.classList.add("warn"); return; }
    field.classList.remove("warn");
    params[node.key] = field.value;
    onChange?.();
    onCommit?.();
  });
  paintField();
  // The URL box is OFF unless `sourceField: true` — same reasoning as
  // widgets/image.js: the tile already carries preview, drop and click-to-choose,
  // and typing a source by hand is the rarer intent.
  if (node.sourceField === true) wrap.append(field);

  // The thumbnail IS the drop target. A vector param holds a parsed document, so
  // there is no URL an <img> could point at — the artwork is drawn inline
  // instead, and that tile is what a file is dropped on and what opens the file
  // picker. One element doing all three keeps the rail's 300 px from carrying a
  // preview, a drop zone and a button that all mean the same thing.
  const drop = mountDrop("vector", {
    params, node, onAssetUpload, onChange, onCommit, onRender: () => { paintField(); paintThumb(); },
  });
  const thumb = drop.el;
  thumb.setAttribute("data-pf-thumb", "");

  // `vectorThumb` returns null for a document it cannot draw — malformed, empty,
  // or carrying a coordinate that is not finite — rather than throwing. The tile
  // stays either way, because it is the drop target: losing it on a bad document
  // would strand the user with no way to replace it.
  let thumbSeq = 0;
  function showThumb(doc) {
    const art = thumb.querySelector("svg");
    if (art) art.remove();
    const svg = doc ? vectorThumb(doc) : null;
    thumb.classList.toggle("has-thumb", !!svg);
    if (svg) thumb.prepend(svg);
  }
  function paintThumb() {
    const own = params[node.key];
    const seq = ++thumbSeq;
    if (isOpaque(own)) { showThumb(own); return; }
    showThumb(null);
    // Nothing in the param — fall back to what the PART declares, which is where
    // a bundled default has to live (the allow list passes only https, so a
    // file:/dev URL cannot sit in `defaults`). Unlike an image there is nothing
    // to point at: the document must be fetched and parsed before it can be
    // drawn, so this lands a tick or two later, and a source that never resolves
    // just leaves the tile empty — it stays a drop target either way.
    const source = declaredSource?.("vector", node.key);
    if (source === undefined) return;
    declaredVectorDoc(source).then((doc) => { if (doc && seq === thumbSeq) showThumb(doc); });
  }
  paintThumb();

  wrap.append(thumb, drop.errorEl);

  const sync = () => { paintField(); paintThumb(); };
  return { el: wrap, sync, dispose: () => drop.dispose() };
}
