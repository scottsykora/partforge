import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { addSugar } from "../src/framework/geometry/solid-sugar.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

// an asymmetric box, so bbox reveals orientation AND position
const box = () => k.box([0, 0, 0], [2, 4, 6]);
const sameGeom = (a, b) => {
  expect(a.volume()).toBeCloseTo(b.volume(), 6);
  const ba = a.boundingBox(), bb = b.boundingBox();
  for (let i = 0; i < 3; i++) {
    expect(ba.min[i]).toBeCloseTo(bb.min[i], 4);
    expect(ba.max[i]).toBeCloseTo(bb.max[i], 4);
  }
};

test("rotateX/Y/Z equal rotate about the world axis through origin", () => {
  sameGeom(addSugar(box()).rotateX(37), box().rotate(37, [0, 0, 0], [1, 0, 0]));
  sameGeom(addSugar(box()).rotateY(37), box().rotate(37, [0, 0, 0], [0, 1, 0]));
  sameGeom(addSugar(box()).rotateZ(37), box().rotate(37, [0, 0, 0], [0, 0, 1]));
});

test("rotateAbout maps a named axis + through-point (and a raw vector axis) to rotate", () => {
  sameGeom(addSugar(box()).rotateAbout({ axis: "Z", deg: 25, through: [5, 0, 0] }), box().rotate(25, [5, 0, 0], [0, 0, 1]));
  sameGeom(addSugar(box()).rotateAbout({ axis: [0, 1, 0], deg: 25 }), box().rotate(25, [0, 0, 0], [0, 1, 0]));
});

test("rotateAbout throws on an unknown axis", () => {
  expect(() => addSugar(box()).rotateAbout({ axis: "Q", deg: 10 })).toThrow();
});

test("along orients +Z to each direction, matching the mapped rotation", () => {
  const map = { "+Z": null, "-Z": [180, [1, 0, 0]], "+Y": [-90, [1, 0, 0]], "-Y": [90, [1, 0, 0]], "+X": [90, [0, 1, 0]], "-X": [-90, [0, 1, 0]] };
  for (const [dir, r] of Object.entries(map)) {
    const got = addSugar(box()).along(dir);
    const want = r ? box().rotate(r[0], [0, 0, 0], r[1]) : box();
    sameGeom(got, want);
  }
});

test("along throws on an unknown direction", () => {
  expect(() => addSugar(box()).along("up")).toThrow();
});

test("at equals translate", () => {
  sameGeom(addSugar(box()).at([3, -2, 7]), box().translate([3, -2, 7]));
});

test("kernel solids come pre-sugared (manifold) and along works end to end", () => {
  const s = k.box([0, 0, 0], [2, 4, 6]);
  expect(typeof s.along).toBe("function");
  sameGeom(s.along("+Y"), k.box([0, 0, 0], [2, 4, 6]).rotate(-90, [0, 0, 0], [1, 0, 0]));
});

test("sugar survives chaining (every returned solid is sugared)", () => {
  const s = k.box([0, 0, 0], [2, 4, 6]).rotateZ(10).at([1, 2, 3]);
  expect(typeof s.rotateX).toBe("function");
});

test("a feature built with the vocabulary equals the raw-primitive build", () => {
  const viaVocab = k.box([0, 0, 0], [20, 20, 10]).cutAll([
    k.cylinder(2, 2, 30).along("+Y").at([10, -5, 5]),   // cross bore along Y
    k.cylinder(1.5, 1.5, 12).at([5, 5, -1]),            // vertical hole
    k.cylinder(1.5, 1.5, 12).at([15, 15, -1]),
  ]);
  let viaRaw = k.box([0, 0, 0], [20, 20, 10]);
  viaRaw = viaRaw.cut(k.cylinder(2, 2, 30).rotate(-90, [0, 0, 0], [1, 0, 0]).translate([10, -5, 5]));
  viaRaw = viaRaw.cut(k.cylinder(1.5, 1.5, 12).translate([5, 5, -1]));
  viaRaw = viaRaw.cut(k.cylinder(1.5, 1.5, 12).translate([15, 15, -1]));
  sameGeom(viaVocab, viaRaw);
});

test('along("+Z") returns a fresh handle with identity geometry', () => {
  const s = k.box([0, 0, 0], [2, 4, 6]);
  const r = s.along("+Z");
  expect(r).not.toBe(s);
  sameGeom(r, k.box([0, 0, 0], [2, 4, 6]));
});

test("sugar methods are shared across solids (no per-solid closures)", () => {
  expect(k.box([0,0,0],[1,1,1]).rotateX).toBe(k.box([0,0,0],[2,2,2]).rotateX);
});

test("rotateAbout does a TRUE axis-angle rotation for a non-basis axis (matches analytic ground truth)", () => {
  const r = k.box([0, 0, 0], [2, 4, 6]).rotateAbout({ axis: [1, 1, 0], deg: 90 });
  const b = r.boundingBox();
  expect(b.min[0]).toBeCloseTo(0, 3);      expect(b.max[0]).toBeCloseTo(7.2426, 3);
  expect(b.min[1]).toBeCloseTo(-4.2426, 3); expect(b.max[1]).toBeCloseTo(3, 3);
  expect(b.min[2]).toBeCloseTo(-1.4142, 3); expect(b.max[2]).toBeCloseTo(2.8284, 3);
});

test("basis-axis rotateAbout is unchanged (still equals the euler path)", () => {
  sameGeom(k.box([0,0,0],[2,4,6]).rotateAbout({ axis: "Z", deg: 30 }),
           k.box([0,0,0],[2,4,6]).rotate(30, [0,0,0], [0,0,1]));
});
