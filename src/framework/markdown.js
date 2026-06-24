// Render a (trusted, author-authored) Markdown description to sanitized HTML for
// display in a control/section info popover. Main-thread only — it imports a DOM
// sanitizer, so it must NOT be imported from the geometry worker.
import { marked } from "marked";
import createDOMPurify from "dompurify";

const CONFIG = {
  ALLOWED_TAGS: ["a", "img", "p", "br", "strong", "em", "code", "pre", "blockquote",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "hr", "del"],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "target", "rel"],
  // links: http(s)/mailto; images: https or data:image/. (Union applied to all URI attrs.)
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/)/i,
  FORBID_ATTR: ["style"],
};

// DOMPurify is initialized lazily so that window is available at call time.
// Eager module-level init runs before happy-dom has finished setting up its
// global window, causing DOMPurify.isSupported to be false.
let _purify = null;
function getPurify() {
  if (_purify) return _purify;
  // Pass window explicitly: works in a real browser and in the happy-dom
  // per-file test environment (where window is global but may not be set yet
  // at module-evaluation time).
  _purify = createDOMPurify(window);
  // Links open in a new tab and cannot reach window.opener.
  _purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return _purify;
}

// src: a CommonMark string. Returns sanitized HTML. Empty/blank/non-string → "".
export function renderMarkdown(src) {
  if (typeof src !== "string" || !src.trim()) return "";
  const raw = marked.parse(src, { async: false });
  return getPurify().sanitize(raw, CONFIG);
}
