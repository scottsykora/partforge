// Hand-built triangle soups for the describe pipeline's kernel-free unit tests.
// Every fixture returns the Manifold convention (`positions` only, 9 floats per
// triangle, no `indices`) because that is what the describe path actually sees —
// mesh imports are Manifold-only. Winding is CCW seen from outside, so face
// normals point outward and dihedral signs come out convex-positive.
const tri = (out, a, b, c) => { out.push(...a, ...b, ...c); };

// Axis-aligned box at the origin, [0,0,0]..[sx,sy,sz]. 12 triangles, and every
// one of its 12 edges is a +90° convex edge — the simplest possible topology
// assertion.
export function boxMesh(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const quads = [[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  const positions = [];
  for (const [a,b,c,d] of quads) { tri(positions, v[a], v[b], v[c]); tri(positions, v[a], v[c], v[d]); }
  return { positions };
}

// Z-axis cylinder from z=0 to z=h, radius r, `segs` facets. Two planar caps and
// one cylindrical wall: the minimum fixture that makes segmentation prove it can
// tell a curved surface from a flat one.
export function cylinderMesh(r, h, segs = 32) {
  const positions = [];
  const p = (i, z) => [r * Math.cos(2 * Math.PI * i / segs), r * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const a = p(i, 0), b = p(i + 1, 0), c = p(i + 1, h), d = p(i, h);
    tri(positions, a, b, c); tri(positions, a, c, d);        // wall
    tri(positions, [0,0,0], b, a);                            // bottom cap (normal -Z)
    tri(positions, [0,0,h], d, c);                            // top cap (normal +Z)
  }
  return { positions };
}

// A washer: outer radius rOut, concentric bore rIn, thickness h. This is THE
// through-hole fixture. The outer wall's edges to the caps are convex; the bore's
// are concave, which is the single distinction every hole rule is built on.
export function annulusPlate(rOut, rIn, h, segs = 32) {
  const positions = [];
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const o0 = p(rOut, i, 0), o1 = p(rOut, i + 1, 0), o2 = p(rOut, i + 1, h), o3 = p(rOut, i, h);
    const n0 = p(rIn, i, 0), n1 = p(rIn, i + 1, 0), n2 = p(rIn, i + 1, h), n3 = p(rIn, i, h);
    tri(positions, o0, o1, o2); tri(positions, o0, o2, o3);   // outer wall, normal outward
    tri(positions, n1, n0, n3); tri(positions, n1, n3, n2);   // bore wall, normal inward-facing
    tri(positions, o1, o0, n0); tri(positions, o1, n0, n1);   // bottom annulus, normal -Z
    tri(positions, o3, o2, n2); tri(positions, o3, n2, n3);   // top annulus, normal +Z
  }
  return { positions };
}

// A full torus (Z axis, centred at `center`): main-sweep radius R, tube radius r,
// `segs` facets around the main sweep, `tubeSegs` around the tube. Closed and
// watertight (both sweeps wrap) — the fixture the torus branch of
// surface-graph.js's `sameSurface` needed and didn't have (no torus fixture existed
// anywhere in this file before that gap was found in review).
//
// Defaults are finer than the other fixtures' (48 each way, not ~16-32): a torus
// curves in TWO directions at once, so its chord error is set by the SMALLER of
// the two radii (the tube, `r`) rather than by the single radius a cylinder or
// sphere fixture's facet count has to clear — at the coarser densities this file's
// other shapes use, the tessellation's own sagitta already exceeds segment.js's
// `FIT_TOL_FRAC` acceptance band before any test logic runs at all (measured
// directly: 24x12 clears a mere ~0.10mm maxDev against an ~0.011mm budget on a
// R=10/r=3 torus — 10x over). 48x48 clears the same budget with margin
// (~0.007mm against ~0.011mm).
//
// Note this fixture is NOT expected to segment into one patch via `segment()`'s
// region growing — that mechanism bootstraps curvature recognition from a mutual
// witness pair of similarly-curved edges near a seed triangle (see segment.js's
// `sameFamily`/`familySignature`), which a doubly-curved surface's two very
// different principal radii structurally defeat (a seed triangle's u-direction
// and v-direction neighbours never share an implied radius to corroborate each
// other with). That is a pre-existing, orthogonal limitation of region growing on
// double curvature, out of scope for this fixture's purpose: exercising
// surface-graph.js directly with hand-built torus patches (`fitTorus` run once
// over the whole mesh, the same way segment.js's own `bestFit` would), not
// proving segment() itself handles tori.
export function torusMesh(R, r, segs = 48, tubeSegs = 48, center = [0, 0, 0]) {
  const positions = [];
  const p = (i, j) => {
    const u = 2 * Math.PI * i / segs, v = 2 * Math.PI * j / tubeSegs;
    const rad = R + r * Math.cos(v);
    return [center[0] + rad * Math.cos(u), center[1] + rad * Math.sin(u), center[2] + r * Math.sin(v)];
  };
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
      tri(positions, a, b, c); tri(positions, a, c, d);
    }
  }
  return { positions };
}

