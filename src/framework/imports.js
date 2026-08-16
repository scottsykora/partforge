// Resolve a part's declared `imports` ({ name: source }) to bytes + a SHA-256
// content digest + a detected format, before the synchronous build — the
// import-asset sibling of fonts.js: same source grammar and identity-
// memoization rule (import sources are content-stable for a session), built on
// the shared resolution core in asset-resolve.js. DOM-free and node:-free;
// crypto.subtle exists in workers and Node.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";

const EXT = { step: "step", stp: "step", stl: "stl", "3mf": "3mf" };

export function detectFormat(source, bytes) {
  const path = source instanceof URL ? source.pathname : typeof source === "string" ? source.split("?")[0] : null;
  const ext = path?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext];
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (u8 && u8.length > 0) {
    const head = String.fromCharCode(...u8.slice(0, 64));
    if (head.startsWith("ISO-10303-21")) return "step";
    if (u8[0] === 0x50 && u8[1] === 0x4b) return "3mf"; // zip signature
    return "stl"; // ascii "solid …" and binary STL both land here
  }
  throw new Error(`unrecognized import format${path ? ` for "${path}"` : ""} — use a .step/.stl/.3mf extension or non-empty bytes`);
}

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map(); // source → Promise<{bytes, digest, format}>
const resolveOne = makeAssetResolver(
  cache,
  async (bytes, v, source) => {
    const format = detectFormat(source instanceof URL || typeof source === "string" ? source : v, bytes);
    return { bytes, digest: await sha256Hex(bytes), format };
  },
  "resolveImports: an import source must be bytes, a URL, or a thunk returning one",
);

export async function resolveImports(importsDecl) {
  return resolveDecl(importsDecl, resolveOne);
}
