// partforge/geometry — pure 2-D profile helpers and solid patterns.
//
// DOM-free and kernel-free: this is the entry a part's build functions import
// (importing "partforge" inside a worker throws `document is not defined`).

import type { ArcContour, Point2, Point3, PointsContour, Region2D, Solid } from "./kernel.js";

export type { ArcContour, Point2, Point3, PointsContour, Region2D, Solid };

/** A pie/sector wedge with its tip at the origin. */
export function piePolygon(tipR: number, arcDeg: number, segs?: number): PointsContour;

/** A regular hexagon of circumradius `r`. */
export function hexPolygon(r: number): PointsContour;

/** A `w` × `h` rectangle centred at the origin with corner radius `r`. */
export function roundedRectPolygon(w: number, h: number, r: number, segs?: number): PointsContour;

/** A regular `n`-gon of circumradius `r`; `flat: true` seats a flat side down. */
export function regularPolygon(n: number, r: number, opts?: { flat?: boolean }): PointsContour;

export function ellipsePolygon(rx: number, ry: number, segs?: number): PointsContour;

/** A stadium/slot; overall length is `length + 2r`. */
export function slotPolygon(length: number, r: number, segs?: number): PointsContour;

export function starPolygon(points: number, outerR: number, innerR: number): PointsContour;

/** An annular sector. `arcDeg` must be < 360 — a full ring is a contour-with-hole. */
export function ringSectorPolygon(innerR: number, outerR: number, arcDeg: number, segs?: number): PointsContour;

/**
 * A CCW circle of radius `r` centred at `center`, as a FACETED point list
 * (`segs` segments). For curve-exact corners use `roundedProfile`/`pathProfile`.
 */
export function circleProfile(r: number, center?: Point2, segs?: number): PointsContour;

/**
 * Per-corner rounding geometry shared by `filletPolygon` and `roundedProfile`:
 * the incoming/outgoing tangent points, the arc centre, the clamped radius, the
 * short sweep and its start angle — or `null` for a corner that stays sharp.
 */
export function cornerArc(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  r: number,
): { a: number[]; b: number[]; c: number[]; rr: number; dA: number; a0: number } | null;

/**
 * Round every corner of a CCW polygon, BAKING each arc into line facets — so
 * STEP corners are faceted. Use `roundedProfile` for true circular edges.
 */
export function filletPolygon(points: PointsContour, r: number, opts?: { segs?: number }): PointsContour;

/**
 * Round corners the same way as `filletPolygon` but keep them mathematically
 * TRUE — the arc is carried symbolically, so STEP export gets real circular
 * edges. A scalar `r` rounds every corner; a per-corner `r[]` (length = points)
 * rounds selectively. Accepted by `prism`/`extrude`, not yet by `loft`.
 */
export function roundedProfile(points: PointsContour, r: number | number[]): ArcContour;

/** The fluent builder `pathProfile` returns. `close()` snapshots the contour. */
export interface PathProfileBuilder {
  lineTo(to: Point2): PathProfileBuilder;
  /** A circular arc to `to` passing through `via`. */
  arcTo(to: Point2, via: Point2): PathProfileBuilder;
  /** A cubic Bézier to `to` with control points `c1`/`c2`. */
  cubicTo(to: Point2, c1: Point2, c2: Point2): PathProfileBuilder;
  /** Close the contour and return it. Needs at least one segment. */
  close(): ArcContour;
}

/**
 * A fluent builder for a curve-native path contour. Cubic segments become exact
 * B-rep spline edges on OCCT and facet at mesh LOD on Manifold.
 */
export function pathProfile(start: Point2): PathProfileBuilder;

/** Convex-corner style for `offsetPolygon`. */
export type OffsetCorners = "round" | "chamfer" | "sharp";

/**
 * Offset a point-list polygon or an `{ outer, holes }` region by `delta` mm —
 * positive grows material, negative insets (regions offset material-wise).
 * Simple polygon in, simple polygon out: an offset that would collapse or split
 * the contour THROWS. Pure, so it works in `derive()` as well as `build()`.
 */
export function offsetPolygon(
  profile: PointsContour,
  delta: number,
  opts?: { corners?: OffsetCorners; segs?: number },
): PointsContour;
export function offsetPolygon(
  profile: Region2D,
  delta: number,
  opts?: { corners?: OffsetCorners; segs?: number },
): Region2D;

/** `count` copies of `solid` translated by `i * step`. Feed to `k.union` / `s.cutAll`. */
export function linearPattern(solid: Solid, count: number, step: Point3): Solid[];

/**
 * `count` copies spaced `angle / count` degrees apart around `axis` through
 * `center`. `rotateCopies: false` keeps each copy's original orientation.
 */
export function circularPattern(
  solid: Solid,
  count: number,
  opts?: {
    center?: Point3;
    axis?: "X" | "Y" | "Z" | Point3;
    angle?: number;
    rotateCopies?: boolean;
  },
): Solid[];