// An axis-aligned box with ONE vertical edge (the x=sx,y=0 edge) replaced by a
// flat 45-degree bevel of size `c`. THE chamfer fixture: a finite straight
// chamfer necessarily terminates against two more faces (the top and bottom
// caps here) besides the two it actually blends (the +X and -Y walls) — this
// is what any real straight chamfer looks like, and is exactly what exposed
// dressups.js's original `arcs.length !== 2` premise as too strict (round 1
// review): the bevel plane here has FOUR arcs, not two.
export function chamferedBox(sx, sy, sz, c) {
  const v0=[0,0,0], v1=[sx,0,0], v2=[sx,sy,0], v3=[0,sy,0];
  const v4=[0,0,sz], v5=[sx,0,sz], v6=[sx,sy,sz], v7=[0,sy,sz];
  const p0=[sx-c,0,0], p1=[sx,c,0], p2=[sx-c,0,sz], p3=[sx,c,sz];
  const positions = [];
  tri(positions, v3, v2, p1); tri(positions, v3, p1, p0); tri(positions, v3, p0, v0);   // bottom cap (-Z)
  tri(positions, v4, p2, p3); tri(positions, v4, p3, v6); tri(positions, v4, v6, v7);   // top cap (+Z)
  tri(positions, p1, v2, v6); tri(positions, p1, v6, p3);                               // +X wall (reduced)
  tri(positions, v0, p0, p2); tri(positions, v0, p2, v4);                               // -Y wall (reduced)
  tri(positions, v2, v3, v7); tri(positions, v2, v7, v6);                               // +Y wall (unaffected)
  tri(positions, v3, v0, v4); tri(positions, v3, v4, v7);                               // -X wall (unaffected)
  tri(positions, p0, p1, p3); tri(positions, p0, p3, p2);                               // the 45-degree bevel
  return { positions };
}

// `annulusPlate` with the TOP mouth opened into a 45-degree countersink: the
// straight bore (radius `rIn`) only runs from z=0 to z=h-(rC-rIn); above that
// it widens conically out to radius `rC` at the top face. THE countersunk-hole
// fixture — a straight through-bore with one chamfered (conical) entrance,
// arguably the single most common chamfered feature in real mechanical parts,
// and the fixture that exposed detectHoles's original mouth filter (plane-only)
// missing it entirely (round 1 review): the convex arc off the bore's top end
// lands on a CONE, not a plane, so the through-hole branch never fired.
export function countersunkPlate(rOut, rIn, rC, h, segs = 96) {
  const positions = [];
  const d = rC - rIn;        // countersink depth at 45 degrees (widening rate 1:1)
  const zc = h - d;          // height where the straight bore ends and the cone begins
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const o0 = p(rOut,i,0), o1 = p(rOut,i+1,0), o2 = p(rOut,i+1,h), o3 = p(rOut,i,h);
    const b0 = p(rIn,i,0), b1 = p(rIn,i+1,0), b2 = p(rIn,i+1,zc), b3 = p(rIn,i,zc);
    const c2 = p(rC,i+1,h), c3 = p(rC,i,h);
    tri(positions, o0, o1, o2); tri(positions, o0, o2, o3);                             // outer wall
    tri(positions, b1, b0, b3); tri(positions, b1, b3, b2);                             // straight bore (0..zc)
    tri(positions, p(rIn,i+1,zc), p(rIn,i,zc), c3); tri(positions, p(rIn,i+1,zc), c3, c2); // countersink cone (zc..h)
    tri(positions, o1, o0, b0); tri(positions, o1, b0, b1);                             // bottom annulus (plain mouth)
    tri(positions, o3, o2, c2); tri(positions, o3, c2, c3);                             // top annulus (around the countersink)
  }
  return { positions };
}

