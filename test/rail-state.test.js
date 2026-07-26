import { describe, expect, test } from "vitest";
import {
  RAIL_COLLAPSE_AT, RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH,
  RAIL_REOPEN_AT, RAIL_STORAGE_KEY,
  clampRailWidth, railMaxWidth, readRailPref, resolveRailDrag, writeRailPref,
} from "../src/framework/rail-state.js";

// A Storage stand-in. `throws` models private-mode / disabled storage, which
// must degrade to defaults rather than propagate (see view-state.js).
function fakeStorage({ initial = null, throws = false } = {}) {
  let value = initial;
  return {
    getItem() { if (throws) throw new Error("denied"); return value; },
    setItem(_k, v) { if (throws) throw new Error("denied"); value = v; },
    read: () => value,
  };
}

const WIDE = 1600; // shell wide enough that RAIL_MAX_WIDTH, not shellWidth/2, is the cap

describe("railMaxWidth", () => {
  test("caps at RAIL_MAX_WIDTH on a wide shell", () => {
    expect(railMaxWidth(WIDE)).toBe(RAIL_MAX_WIDTH);
  });
  test("gives the rail at most half a narrow shell", () => {
    expect(railMaxWidth(900)).toBe(450);
  });
  test("never returns less than RAIL_MIN_WIDTH, so max >= min always holds", () => {
    expect(railMaxWidth(300)).toBe(RAIL_MIN_WIDTH);
    expect(railMaxWidth(0)).toBe(RAIL_MIN_WIDTH);
  });
  test("falls back to RAIL_MAX_WIDTH for a non-finite measurement", () => {
    expect(railMaxWidth(NaN)).toBe(RAIL_MAX_WIDTH);
    expect(railMaxWidth(undefined)).toBe(RAIL_MAX_WIDTH);
  });
});

describe("clampRailWidth", () => {
  test("passes an in-range width through, rounded", () => {
    expect(clampRailWidth(320.4, WIDE)).toBe(320);
  });
  test("floors at RAIL_MIN_WIDTH", () => {
    expect(clampRailWidth(10, WIDE)).toBe(RAIL_MIN_WIDTH);
  });
  test("ceilings at RAIL_MAX_WIDTH", () => {
    expect(clampRailWidth(9000, WIDE)).toBe(RAIL_MAX_WIDTH);
  });
  test("ceilings at half the shell when that is smaller", () => {
    expect(clampRailWidth(9000, 900)).toBe(450);
  });
  test("falls back to the default for a non-finite width", () => {
    expect(clampRailWidth(NaN, WIDE)).toBe(RAIL_DEFAULT_WIDTH);
  });
});

describe("resolveRailDrag", () => {
  const open = { width: 400, collapsed: false };
  const shut = { width: 400, collapsed: true };

  // One case per cell of spec §4.3's snap table.
  test("open: below the collapse threshold snaps shut, keeping the last width", () => {
    expect(resolveRailDrag(RAIL_COLLAPSE_AT - 1, open, WIDE)).toEqual({ width: 400, collapsed: true });
  });
  test("open: inside the hysteresis band it resists at the minimum", () => {
    expect(resolveRailDrag(RAIL_COLLAPSE_AT + 1, open, WIDE)).toEqual({ width: RAIL_MIN_WIDTH, collapsed: false });
    expect(resolveRailDrag(RAIL_REOPEN_AT + 1, open, WIDE)).toEqual({ width: RAIL_MIN_WIDTH, collapsed: false });
  });
  test("open: at or above the minimum it follows the pointer", () => {
    expect(resolveRailDrag(340, open, WIDE)).toEqual({ width: 340, collapsed: false });
  });
  test("collapsed: stays shut until the far threshold", () => {
    expect(resolveRailDrag(RAIL_COLLAPSE_AT - 1, shut, WIDE)).toBe(shut);
    expect(resolveRailDrag(RAIL_REOPEN_AT - 1, shut, WIDE)).toBe(shut);
  });
  test("collapsed: reopens at the minimum once past the far threshold", () => {
    expect(resolveRailDrag(RAIL_REOPEN_AT, shut, WIDE)).toEqual({ width: RAIL_MIN_WIDTH, collapsed: false });
  });
  test("collapsed: reopens and follows the pointer above the minimum", () => {
    expect(resolveRailDrag(400, shut, WIDE)).toEqual({ width: 400, collapsed: false });
  });

  // The hysteresis exists so a shaky hand can't flap the rail. Travelling in
  // through the band must not reopen, and travelling out must not re-collapse.
  test("the band is directional: 170px stays shut coming from shut, stays open coming from open", () => {
    const mid = (RAIL_COLLAPSE_AT + RAIL_REOPEN_AT) / 2;
    expect(resolveRailDrag(mid, shut, WIDE).collapsed).toBe(true);
    expect(resolveRailDrag(mid, open, WIDE).collapsed).toBe(false);
  });
});

describe("readRailPref", () => {
  test("defaults when storage is empty", () => {
    expect(readRailPref(fakeStorage(), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("defaults when storage throws", () => {
    expect(readRailPref(fakeStorage({ throws: true }), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("defaults on corrupt JSON", () => {
    expect(readRailPref(fakeStorage({ initial: "{not json" }), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("defaults on a non-object payload", () => {
    expect(readRailPref(fakeStorage({ initial: "42" }), WIDE)).toEqual({ width: RAIL_DEFAULT_WIDTH, collapsed: false });
  });
  test("round-trips a stored value", () => {
    const storage = fakeStorage({ initial: JSON.stringify({ width: 400, collapsed: true }) });
    expect(readRailPref(storage, WIDE)).toEqual({ width: 400, collapsed: true });
  });
  test("re-clamps a width saved on a wider monitor", () => {
    const storage = fakeStorage({ initial: JSON.stringify({ width: 540, collapsed: false }) });
    expect(readRailPref(storage, 900)).toEqual({ width: 450, collapsed: false });
  });
  test("treats a non-boolean collapsed as open", () => {
    const storage = fakeStorage({ initial: JSON.stringify({ width: 300, collapsed: "yes" }) });
    expect(readRailPref(storage, WIDE).collapsed).toBe(false);
  });
});

describe("writeRailPref", () => {
  test("writes width and collapsed under the partforge-namespaced key", () => {
    const storage = fakeStorage();
    writeRailPref({ width: 320, collapsed: false }, storage);
    expect(JSON.parse(storage.read())).toEqual({ width: 320, collapsed: false });
    expect(RAIL_STORAGE_KEY).toBe("partforge:rail");
  });
  test("is a no-op when storage throws", () => {
    expect(() => writeRailPref({ width: 320, collapsed: false }, fakeStorage({ throws: true }))).not.toThrow();
  });
});
