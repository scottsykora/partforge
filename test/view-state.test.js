import { afterEach, beforeEach, expect, test } from "vitest";
import {
  loadRotating, saveRotating, loadCamera, saveCamera, loadView, saveView,
  loadTheme, saveTheme,
} from "../src/framework/view-state.js";

function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

beforeEach(() => { globalThis.localStorage = mockStorage(); });
afterEach(() => { delete globalThis.localStorage; });

test("rotating round-trips true/false; defaults to true when absent", () => {
  expect(loadRotating()).toBe(true);     // absent → default true
  saveRotating(false);
  expect(loadRotating()).toBe(false);
  saveRotating(true);
  expect(loadRotating()).toBe(true);
});

test("camera round-trips pos/target; null when absent", () => {
  expect(loadCamera()).toBeNull();
  saveCamera({ pos: [1, 2, 3], target: [4, 5, 6] });
  expect(loadCamera()).toEqual({ pos: [1, 2, 3], target: [4, 5, 6] });
});

test("view round-trips a name; null when absent", () => {
  expect(loadView()).toBeNull();
  saveView("assembly");
  expect(loadView()).toBe("assembly");
});

test("theme round-trips light/dark; defaults to dark when absent", () => {
  expect(loadTheme()).toBe("dark");      // absent → default dark
  saveTheme("light");
  expect(loadTheme()).toBe("light");
  saveTheme("dark");
  expect(loadTheme()).toBe("dark");
});

test("corrupt stored theme → loadTheme returns the dark default", () => {
  globalThis.localStorage.setItem("partforge:theme", "neon");
  expect(loadTheme()).toBe("dark");
});

test("corrupt camera JSON → loadCamera returns null", () => {
  globalThis.localStorage.setItem("partforge:camera", "{not json");
  expect(loadCamera()).toBeNull();
});

test("non-finite camera value → loadCamera returns null", () => {
  globalThis.localStorage.setItem("partforge:camera", '{"pos":[1,2,null],"target":[0,0,0]}');
  expect(loadCamera()).toBeNull();
});

test("saveCamera skips invalid input (no write, no throw)", () => {
  saveCamera({ pos: [1, 2, 3] });        // missing target
  expect(loadCamera()).toBeNull();
  saveCamera({ pos: [1, 2], target: [0, 0, 0] }); // wrong length
  expect(loadCamera()).toBeNull();
});

test("storage that throws → loads return defaults, saves are no-ops", () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  expect(loadRotating()).toBe(true);
  expect(loadCamera()).toBeNull();
  expect(loadView()).toBeNull();
  expect(loadTheme()).toBe("dark");
  expect(() => {
    saveRotating(false);
    saveCamera({ pos: [1, 2, 3], target: [0, 0, 0] });
    saveView("x");
    saveTheme("light");
  }).not.toThrow();
});
