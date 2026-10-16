import fs from "node:fs/promises";
import XLSX from "xlsx";
import { createCanvas } from "@napi-rs/canvas";
import { makeDocx } from "./resume-files.mjs";
function pdf(objects) {
  let value = "%PDF-1.4\n",
    offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(value, "latin1"));
    value += i + 1 + " 0 obj\n" + obj + "\nendobj\n";
  }
  const xref = Buffer.byteLength(value, "latin1");
  value +=
    "xref\n0 " +
    (objects.length + 1) +
    "\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size " +
    (objects.length + 1) +
    " /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF";
  return Buffer.from(value, "latin1");
}
const stream = (text) =>
  "<< /Length " +
  Buffer.byteLength(text, "latin1") +
  " >>\nstream\n" +
  text +
  "\nendstream";
export async function generateRecruitmentFixtures() {
  const dir = new URL("../fixtures/recruitment-attachments/", import.meta.url);
  await fs.mkdir(dir, { recursive: true });
  const sheet = XLSX.utils.aoa_to_sheet([
    ["合成招聘岗位表"],
    ["共用条件：遵纪守法"],
    ["岗位", "地区", "人数", "学历"],
    ["消防工程师", "合成城", 2, "本科"],
    ["消防维保员", "合成城", 1, "大专"],
  ]);
  sheet["!merges"] = [{ s: { r: 1, c: 0 }, e: { r: 1, c: 3 } }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "岗位表");
  for (const [name, bookType] of [
    ["roles.xlsx", "xlsx"],
    ["roles.xls", "biff8"],
  ])
    await fs.writeFile(
      new URL(name, dir),
      XLSX.write(book, { type: "buffer", bookType }),
    );
  const contents = [
    "BT /F1 16 Tf 50 720 Td (Synthetic recruitment) Tj ET",
    "BT /F1 16 Tf 50 720 Td (Fire Engineer - Bachelor) Tj ET",
  ];
  await fs.writeFile(
    new URL("two-pages.pdf", dir),
    pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      ...contents.map(
        (_, i) =>
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents " +
          (5 + i) +
          " 0 R >>",
      ),
      ...contents.map(stream),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]),
  );
  const canvas = createCanvas(1000, 400),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 1000, 400);
  context.fillStyle = "black";
  context.font = "48px Arial";
  context.fillText("FIRE ENGINEER", 30, 100);
  context.fillText("DEGREE BACHELOR", 30, 190);
  context.fillText("CITY EXAMPLE", 30, 280);
  await fs.writeFile(new URL("poster.png", dir), canvas.toBuffer("image/png"));
  const image = canvas.toBuffer("image/jpeg"),
    imageObject =
      "<< /Type /XObject /Subtype /Image /Width 1000 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
      image.length +
      " >>\nstream\n" +
      image.toString("latin1") +
      "\nendstream";
  await fs.writeFile(
    new URL("scanned-page.pdf", dir),
    pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 400] /Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >>",
      stream("q 1000 0 0 400 0 0 cm /I Do Q"),
      imageObject,
    ]),
  );
  await fs.writeFile(
    new URL("roles.docx", dir),
    makeDocx({
      "[Content_Types].xml":
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "_rels/.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      "word/document.xml":
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>共用条件：遵纪守法</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>消防工程师</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>本科</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    }),
  );
}
