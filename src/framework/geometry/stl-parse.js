// Pure-JS STL reader (ascii + binary), the read twin of mesh-stl.js's writer.
// Returns triangle soup: positions x,y,z per vertex, indices 0..3n-1. Vertex
// welding is deliberately NOT done here — Manifold's Mesh.merge() welds at
// import (mesh-build.js), and the soup keeps this parser trivial and exact.
const u8of = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b);

function isAscii(u8) {
  // "solid" prefix is not enough (binary files sometimes start with it);
  // require an ascii "facet" token in the first 1 KB too.
  const head = String.fromCharCode(...u8.slice(0, 1024));
  return head.trimStart().startsWith("solid") && head.includes("facet");
}

export function parseStl(bytes) {
  const u8 = u8of(bytes);
  return isAscii(u8) ? parseAscii(u8) : parseBinary(u8);
}

function parseAscii(u8) {
  const text = new TextDecoder().decode(u8);
  const V = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let m; (m = re.exec(text)); ) V.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (V.length === 0 || V.length % 9 !== 0)
    throw new Error(`ascii STL parse failed: ${V.length / 3} vertices (not a multiple of 3)`);
  return soup(Float32Array.from(V));
}

function parseBinary(u8) {
  if (u8.length < 84) throw new Error("binary STL truncated: shorter than the 84-byte header");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(80, true);
  if (u8.length < 84 + n * 50) throw new Error(`binary STL truncated: header says ${n} triangles, file has ${Math.floor((u8.length - 84) / 50)}`);
  const positions = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // skip the facet normal
    for (let j = 0; j < 9; j++) positions[i * 9 + j] = dv.getFloat32(o + j * 4, true);
  }
  return soup(positions);
}

const soup = (positions) => ({
  positions,
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
