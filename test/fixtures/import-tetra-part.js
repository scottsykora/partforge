// The smallest part with a declared import: a watertight tetrahedron as inline ASCII
// STL, so a CLI test can run `describe <this>#scan` with no mesh file on disk.
const V = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
const F = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const stl = `solid tetra\n${F.map((f) =>
  `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${V[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid tetra\n`;
export default {
  name: "tetra",
  imports: { scan: () => new TextEncoder().encode(stl) },
  parts: { body: { build: (k) => k.import("scan") } },
  views: { default: { parts: ["body"] } },
  params: {},
};
