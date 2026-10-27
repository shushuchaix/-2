import { DOMParser } from "linkedom";
import { readZipEntries } from "../resume/zip.mjs";
export const ATTACHMENT_ZIP_LIMITS = {
  maxEntries: 2000,
  maxExpandedBytes: 104857600,
  maxCompressionRatio: 200,
};
const text = (node) =>
  [...node.getElementsByTagName("w:t")].map((n) => n.textContent).join("");
export function parseDocx(bytes) {
  const entries = readZipEntries(Buffer.from(bytes), ATTACHMENT_ZIP_LIMITS),
    part = entries.get("word/document.xml");
  if (!part) throw Error("DOCX document missing");
  const doc = new DOMParser().parseFromString(
      part.toString("utf8"),
      "text/xml",
    ),
    blocks = [],
    tables = [];
  for (const [index, p] of [...doc.getElementsByTagName("w:p")].entries())
    if (!p.closest("w\\:tbl")) {
      const value = text(p).trim();
      if (value)
        blocks.push({
          text: value,
          confidence: 100,
          location: { paragraph: index + 1 },
        });
    }
  for (const [index, table] of [
    ...doc.getElementsByTagName("w:tbl"),
  ].entries()) {
    const cells = [],
      merges = [];
    for (const [row, tr] of [...table.getElementsByTagName("w:tr")].entries()) {
      let col = 0;
      for (const tc of tr.getElementsByTagName("w:tc")) {
        const span = Number(
            tc.getElementsByTagName("w:gridSpan")[0]?.getAttribute("w:val") ||
              1,
          ),
          vertical = tc.getElementsByTagName("w:vMerge")[0];
        if (!Number.isSafeInteger(span) || span < 1 || span > 100)
          throw Error("DOCX invalid merge");
        const location = { table: index + 1, row: row + 1, col: col + 1 };
        cells.push({
          text: text(tc),
          location,
          confidence: 100,
          ambiguousMerge: span > 1 || Boolean(vertical),
        });
        if (span > 1 || vertical)
          merges.push({ ...location, span, vertical: Boolean(vertical) });
        col += span;
      }
    }
    tables.push({ location: { table: index + 1 }, cells, merges });
  }
  return { blocks, tables };
}
