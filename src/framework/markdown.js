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

// DOMPurify caches Node.prototype.nodeName to resist DOM-clobbering attacks.
// happy-dom puts the correct nodeName implementation on Element.prototype (for
// elements) and leaves Node.prototype.nodeName returning "" for all nodes.
// DOMPurify uses the cached getter exclusively, so all nodes get tagName=""
// and are stripped as "unknown". Patch the getter to return the correct value:
//   - Elements:    delegate to Element.prototype.nodeName (returns "UL", "A", …)
//   - Text/Other:  nodeType → the canonical nodeName constant
// The guard (`=== ""` probe on a freshly created element) makes this a no-op
// in real browsers where Node.prototype.nodeName already works correctly.
/* c8 ignore next 20 */
(function patchNodeNameForDOMPurify() {
  const nodeDesc = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
  const elemDesc = Object.getOwnPropertyDescriptor(Element.prototype, "nodeName");
  if (!nodeDesc?.get || !elemDesc?.get) return;
  if (nodeDesc.get.call(document.createElement("span")) !== "") return; // already correct
  const origGet = nodeDesc.get;
  const elemGet = elemDesc.get;
  // nodeType constants (per DOM spec)
  const NODE_NAMES = { 3: "#text", 7: "#pi", 8: "#comment", 9: "#document", 10: "#doctype", 11: "#document-fragment" };
  Object.defineProperty(Node.prototype, "nodeName", {
    get() {
      if (this instanceof Element) return elemGet.call(this);
      const raw = origGet.call(this);
      if (raw !== "") return raw;
      return NODE_NAMES[this.nodeType] ?? "#unknown";
    },
    configurable: true,
  });
}());

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
