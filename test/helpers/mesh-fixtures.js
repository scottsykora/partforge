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

