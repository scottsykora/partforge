// Pin store: per-view, keyed (subPart, featureLabel, occurrence), toggle semantics.
import { expect, test } from "vitest";
import { createPinStore, occurrenceOf } from "../../../src/framework/measure/pins.js";

const key = (subPart, featureLabel = null, occurrence = 0) => ({ subPart, featureLabel, occurrence });

test("toggle adds then removes", () => {
  const pins = createPinStore();
  expect(pins.toggle("main", key("body", "bore"))).toBe(true);
  expect(pins.has("main", key("body", "bore"))).toBe(true);
  expect(pins.count("main")).toBe(1);
  expect(pins.toggle("main", key("body", "bore"))).toBe(false);
  expect(pins.count("main")).toBe(0);
});

test("pins are per-view", () => {
  const pins = createPinStore();
  pins.toggle("main", key("body", "bore"));
  expect(pins.count("exploded")).toBe(0);
  expect(pins.list("main")).toEqual([key("body", "bore")]);
});

test("null label (sub-part bbox pin) and occurrence disambiguate", () => {
  const pins = createPinStore();
  pins.toggle("main", key("body"));
  pins.toggle("main", key("body", "hole", 0));
  pins.toggle("main", key("body", "hole", 1));
  expect(pins.count("main")).toBe(3);
  pins.clear("main");
  expect(pins.count("main")).toBe(0);
});

test("occurrenceOf counts same-label features before this id", () => {
  // features table: id N is features[N-1]
  expect(occurrenceOf(["hole", "hole", "slot", "hole"], 1)).toBe(0);
  expect(occurrenceOf(["hole", "hole", "slot", "hole"], 2)).toBe(1);
  expect(occurrenceOf(["hole", "hole", "slot", "hole"], 4)).toBe(2);
  expect(occurrenceOf(["hole", "slot"], 2)).toBe(0);
});
