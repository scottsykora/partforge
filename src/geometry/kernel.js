// The GeometryKernel contract (documentation) + 2-D polygon helpers shared by
// drum.js when calling kernel.prism(). Backends implement the @typedef below.

/**
 * @typedef {Object} Solid  An opaque handle to a backend solid.
 * @property {(tool: Solid) => Solid} cut
 * @property {(tools: Solid[]) => Solid} cutAll      batch subtract (backend-optimized)
 * @property {(v: number[]) => Solid} translate
 * @property {(deg: number, center: number[], axis: number[]) => Solid} rotate
 * @property {(plane: "XY"|"XZ"|"YZ") => Solid} mirror
 * @property {(opts?: {quality?: "preview"|"print"}) => {positions:Float32Array, normals:Float32Array, indices:Uint32Array, triangles:number}} toMesh
 * @property {(opts?: {quality?: "preview"|"print"}) => ArrayBuffer} toSTL
 *
 * @typedef {Object} GeometryKernel
 * @property {(rBottom:number, rTop:number, h:number, opts?:{center?:boolean}) => Solid} cylinder
 * @property {(min:number[], max:number[]) => Solid} box
 * @property {(points2D:number[][], h:number) => Solid} prism   extrude polygon from z=0
 * @property {(o:{pathR:number,profileR:number,pitch:number,turns:number,z0:number,lefthand:boolean}) => Solid} helixSweptTube
 * @property {(solids:Solid[]) => Solid} union
 * @property {(named:{name:string,solid:Solid}[]) => ArrayBuffer} toSTEP   OCCT only
 */

// CCW polygon points for a circular-sector "pie" from the origin, radius tipR.
export function piePolygon(tipR, arcDeg, segs = 32) {
  const a = (arcDeg * Math.PI) / 180;
  const pts = [[0, 0]];
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  for (let i = 0; i <= steps; i++) {
    const t = (a * i) / steps;
    pts.push([tipR * Math.cos(t), tipR * Math.sin(t)]);
  }
  return pts;
}

// Vertex-up regular hexagon, circumradius r (flats facing ±X).
export function hexPolygon(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}
