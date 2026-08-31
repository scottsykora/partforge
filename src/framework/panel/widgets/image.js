// The `type: "image"` control. Its VALUE is an image source — either a URL
// string (the same grammar `PartDefinition.images` already accepts) or raw PNG
// bytes (an ArrayBuffer/typed array): the partforge-cloud sandbox cannot fetch
// URLs, so it puts the bytes straight in the param. Everything downstream
// (presets, undo, the params hash, `when`) works with either shape, no special
// case — this widget is the only place on the main thread that has to look at
// the difference.
//
// Two renderings, mirroring widgets/font.js exactly. With a host-supplied
// `imageCatalog` it is a button — a thumbnail + label — opening the picker.
// Without one it degrades to a URL text field, so a standalone partforge app
// (which ships no catalog) still exposes the parameter.
//
// Main-thread only: the preview is a plain `<img>` bound to the source URL —
// the browser decodes the PNG natively. Do NOT import `png-decode.js` (or
// anything from images.js) here; that decoder belongs to the worker's build
// path, not the panel.
import { attachInfo } from "../info.js";
import { IMAGE_ALLOW_DEFAULT, imageSourceAllowed } from "../../image-source.js";
import { mountDrop } from "./file-drop.js";
import { declaredImageUrl } from "../declared-source.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

// A URL source → its filename, for a label with no catalog to ask. A byte
// value has no filename — callers check `isBytes` first and never reach this
// for one. Not a source to fetch, never a source to warn about: `isNoImageSource`
// values (unset/"") read as "No image" rather than a broken link.
export function imageLabel(source) {
  if (typeof source !== "string" || !source) return "No image";
  let path = source;
  try { path = new URL(source).pathname; } catch { /* not a URL — use the raw string */ }
  const file = path.split("/").filter(Boolean).pop();
  return file || source;
}

// An object URL is a real resource, not a string: the browser pins the blob
// behind it until it is revoked, and a panel rebuild constructs a fresh widget
// every time. This owns the whole lifetime — one live URL at a time, the old one
// revoked before a new one replaces it, and everything released on dispose — so
// no caller has to remember. Returns `null` for a value that needs no URL.
function makeObjectUrlSlot() {
  let current = null;
  const release = () => {
    if (current) URL.revokeObjectURL(current);
    current = null;
  };
  return {
    forBytes(source) {
      release();
      if (!isBytes(source)) return null;
      // Always image/png: `imageToPng` is what produced these bytes, whatever the
      // user dropped. The type matters — a Blob with none renders nothing.
      current = URL.createObjectURL(new Blob([source], { type: "image/png" }));
      return current;
    },
    dispose: release,
  };
}

// Point (or unpoint) the live preview. A string source is used directly. Bytes —
// the partforge-cloud sandbox path, where the converted PNG travels in the param
// because that sandbox cannot fetch URLs — become an object URL, so the cloud
// gets the same thumbnail as everyone else rather than a blank tile. `onerror`
// still covers the remaining broken-image case: a URL that 404s or CORS refuses.
// Resolved ONCE per paint, never per image: the catalog rendering shows the same
// source in two <img>s, and asking the slot twice would revoke the URL it had
// just handed the first one, leaving it pointing at a dead blob.
function previewSrc(source, urls) {
  return typeof source === "string" && source ? source : urls.forBytes(source);
}

// When the control's own param is empty, show what the PART is using: its
// bundled default lives in the `images` declaration, which is the only place it
// can live (the allow list passes only https, so a file:/dev URL cannot sit in
// `defaults`). Resolving it is async — a Vite thunk has to be called — so the
// tile paints empty first and fills in, and a source that never resolves simply
// leaves it empty. `seq` guards against a slow resolve landing after a newer one.
function paintDeclared(img, declaredSource, node, apply) {
  if (!declaredSource) return;
  const source = declaredSource("image", node.key);
  if (source === undefined) return;
  const seq = ++img._pfDeclaredSeq;
  declaredImageUrl(source).then((url) => {
    if (url && seq === img._pfDeclaredSeq) apply(url);
  });
}

