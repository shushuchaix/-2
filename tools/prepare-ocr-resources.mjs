import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
await fs.mkdir("resources/ocr", { recursive: true });
const files = [];
for (const lang of ["eng", "chi_sim"]) {
  const name = lang + ".traineddata.gz",
    source =
      "node_modules/@tesseract.js-data/" + lang + "/4.0.0_best_int/" + name,
    bytes = await fs.readFile(source);
  await fs.writeFile("resources/ocr/" + name, bytes);
  files.push({
    root: "ocr",
    path: name,
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
async function add(root, rel) {
  const bytes = await fs.readFile(
    root === "app" ? rel : "resources/ocr/" + rel,
  );
  files.push({
    root,
    path: rel,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const rel = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) await walk(rel);
    else if (
      /(?:\.wasm(?:\.js)?|\.node|LICENSE[^/]*|package\.json|worker-script\/node\/index\.js)$/.test(
        rel,
      )
    )
      await add("app", rel);
  }
}
for (const directory of [
  "node_modules/tesseract.js",
  "node_modules/tesseract.js-core",
  "node_modules/@napi-rs/canvas",
  "node_modules/@napi-rs/canvas-win32-x64-msvc",
  "node_modules/pdfjs-dist/node_modules",
])
  await walk(directory);
for (const rel of [
  "LICENSE.apache-2.0.txt",
  "NOTICE.txt",
  "LICENSE.mit-packaging.txt",
])
  await add("ocr", rel);
await fs.writeFile(
  "resources/ocr/manifest.json",
  JSON.stringify(
    {
      version: 1,
      languageVersion: "tessdata-best-int-4.0.0",
      upstream: "https://github.com/naptha/tessdata",
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(files));
