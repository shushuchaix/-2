import XLSX from "xlsx";
import { readZipEntries } from "../resume/zip.mjs";
import { ATTACHMENT_ZIP_LIMITS } from "./docx.mjs";
export function parseSpreadsheet(bytes, { zip = false } = {}) {
  if (zip) {
    const entries = readZipEntries(Buffer.from(bytes), ATTACHMENT_ZIP_LIMITS);
    if (!entries.has("xl/workbook.xml")) throw Error("XLSX workbook missing");
  }
  const book = XLSX.read(Buffer.from(bytes), {
      type: "buffer",
      cellFormula: false,
      cellHTML: false,
      bookVBA: false,
      bookDeps: false,
      bookFiles: false,
      WTF: true,
    }),
    tables = [];
  let total = 0;
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name],
      cells = [],
      merges = sheet["!merges"] || [];
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith("!")) continue;
      if (++total > 100000)
        throw Object.assign(Error("Workbook cell limit"), {
          code: "attachment_expansion_limit",
        });
      const position = XLSX.utils.decode_cell(address),
        merged = merges.some(
          (m) =>
            position.r >= m.s.r &&
            position.r <= m.e.r &&
            position.c >= m.s.c &&
            position.c <= m.e.c,
        );
      cells.push({
        text: String(cell.w ?? cell.v ?? ""),
        location: { sheet: name, cell: address },
        row: position.r + 1,
        col: position.c + 1,
        confidence: 100,
        ambiguousMerge: merged,
      });
    }
    tables.push({ location: { sheet: name }, cells, merges });
  }
  return { blocks: [], tables };
}