// A solid cylinder (radius R, height H) with its TOP rim rounded by a tangent
// torus fillet of radius r — THE fillet fixture, deliberately the CONVEX-corner
// case (material fills rho<R, z<H, so the corner being rounded has only 90
// degrees of material — same family as a box edge). Section-ordered (bottom
// cap, then wall, then fillet, then top cap, each a contiguous run of
// triangles) so a caller can slice out exactly the fillet's own faces by index
// range alone via `filletFaceRange` — needed because this shape is NOT expected
// to segment cleanly via `segment()`'s own region growing (same structural
// limitation `torusMesh`'s own comment documents: growth's witness-corroboration
// bootstrap doesn't handle double curvature), so tests hand-build this patch
// with `fitTorus` directly, the same pattern describe-surface-graph.test.js's
// own `torusPatch` helper already uses for the full-torus fixture.
//
// A fillet rounding a CONCAVE corner instead (e.g. a boss's BASE) is the torus's
// OTHER meridian half, whose true outward mesh normal points TOWARD the tube's
// own local center rather than away from it — verified directly that
// `fitTorus` (fit.js), which recovers the minor radius via `p - r*n` collapsing
// onto the main circle, assumes normals point away from center and returns
// garbage (minor radius off by 10x, maxDev ~1) for the concave-corner half fed
// its true outward normals. That is a real scope limit of `fitTorus` as
// written, not something to fix here; this fixture sidesteps it by using the
// convex-corner half, which is what `fitTorus` supports today.
export function filletedCylinderTop(R, H, r, segs = 96, tubeSegs = 48) {
  const positions = [];
  const rTop = R - r, zWall = H - r;
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) tri(positions, [0,0,0], p(R,i+1,0), p(R,i,0));                 // bottom cap (-Z)
  for (let i = 0; i < segs; i++) {                                                              // wall (radius R, 0..zWall)
    tri(positions, p(R,i,0), p(R,i+1,0), p(R,i+1,zWall)); tri(positions, p(R,i,0), p(R,i+1,zWall), p(R,i,zWall));
  }
  for (let i = 0; i < segs; i++) {                                                              // fillet (torus quarter patch)
    for (let j = 0; j < tubeSegs; j++) {
      const phi0 = (Math.PI/2) * j / tubeSegs, phi1 = (Math.PI/2) * (j+1) / tubeSegs;
      // rho(phi)=rTop+r*sin(phi), z(phi)=zWall+r*cos(phi): at phi=0 this is
      // (rTop, zWall+r)=(rTop,H), tangent to the top cap; at phi=pi/2 it's
      // (rTop+r, zWall)=(R,zWall), tangent to the wall.
      const rho0 = rTop + r*Math.sin(phi0), z0 = zWall + r*Math.cos(phi0);
      const rho1 = rTop + r*Math.sin(phi1), z1 = zWall + r*Math.cos(phi1);
      const a = p(rho0,i,z0), b = p(rho0,i+1,z0), c = p(rho1,i+1,z1), d = p(rho1,i,z1);
      tri(positions, a, c, b); tri(positions, a, d, c);
    }
  }
  for (let i = 0; i < segs; i++) tri(positions, [0,0,H], p(rTop,i,H), p(rTop,i+1,H));            // top cap (+Z, radius rTop)
  return { positions };
}

// The face-index range `filletedCylinderTop`'s own fillet (torus) patch occupies,
// given the same (segs, tubeSegs) — bottom cap is `segs` triangles, wall is
// `2*segs`, so the fillet starts right after both and runs `2*segs*tubeSegs`
// triangles long. Lets a caller slice the fillet's faces out for a hand-built
// `fitTorus` patch without re-deriving this arithmetic at every call site.
export function filletFaceRange(segs, tubeSegs) {
  return [3 * segs, 3 * segs + 2 * segs * tubeSegs];
}

// A plate with a cylindrical boss standing on it, the boss's BASE rounded by a
// tangent torus fillet — the CONCAVE-corner twin of `filletedCylinderTop`
// (there, the top rim; here, the base): the corner being rounded has 270
// degrees of material, the shape you get at a pocket floor or a boss base.
// Its true outward mesh normal points TOWARD the tube's own local
// cross-section centre rather than away from it — the case `fitTorus`
// (fit.js) originally could not fit at all (round-2 review: its minor-radius
// search sampled only positive r, and the identity this shape needs is
// negative r; see fitTorus's own comment). Section-ordered (bottom cap, plate
// wall, plate top annulus, fillet, shaft wall, shaft cap, each a contiguous
// run) for the same reason `filletedCylinderTop` is: this shape is not
// expected to segment cleanly via `segment()`'s own region growing (double
// curvature defeats its witness-corroboration bootstrap, same as
// `torusMesh`'s own comment covers), so tests hand-build each patch directly
// via `filletBaseRange` instead.
export function filletedCylinderBase(Rp, Hp, R, Hs, r, segs = 96, tubeSegs = 48) {
  const positions = [];
  const rFlat = R + r, zc = Hp + r;
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) tri(positions, [0,0,0], p(Rp,i+1,0), p(Rp,i,0));                // bottom cap (-Z)
  for (let i = 0; i < segs; i++) {                                                               // plate wall (radius Rp, 0..Hp)
    tri(positions, p(Rp,i,0), p(Rp,i+1,0), p(Rp,i+1,Hp)); tri(positions, p(Rp,i,0), p(Rp,i+1,Hp), p(Rp,i,Hp));
  }
  for (let i = 0; i < segs; i++) {                                                               // plate top annulus (Rp -> rFlat at z=Hp)
    tri(positions, p(Rp,i+1,Hp), p(Rp,i,Hp), p(rFlat,i,Hp)); tri(positions, p(Rp,i+1,Hp), p(rFlat,i,Hp), p(rFlat,i+1,Hp));
  }
  for (let i = 0; i < segs; i++) {                                                               // fillet (torus quarter patch)
    for (let j = 0; j < tubeSegs; j++) {
      const phi0 = (Math.PI/2) * j / tubeSegs, phi1 = (Math.PI/2) * (j+1) / tubeSegs;
      // rho(phi)=rFlat-r*sin(phi), z(phi)=zc-r*cos(phi): at phi=0 this is
      // (rFlat, zc-r)=(rFlat,Hp), tangent to the plate top; at phi=pi/2 it's
      // (rFlat-r, zc)=(R,zc), tangent to the shaft wall.
      const rho0 = rFlat - r*Math.sin(phi0), z0 = zc - r*Math.cos(phi0);
      const rho1 = rFlat - r*Math.sin(phi1), z1 = zc - r*Math.cos(phi1);
      const a = p(rho0,i,z0), b = p(rho0,i+1,z0), c = p(rho1,i+1,z1), d = p(rho1,i,z1);
      tri(positions, a, b, c); tri(positions, a, c, d);
    }
  }
  for (let i = 0; i < segs; i++) {                                                               // shaft wall (radius R, zc..zc+Hs)
    tri(positions, p(R,i,zc), p(R,i+1,zc), p(R,i+1,zc+Hs)); tri(positions, p(R,i,zc), p(R,i+1,zc+Hs), p(R,i,zc+Hs));
  }
  for (let i = 0; i < segs; i++) tri(positions, [0,0,zc+Hs], p(R,i,zc+Hs), p(R,i+1,zc+Hs));      // shaft top cap (+Z, radius R)
  return { positions };
}