function applyPreview(img, src) {
  if (src) {
    img.hidden = false;
    img.src = src;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
}

export function makeImage(node, params, { onChange, onCommit, info, imageCatalog, onAssetUpload, declaredSource } = {}) {
  const urls = makeObjectUrlSlot();   // one live preview URL per widget; see makeObjectUrlSlot
  const allow = Array.isArray(node.allow) && node.allow.length ? node.allow : IMAGE_ALLOW_DEFAULT;
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label ?? node.key);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  const preview = document.createElement("img");
  preview.className = "image-preview";
  preview._pfDeclaredSeq = 0;
  preview.alt = "";
  preview.hidden = true;
  // A URL that fails to load (404, CORS, revoked link) must degrade to hidden,
  // not the browser's broken-image glyph.
  preview.addEventListener("error", () => { preview.hidden = true; });

  if (!imageCatalog) {
    // Degraded path: a URL field. Unlike `text`, it does NOT write on every
    // keystroke — a half-typed URL is a guaranteed failed fetch, and the
    // rebuild loop would chase every one of them.
    const field = document.createElement("input");
    field.type = "text";
    field.className = "text-input";
    const paintField = () => {
      const v = params[node.key];
      // Bytes cannot round-trip through a text field — `String(arrayBuffer)`
      // is "[object ArrayBuffer]", not a value anyone typed. Show an honest
      // placeholder instead of that, and leave the field free to type a
      // replacement URL over it.
      field.value = isBytes(v) ? "" : String(v ?? "");
      field.placeholder = isBytes(v) ? "Uploaded image" : "";
      field.classList.remove("warn");
      const own = previewSrc(v, urls);
      applyPreview(preview, own);
      preview.parentElement?.classList.toggle("has-thumb", !preview.hidden);
      if (!own) paintDeclared(preview, declaredSource, node, (url) => {
        applyPreview(preview, url);
        preview.parentElement?.classList.toggle("has-thumb", true);
      });
    };
    field.addEventListener("change", () => {
      if (!imageSourceAllowed(field.value, allow)) { field.classList.add("warn"); return; }
      field.classList.remove("warn");
      params[node.key] = field.value;
      onChange?.();
      onCommit?.();
    });
    paintField();
    // `sourceField: false` drops the URL box. The tile already is the preview, the
    // drop target and the click-to-choose, so the field is a fourth affordance for
    // one job on a 288 px rail. Default ON: it is the only way to type an https URL
    // or a pfc-asset token, and for a vector control there is no catalog either.
    // Nothing is lost by hiding it — the `warn` state lives on the field's own
    // change handler, which is unreachable once the field is gone.
    if (node.sourceField !== false) wrap.append(field);

    const drop = mountDrop("image", {
      params, node, onAssetUpload, onChange, onCommit, onRender: paintField,
    });
    // The tile IS the preview: dropping, clicking to choose, and showing what is
    // currently selected become one box rather than three stacked ones.
    // `has-thumb` swaps the dashed empty-state border for a solid frame.
    drop.el.setAttribute("data-pf-thumb", "");
    drop.el.prepend(preview);
    wrap.append(drop.el, drop.errorEl);

    return { el: wrap, sync: paintField, dispose: () => { drop.dispose(); urls.dispose(); } };
  }

  const btn = el("button", "image-btn");
  btn.type = "button";
  const thumb = document.createElement("img");
  thumb.className = "image-btn-thumb";
  thumb.alt = "";
  thumb.hidden = true;
  thumb.addEventListener("error", () => { thumb.hidden = true; });
  const iname = el("span", "iname");
  btn.append(thumb, iname);
  btn.insertAdjacentHTML("beforeend",
    '<svg class="caret" width="8" height="7" viewBox="0 0 8 7" aria-hidden="true"><polygon points="0,0 8,0 4,7" fill="currentColor"/></svg>');
  wrap.append(btn);

  // The value alone cannot describe a byte-valued source, and even a URL's
  // filename is a guess a catalog can improve on. `describe` is optional and
  // may be async, so the label is painted twice: an immediate honest guess,
  // then the catalog's answer when it lands (same two-pass shape as font.js's
  // `paint`, `paintSeq` included so a stale describe() can't win a race
  // against a newer one).
  let paintSeq = 0;
  const paint = () => {
    const src = params[node.key];
    const seq = ++paintSeq;
    const url = previewSrc(src, urls);
    applyPreview(preview, url);
    applyPreview(thumb, url);
    preview.parentElement?.classList.toggle("has-thumb", !preview.hidden);
    if (!url) paintDeclared(preview, declaredSource, node, (u) => {
      applyPreview(preview, u);
      applyPreview(thumb, u);
      preview.parentElement?.classList.toggle("has-thumb", true);
    });
    const show = ({ label: text, width, height }) => {
      if (seq !== paintSeq) return;                  // a newer paint already won
      iname.textContent = width && height ? `${text} (${width}×${height})` : text;
    };
    show(isBytes(src) ? { label: "Uploaded image" } : { label: imageLabel(src) });
    if (typeof imageCatalog.describe !== "function") return;
    Promise.resolve()
      .then(() => imageCatalog.describe(src))
      .then((d) => {
        if (!d) return;
        show({ label: d.label ?? (isBytes(src) ? "Uploaded image" : imageLabel(src)), width: d.width, height: d.height });
      })
      .catch(() => { /* a failed lookup keeps the immediate label */ });
  };
  paint();

  // The picker registers itself through setImagePicker (see below); with no
  // picker in the bundle the button is inert rather than broken.
  //
  // The handle is kept because the picker is a TAKEOVER: it appends itself to
  // the rail, outside the panel root, so tearing the panel down does not take it
  // with it. Without dispose() the element — and the `document` keydown listener
  // that only close() unhooks — would outlive the panel holding a stale `params`.
  let picker = null;
  btn.addEventListener("click", () => {
    picker = openImagePicker?.({ node, params, allow, imageCatalog, anchor: wrap, onPicked: () => { paint(); onChange?.(); onCommit?.(); } }) ?? null;
  });

  const drop = mountDrop("image", { params, node, onAssetUpload, onChange, onCommit, onRender: paint });
  // Same merge as the degraded branch — the large preview lives in the drop tile;
  // the catalog button keeps its own small thumb.
  drop.el.setAttribute("data-pf-thumb", "");
  drop.el.prepend(preview);
  wrap.append(drop.el, drop.errorEl);

  return {
    el: wrap,
    sync: paint,
    dispose: () => { picker?.close(); picker = null; drop.dispose(); urls.dispose(); },
  };
}

// Assigned by image-picker.js, which widgets/index.js imports for the side
// effect. Kept as a mutable binding rather than a static import so this file
// stays usable — and testable — without dragging the whole picker in.
export let openImagePicker = null;
export const setImagePicker = (fn) => { openImagePicker = fn; };
