// The `type: "font"` control. Its VALUE is a font source string — the same
// grammar `PartDefinition.fonts` already accepts — so everything downstream
// (presets, undo, the params hash, `when`) works with no special case.
//
// Two renderings. With a host-supplied `fontCatalog` it is a button showing the
// current face IN that face, opening the picker. Without one it degrades to a
// URL text field, so a standalone partforge app (which ships no catalog) still
// exposes the parameter.
import { attachInfo } from "../info.js";
import { FONT_ALLOW_DEFAULT, fontSourceAllowed } from "../../font-source.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const WEIGHTS = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
                  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
export const variantLabel = (v) => {
  if (!v) return "Regular";
  const w = String(v).replace(/i$/, ""), italic = /i$/.test(String(v));
  return `${WEIGHTS[w] ?? w}${italic ? " Italic" : ""}`;
};

// A source string → something human. Cloud's fetch_web_font stores files as
// `<family-slug>[-<variant>].ttf`, so the filename round-trips the label for
// free on the vendored path; a bare URL falls back to its filename stem.
export function fontLabel(source) {
  if (typeof source !== "string" || !source) return { family: "—", variant: null };
  let path = source;
  try { path = new URL(source).pathname; } catch { /* not a URL — use the raw string */ }
  const file = path.split("/").filter(Boolean).pop() ?? source;
  const stem = file.replace(/\.(ttf|otf)$/i, "");
  const m = /^(.*)-(\d{3}i?|italic)$/i.exec(stem);
  const slug = m ? m[1] : stem;
  const family = slug.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "—";
  return { family, variant: m ? m[2] : null };
}

export function makeFont(node, params, { onChange, onCommit, info, fontCatalog } = {}) {
  const allow = Array.isArray(node.allow) && node.allow.length ? node.allow : FONT_ALLOW_DEFAULT;
  const wrap = el("div", "slider");
  const row = el("div", "row");
  const label = el("label", "", node.label ?? node.key);
  attachInfo(label, node.description, info);
  row.append(label);
  wrap.append(row);

  if (!fontCatalog) {
    // Degraded path: a URL field. Unlike `text`, it does NOT write on every
    // keystroke — a half-typed URL is a guaranteed failed fetch, and the
    // rebuild loop would chase every one of them.
    const field = document.createElement("input");
    field.type = "text";
    field.className = "text-input";
    field.value = String(params[node.key] ?? "");
    field.addEventListener("change", () => {
      if (!fontSourceAllowed(field.value, allow)) { field.classList.add("warn"); return; }
      field.classList.remove("warn");
      params[node.key] = field.value;
      onChange?.();
      onCommit?.();
    });
    wrap.append(field);
    return { el: wrap, sync: () => { field.value = String(params[node.key] ?? ""); field.classList.remove("warn"); } };
  }

  const btn = el("button", "font-btn");
  btn.type = "button";
  const fname = el("span", "fname");
  const fvar = el("span", "fvar");
  btn.append(fname, fvar);
  btn.insertAdjacentHTML("beforeend",
    '<svg class="caret" width="8" height="7" viewBox="0 0 8 7" aria-hidden="true"><polygon points="0,0 8,0 4,7" fill="currentColor"/></svg>');
  wrap.append(btn);

  // The value alone cannot name a live-picked face: a gstatic filename is a
  // content hash. Ask the catalog first (it holds the reverse lookup), and fall
  // back to the filename — which is right for a vendored `<family>-<variant>.ttf`
  // and merely ugly for a hash. `describe` is optional and may be async, so the
  // label is painted twice: filename immediately, catalog answer when it lands.
  let paintSeq = 0;
  const paint = () => {
    const src = params[node.key];
    const seq = ++paintSeq;
    const show = ({ family, variant }) => {
      if (seq !== paintSeq) return;                  // a newer paint already won
      fname.textContent = family;
      fvar.textContent = variantLabel(variant);
      fname.style.fontFamily = `"${family}", var(--pf-sans)`;
    };
    show(fontLabel(src));
    if (typeof fontCatalog.describe !== "function") return;
    Promise.resolve()
      .then(() => fontCatalog.describe(src))
      .then((d) => { if (d?.family) show(d); })
      .catch(() => { /* a failed lookup keeps the filename label */ });
  };
  paint();

  // Task 6 replaces this with the real picker; the seam is deliberately one line.
  btn.addEventListener("click", () => {
    openFontPicker?.({ node, params, allow, fontCatalog, anchor: wrap, onPicked: () => { paint(); onChange?.(); onCommit?.(); } });
  });

  return { el: wrap, sync: paint };
}

// Assigned by font-picker.js when the panel bundle includes it (Task 6). Kept
// as a mutable binding rather than a static import so this file stays usable —
// and testable — without dragging the whole picker in.
export let openFontPicker = null;
export const setFontPicker = (fn) => { openFontPicker = fn; };
