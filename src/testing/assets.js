// Node-side source mapping for part asset declarations (fonts + imports):
// framework resolvers use global fetch, which cannot read file: URLs in Node,
// so map those to bytes here before handing the decl down. Everything else
// (http(s) strings, bytes, thunks) passes through untouched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function nodeAssetSources(decl) {
  if (!decl) return decl;
  const out = {};
  for (const [name, src] of Object.entries(decl)) {
    const u = src instanceof URL ? src : typeof src === "string" && src.startsWith("file:") ? new URL(src) : null;
    if (u?.protocol === "file:") {
      const b = readFileSync(fileURLToPath(u));
      out[name] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    } else out[name] = src;
  }
  return out;
}
