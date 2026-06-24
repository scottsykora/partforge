// The GeometryKernel contract (documentation). Backends implement the @typedef
// below. (2-D polygon helpers live in ./polygon.js.)

/**
 * @typedef {Object} Solid  An opaque handle to a backend solid.
 * @property {(tool: Solid) => Solid} cut
 * @property {(tools: Solid[]) => Solid} cutAll      batch subtract (backend-optimized)
 * @property {(other: Solid) => Solid} intersect     boolean intersection (Manifold)
 * @property {() => Solid} clone   independent copy (replicad consumes solids on transform)
 * @property {() => {min:number[],max:number[],center:number[],size:number[]}} boundingBox   axis-aligned bounds (query)
 * @property {(v: number[]) => Solid} translate
 * @property {(deg: number, center: number[], axis: number[]) => Solid} rotate
 * @property {(plane: "XY"|"XZ"|"YZ") => Solid} mirror
 * @property {() => number} volume                   solid volume in mm³ (Manifold; used by collision tests)
 * @property {(opts?: {quality?: "preview"|"print"}) => {positions:Float32Array, normals:Float32Array, indices:Uint32Array, triangles:number}} toMesh
 * @property {(opts?: {quality?: "preview"|"print"}) => Promise<ArrayBuffer>} toSTL
 * @property {() => {positions:Float32Array, indices:Uint32Array}} toIndexedMesh   indexed mesh, for 3MF (Manifold)
 *
 * @typedef {Object} GeometryKernel
 * @property {(rBottom:number, rTop:number, h:number, opts?:{center?:boolean}) => Solid} cylinder
 * @property {(r:number) => Solid} sphere   sphere centred at the origin
 * @property {(min:number[], max:number[]) => Solid} box
 * @property {(points2D:number[][], h:number) => Solid} prism   extrude polygon from z=0
 * @property {(o:{pathR:number,profileR:number,pitch:number,turns:number,z0:number,lefthand:boolean}) => Solid} helixSweptTube
 * @property {(solids:Solid[]) => Solid} union
 * @property {(named:{name:string,solid:Solid}[]) => Promise<ArrayBuffer>} toSTEP   OCCT only
 * @property {() => void} [cleanup]   free per-job WASM objects (Manifold backend); call after each job
 */
