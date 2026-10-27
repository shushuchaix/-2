import test from "node:test";
import assert from "node:assert/strict";
import { apiFixture } from "../helpers/api-fixture.mjs";

// An actual image-only PDF, with no fonts or text operators; no personal data.
function imageOnlyPdf() {
  const drawing = "q 100 0 0 100 50 600 cm /Im0 Do Q";
  const image = "ff0000>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("image-only resume explains missing text and how to import instead", async (t) => {
  const f = await apiFixture(t);
  const result = await f.call("/api/v2/profiles/import-preview", {
    filename: "image-only.pdf",
    base64: imageOnlyPdf().toString("base64"),
  });
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /PDF.*没有可提取的文字/);
  assert.match(result.data.error, /OCR/);
  assert.match(result.data.error, /TXT.*粘贴/);
  assert.equal((await f.call("/api/v2/profiles")).data.profiles.length, 0);
});