// The face-index range `filletedCylinderBase`'s own fillet (torus) patch
// occupies: bottom cap (`segs`), plate wall (`2*segs`), plate top annulus
// (`2*segs`) all precede it, so it starts after `5*segs` and runs
// `2*segs*tubeSegs` triangles long. Mirrors `filletFaceRange`.
export function filletBaseRange(segs, tubeSegs) {
  return [5 * segs, 5 * segs + 2 * segs * tubeSegs];
}

// A blind-hole cup: a solid cylinder (outer radius rOut, height h) with a
// flat-bottomed cylindrical bore (radius rIn) that stops at z=dBlind rather
// than breaking through — THE blind-hole fixture. Built by directly reusing
// `annulusPlate`'s own proven wall/mouth winding (the bore-wall and
// top-annulus patterns below are copied from it verbatim, just shifted to
// start at z=dBlind instead of z=0) plus `cylinderMesh`'s own cap windings for
// the solid bottom and the flat floor — rather than re-derived from scratch,
// after an earlier from-scratch attempt at this fixture got the bore wall's
// and the floor's winding backwards (bore came out convex, floor came out on
// the wrong side) and was caught only by checking the resulting curvature/arc
// convexity against the plain annulusPlate/cylinderMesh fixtures already known
// to be correct.
export function cupMesh(rOut, rIn, h, dBlind, segs = 48) {
  const positions = [];
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const o0 = p(rOut,i,0), o1 = p(rOut,i+1,0), o2 = p(rOut,i+1,h), o3 = p(rOut,i,h);
    const n0 = p(rIn,i,dBlind), n1 = p(rIn,i+1,dBlind), n2 = p(rIn,i+1,h), n3 = p(rIn,i,h);
    tri(positions, o0, o1, o2); tri(positions, o0, o2, o3);                     // outer wall (full height, convex)
    tri(positions, [0,0,0], p(rOut,i+1,0), p(rOut,i,0));                       // solid bottom cap (-Z)
    tri(positions, n1, n0, n3); tri(positions, n1, n3, n2);                     // bore wall (dBlind..h, concave/inward)
    tri(positions, o3, o2, n2); tri(positions, o3, n2, n3);                     // top annulus (the hole's mouth, +Z)
    tri(positions, [0,0,dBlind], p(rIn,i,dBlind), p(rIn,i+1,dBlind));           // blind floor (+Z, material below)
  }
  return { positions };
}

// Emits two triangles for the coplanar quad a,b,c,d (perimeter order, either
// winding) with vertices wound so the resulting normal points toward `outward`
// (only the SIGN of the dot product against it is used, so an exact direction
// isn't required). Used throughout the box-with-a-hole fixtures below to avoid
// hand-deriving a cross product's sign per quad, which is exactly the kind of
// arithmetic a sign error hides in silently — a mis-wound face reads as an
// ordinary mesh to everything except `topology.js`'s dihedral sign.
function quadTowards(out, a, b, c, d, outward) {
  const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const e2 = [d[0]-a[0], d[1]-a[1], d[2]-a[2]];
  const n = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
  if (n[0]*outward[0] + n[1]*outward[1] + n[2]*outward[2] >= 0) { tri(out, a, b, c); tri(out, a, c, d); }
  else { tri(out, a, d, c); tri(out, a, c, b); }
}

