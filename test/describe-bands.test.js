// Bevel bands: a chamfer (or drafted cut) swept along a CURVED profile tessellates
// into dozens of tiny planar fragments, one per facet — all sharing a constant slope
// against one axis while their azimuth follows the curve. Before this detector those
// fragments read as a pile of junk chamfers/bosses/pockets (a real box-opener STL
// reported 48 bosses + 40 pockets for one beveled blade edge) and blew the acceptance
// budget so even the base extrusion went unreconstructed. detectBands groups such a
// chain into ONE `bevel` feature carrying the swept profile polyline, the bevel angle,
// and the profile plane — the description an agent can actually rebuild from.
//
// Fixtures are exact and kernel-built, and the orientation regression uses the same
// 29°-about-an-oblique-axis sweep every describe regression here uses, because it is
// the one that has actually caught bugs.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { describe as describeMesh } from "../src/framework/oracle/describe.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// A rounded-rectangle footprint — the corner arcs are what force the chamfer band to
// fragment (each tessellation facet fits its own tiny plane at the same 45° slope).
function roundedRect(w, d, r, n = 10) {
  const pts = [];
  const corners = [
    [w / 2 - r, d / 2 - r, 0], [-(w / 2 - r), d / 2 - r, Math.PI / 2],
    [-(w / 2 - r), -(d / 2 - r), Math.PI], [w / 2 - r, -(d / 2 - r), 3 * Math.PI / 2],
  ];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * (Math.PI / 2);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

const beveledPlate = () =>
  k.extrude({ profile: { outer: roundedRect(60, 40, 10) }, h: 8 })
    .chamfer({ d: 3, edges: { inPlane: "XY", at: 8 } });

test("a chamfer swept around a rounded outline reads as ONE bevel feature", () => {
  const r = describeMesh(k, beveledPlate(), { digest: "band-plate" });
  expect(r.error).toBeUndefined();
  const bevels = r.features.filter((f) => f.type === "bevel");
  expect(bevels.length).toBe(1);
  const [b] = bevels;
  // The cut faces sit at 45° to the profile plane, whose normal is the extrude axis.
  expect(Math.abs(b.angleDeg - 45)).toBeLessThan(3);
  expect(Math.abs(Math.abs(b.axis[2]) - 1)).toBeLessThan(0.01);
  // The swept profile is a real polyline an agent can rebuild from, not a point count.
  expect(b.profile.kind).toBe("polyline");
  expect(b.profile.points.length).toBeGreaterThanOrEqual(8);
  expect(b.profile.points.length).toBeLessThanOrEqual(48);
  // A 3mm chamfer's slant width is 3·√2 ≈ 4.24mm.
  expect(Math.abs(b.width - 3 * Math.SQRT2)).toBeLessThan(1);
  // The band spans the chamfered zone along the axis: z from 5 to 8.
  expect(Math.abs(b.span[0] - 5)).toBeLessThan(0.5);
  expect(Math.abs(b.span[1] - 8)).toBeLessThan(0.5);
});

test("the band claims its fragments — no junk features remain on bevel-slope surfaces", () => {
  const r = describeMesh(k, beveledPlate(), { digest: "band-plate2" });
  // Without banding this solid's chamfer ring reported as a pile of per-facet
  // chamfer features. Any surviving chamfer must stand on a surface OUTSIDE the
  // band's slope class (the rounded corners' vertical wall facets also misread as
  // chamfers, but that is the θ≈90° wall-fragmentation gap, out of this rule's
  // scope — those normals have |nz| ≈ 0).
  const surfById = new Map(r.surfaces.map((s) => [s.id, s]));
  for (const f of r.features.filter((x) => x.type === "chamfer")) {
    const nz = Math.abs(surfById.get(f.surfaces[0])?.fit?.normal?.[2] ?? 0);
    expect(nz).toBeLessThan(0.5);
  }
  expect(r.features.filter((f) => f.type === "boss" || f.type === "pocket").length).toBe(0);
  // The base extrusion still reconstructs — banding must not eat the part itself.
  expect(r.features.some((f) => f.type === "extrusion")).toBe(true);
  expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.6);
});

