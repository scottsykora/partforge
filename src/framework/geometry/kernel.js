// The GeometryKernel contract. The op lists below are DATA, not just docs: the
// parity tests (test/kernel-contract.test.js and the OCCT twin in
// test/occt-backend.test.js) assert each backend exposes exactly these ops, so the
// contract can't silently drift from the implementations — the drift class that
// once broke the probe kernel (see probe.js). The @typedefs document signatures,
// options-object form first (the canonical calling convention — normalizers and
// exact valid-key lists live in op-options.js, wired in at kernel-front.js
// (finishKernel) and solid-sugar.js (addSugar); legacy positional forms stay
// silently accepted until contract v2). The prose half of the contract —
// conventions, value semantics, conformance classes, versioning policy — is
// docs/KERNEL-CONTRACT.md; change either side and you must update the other.
// (2-D polygon helpers live in ./polygon.js.)

// The prose half's version: docs/KERNEL-CONTRACT.md's "Contract version" header
// must match this number (asserted in kernel-contract.test.js). Bump only on a
// breaking contract change — see the doc's Versioning section.
export const CONTRACT_VERSION = 1;

// Ops every backend kernel must implement.
export const KERNEL_OPS = [
  "cylinder", "boredCylinder", "sphere", "box", "prism", "extrude", "revolve",
  "loft", "sweep", "helixSweptTube", "union", "shape2d", "text2d", "hull", "hullChain", "toSTEP",
];

// Backend-optional kernel ops: the Manifold cache brackets + WASM lifetime hooks.
// jobs.js calls all of these via `?.`, so a backend may simply omit them.
export const KERNEL_OPTIONAL_OPS = [
  "beginSubPart", "endSubPart", "cacheStats", "resetCacheStats", "cleanup",
];

// Ops every Solid must implement (including the sugar addSugar() attaches).
export const SOLID_OPS = [
  "cut", "cutAll", "intersect", "union", "clone", "label", "boundingBox", "volume",
  "translate", "rotate", "rotateX", "rotateY", "rotateZ", "rotateAbout", "along", "at",
  "mirror", "scale", "toMesh", "toSTL", "toIndexedMesh",
  "fillet", "chamfer", "shell",
];

// Backend-optional Solid queries: Manifold mesh-topology numbers (measure.js
// guards with `typeof`); OCCT has no cheap equivalent.
export const SOLID_OPTIONAL_OPS = ["genus", "isEmpty"];

// Public methods every Shape2D exposes (2-D boolean value; contract-linted).
export const SHAPE2D_OPS = [
  "union", "cut", "cutAll", "intersect", "offset", "area", "boundingBox", "toRegions", "simple", "regions", "clone",
  "extrude", "revolve",
];

// Solid ops only OCCT implements natively. Single source of truth: probe.js routes
// a part to OCCT when its build uses one of these, and the Manifold backend
// generates its KernelCapabilityError stubs from the same list — adding an op here
// wires up both automatically.
export const OCCT_ONLY_OPS = ["fillet", "chamfer", "shell"];

