// The `type: "image"` picker: a takeover panel over the rail — a search box
// above a thumbnail grid — reusing the `.picker`/`.pk-head`/`.pk-search`
// scaffolding font-picker.js built, since a search-then-pick takeover is the
// same shape for either asset kind. No variants pane: an image source has no
// weight/style axis to drill into, so choosing IS committing.
//
// Main-thread only — it is DOM-heavy and is NOT part of the worker graph. It
// draws thumbnails through plain `<img src>`, so the browser's own decoder does
// the work; nothing here imports `png-decode.js`.
import { setImagePicker } from "./widgets/image.js";
import { imageSourceAllowed } from "../image-source.js";

const SEARCH_LIMIT = 60;
const SEARCH_DEBOUNCE_MS = 120;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// At most one picker is open at a time, and the previous one has to be CLOSED
// rather than merely detached: its `keydown` listener lives on `document`, so
// dropping the element off the DOM leaves the handler — and the whole closure —
// alive forever, one more on every re-open. Only close() unregisters it.
let openPicker = null;

export function openImagePicker({ node, params, allow, imageCatalog, anchor, onPicked }) {
  // Takeover: the picker covers the rail on desktop and the single visible pane
  // below the narrow breakpoint, same as the font picker.
  const host = anchor?.closest?.(".pf-rail") ?? anchor?.parentElement ?? document.body;
  openPicker?.close();                                  // never two at once

  let results = [];
  let query = "";
  let closed = false;
  let searchSeq = 0;
  let debounce = null;
  let failed = false;

  // ── DOM ─────────────────────────────────────────────────────────────────
  const picker = el("div", "picker");
  const head = el("div", "pk-head");
  const titlebar = el("div", "pk-titlebar");
  const closeBtn = el("button", "pk-x", "×");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  titlebar.append(el("b", "", node.label ?? node.key), closeBtn);
  const search = document.createElement("input");
  search.className = "pk-search";
  search.type = "text";
  search.placeholder = "Search images";
  search.autocomplete = "off";
  search.spellcheck = false;
  head.append(titlebar, search);
  const grid = el("div", "pk-img-grid");
  const empty = el("p", "pk-empty");
  empty.hidden = true;
  picker.append(head, grid, empty);
  host.append(picker);
  search.focus?.();

  // ── the grid ────────────────────────────────────────────────────────────
  // Not virtualized like the font list: a search result page is bounded by
  // SEARCH_LIMIT, so the DOM cost of every row existing at once stays small —
  // no scroll-position bookkeeping to get wrong for what is, at most, one
  // catalog page of thumbnails.
  function render() {
    if (closed) return;
    grid.textContent = "";
    // A catalog is host-supplied, not trusted — drop any asset the allowlist
    // refuses, same rule the font picker applies to a family's variants.
    const admissible = results.filter((a) => a && typeof a.url === "string" && imageSourceAllowed(a.url, allow));
    for (const asset of admissible) {
      const card = el("button", "pk-img-card");
      card.type = "button";
      card.dataset.sel = String(asset.url === params[node.key]);
      const thumb = document.createElement("img");
      thumb.className = "pk-img-thumb";
      thumb.alt = "";
      thumb.src = asset.thumbUrl || asset.url;
      thumb.addEventListener("error", () => { thumb.hidden = true; });
      const cap = el("span", "pk-img-cap", asset.label ?? "");
      card.append(thumb, cap);
      card.addEventListener("click", () => choose(asset));
      grid.append(card);
    }
    empty.hidden = admissible.length > 0;
    if (!admissible.length) {
      empty.textContent = failed ? "The image catalog is unavailable."
        : query.trim() ? `No images match "${query.trim()}".`
        : "No images available.";
    }
  }

  function choose(asset) {
    params[node.key] = asset.url;
    onPicked?.();
    close();
  }

  function runSearch(q) {
    const seq = ++searchSeq;
    Promise.resolve()
      .then(() => imageCatalog.search(q, { limit: SEARCH_LIMIT }))
      .then((entries) => {
        if (closed || seq !== searchSeq) return;        // a newer search already won
        failed = false;
        results = Array.isArray(entries) ? entries : [];
        render();
      })
      .catch(() => {
        if (closed || seq !== searchSeq) return;
        failed = true;
        results = [];
        render();
      });
  }

  search.addEventListener("input", () => {
    query = search.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(query.trim()), SEARCH_DEBOUNCE_MS);
  });

  // ── closing ─────────────────────────────────────────────────────────────
  const handle = { close };

  function close() {
    if (closed) return;                                  // idempotent
    closed = true;
    clearTimeout(debounce);
    document.removeEventListener("keydown", onKey);
    picker.remove();
    if (openPicker === handle) openPicker = null;
  }
  function onKey(ev) {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    close();
  }
  document.addEventListener("keydown", onKey);
  closeBtn.addEventListener("click", close);

  runSearch("");
  render();
  openPicker = handle;
  return handle;
}

setImagePicker(openImagePicker);
