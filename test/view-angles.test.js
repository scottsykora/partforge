import { describe, it, expect } from "vitest";
import { CANONICAL_VIEWS, cameraPoseForView } from "../src/framework/view-angles.js";

describe("cameraPoseForView", () => {
  const bounds = { center: [0, 0, 0], radius: 10 };

  it("lists the 7 canonical views", () => {
    expect(CANONICAL_VIEWS).toEqual(["iso", "front", "back", "top", "bottom", "left", "right"]);
  });

  it("places the top camera above the part looking down", () => {
    const pose = cameraPoseForView("top", bounds);
    expect(pose.position[1]).toBeGreaterThan(0); // above in three.js Y-up
    expect(pose.target).toEqual([0, 0, 0]);
  });

  it("frames the camera outside the bounding radius", () => {
    const pose = cameraPoseForView("front", bounds);
    const dist = Math.hypot(...pose.position.map((v, i) => v - bounds.center[i]));
    expect(dist).toBeGreaterThan(bounds.radius);
  });

  it("throws on an unknown view", () => {
    expect(() => cameraPoseForView("nope", bounds)).toThrow();
  });
});