// A hollow box: a uniform-wall-thickness shell between an outer box
// [0,0,0]..[sx,sy,sz] and a concentric inner cavity [wall]..[sx-wall,sy-wall,sz-wall].
// Outer faces point outward; the cavity faces point the other way, into the empty
// space they bound — same convention as this file's other inward-facing bore/cavity
// walls. THE positive-direction fixture for the raycast-based uniform-wall-thickness
// shell rule in features/sweeps.js: every one of its 12 planes reads the same inward
// thickness (`wall`), the shape the rule exists to recognise.
export function hollowBoxMesh(sx, sy, sz, wall) {
  const positions = [];
  const o = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const i = [[wall,wall,wall],[sx-wall,wall,wall],[sx-wall,sy-wall,wall],[wall,sy-wall,wall],
             [wall,wall,sz-wall],[sx-wall,wall,sz-wall],[sx-wall,sy-wall,sz-wall],[wall,sy-wall,sz-wall]];
  const outer = [
    [o[3],o[2],o[1],o[0],[0,0,-1]], [o[4],o[5],o[6],o[7],[0,0,1]],
    [o[0],o[1],o[5],o[4],[0,-1,0]], [o[1],o[2],o[6],o[5],[1,0,0]],
    [o[2],o[3],o[7],o[6],[0,1,0]],  [o[3],o[0],o[4],o[7],[-1,0,0]],
  ];
  for (const [a,b,c,d,n] of outer) quadTowards(positions, a, b, c, d, n);
  const inner = [
    [i[3],i[2],i[1],i[0],[0,0,1]], [i[4],i[5],i[6],i[7],[0,0,-1]],
    [i[0],i[1],i[5],i[4],[0,1,0]], [i[1],i[2],i[6],i[5],[-1,0,0]],
    [i[2],i[3],i[7],i[6],[0,-1,0]], [i[3],i[0],i[4],i[7],[1,0,0]],
  ];
  for (const [a,b,c,d,n] of inner) quadTowards(positions, a, b, c, d, n);
  return { positions };
}

// An open tray: `hollowBoxMesh`'s shell with the top face (z=sz) removed and the cut
// closed by a rectangular-annulus RIM at z=sz connecting the outer top edge to the
// inner top edge — so the cavity is open to the outside, the way a real tray or
// enclosure base is, rather than a fully sealed shell. THE negative-direction
// counterpart `hollowBoxMesh` doesn't cover: every plane here is still uniform-
// thickness (the rule must still fire), but there is no outer top face at all —
// exactly the topology that defeated the plane-pairing approach this rule replaced
// (a pairing rule finds no anti-parallel partner for the missing top and reports
// nothing; a thickness-by-raycast rule doesn't care that a partner face exists,
// only that the inward distance is small and consistent).
export function openTrayMesh(sx, sy, sz, wall) {
  const positions = [];
  const o = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const outer = [
    [o[3],o[2],o[1],o[0],[0,0,-1]],
    [o[0],o[1],o[5],o[4],[0,-1,0]], [o[1],o[2],o[6],o[5],[1,0,0]],
    [o[2],o[3],o[7],o[6],[0,1,0]],  [o[3],o[0],o[4],o[7],[-1,0,0]],
  ];
  for (const [a,b,c,d,n] of outer) quadTowards(positions, a, b, c, d, n);
  const iFloor = [[wall,wall,wall],[sx-wall,wall,wall],[sx-wall,sy-wall,wall],[wall,sy-wall,wall]];
  const iTop = [[wall,wall,sz],[sx-wall,wall,sz],[sx-wall,sy-wall,sz],[wall,sy-wall,sz]];
  const i = [...iFloor, ...iTop];
  const inner = [
    [i[3],i[2],i[1],i[0],[0,0,1]],
    [i[0],i[1],i[5],i[4],[0,1,0]], [i[1],i[2],i[6],i[5],[-1,0,0]],
    [i[2],i[3],i[7],i[6],[0,-1,0]], [i[3],i[0],i[4],i[7],[1,0,0]],
  ];
  for (const [a,b,c,d,n] of inner) quadTowards(positions, a, b, c, d, n);
  const [OA, OB, OC, OD] = [o[4], o[5], o[6], o[7]];
  const [IA, IB, IC, ID] = iTop;
  for (const [P, Q, R, S] of [[OA,OB,IB,IA],[OB,OC,IC,IB],[OC,OD,ID,IC],[OD,OA,IA,ID]]) {
    quadTowards(positions, P, Q, R, S, [0, 0, 1]);
  }
  return { positions };
}