/**
 * @typedef {Object} Solid  An opaque handle to a backend solid. `_`-prefixed keys are backend internals.
 * @property {(tool: Solid) => Solid} cut
 * @property {(tools: Solid[]) => Solid} cutAll      batch subtract (backend-optimized)
 * @property {(other: Solid) => Solid} intersect     boolean intersection (both backends)
 * @property {(other: Solid) => Solid} union         boolean union with one other solid (n-ary: k.union([...]))
 * @property {() => Solid} clone   independent copy (replicad consumes solids on transform)
 * @property {(name: string) => Solid} label   name this solid's surface for hover/pick feature attribution (survives transforms + booleans; same name on several solids merges into one feature)
 * @property {() => {min:number[],max:number[],center:number[],size:number[]}} boundingBox   axis-aligned bounds (query)
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
 * @property {(opts?: {quality?: "preview"|"print"}) => {positions:Float32Array, normals:Float32Array, indices?:Uint32Array, triangles:number, edges?:Float32Array}} toMesh
 *           `edges` = feature-edge line segments (Manifold); quality is advisory — the Manifold kernel bakes it at creation
 * @property {(opts?: {quality?: "preview"|"print"}) => Promise<ArrayBuffer>} toSTL
 * @property {() => {positions:Float32Array, indices:Uint32Array}} toIndexedMesh   indexed mesh, for 3MF
 * @property {(r:number|{r:number,edges?:object}) => Solid} fillet    round edges (OCCT only); fillet(3) or fillet({r,edges}); legacy (r,selector) accepted until v2
 * @property {(d:number|{d:number,edges?:object}) => Solid} chamfer  bevel edges (OCCT only); chamfer(1) or chamfer({d,edges}); legacy (d,selector) accepted until v2
 * @property {(o:{t:number,open:object}) => Solid} shell   hollow inward (OCCT only); legacy (thickness,openFaces) accepted until v2
 * @property {() => number} [genus]     through-hole count (Manifold only)
 * @property {() => boolean} [isEmpty]  no geometry at all (Manifold only)
 *
 * @typedef {Object} Shape2D  An opaque 2-D boolean value (both backends: Manifold wraps a CrossSection, OCCT a replicad Drawing). `_`-prefixed keys are backend internals.
 * @property {(other: Shape2D|number[][]) => Shape2D} union
 * @property {(other: Shape2D|number[][]) => Shape2D} cut
 * @property {(others: (Shape2D|number[][])[]) => Shape2D} cutAll   batch subtract
 * @property {(other: Shape2D|number[][]) => Shape2D} intersect
 * @property {() => number} area   net area (outers minus holes), mm²
 * @property {() => {min:number[],max:number[]}} boundingBox   axis-aligned 2-D bounds
 * @property {() => {outer:number[][],holes:number[][][]}[]} toRegions   materialize into region arrays (assembleRegions)
 * @property {() => {outer:number[][],holes:number[][][]}} simple   toRegions(), unwrapped — throws unless exactly 1 region
 * @property {() => Shape2D} clone   independent handle
 *
 * @typedef {Object} GeometryKernel
 * @property {(o:{r?:number,d?:number,r1?:number,r2?:number,d1?:number,d2?:number,h:number,center?:boolean}) => Solid} cylinder   canonical: {r|d,h} straight, {r1,r2,h}|{d1,d2,h} cone; legacy (rBottom,rTop,h,opts) accepted until contract v2
 * @property {(o:{od:number,h:number,bore:number}) => Solid} boredCylinder   compound: bored-through cylinder (one cache node)
 * @property {(o:{r?:number,d?:number}) => Solid} sphere   sphere centred at the origin; {r|d}; bare sphere(r) stays valid
 * @property {(o:{size?:number[],center?:boolean,min?:number[],max?:number[]}) => Solid} box   {size} = centered X/Y, base z=0 ({center:true} centers Z too) or {min,max}; legacy (min,max) accepted until v2
 * @property {(o:{points:number[][],h:number,twist?:number,scaleTop?:number}) => Solid} prism   extrude polygon from z=0; legacy (points,h,opts) accepted until v2
 * @property {(o:{profile:number[][]|{outer:number[][],holes?:number[][][]},h:number,twist?:number,scaleTop?:number}) => Solid} extrude   polygon-with-holes region from z=0; legacy (profile,h,opts) accepted until v2
 * @property {(o:{rings:{polygon?:number[][],sides?:number,radius?:number,z:number,rotate?:number,scale?:number|number[]}[],ruled?:boolean,closed?:boolean}) => Solid} loft   stack polygon cross-sections; legacy (rings,opts) accepted until v2
 * @property {(o:{profile:number[][],path:number[][],closed?:boolean,cornerRadius?:number,ruled?:boolean,smooth?:boolean}) => Solid} sweep   sweep a 2-D profile along a 3-D polyline; legacy (profile,path,opts) accepted until v2
 * @property {(o:{profile:number[][],degrees?:number}) => Solid} revolve   revolve a lathe profile [[r,z],…] around Z; legacy (points,opts) accepted until v2
 * @property {(o:{pathR:number,profileR:number,pitch:number,turns:number,z0:number,lefthand:boolean}) => Solid} helixSweptTube
 * @property {(solids:Solid[]) => Solid} union
 * @property {(profile: number[][]|{outer:number[][],holes?:number[][][]}|Shape2D) => Shape2D} shape2d   2-D boolean value (both backends: Manifold wraps a CrossSection, OCCT a replicad Drawing)
 * @property {(inputs: (Shape2D|number[][]|{start:number[],segments:object[]})[]) => Shape2D} hull   convex hull of all inputs → a convex Shape2D (faceted; pure-JS monotone chain)
 * @property {(inputs: (Shape2D|number[][]|{start:number[],segments:object[]})[]) => Shape2D} hullChain   swept hull over an ordered sequence (≥2): union of hull([inᵢ,inᵢ₊₁])
 * @property {(named:{name:string,solid:Solid}[]) => Promise<ArrayBuffer>} toSTEP   OCCT only (Manifold throws KernelCapabilityError)
 * @property {(name:string) => void} [beginSubPart]   open a per-sub-part solid-cache round (Manifold only)
 * @property {() => void} [endSubPart]                close the cache round (always pair with beginSubPart)
 * @property {() => {hits:number,misses:number}} [cacheStats]
 * @property {() => void} [resetCacheStats]
 * @property {() => void} [cleanup]   free per-job WASM objects (Manifold backend); call after each job
 */
