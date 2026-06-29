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
