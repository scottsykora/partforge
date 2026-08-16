// Minimal 3MF reader, the read twin of threemf.js's writer. 3MF is an OPC
// package (a zip) holding an XML model; unzip (fflate), find the model part,
// extract vertices/triangles/per-item transforms and the model unit, and
// merge every build item into one soup-free indexed mesh in millimetres.
//
// Regex-based extraction, NOT a DOM parse — workers have no DOMParser and the
// worker graph must stay DOM-free (test/worker-layering.test.js enforces
// this transitively). Scope: geometry only — materials, colors and beam
// lattices are ignored, and only top-level <object><mesh> content is read
// (no <components> nesting).
import { unzipSync } from "fflate";

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export function parse3MF(bytes) {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let files;
  try {
    files = unzipSync(u8);
  } catch (e) {
    throw new Error(`3mf import: not a readable zip archive (${e?.message || e})`);
  }
  const modelPath = Object.keys(files).find((f) => f.toLowerCase().endsWith(".model"));
  if (!modelPath) throw new Error("3mf import: archive has no 3D model part (*.model)");
  const xml = new TextDecoder().decode(files[modelPath]);

  const unit = xml.match(/<model\b[^>]*\bunit="([^"]+)"/)?.[1] ?? "millimeter";
  const scale = UNIT_MM[unit];
  if (!scale) throw new Error(`3mf import: unknown unit "${unit}"`);

  // objects: id -> { P: number[] (already scaled to mm), I: number[] }
  const objects = new Map();
  const objRe = /<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g;
  for (let m; (m = objRe.exec(xml)); ) {
    const [, id, body] = m;
    const P = [], I = [];
    const vRe = /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g;
    for (let v; (v = vRe.exec(body)); ) P.push(+v[1] * scale, +v[2] * scale, +v[3] * scale);
    const tRe = /<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"/g;
    for (let t; (t = tRe.exec(body)); ) I.push(+t[1], +t[2], +t[3]);
    if (I.length) objects.set(id, { P, I });
  }
  if (objects.size === 0) throw new Error("3mf import: model contains no mesh geometry");

  // Build items: <item objectid="N" transform="m00 m01 m02 m10 m11 m12 m20 m21
  // m22 m30 m31 m32"/> — row-major 4x3, translation in the last row, per the
  // 3MF core spec (the transform is applied to a row vector: v' = v*M, i.e.
  // x' = x*m00 + y*m10 + z*m20 + m30, and so on). No <build>, or an object
  // with no matching item, falls back to identity placement.
  //
  // Attributes are pulled independently from each <item> tag (rather than in
  // one fixed-order regex) because `objectid` and `transform` can appear in
  // either order and a single ordered pattern with an optional middle group
  // can match the tag while silently leaving `transform` uncaptured.
  const items = [];
  const itemTagRe = /<item\b[^>]*\/>/g;
  for (let m; (m = itemTagRe.exec(xml)); ) {
    const tag = m[0];
    const id = tag.match(/\bobjectid="(\d+)"/)?.[1];
    if (!id) continue;
    const t = tag.match(/\btransform="([^"]+)"/)?.[1];
    items.push({ id, t: t ? t.trim().split(/\s+/).map(Number) : null });
  }
  const chosen = items.length ? items : [...objects.keys()].map((id) => ({ id, t: null }));

  const V = [], Tr = [];
  for (const { id, t } of chosen) {
    const o = objects.get(id);
    if (!o) continue;
    const base = V.length / 3;
    for (let i = 0; i < o.P.length; i += 3) {
      let x = o.P[i], y = o.P[i + 1], z = o.P[i + 2];
      if (t) {
        // Translation components (m30 m31 m32) are expressed in model units
        // per the 3MF spec, same as vertex coordinates — scale them to mm too
        // so they combine correctly with the already-scaled x/y/z above.
        const x2 = t[0] * x + t[3] * y + t[6] * z + t[9] * scale;
        const y2 = t[1] * x + t[4] * y + t[7] * z + t[10] * scale;
        const z2 = t[2] * x + t[5] * y + t[8] * z + t[11] * scale;
        x = x2; y = y2; z = z2;
      }
      V.push(x, y, z);
    }
    for (const idx of o.I) Tr.push(base + idx);
  }
  return { positions: Float32Array.from(V), indices: Uint32Array.from(Tr) };
}
