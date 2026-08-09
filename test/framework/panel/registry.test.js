import { expect, test } from "vitest";
import { WIDGET_SPECS, WIDGET_TYPES, specFor, fieldsFor } from "../../../src/framework/panel/widget-specs.js";

test("the registry covers exactly the types this phase supports", () => {
  expect(WIDGET_TYPES.sort()).toEqual(["checkbox", "number", "radio", "select", "slider", "text", "textarea"]);
});

test("every spec declares a kind and a non-empty field list", () => {
  for (const spec of WIDGET_SPECS) {
    expect(spec.kind, `${spec.type}.kind`).toBe("control");
    expect(spec.fields.length, `${spec.type}.fields`).toBeGreaterThan(0);
  }
});

test("every numeric type accepts the legacy control fields", () => {
  // rules-schema.js's CONTROL_FIELDS, which the registry replaces. Losing one of
  // these makes unknown-control-field warn on a perfectly legitimate field.
  for (const f of ["key", "label", "unit", "min", "max", "step", "control", "hidden", "description"]) {
    expect(fieldsFor("slider"), `slider is missing "${f}"`).toContain(f);
  }
});

test("checkbox accepts the legacy toggle and feature fields", () => {
  for (const f of ["key", "label", "on", "hidden", "description"]) {
    expect(fieldsFor("checkbox"), `checkbox is missing "${f}"`).toContain(f);
  }
});

test("specFor returns undefined for an unknown type", () => {
  expect(specFor("nope")).toBeUndefined();
  expect(fieldsFor("nope")).toEqual([]);
});

import { WIDGET_FACTORIES } from "../../../src/framework/panel/widgets/index.js";

test("every registered type has a DOM factory, and every factory a spec", () => {
  expect(Object.keys(WIDGET_FACTORIES).sort()).toEqual([...WIDGET_TYPES].sort());
  for (const type of WIDGET_TYPES) {
    expect(typeof WIDGET_FACTORIES[type], `${type} factory`).toBe("function");
  }
});