// A plate [0,0,0]..[sx,sy,sz] with one closed rectangular pocket recessed into its
// top face — the rectangular analogue of `cupMesh`'s circular blind bore. Footprint
// [px,px+pw] x [py,py+pl], recessed from z=sz down to z=sz-pd; must sit strictly
// inside the plate's own footprint so the pocket is fully surrounded by material,
// not cut through an edge. THE wide-shallow-pocket fixture for
// features/prismatic.js's mouth-vs-floor-vs-own-wall regression: with pw/pl large
// and pd small, the pocket's own floor (pw*pl) is bigger than its own side walls
// (perimeter*pd), the opposite proportion from a deep narrow pocket — exactly the
// case that exposed pass two trying a small SIDE WALL as a candidate cap before
// ever reaching the real floor.
export function boxWithPocket(sx, sy, sz, px, py, pw, pl, pd) {
  const positions = [];
  const o = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const outer = [
    [o[3],o[2],o[1],o[0],[0,0,-1]],
    [o[0],o[1],o[5],o[4],[0,-1,0]], [o[1],o[2],o[6],o[5],[1,0,0]],
    [o[2],o[3],o[7],o[6],[0,1,0]],  [o[3],o[0],o[4],o[7],[-1,0,0]],
  ];
  for (const [a,b,c,d,n] of outer) quadTowards(positions, a, b, c, d, n);
  const [OA, OB, OC, OD] = [o[4], o[5], o[6], o[7]];
  const IA = [px,py,sz], IB = [px+pw,py,sz], IC = [px+pw,py+pl,sz], ID = [px,py+pl,sz];
  for (const [P, Q, R, S] of [[OA,OB,IB,IA],[OB,OC,IC,IB],[OC,OD,ID,IC],[OD,OA,IA,ID]]) {
    quadTowards(positions, P, Q, R, S, [0, 0, 1]);
  }
  const fz = sz - pd;
  const FA = [px,py,fz], FB = [px+pw,py,fz], FC = [px+pw,py+pl,fz], FD = [px,py+pl,fz];
  // Pocket walls: outward INTO the cavity, away from the surrounding material.
  quadTowards(positions, IA, IB, FB, FA, [0, 1, 0]);
  quadTowards(positions, IB, IC, FC, FB, [-1, 0, 0]);
  quadTowards(positions, IC, ID, FD, FC, [0, -1, 0]);
  quadTowards(positions, ID, IA, FA, FD, [1, 0, 0]);
  // Pocket floor: outward +z, up out of the floor into the pocket.
  quadTowards(positions, FA, FB, FC, FD, [0, 0, 1]);
  return { positions };
}

// A plate [0,0,0]..[sx,sy,sz] with one closed rectangular PAD standing proud of its
// top face — `boxWithPocket`'s raised twin, same footprint/position parameters,
// `ph` (pad height) in place of `pd` (pocket depth). THE raised-pad fixture for
// features/prismatic.js's pocket-vs-boss regression: same proportions as the wide-
// shallow pocket above (wide relative to its own walls), so a type-swap bug that
// only showed up on one proportion and not the other would slip past a suite that
// tested just one of this pair.
export function boxWithPad(sx, sy, sz, px, py, pw, pl, ph) {
  const positions = [];
  const o = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const outer = [
    [o[3],o[2],o[1],o[0],[0,0,-1]],
    [o[0],o[1],o[5],o[4],[0,-1,0]], [o[1],o[2],o[6],o[5],[1,0,0]],
    [o[2],o[3],o[7],o[6],[0,1,0]],  [o[3],o[0],o[4],o[7],[-1,0,0]],
  ];
  for (const [a,b,c,d,n] of outer) quadTowards(positions, a, b, c, d, n);
  const [OA, OB, OC, OD] = [o[4], o[5], o[6], o[7]];
  const BA = [px,py,sz], BB = [px+pw,py,sz], BC = [px+pw,py+pl,sz], BD = [px,py+pl,sz];
  for (const [P, Q, R, S] of [[OA,OB,BB,BA],[OB,OC,BC,BB],[OC,OD,BD,BC],[OD,OA,BA,BD]]) {
    quadTowards(positions, P, Q, R, S, [0, 0, 1]);
  }
  const tz = sz + ph;
  const TA = [px,py,tz], TB = [px+pw,py,tz], TC = [px+pw,py+pl,tz], TD = [px,py+pl,tz];
  // Pad side walls: standard convex walls, outward AWAY from the pad's own centre —
  // the opposite sense of the pocket's walls above.
  quadTowards(positions, BA, BB, TB, TA, [0, -1, 0]);
  quadTowards(positions, BB, BC, TC, TB, [1, 0, 0]);
  quadTowards(positions, BC, BD, TD, TC, [0, 1, 0]);
  quadTowards(positions, BD, BA, TA, TD, [-1, 0, 0]);
  // Pad top cap, standard outward +z.
  quadTowards(positions, TA, TB, TC, TD, [0, 0, 1]);
  return { positions };
}

// One `boxWithPad`/`boxWithPocket`-style 4-trapezoid ring, generalised from "the whole
// plate" to an arbitrary Y-band `[y0,y1]` (still the full `[x0,x1]` width) with one
// rectangular hole `[hx0,hx1]x[hy0,hy1]` strictly inside it. Exists so
// `plateWithDistractor` can tile a plate-top-minus-THREE-holes face out of three
// independent single-hole bands stacked in Y, each using the exact same proven
// technique those two fixtures already rely on, rather than a general n-hole tiler: an
// n-hole tiler (tried first) has to put its own grid lines whenever any hole's boundary
// crosses another's span, and every un-subdivided WALL quad on the other side of that
// same edge (the outer plate wall, or a hole's own side wall — both single flat quads,
// same as this ring's own OA-OB etc.) then disagrees with it vertex-for-vertex: a
// T-junction, not the shared edge two triangles need to weld into one watertight mesh
// (caught by `buildTopology`'s own open-edge count, 56 of them, before this fixture's
// three-band form was written).
function bandRing(positions, x0, x1, y0, y1, hx0, hx1, hy0, hy1, z, outward) {
  const OA=[x0,y0,z], OB=[x1,y0,z], OC=[x1,y1,z], OD=[x0,y1,z];
  const HA=[hx0,hy0,z], HB=[hx1,hy0,z], HC=[hx1,hy1,z], HD=[hx0,hy1,z];
  quadTowards(positions, OA, OB, HB, HA, outward);
  quadTowards(positions, OB, OC, HC, HB, outward);
  quadTowards(positions, OC, OD, HD, HC, outward);
  quadTowards(positions, OD, OA, HA, HD, outward);
}

