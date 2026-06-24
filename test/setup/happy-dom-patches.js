// Test-only setup: patches a happy-dom bug where Node.prototype.nodeName returns
// "" for all nodes, causing DOMPurify to strip every element as "unknown".
//
// DOMPurify caches Node.prototype.nodeName to resist DOM-clobbering attacks.
// happy-dom puts the correct nodeName implementation on Element.prototype but
// leaves Node.prototype.nodeName returning "" for all nodes. This patch fixes
// the getter so DOMPurify sees correct tag names.
//
// Guards:
//   1. No-op when document is not defined (plain-Node / WASM test files).
//   2. Only patches when the getter is actually broken (probe returns "").
//      In real browsers and fixed versions of happy-dom this is a safe no-op.
if (typeof document !== "undefined") {
  const nodeDesc = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
  const elemDesc = Object.getOwnPropertyDescriptor(Element.prototype, "nodeName");
  if (nodeDesc?.get && elemDesc?.get) {
    if (nodeDesc.get.call(document.createElement("span")) === "") {
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
    }
  }
}
