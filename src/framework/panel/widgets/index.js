// The DOM half of the widget registry. Its keys must match widget-specs.js
// exactly — test/framework/panel/registry.test.js proves they do.
import { makeNumeric } from "./numeric.js";
import { makeText } from "./text.js";
import { makeCheckbox } from "./checkbox.js";
import { makeSelect, makeRadio } from "./select.js";
import { makeFont } from "./font.js";
// Side-effect import: font-picker.js calls setFontPicker() at module scope, so
// the font widget's button finds a picker to open. It lives HERE and not in
// font.js because the dependency has to run picker → widget and never back —
// font.js must stay importable (and testable) without dragging the whole
// DOM-heavy picker in. See the note at the bottom of font.js.
import "../font-picker.js";

export const WIDGET_FACTORIES = {
  slider: makeNumeric,
  number: makeNumeric,
  text: makeText,
  textarea: makeText,
  checkbox: makeCheckbox,
  select: makeSelect,
  radio: makeRadio,
  font: makeFont,
};
