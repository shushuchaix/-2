import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "tesseract.js";
export function imageDimensions(bytes) {
  const b = Buffer.from(bytes);
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6)))
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP" &&
    b.toString("ascii", 12, 16) === "VP8X"
  )
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 255) break;
      const marker = b[p + 1],
        size = b.readUInt16BE(p + 2);
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      )
        return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      if (size < 2) break;
      p += 2 + size;
    }
  }
  throw Object.assign(Error("Image dimensions unavailable"), {
    code: "attachment_image_unsupported",
  });
}
export function createLocalOcr({
  resourceDir = fileURLToPath(new URL("../../resources/ocr/", import.meta.url)),
  languages = "eng+chi_sim",
  workerPath = fileURLToPath(
    new URL(
      "../../node_modules/tesseract.js/src/worker-script/node/index.js",
      import.meta.url,
    ),
  ).replace(/app\.asar([\\/])/, "app.asar.unpacked$1"),
} = {}) {
  let worker = null,
    queue = Promise.resolve();
  const service = {
    async recognize(bytes, { signal } = {}) {
      const task = queue
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          const dimensions = imageDimensions(bytes);
          if (
            !dimensions.width ||
            !dimensions.height ||
            dimensions.width * dimensions.height > 25000000
          )
            throw Object.assign(Error("Image pixel limit"), {
              code: "attachment_expansion_limit",
            });
          for (const lang of languages.split("+"))
            await fs.access(path.join(resourceDir, lang + ".traineddata.gz"));
          if (!worker)
            worker = await createWorker(languages, 1, {
              langPath: resourceDir,
              workerPath,
              corePath: fileURLToPath(
                new URL(
                  "../../node_modules/tesseract.js-core/",
                  import.meta.url,
                ),
              ),
              gzip: true,
              cacheMethod: "none",
              logger: () => {},
            });
          const current = worker,
            abort = () => {
              worker = null;
              current.terminate().catch(() => {});
            };
          signal?.addEventListener("abort", abort, { once: true });
          try {
            signal?.throwIfAborted();
            const { data } = await current.recognize(
              Buffer.from(bytes),
              {},
              { text: true, blocks: true, tsv: true },
            );
            signal?.throwIfAborted();
            const blocks = [];
            for (const block of data.blocks || [])
              for (const p of block.paragraphs || [])
                for (const line of p.lines || [])
                  if (line.text?.trim())
                    blocks.push({
                      text: line.text.trim(),
                      confidence: Number(line.confidence || 0),
                      location: {
                        bbox: [
                          line.bbox.x0,
                          line.bbox.y0,
                          line.bbox.x1 - line.bbox.x0,
                          line.bbox.y1 - line.bbox.y0,
                        ],
                      },
                    });
            return { blocks, confidence: data.confidence, dimensions };
          } finally {
            signal?.removeEventListener("abort", abort);
          }
        });
      queue = task;
      try {
        return await task;
      } catch (e) {
        signal?.throwIfAborted();
        if (e.code === "ENOENT")
          throw Object.assign(Error("Local OCR resources unavailable"), {
            code: "ocr_unavailable",
          });
        throw e;
      }
    },
    async close() {
      await queue.catch(() => {});
      if (worker) await worker.terminate();
      worker = null;
    },
  };
  return service;
}