// A plate with a small boss, a small pocket, and a much larger co-oriented "distractor"
// pad standing elsewhere on the same plate — THE regression fixture for R57 (CRITICAL,
// prismatic.js commit d0718e0). The pre-fix pocket/boss rule read
// `allCaps.find(c => dot(c.fit.normal, cap.fit.normal) > 0.98)` — the largest-by-area
// co-oriented plane ANYWHERE on the part, with no adjacency check — instead of a plane
// the feature's own walls actually meet. The boss's and the pocket's own genuine
// surrounding partner is the plate's own top face; but the distractor's footprint eats
// most of the plate top's own area, so what is LEFT of the plate top (`sx*sy` minus all
// three footprints) comes out SMALLER than the distractor's own top (which nothing sits
// on top of it to shrink). Sorted by area, the old rule's `.find()` reaches the
// distractor before it ever reaches the plate — even though the boss's and the pocket's
// own walls are nowhere near it. Compared against the distractor's own far-away offset,
// a boss standing `bh` proud of the plate reads sunk `distractor top z - boss top z` deep
// and is reported a POCKET instead of a BOSS — R57's exact failure mode, a rebuilding
// agent told to CUT where it should ADD. The pocket keeps its own type by coincidence
// (its displacement against the distractor is negative either way, same as against its
// true partner) but its reported DEPTH is wrong by orders of magnitude — the failure a
// type-only assertion would miss, which is why the regression test built on this fixture
// checks depth too.
//
// The plate top is three Y-bands stacked bottom to top — `[0,y1]` (boss), `[y1,y2]`
// (pocket), `[y2,sy]` (distractor), each its own `bandRing` — so the LEFT/RIGHT outer
// walls (which every band touches) are built band-by-band too, matching that same
// three-way split; FRONT/BACK only ever touch one band each (`y=0` only the boss band,
// `y=sy` only the distractor band) and stay single quads. `dw*dl` is deliberately built
// to be most of the plate's own total area (the distractor band dominates the other two
// in height) — see this fixture's own header for why that inequality is the whole
// point. Every one of the boundary coordinates below (plate edges, band splits, and
// each footprint's own x0/x1/y0/y1) is chosen distinct from every other, so no two
// features' side walls ever land on the same infinite plane and get folded into one
// multi-island surface by `mergeCoFamily` (surface-graph.js) — a real behaviour this
// file's own `wallIslandFor`/`islandsOf` machinery handles correctly, but orthogonal to
// the one bug this fixture exists to reproduce, so kept out of the way rather than
// exercised here.
export function plateWithDistractor(
  sx, sy, sz,
  y1, y2,             // band splits: boss in [0,y1], pocket in [y1,y2], distractor in [y2,sy]
  bx, by, bs, bh,     // boss: footprint [bx,bx+bs] x [by,by+bs], height bh
  px, py, ps, pd,     // pocket: footprint [px,px+ps] x [py,py+ps], depth pd
  dx, dy, dw, dl, dh, // distractor pad: footprint [dx,dx+dw] x [dy,dy+dl], height dh
) {
  const positions = [];
  const o = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const outer = [
    [o[0],o[1],o[5],o[4],[0,-1,0]], [o[2],o[3],o[7],o[6],[0,1,0]], // front (y=0), back (y=sy)
  ];
  for (const [a,b,c,d,n] of outer) quadTowards(positions, a, b, c, d, n);
  // Bottom, left (x=0), and right (x=sx): one quad per band each, matching the top
  // face's own three-way split — every one of these faces touches all three bands
  // (unlike front/back, which only ever touch the outermost one), so each needs the
  // same y1/y2 subdivision the top bands introduce, or its single long edge would
  // T-junction against three shorter ones on the other side of it (`bandRing`'s own
  // comment has the full story; this exact mismatch, on the bottom face specifically,
  // is what an earlier version of this fixture missed).
  for (const [ya, yb] of [[0, y1], [y1, y2], [y2, sy]]) {
    quadTowards(positions, [0,ya,0], [sx,ya,0], [sx,yb,0], [0,yb,0], [0,0,-1]);
    quadTowards(positions, [0,ya,0], [0,yb,0], [0,yb,sz], [0,ya,sz], [-1,0,0]);
    quadTowards(positions, [sx,ya,0], [sx,yb,0], [sx,yb,sz], [sx,ya,sz], [1,0,0]);
  }

  bandRing(positions, 0, sx, 0, y1, bx, bx + bs, by, by + bs, sz, [0, 0, 1]);
  bandRing(positions, 0, sx, y1, y2, px, px + ps, py, py + ps, sz, [0, 0, 1]);
  bandRing(positions, 0, sx, y2, sy, dx, dx + dw, dy, dy + dl, sz, [0, 0, 1]);

  // Boss: standard raised pad, `boxWithPad`'s own wall/top pattern.
  const BA=[bx,by,sz], BB=[bx+bs,by,sz], BC=[bx+bs,by+bs,sz], BD=[bx,by+bs,sz];
  const bz = sz + bh;
  const TA=[bx,by,bz], TB=[bx+bs,by,bz], TC=[bx+bs,by+bs,bz], TD=[bx,by+bs,bz];
  quadTowards(positions, BA, BB, TB, TA, [0,-1,0]);
  quadTowards(positions, BB, BC, TC, TB, [1,0,0]);
  quadTowards(positions, BC, BD, TD, TC, [0,1,0]);
  quadTowards(positions, BD, BA, TA, TD, [-1,0,0]);
  quadTowards(positions, TA, TB, TC, TD, [0,0,1]);

  // Pocket: standard recessed cavity, `boxWithPocket`'s own wall/floor pattern.
  const IA=[px,py,sz], IB=[px+ps,py,sz], IC=[px+ps,py+ps,sz], ID=[px,py+ps,sz];
  const fz = sz - pd;
  const FA=[px,py,fz], FB=[px+ps,py,fz], FC=[px+ps,py+ps,fz], FD=[px,py+ps,fz];
  quadTowards(positions, IA, IB, FB, FA, [0,1,0]);
  quadTowards(positions, IB, IC, FC, FB, [-1,0,0]);
  quadTowards(positions, IC, ID, FD, FC, [0,-1,0]);
  quadTowards(positions, ID, IA, FA, FD, [1,0,0]);
  quadTowards(positions, FA, FB, FC, FD, [0,0,1]);

  // Distractor: another raised pad, same pattern, just much bigger in footprint.
  const WA=[dx,dy,sz], WB=[dx+dw,dy,sz], WC=[dx+dw,dy+dl,sz], WD=[dx,dy+dl,sz];
  const dz = sz + dh;
  const UA=[dx,dy,dz], UB=[dx+dw,dy,dz], UC=[dx+dw,dy+dl,dz], UD=[dx,dy+dl,dz];
  quadTowards(positions, WA, WB, UB, UA, [0,-1,0]);
  quadTowards(positions, WB, WC, UC, UB, [1,0,0]);
  quadTowards(positions, WC, WD, UD, UC, [0,1,0]);
  quadTowards(positions, WD, WA, UA, UD, [-1,0,0]);
  quadTowards(positions, UA, UB, UC, UD, [0,0,1]);

  return { positions };
}

