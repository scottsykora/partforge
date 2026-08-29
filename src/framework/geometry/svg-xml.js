// Minimal XML reader for the SVG subset this framework admits — elements,
// attributes, and the five predefined entities. NOT a general XML parser: no
// DTD, no CDATA, no entity declarations, no namespace resolution (prefixes are
// simply stripped). It exists because the geometry worker has no DOMParser and
// neither does Node, so the browser's parser is unavailable on both paths the
// framework has to serve (see the spec's "Why the worker" section).
//
// Pure leaf: no repo imports, no DOM, no node:.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decodeEntities = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    const code = e[1] === "x" || e[1] === "X"
      ? parseInt(e.slice(2), 16)
      : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

// Namespace prefixes carry no meaning for us (we only ever look at SVG
// elements), so `svg:path` and `path` are the same tag.
const normTag = (raw) => raw.replace(/^[^:]*:/, "").toLowerCase();

function toText(input) {
  if (typeof input === "string") return input;
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return new TextDecoder().decode(input);
  throw new Error("svg: input must be a string, ArrayBuffer, or typed array");
}

// `<name a="1" b='2' />` → { attrs, selfClosing }. `src` is the tag's interior,
// after the name.
function readAttrs(src, tagName) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    // Attribute names keep their case: SVG is case-sensitive and `viewBox` is
    // spelled with a capital B. Only TAGS are lowercased.
    attrs[m[1].replace(/^xml:/, "")] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  if (/=\s*[^"'\s>]/.test(src.replace(re, ""))) {
    throw new Error(`svg: unquoted attribute value in <${tagName}>`);
  }
  return attrs;
}

export function parseSvgXml(input) {
  const text = toText(input);
  let i = 0;
  let root = null;
  const stack = [];

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt;

    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) throw new Error("svg: unterminated comment");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) throw new Error("svg: unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", i)) {
      // DOCTYPE and friends — skip to the matching '>', tolerating one level of
      // internal subset brackets (`<!DOCTYPE svg [ ... ]>`).
      let depth = 0, j = i + 2;
      for (; j < text.length; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth <= 0) break;
      }
      if (j >= text.length) throw new Error("svg: unterminated declaration");
      i = j + 1;
      continue;
    }

    const gt = text.indexOf(">", i);
    if (gt < 0) throw new Error("svg: unterminated tag");
    const raw = text.slice(i + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {                                  // closing tag
      const name = normTag(raw.slice(1).trim());
      const open = stack.pop();
      if (!open) throw new Error(`svg: unexpected closing tag </${name}>`);
      if (open.tag !== name) throw new Error(`svg: mismatched closing tag </${name}> for <${open.tag}>`);
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error("svg: element with no tag name");
    const tag = normTag(nameMatch[1]);
    const node = { tag, attrs: readAttrs(body.slice(nameMatch[0].length), tag), children: [] };

    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) throw new Error("svg: more than one root element");
    else root = node;

    if (!selfClosing) stack.push(node);
  }

  if (stack.length) throw new Error(`svg: unclosed <${stack.at(-1).tag}>`);
  if (!root) throw new Error("svg: no root element found");
  return root;
}
