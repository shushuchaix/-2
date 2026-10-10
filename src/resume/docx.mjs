import path from "node:path";
import { readZipEntries } from "./zip.mjs";
const entities = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (text) =>
  text.replace(/&(#[xX]?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (match, body) => {
    if (entities[body]) return entities[body];
    const hex = /^#[xX]/.test(body),
      n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(n) &&
      n >= 0 &&
      n <= 0x10ffff &&
      !(n >= 0xd800 && n <= 0xdfff)
      ? String.fromCodePoint(n)
      : match;
  });
const attrs = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
      m[1],
      decode(m[2] ?? m[3]),
    ]),
  );
function partText(xml) {
  let out = "";
  const token =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:(?:p|tc|tr)>/g;
  for (const match of xml.matchAll(token)) {
    if (match[1] !== undefined) out += decode(match[1]);
    else if (match[0].startsWith("<w:tab") || match[0] === "</w:tc>")
      out += "\t";
    else out += "\n";
  }
  return out.trim();
}
export function readDocx(buffer) {
  const entries = readZipEntries(buffer),
    body = entries.get("word/document.xml");
  if (!body) throw new Error("DOCX missing word/document.xml");
  const xml = body.toString("utf8"),
    warnings = [],
    texts = [partText(xml)];
  const relationships = new Map();
  for (const match of (
    entries.get("word/_rels/document.xml.rels")?.toString("utf8") || ""
  ).matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const a = attrs(match[0]);
    relationships.set(a.Id, a);
  }
  const referenced = new Set(
    [
      ...xml.matchAll(/<w:(?:headerReference|footerReference)\b[^>]*\/?\s*>/g),
    ].map((m) => attrs(m[0])["r:id"]),
  );
  const used = new Set();
  for (const id of referenced) {
    const r = relationships.get(id);
    if (!r || r.TargetMode === "External") {
      warnings.push("missing_or_external_document_part");
      continue;
    }
    const file = path.posix.normalize(path.posix.join("word", r.Target || ""));
    if (
      !file.startsWith("word/") ||
      !/^https?:\/\/schemas\.(?:openxmlformats\.org|microsoft\.com)\/.+\/(header|footer)$/.test(
        r.Type || "",
      )
    ) {
      warnings.push("unsupported_document_part");
      continue;
    }
    if (used.has(file)) continue;
    used.add(file);
    const part = entries.get(file);
    if (part) texts.push(partText(part.toString("utf8")));
    else warnings.push("missing_document_part");
  }
  return {
    text: texts.filter(Boolean).join("\n"),
    warnings: [...new Set(warnings)],
  };
}
