// The GeometryKernel contract (documentation). Backends implement the @typedef
// below. (2-D polygon helpers live in ./polygon.js.)

/**
 * @typedef {Object} Solid  An opaque handle to a backend solid.
 * @property {string} _hash   content hash (Manifold backend only; drives the worker solid cache)
 * @property {(tool: Solid) => Solid} cut
 * @property {(tools: Solid[]) => Solid} cutAll      batch subtract (backend-optimized)
 * @property {(other: Solid) => Solid} intersect     boolean intersection (both backends)
 * @property {() => Solid} clone   independent copy (replicad consumes solids on transform)
 * @property {() => {min:number[],max:number[],center:number[],size:number[]}} boundingBox   axis-aligned bounds (query)
 * @property {(thickness:number, openFaces:object) => Solid} shell   hollow inward (OCCT only); openFaces selector required
 * @property {(v: number[]) => Solid} translate
 * @property {(deg: number, center: number[], axis: number[]) => Solid} rotate   internal primitive — prefer rotateX/Y/Z / rotateAbout
 * @property {(deg: number) => Solid} rotateX   rotate about world X through the origin
 * @property {(deg: number) => Solid} rotateY   rotate about world Y through the origin
 * @property {(deg: number) => Solid} rotateZ   rotate about world Z through the origin
 * @property {(o:{axis:"X"|"Y"|"Z"|number[], deg:number, through?:number[]}) => Solid} rotateAbout   general rotation (legible)
 * @property {(dir:"+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z") => Solid} along   orient the canonical +Z build axis along dir
 * @property {(v:number[]) => Solid} at   place an origin-built solid at point v (alias of translate)
 * @property {(plane: "XY"|"XZ"|"YZ") => Solid} mirror
 * @property {(factor:number, center?:number[]) => Solid} scale   uniform scale about center (default origin)
 * @property {() => number} volume                   solid volume in mm³ (both backends; used by collision/overlap tests)
 * @property {(opts?: {quality?: "preview"|"print"}) => {positions:Float32Array, normals:Float32Array, indices:Uint32Array, triangles:number}} toMesh
 * @property {(opts?: {quality?: "preview"|"print"}) => Promise<ArrayBuffer>} toSTL
 * @property {() => {positions:Float32Array, indices:Uint32Array}} toIndexedMesh   indexed mesh, for 3MF (Manifold)
 *
 * @typedef {Object} GeometryKernel
 * @property {(rBottom:number, rTop:number, h:number, opts?:{center?:boolean}) => Solid} cylinder
 * @property {(o:{od:number,h:number,bore:number}) => Solid} boredCylinder   compound: bored-through cylinder (one cache node)
 * @property {(r:number) => Solid} sphere   sphere centred at the origin
 * @property {(min:number[], max:number[]) => Solid} box
 * @property {(points2D:number[][], h:number, opts?:{twist?:number,scaleTop?:number}) => Solid} prism   extrude polygon from z=0 (optional twist° + uniform top taper)
 * @property {(points2D:number[][], opts?:{degrees?:number}) => Solid} revolve   revolve a lathe profile [[r,z],…] around Z
 * @property {(o:{pathR:number,profileR:number,pitch:number,turns:number,z0:number,lefthand:boolean}) => Solid} helixSweptTube
 * @property {(solids:Solid[]) => Solid} union
 * @property {(named:{name:string,solid:Solid}[]) => Promise<ArrayBuffer>} toSTEP   OCCT only
 * @property {() => void} [cleanup]   free per-job WASM objects (Manifold backend); call after each job
 */
