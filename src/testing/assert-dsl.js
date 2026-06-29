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

const EPS = 1e-6;
const approxEq = (a, b) => Math.abs(a - b) <= EPS + EPS * Math.abs(b);
const fmtVec = (v) => "[" + v.map((x) => (x === null ? "*" : x)).join(",") + "]";

export function evaluateAssertion(parsed, actual) {
  switch (parsed.op) {
    case "eq": {
      const pass = typeof parsed.value === "boolean" ? actual === parsed.value : approxEq(actual, parsed.value);
      return { pass, message: `${actual} ${pass ? "==" : "!="} ${parsed.value}` };
    }
    case "gte": return mk(actual >= parsed.value - EPS, actual, ">=", parsed.value);
    case "lte": return mk(actual <= parsed.value + EPS, actual, "<=", parsed.value);
    case "gt": return mk(actual > parsed.value, actual, ">", parsed.value);
    case "lt": return mk(actual < parsed.value, actual, "<", parsed.value);
    case "range": {
      const pass = actual >= parsed.min - EPS && actual <= parsed.max + EPS;
      return { pass, message: `${actual} ${pass ? "in" : "out of"} ${parsed.min}..${parsed.max}` };
    }
    case "vle":
    case "vge": {
      const ge = parsed.op === "vge";
      let pass = true;
      for (let i = 0; i < 3; i++) {
        const lim = parsed.vec[i];
        if (lim === null) continue;
        if (ge ? actual[i] < lim - EPS : actual[i] > lim + EPS) pass = false;
      }
      return { pass, message: `${fmtVec(actual)} ${ge ? ">=" : "<="} ${fmtVec(parsed.vec)}` };
    }
    default: throw new Error(`assertion: unknown op "${parsed.op}"`);
  }
}

function mk(pass, actual, opStr, value) {
  return { pass, message: `${actual} ${pass ? opStr : "not " + opStr} ${value}` };
}
