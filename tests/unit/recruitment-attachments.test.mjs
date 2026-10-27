import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { createTempDir } from "../helpers/fixtures.mjs";
import { createDocConverter } from "../../src/attachments/doc-converter.mjs";
import {
  parseAttachmentBytes,
  createAttachmentService,
} from "../../src/attachments/service.mjs";
import { makeDocx, makeZip } from "../helpers/resume-files.mjs";
import { createLocalOcr } from "../../src/attachments/ocr.mjs";
const fixture = (name) =>
  fs.readFile(
    new URL("../fixtures/recruitment-attachments/" + name, import.meta.url),
  );

test("DOC converter retries a failed version probe and caches only a successful probe", async (t) => {
  const dataDir = await createTempDir(t),
    executable = path.join(dataDir, "synthetic-office.exe");
  await fs.writeFile(executable, "synthetic-placeholder");
  let probes = 0,
    conversions = 0;
  const docx = makeDocx({
    "word/document.xml":
      '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>合成岗位</w:t></w:r></w:p></w:body></w:document>',
  });
  t.mock.method(childProcess, "spawn", (_executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(async () => {
      try {
        if (args.includes("--version")) {
          probes++;
          if (probes === 1) return child.emit("close", 1);
          child.stdout.emit("data", Buffer.from("LibreOffice synthetic"));
        } else {
          conversions++;
          await fs.writeFile(
            path.join(args[args.indexOf("--outdir") + 1], "input.docx"),
            docx,
          );
        }
        child.emit("close", 0);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const converter = createDocConverter({
    executable,
    cleanup: {
      register: async ({ relativePath }) => path.join(dataDir, relativePath),
    },
  });
  const input = {
    bytes: Buffer.from("synthetic-doc"),
    ref: { scope: {}, activityId: "synthetic" },
  };
  await assert.rejects(converter.convert({ ...input, attemptId: "one" }), {
    code: "doc_conversion_failed",
  });
  assert.deepEqual(
    await converter.convert({ ...input, attemptId: "two" }),
    docx,
  );
  assert.deepEqual(
    await converter.convert({ ...input, attemptId: "three" }),
    docx,
  );
  assert.equal(probes, 2);
  assert.equal(conversions, 2);
});

test("attachment manifest retains all 41 entries and marks unattempted items", async () => {
  let requests = 0;
  const attachments = Array.from({ length: 41 }, (_, i) => ({
    url: `https://jobs.example.org/a/${i}.pdf`,
  }));
  const service = createAttachmentService({
    ledger: {
      reserve: async () => ({ duplicate: false, reservationId: "synthetic" }),
    },
    cleanup: { cleanupAttempt: async () => {} },
    request: async () => {
      requests++;
      return { status: 404 };
    },
  });
  const result = await service.enrich({
    record: { attachments },
    ref: { scope: {} },
    token: {},
  });
  assert.deepEqual(
    result.attachments.map((a) => a.url),
    attachments.map((a) => a.url),
  );
  assert.equal(requests, 40);
  assert.equal(result.attachments[40].textStatus, "pending");
  assert.ok(
    result.attachments[40].issues.some(
      (issue) => issue.code === "attachment_batch_limit",
    ),
  );
});

test("attachment budget exhaustion preserves attempted evidence and remaining manifest", async () => {
  let credits = 0,
    requests = 0;
  const service = createAttachmentService({
    ledger: {
      reserve: async () => {
        if (credits >= 2)
          throw Object.assign(Error("source_budget_exhausted"), {
            code: "source_budget_exhausted",
            budgetKind: "attachments",
          });
        credits++;
        return { duplicate: false, reservationId: "synthetic" };
      },
    },
    cleanup: { cleanupAttempt: async () => {} },
    request: async () => {
      requests++;
      return { status: 404 };
    },
  });
  const result = await service.enrich({
    record: {
      attachments: Array.from({ length: 3 }, (_, i) => ({
        url: `https://jobs.example.org/${i}.pdf`,
      })),
    },
    ref: { scope: {} },
    token: {},
  });
  assert.equal(result.attachments.length, 3);
  assert.equal(result.attachments[0].extraction.status, "pending");
  assert.equal(result.attachments[2].textStatus, "pending");
  assert.equal(result.attachmentBudgetExhausted, true);
  assert.equal(requests, 2);
});
test("spreadsheet_rows_keep_degree_cell_and_shared_merge_provenance_without_guessing", async () => {
  for (const name of ["roles.xlsx", "roles.xls"]) {
    const r = await parseAttachmentBytes({ bytes: await fixture(name) });
    assert.equal(r.status, "extracted");
    const field = r.fields.find(
      (f) => f.field === "degree" && f.value === "本科",
    );
    assert.deepEqual(field.evidence.location, { sheet: "岗位表", cell: "D4" });
    assert.equal(r.tables[0].merges.length, 1);
    assert.ok(
      r.tables[0].cells.some(
        (c) => c.location.cell === "A2" && c.ambiguousMerge,
      ),
    );
  }
});
test("pdf_keeps_second_page_coordinates_and_docx_keeps_merged_cells", async () => {
  const pdf = await parseAttachmentBytes({
    bytes: await fixture("two-pages.pdf"),
  });
  assert.equal(pdf.status, "extracted");
  assert.equal(
    pdf.blocks.find((b) => b.text.includes("Bachelor")).location.page,
    2,
  );
  const xml =
    '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>共用条件：遵纪守法</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>消防工程 本科</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const docx = await parseAttachmentBytes({
    bytes: makeDocx({ "word/document.xml": xml }),
  });
  assert.equal(docx.status, "extracted");
  assert.equal(docx.tables[0].merges[0].span, 2);
  assert.equal(docx.fields[0].status, "unknown");
});
test("invalid_expansion_missing_converter_and_uncertain_ocr_never_become_verified", async () => {
  assert.equal(
    (await parseAttachmentBytes({ bytes: Buffer.from("%PDF-invalid") })).status,
    "rejected",
  );
  const bomb = makeZip({ "word/document.xml": "x".repeat(1000000) });
  const b = await parseAttachmentBytes({ bytes: bomb });
  assert.equal(b.issues[0].code, "attachment_expansion_limit");
  const doc = Buffer.from("d0cf11e0a1b11ae10000000000000000", "hex");
  assert.equal(
    (await parseAttachmentBytes({ bytes: doc, extension: ".doc" })).status,
    "pending",
  );
  const scan = await parseAttachmentBytes({
    bytes: await fixture("poster.png"),
    ocr: {
      recognize: async () => ({
        blocks: [
          {
            text: "Degree Bachelor",
            confidence: 20,
            location: { bbox: [0, 0, 100, 40] },
          },
        ],
      }),
    },
  });
  assert.equal(scan.status, "pending");
  assert.ok(scan.fields.every((f) => f.status === "unknown"));
});
test("real_local_ocr_reads_poster_and_image_only_pdf_with_position_evidence", async () => {
  const ocr = createLocalOcr({ languages: "eng" });
  try {
    for (const name of ["poster.png", "scanned-page.pdf"]) {
      const r = await parseAttachmentBytes({ bytes: await fixture(name), ocr });
      assert.ok(r.blocks.some((b) => /FIRE ENGINEER/.test(b.text)));
      assert.ok(r.fields.some((f) => f.value.toUpperCase() === "BACHELOR"));
      assert.ok(r.blocks.every((b) => Array.isArray(b.location.bbox)));
      if (name.endsWith(".pdf"))
        assert.ok(r.blocks.every((b) => b.location.page === 1));
    }
  } finally {
    await ocr.close();
  }
});
