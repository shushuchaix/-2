import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";

const rectangle = (bbox) =>
  Array.isArray(bbox) &&
  bbox.length === 4 &&
  bbox.every(Number.isFinite) &&
  bbox[2] > 0 &&
  bbox[3] > 0
    ? [bbox[0], bbox[1], bbox[0] + bbox[2], bbox[1] + bbox[3]]
    : null;
const overlaps = (a, b) =>
  a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const normalizedText = (text) =>
  String(text || "")
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toLowerCase();

// Image dimensions are pixels; the current drawing matrix determines their PDF bounds.
// Follow forms/groups and repeated images instead of using the amount of native text.
async function paintedImages(page) {
  const { fnArray, argsArray } = await page.getOperatorList(),
    regions = [],
    stack = [];
  let matrix = [1, 0, 0, 1, 0, 0],
    unknown = false,
    hasImages = false;
  const transform = (value) => {
    if (
      !value ||
      value.length !== 6 ||
      !Array.from(value).every(Number.isFinite)
    ) {
      unknown = true;
      return;
    }
    matrix = Util.transform(matrix, value);
  };
  const image = (extra) => {
    hasImages = true;
    const current = extra ? Util.transform(matrix, extra) : matrix;
    const bounds = Util.getAxialAlignedBoundingBox([0, 0, 1, 1], current),
      view = page.view;
    const clipped = [
      Math.max(bounds[0], view[0]),
      Math.max(bounds[1], view[1]),
      Math.min(bounds[2], view[2]),
      Math.min(bounds[3], view[3]),
    ];
    if (!clipped.every(Number.isFinite)) unknown = true;
    else if (clipped[0] < clipped[2] && clipped[1] < clipped[3])
      regions.push(clipped);
  };
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i],
      args = argsArray[i];
    if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
      stack.push(matrix.slice());
      // Group.matrix bounds the intermediate canvas; its content starts with
      // the original transform. FormBegin applies the content matrix once.
      const extra = op === OPS.paintFormXObjectBegin ? args[0] : null;
      if (extra) transform(extra);
    } else if (
      [OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)
    ) {
      if (stack.length) matrix = stack.pop();
      else unknown = true;
    } else if (op === OPS.transform) transform(args);
    else if (
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintSolidColorImageMask,
      ].includes(op)
    )
      image();
    else if (op === OPS.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = args;
      for (let n = 0; n < positions.length; n += 2)
        image([sx, 0, 0, sy, positions[n], positions[n + 1]]);
    } else if (op === OPS.paintImageMaskXObjectRepeat) {
      const [, sx, skewX, skewY, sy, positions] = args;
      for (let n = 0; n < positions.length; n += 2)
        image([sx, skewX, skewY, sy, positions[n], positions[n + 1]]);
    } else if (
      op === OPS.paintInlineImageXObjectGroup ||
      op === OPS.paintImageMaskXObjectGroup
    ) {
      const entries =
        op === OPS.paintInlineImageXObjectGroup ? args[1] : args[0];
      for (const entry of entries) image(entry.transform);
    }
  }
  return { regions, unknown: unknown && hasImages };
}

function fromOcr(block, viewport, pageNo) {
  const box = rectangle(block.location?.bbox);
  if (!box) return null;
  const a = viewport.convertToPdfPoint(box[0], box[1]),
    b = viewport.convertToPdfPoint(box[2], box[3]);
  const x = Math.min(a[0], b[0]),
    y = Math.min(a[1], b[1]);
  return {
    ...block,
    location: {
      ...block.location,
      page: pageNo,
      bbox: [x, y, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])],
    },
  };
}

function duplicatesNative(block, native) {
  const bounds = rectangle(block.location.bbox),
    nearby = native.filter((item) =>
      overlaps(bounds, rectangle(item.location.bbox)),
    );
  const text = normalizedText(block.text);
  return (
    nearby.some((item) => normalizedText(item.text) === text) ||
    (nearby.length > 0 &&
      normalizedText(nearby.map((item) => item.text).join("")) === text)
  );
}
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
        const native = items.map((i) => ({
          text: i.str,
          confidence: 100,
          location: {
            page: pageNo,
            bbox: [i.transform[4], i.transform[5], i.width, i.height],
          },
        }));
        blocks.push(...native);
        const images = await paintedImages(page);
        if (images.unknown)
          issues.push({ code: "pdf_image_geometry_unknown", page: pageNo });
        if (!items.length || images.regions.length) {
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
            const recognized = [];
            for (const b of result.blocks || []) {
              if (!b.text?.trim()) continue;
              const block = fromOcr(b, viewport, pageNo);
              if (!block || !Number.isFinite(block.confidence)) {
                issues.push({ code: "pdf_ocr_evidence_invalid", page: pageNo });
                continue;
              }
              if (!duplicatesNative(block, native)) recognized.push(block);
            }
            blocks.push(...recognized);
            for (const issue of result.issues || [])
              issues.push({ ...issue, page: pageNo });
            // An OCR echo of the native header cannot attest to a raster table.
            for (const region of images.regions)
              if (
                !recognized.some(
                  (block) =>
                    block.confidence >= 85 &&
                    overlaps(region, rectangle(block.location.bbox)),
                )
              )
                issues.push({
                  code: "pdf_image_uncovered",
                  page: pageNo,
                  bbox: [
                    region[0],
                    region[1],
                    region[2] - region[0],
                    region[3] - region[1],
                  ],
                });
          } catch (error) {
            signal?.throwIfAborted();
            if (error.code === "attachment_expansion_limit") throw error;
            issues.push({
              code:
                error.code === "ocr_unavailable"
                  ? "ocr_unavailable"
                  : "pdf_ocr_failed",
              page: pageNo,
            });
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
