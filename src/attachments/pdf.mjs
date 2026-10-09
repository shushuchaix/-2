import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
export async function parsePdf(bytes, { ocr, signal } = {}) {
  const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    }),
    doc = await task.promise,
    blocks = [],
    issues = [];
  try {
    if (doc.numPages > 200)
      throw Object.assign(Error("PDF page limit"), {
        code: "attachment_expansion_limit",
      });
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(pageNo);
      try {
        const content = await page.getTextContent(),
          items = content.items.filter((i) => i.str?.trim());
        for (const i of items)
          blocks.push({
            text: i.str,
            confidence: 100,
            location: {
              page: pageNo,
              bbox: [i.transform[4], i.transform[5], i.width, i.height],
            },
          });
        if (!items.length) {
          if (!ocr) {
            issues.push({ code: "ocr_unavailable", page: pageNo });
            continue;
          }
          const viewport = page.getViewport({ scale: 2 });
          if (viewport.width * viewport.height > 25000000)
            throw Object.assign(Error("PDF image size limit"), {
              code: "attachment_expansion_limit",
            });
          // PDF.js owns the canvas factory for both its intermediate images and render target.
          // Mixing native canvases from different installed versions can crash the process.
          const raster = doc.canvasFactory.create(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          try {
            await page.render({ canvasContext: raster.context, viewport })
              .promise;
            const result = await ocr.recognize(
              raster.canvas.toBuffer("image/png"),
              { signal },
            );
            for (const b of result.blocks || [])
              blocks.push({ ...b, location: { ...b.location, page: pageNo } });
          } finally {
            doc.canvasFactory.destroy(raster);
          }
        }
      } finally {
        page.cleanup();
      }
    }
    return { blocks, tables: [], issues };
  } finally {
    await doc.destroy();
  }
}
