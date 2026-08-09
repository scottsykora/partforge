// The DOM half of the widget registry. Its keys must match widget-specs.js
// exactly — test/framework/panel/registry.test.js proves they do.
import { makeNumeric } from "./numeric.js";
import { makeText } from "./text.js";
import { makeCheckbox } from "./checkbox.js";
import { makeSelect, makeRadio } from "./select.js";

export const WIDGET_FACTORIES = {
  slider: makeNumeric,
  number: makeNumeric,
  text: makeText,
  textarea: makeText,
  checkbox: makeCheckbox,
  select: makeSelect,
  radio: makeRadio,
};