// A cube and an elongated bar — the negative fixtures for the shell rule. Both are
// plain solid boxMesh() calls under a name that documents WHY each is used where it
// is: the cube is the false-positive case (perfectly consistent inward-ray readings
// across all six faces, which is exactly why the shell rule needs a size-relative
// gate and not just a consistency gate — see features/sweeps.js), and the bar is the
// large-spread case (three very different pair distances) the old plane-pairing
// approach already handled and the new raycast approach must keep handling.
export const cubeMesh = (s) => boxMesh(s, s, s);
export const barMesh = (sx, sy, sz) => boxMesh(sx, sy, sz);

// Applies an arbitrary rotation (Euler angles in radians, X then Y then Z) to
// a mesh's flat `positions` array. Exists because EVERY fixture above is
// axis-aligned and origin-centred, which is not incidental to a real bug this
// module's own tests once missed entirely: a coplanar quad diagonal's
// dihedral computes to bit-exact `0.0` only when the mesh happens to be
// axis-aligned (a lucky cancellation in the underlying cross/dot/atan2
// chain); rotate the identical, still-perfectly-flat geometry and the same
// diagonal comes out as noise like `-9.4e-17` — a real zero with the wrong
// bit pattern. Code in `segment.js` that tested `dihedral === 0` passed every
// axis-aligned fixture in this file while being completely broken for any
// rotated (i.e. almost every REAL) part. `rotateMesh` lets the segmentation
// suite prove recovery does not depend on axis alignment, by running the same
// fixtures through an arbitrary, deliberately unremarkable rotation.
export function rotateMesh({ positions }, [rx, ry, rz]) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i+1], z = positions[i+2];
    const y1 = y*cx - z*sx, z1 = y*sx + z*cx;           // rotate about X
    const x2 = x*cy + z1*sy, z2 = -x*sy + z1*cy;         // rotate about Y
    const x3 = x2*cz - y1*sz, y3 = x2*sz + y1*cz;        // rotate about Z
    out[i] = x3; out[i+1] = y3; out[i+2] = z2;
  }
  return { positions: out };
}

