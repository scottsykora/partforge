import { expect, test } from "vitest";
import { buildBVH } from "../src/testing/bvh.js";

// a unit-ish box [0,0,0]..[10,20,5] as a non-indexed triangle soup (12 tris)
function boxMesh(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const quads = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
  const pos = [];
  for (const [a,b,c,d] of quads) { for (const i of [a,b,c, a,c,d]) pos.push(...v[i]); }
  return { positions: pos };
}

test("raycast hits the near face and returns its distance", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]); // from below, up through z
  expect(hit).not.toBeNull();
  expect(hit.t).toBeCloseTo(3, 5);                  // z=0 face is 3 away
});

test("raycast returns the NEAREST hit, not a far one", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]);
  expect(hit.t).toBeCloseTo(3, 5);                  // not 8 (the z=5 face)
});

test("skipTri ignores the source triangle (nearest becomes the far face)", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const first = bvh.raycast([4.9, 10, -3], [0, 0, 1]);
  const second = bvh.raycast([4.9, 10, -3], [0, 0, 1], { skipTri: first.tri });
  expect(second.t).toBeCloseTo(8, 5);               // z=5 face
});

test("a ray that misses returns null", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  expect(bvh.raycast([100, 100, -3], [0, 0, 1])).toBeNull();
});

test("closestPoint on a box face returns the perpendicular foot + distance", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const r = bvh.closestPoint([5, 10, 9]);   // 4 above the z=5 top face
  expect(r.dist).toBeCloseTo(4, 5);
  expect(r.point[2]).toBeCloseTo(5, 5);
});

test("closestPoint matches a brute-force reference on the box", () => {
  const mesh = boxMesh(10, 20, 5);
  const bvh = buildBVH(mesh);
  const pts = [[-3, -3, -3], [5, 25, 2], [12, 10, 8], [5, 10, 2.5]];
  const brute = (p) => {
    let best = Infinity;
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      const o = t * 9;
      const A = [mesh.positions[o], mesh.positions[o+1], mesh.positions[o+2]];
      const B = [mesh.positions[o+3], mesh.positions[o+4], mesh.positions[o+5]];
      const C = [mesh.positions[o+6], mesh.positions[o+7], mesh.positions[o+8]];
      best = Math.min(best, Math.sqrt(distSqPointTriRef(p, A, B, C)));
    }
    return best;
  };
  for (const p of pts) expect(bvh.closestPoint(p).dist).toBeCloseTo(brute(p), 4);
});

// reference closest-point-on-triangle (Ericson) for the brute-force check
function distSqPointTriRef(P, A, B, C) {
  const sub = (p, q) => [p[0]-q[0], p[1]-q[1], p[2]-q[2]];
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2];
  const add = (p, q) => [p[0]+q[0], p[1]+q[1], p[2]+q[2]];
  const mul = (p, s) => [p[0]*s, p[1]*s, p[2]*s];
  const ab = sub(B,A), ac = sub(C,A), ap = sub(P,A);
  const d1 = dot(ab,ap), d2 = dot(ac,ap); if (d1<=0&&d2<=0) return dot(ap,ap);
  const bp = sub(P,B), d3 = dot(ab,bp), d4 = dot(ac,bp); if (d3>=0&&d4<=d3) return dot(bp,bp);
  const vc = d1*d4 - d3*d2; if (vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);const q=add(A,mul(ab,v));const pq=sub(P,q);return dot(pq,pq);}
  const cp = sub(P,C), d5 = dot(ab,cp), d6 = dot(ac,cp); if (d6>=0&&d5<=d6) return dot(cp,cp);
  const vb = d5*d2 - d1*d6; if (vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);const q=add(A,mul(ac,w));const pq=sub(P,q);return dot(pq,pq);}
  const va = d3*d6 - d5*d4; if (va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));const q=add(B,mul(sub(C,B),w));const pq=sub(P,q);return dot(pq,pq);}
  const denom=1/(va+vb+vc); const v=vb*denom, w=vc*denom; const q=add(add(A,mul(ab,v)),mul(ac,w)); const pq=sub(P,q); return dot(pq,pq);
}