// The blade analogue: a constant-45° cut through the plate's ENTIRE thickness,
// swept along a curved profile — built exactly, as a loft between the profile and
// its own normal offset (offset 5 over rise 5 = 45° everywhere along the curve).
// This is the geometry the motivating box-opener STL carries as its blade, and the
// distinction the report must state: `throughCut: true`, where an edge chamfer says
// false.
function bladePlate() {
  const N = 24, W = 60, D = 30, H = 5, DIP = 9;
  const arc = [];
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * W;
    arc.push([x, -DIP * Math.sin(Math.PI * x / W)]);
  }
  const bottom = [...arc, [W, D], [0, D]];
  // Offset the arc points outward along their own miter normals by H.
  const top = bottom.map((p, idx) => {
    if (idx > N) return p;
    const prev = arc[Math.max(0, idx - 1)], next = arc[Math.min(N, idx + 1)];
    const t = [next[0] - prev[0], next[1] - prev[1]];
    const len = Math.hypot(t[0], t[1]) || 1;
    const n = [t[1] / len, -t[0] / len]; // outward: -y side for a CCW outline
    return [p[0] + n[0] * H, p[1] + n[1] * H];
  });
  return k.loft({ rings: [{ polygon: bottom, z: 0 }, { polygon: top, z: H }] });
}

test("a full-thickness profile cut reads as a bevel with throughCut: true", () => {
  const r = describeMesh(k, bladePlate(), { digest: "band-blade" });
  expect(r.error).toBeUndefined();
  const through = r.features.filter((f) => f.type === "bevel" && f.throughCut);
  expect(through.length).toBe(1);
  const [b] = through;
  expect(Math.abs(b.angleDeg - 45)).toBeLessThan(4);
  // The cut runs the plate's whole thickness: rise 5 at 45° is a ~7.07mm face.
  expect(Math.abs(b.width - 5 * Math.SQRT2)).toBeLessThan(1);
  expect(b.profile.points.length).toBeGreaterThanOrEqual(6);
});

test("the edge chamfer's band, by contrast, says throughCut: false", () => {
  const r = describeMesh(k, beveledPlate(), { digest: "band-plate3" });
  const bevels = r.features.filter((f) => f.type === "bevel");
  expect(bevels.length).toBe(1);
  expect(bevels[0].throughCut).toBe(false);
});

test("the rotated plate reports the same bevel", () => {
  const axis = [1, 2, 3].map((v) => v / Math.hypot(1, 2, 3));
  const solid = beveledPlate().rotate(29, [0, 0, 0], axis);
  const r = describeMesh(k, solid, { digest: "band-plate-rot" });
  const bevels = r.features.filter((f) => f.type === "bevel");
  expect(bevels.length).toBe(1);
  expect(Math.abs(bevels[0].angleDeg - 45)).toBeLessThan(3);
});

test("a box's straight base chamfer ring stays four chamfers, not a band", () => {
  // Sharp 90° azimuth jumps at the corners are exactly what separates "four straight
  // chamfers" from "one bevel swept along a smooth profile" — the seam-turn gate.
  const solid = k.box({ size: [40, 30, 10] }).chamfer({ d: 2, edges: { inPlane: "XY", at: 0 } });
  const r = describeMesh(k, solid, { digest: "band-boxch" });
  expect(r.features.filter((f) => f.type === "bevel").length).toBe(0);
  expect(r.features.filter((f) => f.type === "chamfer").length).toBe(4);
});

test("a plain extrusion has no bevel bands", () => {
  const r = describeMesh(k, k.extrude({ profile: { outer: roundedRect(60, 40, 10) }, h: 8 }), { digest: "band-none" });
  expect(r.features.filter((f) => f.type === "bevel").length).toBe(0);
});
