// Assertion mini-DSL: parse a declared expectation into a normalized predicate.
// Numeric values are normalized to base units (mm for length, mm³ for volume) at
// parse time so the evaluator compares plain numbers. Strict: any unrecognized form
// throws an Error naming the offending string.

const UNIT = { mm: 1, cm: 10, mm3: 1, cm3: 1000 };

function toBase(numStr, unit) {
  const n = Number(numStr);
  if (!Number.isFinite(n)) throw new Error(`assertion: not a number: "${numStr}"`);
  if (unit === undefined) return n;
  if (!(unit in UNIT)) throw new Error(`assertion: unknown unit: "${unit}"`);
  return n * UNIT[unit];
}

const NUM = "[-+]?[0-9]*\\.?[0-9]+";
const U = "(mm3|cm3|mm|cm)?";
const reScalar = new RegExp(`^(>=|<=|>|<)?\\s*(${NUM})\\s*${U}$`);
const reRange = new RegExp(`^(${NUM})\\s*\\.\\.\\s*(${NUM})\\s*${U}$`);
const reVec = /^(>=|<=)\s*\[\s*(.+?)\s*\]$/;

export function parseAssertion(expr) {
  if (typeof expr === "number" || typeof expr === "boolean") return { op: "eq", value: expr };
  if (typeof expr !== "string") throw new Error(`assertion: unsupported value ${JSON.stringify(expr)}`);
  const s = expr.trim();

  const vec = s.match(reVec);
  if (vec) {
    const parts = vec[2].split(",").map((t) => t.trim());
    if (parts.length !== 3) throw new Error(`assertion: vector needs 3 components: "${expr}"`);
    return { op: vec[1] === "<=" ? "vle" : "vge", vec: parts.map((t) => (t === "*" ? null : toBase(t, undefined))) };
  }
  const range = s.match(reRange);
  if (range) return { op: "range", min: toBase(range[1], range[3] || undefined), max: toBase(range[2], range[3] || undefined) };

  const sc = s.match(reScalar);
  if (sc) {
    const op = sc[1] ? { ">=": "gte", "<=": "lte", ">": "gt", "<": "lt" }[sc[1]] : "eq";
    return { op, value: toBase(sc[2], sc[3] || undefined) };
  }
  throw new Error(`assertion: unrecognized form: "${expr}"`);
}
