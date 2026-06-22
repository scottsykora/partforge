// Minimal 3MF writer. 3MF is an OPC package (a zip) holding an XML model; it's a
// mesh format like STL but supports units and multiple named objects in one file,
// so a multi-part view exports as a single .3mf. Built from indexed meshes.
import { zipSync, strToU8 } from "fflate";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
  "</Types>";

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
  "</Relationships>";

const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const r = (x) => +x.toFixed(4); // 0.1 µm precision — finer than any printer, much smaller XML

// parts: [{ name, positions: Float32Array (x,y,z per vertex), indices: Uint32Array (3 per triangle) }]
// → ArrayBuffer of the .3mf zip (millimetre units; one <object> + <build> item per part).
export function meshTo3MF(parts) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    "<resources>",
  ];
  parts.forEach((p, i) => {
    out.push(`<object id="${i + 1}" type="model" name="${xmlEsc(p.name)}"><mesh><vertices>`);
    const v = p.positions;
    for (let k = 0; k < v.length; k += 3) out.push(`<vertex x="${r(v[k])}" y="${r(v[k + 1])}" z="${r(v[k + 2])}"/>`);
    out.push("</vertices><triangles>");
    const t = p.indices;
    for (let k = 0; k < t.length; k += 3) out.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>`);
    out.push("</triangles></mesh></object>");
  });
  out.push("</resources><build>");
  parts.forEach((p, i) => out.push(`<item objectid="${i + 1}"/>`));
  out.push("</build></model>");

  const zip = zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "_rels/.rels": strToU8(RELS),
      "3D/3dmodel.model": strToU8(out.join("")),
    },
    { level: 6 } // 3MF XML is highly repetitive — compresses ~10×
  );
  return zip.buffer;
}
