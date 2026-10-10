import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import {
  parseAttachmentBytes,
  createAttachmentService,
} from "../../src/attachments/service.mjs";
import { createRecordEnrichment } from "../../src/application/record-enrichment.mjs";
import { createLocalOcr } from "../../src/attachments/ocr.mjs";
import { assessRecruitmentEvidence } from "../../src/domain/recruitment-evidence.mjs";

// Pin a bundled font so Windows CAD fallback fonts or Linux font availability
// cannot change the synthetic raster text under test.
GlobalFonts.registerFromPath(
  fileURLToPath(
    new URL(
      "../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
      import.meta.url,
    ),
  ),
  "SyntheticPdfFixture",
);

// Real PDF objects and raster payload; only the local OCR boundary is synthetic.
function mixedPdf({
  header = true,
  images = [[520, 400, 40, 100]],
  form = false,
  formMatrix = [1, 0, 0, 1, 0, 0],
  formBounds = [0, 0, 600, 800],
  transparent = false,
} = {}) {
  const canvas = createCanvas(1000, 400),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 1000, 400);
  context.fillStyle = "black";
  context.font = "40px SyntheticPdfFixture";
  context.fillText("FIRE ENGINEER - DEGREE MASTER", 20, 100);
  context.fillText("MAJOR CHEMICAL ENGINEERING", 20, 200);
  const image = canvas.toBuffer("image/jpeg");
  const draw = images
    .map(
      ([width, height, x, y]) =>
        `q ${width} 0 0 ${height} ${x} ${y} cm /I Do Q`,
    )
    .join("\n");
  const text = header
    ? "BT /F 14 Tf 40 720 Td (Synthetic recruitment eligibility and application table) Tj ET\n"
    : "";
  const body = Buffer.from(
    text + (form ? "q 1 0 0 1 0 0 cm /Form Do Q" : draw),
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F 5 0 R >> /XObject << /I 6 0 R /Form 7 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${body.length} >>\nstream\n`),
      body,
      Buffer.from("\nendstream"),
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1000 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from("\nendstream"),
    ]),
    `<< /Type /XObject /Subtype /Form /BBox [${formBounds.join(" ")}] /Matrix [${formMatrix.join(" ")}] ${transparent ? "/Group << /S /Transparency /I true /CS /DeviceRGB >>" : ""} /Resources << /XObject << /I 6 0 R >> >> /Length ${Buffer.byteLength(draw)} >>\nstream\n${draw}\nendstream`,
  ];
  const chunks = [Buffer.from("%PDF-1.7\n")],
    offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.from(object),
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}

const conditions = (confidence = 96) => ({
  text: "Degree Master; Major Chemical Engineering; Certificate required",
  confidence,
  location: { bbox: [100, 700, 750, 40] },
});

test("a real mixed PDF page extracts raster conditions despite its native header", async () => {
  let calls = 0;
  const result = await parseAttachmentBytes({
    bytes: mixedPdf(),
    ocr: {
      recognize: async () => {
        calls++;
        return { blocks: [conditions()] };
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "extracted");
  assert.ok(result.blocks.some((block) => /Master/.test(block.text)));
  assert.equal(
    result.blocks.filter((block) => /Synthetic recruitment/.test(block.text))
      .length,
    1,
  );
  assert.ok(result.fields.some((field) => field.value === "Master"));
});

test("mixed image regions without OCR or with low confidence stay pending", async () => {
  const missing = await parseAttachmentBytes({ bytes: mixedPdf() });
  assert.equal(missing.status, "pending");
  assert.ok(missing.issues.some((issue) => issue.code === "ocr_unavailable"));
  const uncertain = await parseAttachmentBytes({
    bytes: mixedPdf(),
    ocr: { recognize: async () => ({ blocks: [conditions(20)] }) },
  });
  assert.equal(uncertain.status, "pending");
});

test("a mixed PDF cannot be complete when a second painted image has no recognized evidence", async () => {
  const result = await parseAttachmentBytes({
    bytes: mixedPdf({
      images: [
        [520, 250, 40, 400],
        [520, 250, 40, 100],
      ],
    }),
    ocr: { recognize: async () => ({ blocks: [conditions()] }) },
  });
  assert.equal(result.status, "pending");
  assert.ok(
    result.issues.some((issue) => issue.code === "pdf_image_uncovered"),
  );
});

test("native PDF text and its OCR overlap are preserved once while raster requirements remain", async () => {
  const result = await parseAttachmentBytes({
    bytes: mixedPdf(),
    ocr: {
      recognize: async () => ({
        blocks: [
          {
            text: "Synthetic recruitment eligibility and application table",
            confidence: 92,
            location: { bbox: [80, 132, 660, 28] },
          },
          conditions(),
        ],
      }),
    },
  });
  assert.equal(result.status, "extracted");
  assert.equal(
    result.blocks.filter((block) => /Synthetic recruitment/.test(block.text))
      .length,
    1,
  );
  const hidden = result.blocks.find((block) => /Master/.test(block.text));
  assert.ok(hidden);
  assert.deepEqual(hidden.location.bbox, [50, 430, 375, 20]);
});

test("mixed image regions nested in a PDF form are also inspected", async () => {
  let calls = 0;
  const result = await parseAttachmentBytes({
    bytes: mixedPdf({ form: true }),
    ocr: {
      recognize: async () => {
        calls++;
        return { blocks: [conditions()] };
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "extracted");
});

for (const transparent of [false, true]) {
  test(`${transparent ? "transparent" : "ordinary"} PDF form applies its nonidentity content matrix once`, async () => {
    let calls = 0;
    const result = await parseAttachmentBytes({
      bytes: mixedPdf({
        form: true,
        images: [[50, 100, 0, 100]],
        formMatrix: [1, 0, 0, 1, 500, 0],
        formBounds: [0, 0, 100, 200],
        transparent,
      }),
      ocr: {
        recognize: async () => {
          calls++;
          return { blocks: [] };
        },
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "pending");
    assert.deepEqual(
      result.issues.find((issue) => issue.code === "pdf_image_uncovered")?.bbox,
      [500, 100, 50, 100],
    );
  });
}

test("a pure native PDF keeps its text without invoking OCR", async () => {
  const result = await parseAttachmentBytes({
    bytes: mixedPdf({ images: [] }),
    ocr: {
      recognize: async () => {
        throw Error("pure text must not invoke OCR");
      },
    },
  });
  assert.equal(result.status, "extracted");
  assert.equal(result.blocks.length, 1);
});

function serviceFor({ bytes = mixedPdf(), request, cache, ledger, ocr } = {}) {
  return createAttachmentService({
    request: request || (async () => ({ status: 200, bytes })),
    ledger: ledger || {
      reserve: async () => ({ duplicate: false, reservationId: "synthetic" }),
      settle: async () => {},
    },
    cleanup: { cleanupAttempt: async () => {} },
    cache,
    ocr,
  });
}
const oldAttachment = () => ({
  url: "https://jobs.example.org/roles.pdf",
  textStatus: "extracted",
  extraction: {
    status: "extracted",
    format: "pdf",
    parserVersion: "recruitment-attachments-1",
    blocks: [
      {
        text: "Old native header treated as a complete table",
        confidence: 100,
        location: { page: 1, bbox: [40, 720, 300, 14] },
      },
    ],
    tables: [],
    fields: [],
    issues: [],
  },
});
const serviceInput = (record) => ({
  record,
  ref: { scope: {} },
  token: { sliceRunId: "synthetic" },
});

test("old extracted PDF evidence is reparsed instead of permanently skipping the fixed parser", async () => {
  let requests = 0;
  const service = serviceFor({
    request: async () => {
      requests++;
      return { status: 200, bytes: mixedPdf() };
    },
  });
  const output = await service.enrich(
    serviceInput({ attachments: [oldAttachment()] }),
  );
  assert.equal(requests, 1);
  assert.equal(output.attachments[0].textStatus, "pending");
  assert.equal(output.attachments[0].extraction.status, "pending");
  assert.notEqual(
    output.attachments[0].extraction.parserVersion,
    "recruitment-attachments-1",
  );
});

test("an old same-slice PDF cache cannot return the pre-fix extraction", async () => {
  let reads = 0;
  const old = oldAttachment().extraction;
  const service = serviceFor({
    cache: {
      get: async () => ({
        parserVersion: old.parserVersion,
        parsedEvidence: { sliceRunId: "synthetic", result: old },
      }),
      read: async ({ parserVersion, parse }) => {
        reads++;
        assert.notEqual(parserVersion, old.parserVersion);
        return { evidence: await parse({ bytes: mixedPdf() }), reused: false };
      },
    },
  });
  const output = await service.extract({
    ...serviceInput({}),
    attachment: oldAttachment(),
  });
  assert.equal(reads, 1);
  assert.equal(output.status, "pending");
});

test("failed refresh of old PDF evidence cannot complete the current attachment body", async () => {
  const service = serviceFor({
    request: async () => {
      throw Error("synthetic request unavailable");
    },
  });
  const enrich = createRecordEnrichment({
    clock: { now: () => Date.UTC(2026, 9, 10) },
    getAttachmentService: () => service,
  });
  const output = await enrich(
    {
      kind: "notice",
      description: "See attachment.",
      bodyStatus: "incomplete",
      detailStatus: "incomplete",
      attachmentBodyPending: true,
      attachments: [oldAttachment()],
    },
    {
      ref: { scope: {} },
      token: { sliceRunId: "synthetic" },
      request: async () => {
        throw Error("unexpected application request");
      },
    },
  );
  assert.equal(output.attachments[0].textStatus, "pending");
  assert.notEqual(output.attachments[0].extraction?.status, "extracted");
  assert.notEqual(output.bodyStatus, "complete");
});

test("old complete PDF bodies are downgraded when their refresh budget is exhausted", async () => {
  const service = serviceFor({
    ledger: {
      reserve: async () => {
        throw Object.assign(Error("synthetic exhausted"), {
          code: "source_budget_exhausted",
        });
      },
    },
  });
  const output = await service.enrich(
    serviceInput({
      bodyStatus: "complete",
      detailStatus: "complete",
      attachmentBodyPending: false,
      attachments: [oldAttachment()],
    }),
  );
  assert.equal(output.bodyStatus, "incomplete");
  assert.equal(output.detailStatus, "pending");
  assert.equal(output.attachmentBodyPending, true);
  assert.equal(output.attachments[0].extraction.status, "pending");
  assert.equal(output.attachments[0].extraction.blocks.length, 0);
});

for (const status of ["pending", "rejected"]) {
  test(`a failed refresh cannot rescue the old complete body of a ${status} PDF`, async () => {
    const now = Date.UTC(2026, 9, 10),
      attachment = oldAttachment();
    attachment.textStatus = status;
    attachment.extraction.status = status;
    attachment.extraction.blocks = [];
    const record = {
      kind: "job",
      description:
        "Synthetic recruitment body retained before PDF verification. Bachelor degree required.",
      bodyStatus: "complete",
      detailStatus: "complete",
      attachmentBodyPending: false,
      attachments: [attachment],
    };
    assert.equal(
      assessRecruitmentEvidence({ record, now }).bodyVerified,
      false,
    );
    const service = serviceFor({
      request: async () => {
        throw Error("synthetic unavailable");
      },
    });
    const enrich = createRecordEnrichment({
      clock: { now: () => now },
      getAttachmentService: () => service,
    });
    const output = await enrich(record, {
      ref: { scope: {} },
      token: { sliceRunId: "synthetic" },
      request: async () => {
        throw Error("unexpected application request");
      },
    });
    assert.equal(output.attachments[0].extraction.status, "pending");
    assert.equal(
      output.attachments[0].extraction.parserVersion,
      "recruitment-attachments-2",
    );
    assert.equal(output.bodyStatus, "incomplete");
    assert.equal(output.attachmentBodyPending, true);
    assert.equal(
      assessRecruitmentEvidence({ record: output, now }).bodyVerified,
      false,
    );
  });
}

test("the PDF parser upgrade preserves already extracted non-PDF attachment evidence", async () => {
  let requests = 0;
  const attachment = oldAttachment();
  attachment.url = "https://jobs.example.org/roles.docx";
  attachment.extraction.format = "docx";
  attachment.extraction.blocks[0].confidence = 84;
  const service = serviceFor({
    request: async () => {
      requests++;
      return { status: 404 };
    },
  });
  const output = await service.enrich(
    serviceInput({ attachments: [attachment] }),
  );
  assert.equal(requests, 0);
  assert.deepEqual(output.attachments[0], attachment);
});

test("a small logo with only a native OCR echo is conservatively pending", async () => {
  const result = await parseAttachmentBytes({
    bytes: mixedPdf({ images: [[40, 20, 520, 750]] }),
    ocr: {
      recognize: async () => ({
        blocks: [
          {
            text: "Synthetic recruitment eligibility and application table",
            confidence: 95,
            location: { bbox: [80, 132, 660, 28] },
          },
        ],
      }),
    },
  });
  assert.equal(result.status, "pending");
  assert.equal(result.blocks.length, 1);
  assert.ok(
    result.issues.some((issue) => issue.code === "pdf_image_uncovered"),
  );
});

test("refreshing an old PDF restores its body only after new extraction and clears its outdated notice", async () => {
  const service = serviceFor({
    ocr: { recognize: async () => ({ blocks: [conditions()] }) },
  });
  const enrich = createRecordEnrichment({
    clock: { now: () => Date.UTC(2026, 9, 10) },
    getAttachmentService: () => service,
  });
  const output = await enrich(
    {
      kind: "notice",
      description: "See attachment.",
      bodyStatus: "complete",
      detailStatus: "complete",
      attachmentBodyPending: false,
      attachments: [oldAttachment()],
    },
    { ref: { scope: {} }, token: { sliceRunId: "synthetic" } },
  );
  assert.equal(output.bodyStatus, "complete");
  assert.equal(output.attachmentBodyPending, false);
  assert.ok(output.description.includes("Degree Master"));
  assert.ok(
    !(output.attachments[0].issues || []).some(
      (issue) => issue.code === "pdf_parser_outdated",
    ),
  );
});

test("real local OCR reads the raster degree and major from a PDF with a native header", async () => {
  const ocr = createLocalOcr({ languages: "eng" });
  try {
    const result = await parseAttachmentBytes({
      bytes: mixedPdf({ images: [[520, 208, 40, 100]] }),
      ocr,
    });
    assert.ok(
      result.blocks.some((block) => /DEGREE MASTER/.test(block.text)),
      JSON.stringify({
        status: result.status,
        issues: result.issues,
        blocks: result.blocks,
      }),
    );
    assert.ok(
      result.blocks.some((block) => /CHEMICAL ENGINEERING/.test(block.text)),
    );
    assert.ok(
      result.fields.some((field) => field.value.toLowerCase() === "master"),
    );
    assert.equal(
      result.blocks.filter((block) => /Synthetic recruitment/.test(block.text))
        .length,
      1,
    );
  } finally {
    await ocr.close();
  }
});
