import fs from "node:fs/promises";
import { createHash } from "node:crypto";
await fs.mkdir("resources/ocr", { recursive: true });
const files = [];
for (const lang of ["eng", "chi_sim"]) {
  const name = lang + ".traineddata.gz",
    source =
      "node_modules/@tesseract.js-data/" + lang + "/4.0.0_best_int/" + name,
    bytes = await fs.readFile(source);
  await fs.writeFile("resources/ocr/" + name, bytes);
  files.push({
    name,
    sourcePackage: "@tesseract.js-data/" + lang + "@1.0.0",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await fs.copyFile(
  "node_modules/tesseract.js/LICENSE.md",
  "resources/ocr/LICENSE.apache-2.0.txt",
);
await fs.writeFile(
  "resources/ocr/NOTICE.txt",
  "Local OCR language data: naptha/tessdata, 4.0.0_best_int. Training data is Apache-2.0; @tesseract.js-data language npm packages declare MIT. Package versions and integrity are pinned in package-lock.json.\nhttps://github.com/naptha/tessdata\n",
);
await fs.writeFile(
  "resources/ocr/manifest.json",
  JSON.stringify(
    {
      version: "tessdata-best-int-4.0.0",
      upstream: "https://github.com/naptha/tessdata",
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(files));
