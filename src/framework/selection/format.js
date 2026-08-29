// Pure serializer. No three.js, no DOM. Three styles for the same Selection:
//   token  — compact clipboard/CLI line
//   json   — the structured object (embedded tool-call transport)
//   prompt — one natural-language sentence an LLM ingests well
const AXIS_LABEL = { "1,0,0": "+X", "-1,0,0": "-X", "0,1,0": "+Y", "0,-1,0": "-Y", "0,0,1": "+Z", "0,0,-1": "-Z" };

const fmtNormal = (n) => AXIS_LABEL[n.join(",")] ?? n.join(",");
const fmtParams = (p) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(",");

function tokenStyle(s) {
  const head = `@${s.subPart}`;
  const feat = s.feature ? ` · ${s.feature.label}` : "";
  const cut = s.onCutPlane ? " · section" : "";
  return `${head}${feat}${cut} · pt(${s.point.join(",")}) n(${fmtNormal(s.normal)}) · {${fmtParams(s.params)}}`;
}

function promptStyle(s) {
  const params = Object.entries(s.params).map(([k, v]) => `${k}: ${v}`).join(", ");
  const feat = s.feature ? ` **${s.feature.label}**,` : "";
  // The section wording is load-bearing: without it the point reads as a spot
  // on the part's surface, when it is a spot inside the material that the
  // cutaway happens to have opened up.
  const cut = s.onCutPlane ? " the cutaway section face at" : "";
  return `On sub-part **${s.subPart}**, the user pointed at${feat}${cut} local point (${s.point.join(", ")}), `
    + `normal ${fmtNormal(s.normal)}, with params {${params}}.`;
}

export function formatSelection(selection, { style = "token" } = {}) {
  if (style === "json") return selection;
  if (style === "prompt") return promptStyle(selection);
  return tokenStyle(selection);
}
